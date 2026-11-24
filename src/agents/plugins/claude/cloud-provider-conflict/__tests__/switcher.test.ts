import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { rename as fsRename } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { BEDROCK } from '../provider.js';
import type { ConflictPaths, ResolveConflictInput } from '../resolver.js';
import {
  RENAME_RETRY_DELAYS_MS,
  SettingsFileChangedError,
  SwitchBlockedError,
  SwitchFailedError,
  applySwitch,
  renameReplacing,
  writeFileAtomicDefault,
  type SwitchDeps,
} from '../switcher.js';

const SECRET = 'SECRET-VALUE-9f3a';
const BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-5-v1:0';
const POSIX = process.platform !== 'win32';
const FIXED_NOW = new Date('2026-11-17T10:20:30.456Z');

describe('applySwitch', () => {
  let root: string;
  let backupRoot: string;
  let printed: string[];
  const abs = (rel: string): string => join(root, rel);
  const put = (rel: string, body: unknown): string => {
    const file = abs(rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    return file;
  };
  const read = (file: string): string => readFileSync(file, 'utf-8');

  const paths = (extra: ConflictPaths = {}): ConflictPaths => ({
    userSettings: abs('user/settings.json'),
    projectSettings: abs('proj/.claude/settings.json'),
    projectLocalSettings: abs('proj/.claude/settings.local.json'),
    managedFiles: [abs('managed/managed-settings.json')],
    managedDropInDirs: [abs('managed/managed-settings.d')],
    ...extra,
  });
  const plan = (over: Partial<ResolveConflictInput> & { paths?: ConflictPaths } = {}): ResolveConflictInput => ({
    provider: BEDROCK,
    flow: 'claude-agent',
    platform: 'linux',
    env: {},
    cwd: abs('proj'),
    ...over,
    paths: paths(over.paths),
  });
  const deps = (over: SwitchDeps = {}): SwitchDeps => ({
    backupRoot,
    now: () => FIXED_NOW,
    print: (line) => printed.push(line),
    ...over,
  });
  const backupDirs = (): string[] => (existsSync(backupRoot) ? readdirSync(backupRoot) : []);

  const bedrockUser = (): Record<string, unknown> => ({
    model: BEDROCK_MODEL,
    theme: 'dark',
    awsAuthRefresh: `aws sso login ${SECRET}`,
    awsCredentialExport: 'aws export',
    availableModels: [BEDROCK_MODEL, 'claude-opus-4-1', 'arn:aws:bedrock:us-east-1:1:inference-profile/x'],
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: SECRET,
      AWS_SECRET_ACCESS_KEY: SECRET,
      ANTHROPIC_MODEL: BEDROCK_MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: BEDROCK_MODEL,
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      MY_VAR: 'keep',
    },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conflict-switcher-'));
    backupRoot = join(root, 'backups');
    printed = [];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('strips the Bedrock keys, keeps the rest and backs up the exact original bytes', async () => {
    const original = JSON.stringify(bedrockUser(), null, 2);
    const user = put('user/settings.json', original);

    const result = await applySwitch(plan(), deps());

    const after = JSON.parse(read(user)) as Record<string, unknown>;
    expect(after).toEqual({
      theme: 'dark',
      availableModels: ['claude-opus-4-1'],
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example', MY_VAR: 'keep' },
    });
    expect(result.changed).toEqual([user]);
    expect(result.files).toEqual([{ path: user, kind: 'claude-json' }]);
    expect(result.backupDir).toBeTruthy();
    const backupDir = result.backupDir as string;
    expect(backupDir.startsWith(backupRoot)).toBe(true);
    expect(backupDir).toContain('bedrock-switch-');
    const manifest = JSON.parse(read(join(backupDir, 'manifest.json'))) as {
      version: number;
      files: Array<{ backup: string; original: string; kind: string }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ original: user, kind: 'claude-json' });
    expect(read(join(backupDir, manifest.files[0].backup))).toBe(original);
    expect(read(join(backupDir, 'manifest.json'))).not.toContain(SECRET);
    expect(readdirSync(join(user, '..')).sort()).toEqual(['settings.json']);
  });

  it('writes manifest.json before any copy and verifies the copies before the first strip', async () => {
    const user = put('user/settings.json', bedrockUser());
    const original = read(user);
    const order: string[] = [];

    await applySwitch(
      plan(),
      deps({
        afterBackupWrite: (name) => {
          order.push(name);
          // No strip yet while the backup is being written.
          expect(read(user)).toBe(original);
        },
      })
    );

    expect(order[0]).toBe('manifest.json');
    expect(order).toHaveLength(2);
  });

  it('changes nothing when the backup fails after the manifest was written', async () => {
    const user = put('user/settings.json', bedrockUser());
    const original = read(user);

    await expect(
      applySwitch(
        plan(),
        deps({
          afterBackupWrite: (name) => {
            if (name !== 'manifest.json') throw new Error('disk full');
          },
        })
      )
    ).rejects.toBeInstanceOf(SwitchFailedError);

    expect(read(user)).toBe(original);
  });

  it('changes nothing when the backup folder cannot be created', async () => {
    const user = put('user/settings.json', bedrockUser());
    const original = read(user);
    const blocker = put('blocker', 'a file, not a folder');

    await expect(applySwitch(plan(), deps({ backupRoot: join(blocker, 'backups') }))).rejects.toBeInstanceOf(
      SwitchFailedError
    );

    expect(read(user)).toBe(original);
  });

  it.runIf(POSIX)('creates the folder 0700 and the copies 0600 whatever the source mode', async () => {
    const user = put('user/settings.json', bedrockUser());
    const { chmodSync } = await import('node:fs');
    chmodSync(user, 0o644);

    const result = await applySwitch(plan(), deps());

    const backupDir = result.backupDir as string;
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(backupDir)) {
      expect(statSync(join(backupDir, name)).mode & 0o777).toBe(0o600);
    }
    // The edited file keeps its own mode.
    expect(statSync(user).mode & 0o777).toBe(0o644);
  });

  it('never reuses an existing backup folder: EEXIST retries with a random suffix', async () => {
    put('user/settings.json', bedrockUser());
    const taken = join(backupRoot, 'bedrock-switch-2026-11-17T10-20-30-456Z');
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'sentinel'), 'mine');
    const suffixes = ['dup', 'fresh'];
    const takenToo = `${taken}-dup`;
    mkdirSync(takenToo);

    const result = await applySwitch(plan(), deps({ randomSuffix: () => suffixes.shift() as string }));

    expect(result.backupDir).toBe(`${taken}-fresh`);
    expect(readdirSync(taken)).toEqual(['sentinel']);
    expect(readdirSync(takenToo)).toEqual([]);
  });

  it('changes nothing and names the cause when every backup folder name is taken', async () => {
    const user = put('user/settings.json', bedrockUser());
    const original = read(user);
    const taken = join(backupRoot, 'bedrock-switch-2026-11-17T10-20-30-456Z');
    mkdirSync(taken, { recursive: true });
    mkdirSync(`${taken}-same`);

    const run = applySwitch(plan(), deps({ randomSuffix: () => 'same' }));

    await expect(run).rejects.toBeInstanceOf(SwitchFailedError);
    await expect(run).rejects.toThrow(/could not find a free backup folder name.*Nothing was changed/);
    await expect(run).rejects.toMatchObject({ backupDir: null });
    expect(read(user)).toBe(original);
    expect(readdirSync(backupRoot).sort()).toEqual(['bedrock-switch-2026-11-17T10-20-30-456Z', 'bedrock-switch-2026-11-17T10-20-30-456Z-same']);
  });

  it('removes flag-scoped keys only from layers that set the flag, but model ids from every editable layer', async () => {
    const user = put('user/settings.json', bedrockUser());
    const project = put('proj/.claude/settings.json', {
      env: { AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1', ANTHROPIC_DEFAULT_OPUS_MODEL: BEDROCK_MODEL, CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5' },
      model: 'claude-sonnet-4-5',
      awsAuthRefresh: 'keep-me',
    });
    const local = put('proj/.claude/settings.local.json', { model: BEDROCK_MODEL, env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: BEDROCK_MODEL } });

    const result = await applySwitch(plan(), deps());

    expect(JSON.parse(read(project))).toEqual({
      env: { AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5' },
      model: 'claude-sonnet-4-5',
      awsAuthRefresh: 'keep-me',
    });
    expect(JSON.parse(read(local))).toEqual({ env: {} });
    expect(JSON.parse(read(user)).env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect([...result.changed].sort()).toEqual([local, project, user].sort());
  });

  it('keeps non-Bedrock model values and leaves unaffected files untouched', async () => {
    const user = put('user/settings.json', bedrockUser());
    const project = put('proj/.claude/settings.json', { model: 'claude-sonnet-4-5', env: { ANTHROPIC_MODEL: 'claude-opus-4-1' } });
    const projectBytes = read(project);

    const result = await applySwitch(plan(), deps());

    expect(read(project)).toBe(projectBytes);
    expect(result.changed).toEqual([user]);
    expect(result.files.map((f) => f.path)).toEqual([user]);
  });

  it('preserves indentation and unrelated formatting in Claude settings files', async () => {
    const user = put(
      'user/settings.json',
      `{
\t"theme": "dark",
\t"permissions": { "allow": ["Bash(ls)"] },
\t"env": {
\t\t"CLAUDE_CODE_USE_BEDROCK": "1",
\t\t"MY_VAR": "keep"
\t}
}
`
    );

    await applySwitch(plan(), deps());

    expect(read(user)).toBe(`{
\t"theme": "dark",
\t"permissions": { "allow": ["Bash(ls)"] },
\t"env": {
\t\t"MY_VAR": "keep"
\t}
}
`);
  });

  describe('VS Code settings', () => {
    const vscodePlan = (file: string): ResolveConflictInput => plan({ flow: 'connect-vscode', paths: { vscodeSettings: [file] } });
    const entry = (name: string, value: string): string =>
      `    {\n      "name": "${name}",\n      "value": "${value}"\n    }`;
    const settings = (entries: string[]): string => `{
  // editor
  "editor.fontSize": 14,
  "CLAUDE_CODE_USE_BEDROCK": { "keep": true },
  "claudeCode.environmentVariables": [
    // first comment
${entries.join(',\n')}
  ],
  "files.autoSave": "off", // trailing
}
`;

    it('removes only whole Bedrock array entries and keeps every other byte', async () => {
      const kept1 = entry('ANTHROPIC_BASE_URL', 'https://gateway.example');
      const kept2 = entry('ANTHROPIC_MODEL', 'claude-opus-4-1');
      const kept3 = entry('MY_VAR', 'x');
      const file = put(
        'Code/User/settings.json',
        settings([
          kept1,
          entry('CLAUDE_CODE_USE_BEDROCK', '1'),
          entry('AWS_ACCESS_KEY_ID', SECRET),
          kept2,
          entry('AWS_REGION', 'us-east-1'),
          entry('ANTHROPIC_DEFAULT_SONNET_MODEL', BEDROCK_MODEL),
          kept3,
        ])
      );

      const result = await applySwitch(vscodePlan(file), deps());

      expect(read(file)).toBe(settings([kept1, kept2, kept3]));
      expect(result.files).toEqual([{ path: file, kind: 'vscode-jsonc' }]);
      expect(result.changed).toEqual([file]);
    });

    it('keeps the array as [] when every entry goes, and never touches a top-level key of the same name', async () => {
      const file = put(
        'Code/User/settings.json',
        settings([entry('CLAUDE_CODE_USE_BEDROCK', '1'), entry('AWS_PROFILE', 'work')]).replace('    // first comment\n', '')
      );

      await applySwitch(vscodePlan(file), deps());

      expect(read(file)).toBe(`{
  // editor
  "editor.fontSize": 14,
  "CLAUDE_CODE_USE_BEDROCK": { "keep": true },
  "claudeCode.environmentVariables": [],
  "files.autoSave": "off", // trailing
}
`);
    });

    it('keeps flag-scoped names when the file has no flag entry, but still drops Bedrock model entries', async () => {
      const keep = entry('AWS_REGION', 'us-east-1');
      const other = put('Code - Insiders/User/settings.json', settings([keep, entry('ANTHROPIC_SMALL_FAST_MODEL', BEDROCK_MODEL)]));
      // Another edition holds the flag entry, so the verdict is a conflict.
      const flagged = put('Code/User/settings.json', settings([entry('CLAUDE_CODE_USE_BEDROCK', '1')]));

      const result = await applySwitch(plan({ flow: 'connect-vscode', paths: { vscodeSettings: [flagged, other] } }), deps());

      expect([...result.changed].sort()).toEqual([flagged, other].sort());
      expect(read(other)).toBe(settings([keep]));
    });
  });

  it.runIf(POSIX)('writes through a symlinked settings file and keeps the link', async () => {
    const real = put('dotfiles/claude-settings.json', bedrockUser());
    const link = abs('user/settings.json');
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(real, link);

    const result = await applySwitch(plan(), deps());

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(read(real)).env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect(result.changed).toEqual([link]);
    expect(readdirSync(join(real, '..'))).toEqual(['claude-settings.json']);
  });

  it('stops and restores what it wrote when a file changed before its rename', async () => {
    const user = put('user/settings.json', bedrockUser());
    const project = put('proj/.claude/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'x' } });
    const userBytes = read(user);
    const projectBytes = read(project);
    let calls = 0;

    const failure = await applySwitch(
      plan(),
      deps({
        beforeRename: (file) => {
          calls += 1;
          if (calls === 2) appendFileSync(file, '\n');
        },
      })
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SwitchFailedError);
    const err = failure as SwitchFailedError;
    expect(err.backupDir).toBeTruthy();
    expect(err.message).toContain(err.backupDir as string);
    expect(err.message).toContain(user);
    // The project file was written first and is restored; the concurrent edit to the user file stays.
    expect(read(project)).toBe(projectBytes);
    expect(read(user)).toBe(`${userBytes}\n`);
    expect(readdirSync(join(user, '..')).sort()).toEqual(['settings.json']);
  });

  it('detects a changed modification time even when the size is equal', async () => {
    const user = put('user/settings.json', bedrockUser());
    const original = read(user);

    const failure = await applySwitch(
      plan(),
      deps({
        beforeRename: (file) => {
          const later = new Date(Date.now() + 60_000);
          utimesSync(file, later, later);
        },
      })
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SwitchFailedError);
    expect(read(user)).toBe(original);
  });

  it('restores earlier files and names the backup folder when a later write fails', async () => {
    const user = put('user/settings.json', bedrockUser());
    const project = put('proj/.claude/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'x' } });
    const userBytes = read(user);
    const projectBytes = read(project);
    let calls = 0;

    const failure = await applySwitch(
      plan(),
      deps({
        writeFileAtomic: async (file, content, options) => {
          calls += 1;
          if (calls === 2) throw new Error('EACCES: permission denied');
          const { writeFileAtomicDefault } = await import('../switcher.js');
          await writeFileAtomicDefault(file, content, options);
        },
      })
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SwitchFailedError);
    const err = failure as SwitchFailedError;
    expect(err.message).toContain(err.backupDir as string);
    expect(read(user)).toBe(userBytes);
    expect(read(project)).toBe(projectBytes);
    // The folder is kept so the user can recover by hand.
    expect(existsSync(join(err.backupDir as string, 'manifest.json'))).toBe(true);
  });

  it('backs up the Desktop applied file without stripping it', async () => {
    const applied = put('desktop/configLibrary/applied.json', {
      inferenceProvider: 'bedrock',
      inferenceBedrockRegion: 'us-east-1',
      inferenceBedrockBearerToken: SECRET,
    });
    const original = read(applied);

    const result = await applySwitch(
      plan({ flow: 'connect-desktop', paths: { desktopApplied: applied, desktopManaged: null } }),
      deps()
    );

    expect(read(applied)).toBe(original);
    expect(result.files).toEqual([{ path: applied, kind: 'desktop-applied' }]);
    expect(result.changed).toEqual([]);
    const backupDir = result.backupDir as string;
    const manifest = JSON.parse(read(join(backupDir, 'manifest.json'))) as { files: Array<{ backup: string; kind: string }> };
    expect(manifest.files[0].kind).toBe('desktop-applied');
    expect(read(join(backupDir, manifest.files[0].backup))).toBe(original);
  });

  it('does nothing and creates no backup when the re-resolve finds no conflict', async () => {
    const user = put('user/settings.json', { env: { MY_VAR: 'x' } });
    const original = read(user);

    const result = await applySwitch(plan(), deps());

    expect(result).toEqual({ backupDir: null, files: [], changed: [] });
    expect(read(user)).toBe(original);
    expect(backupDirs()).toEqual([]);
    expect(printed).toEqual([]);
  });

  it('throws without changing anything when a managed policy sets the provider', async () => {
    const user = put('user/settings.json', bedrockUser());
    put('managed/managed-settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
    const original = read(user);

    await expect(applySwitch(plan(), deps())).rejects.toBeInstanceOf(SwitchBlockedError);

    expect(read(user)).toBe(original);
    expect(backupDirs()).toEqual([]);
  });

  it('neutralises control characters in the detail of a blocked switch', () => {
    const error = new SwitchBlockedError('unknown', '/tmp/\u001b[31mevil\u0007/settings.json: cannot be read');
    // eslint-disable-next-line no-control-regex
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(error.message).toContain('/tmp/[31mevil/settings.json');
  });

  it('throws without changing anything when the state became unknown', async () => {
    const user = put('user/settings.json', bedrockUser());
    put('proj/.claude/settings.json', '{"env": {"CLAUDE_CODE_USE_BEDROCK": "maybe"}}');
    const original = read(user);

    await expect(applySwitch(plan(), deps())).rejects.toBeInstanceOf(SwitchBlockedError);

    expect(read(user)).toBe(original);
    expect(backupDirs()).toEqual([]);
  });

  it('prints the folder, the undo sentence, the credential notice and the managed-wins note, never a value', async () => {
    put('user/settings.json', bedrockUser());

    const result = await applySwitch(plan(), deps());

    const text = printed.join('\n');
    expect(text).toContain(result.backupDir as string);
    expect(text).toMatch(/copy .*back/i);
    expect(text).toMatch(/credentials/i);
    expect(text).toMatch(/delete/i);
    expect(text).toMatch(/managed policy/i);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(BEDROCK_MODEL);
  });

  it('defaults the backup folder to ~/.codemie/backups (CODEMIE_HOME)', async () => {
    put('user/settings.json', bedrockUser());
    const previous = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = abs('codemie-home');
    try {
      const result = await applySwitch(plan(), { now: () => FIXED_NOW, print: () => undefined });
      expect((result.backupDir as string).startsWith(join(abs('codemie-home'), 'backups'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CODEMIE_HOME;
      else process.env.CODEMIE_HOME = previous;
    }
  });

  describe('backup folder access on Windows', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('limits a new backup folder to the current account before anything is written into it', async () => {
      put('user/settings.json', bedrockUser());
      const seen: Array<{ dir: string; entries: string[] }> = [];
      const restrictBackupAccess = async (dir: string): Promise<void> => {
        seen.push({ dir, entries: readdirSync(dir) });
      };
      const result = await applySwitch(plan(), deps({ platform: 'win32', restrictBackupAccess }));
      expect(seen).toEqual([{ dir: result.backupDir, entries: [] }]);
      expect(readdirSync(result.backupDir as string)).toContain('manifest.json');
    });

    it('still switches, and says so, when the access cannot be limited', async () => {
      const user = put('user/settings.json', bedrockUser());
      const notice = vi.spyOn(logger, 'notice').mockImplementation(() => undefined);
      const restrictBackupAccess = async (): Promise<void> => {
        throw new Error('icacls exited with code 5');
      };
      const result = await applySwitch(plan(), deps({ platform: 'win32', restrictBackupAccess }));
      expect(JSON.parse(read(user)).env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
      expect(notice).toHaveBeenCalledTimes(1);
      const message = String(notice.mock.calls[0][0]);
      expect(message).toContain(result.backupDir as string);
      expect(message).toContain('icacls exited with code 5');
      expect(message).not.toContain(SECRET);
    });

    it('leaves folder access alone on other platforms', async () => {
      const restrictBackupAccess = vi.fn(async (): Promise<void> => undefined);
      for (const platform of ['darwin', 'linux'] as const) {
        put('user/settings.json', bedrockUser());
        const result = await applySwitch(plan(), deps({ platform, restrictBackupAccess, randomSuffix: () => platform }));
        expect(result.backupDir).toBeTruthy();
      }
      expect(restrictBackupAccess).not.toHaveBeenCalled();
    });
  });
});

describe('renameReplacing', () => {
  const locked = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: resource busy or locked`), { code });

  it('retries a file Windows reports as locked and succeeds once it is released', async () => {
    let calls = 0;
    const slept: number[] = [];
    const checks: number[] = [];
    await renameReplacing('a.tmp', 'a', async () => void checks.push(calls), {
      platform: 'win32',
      rename: async () => {
        calls += 1;
        if (calls < 3) throw locked(calls === 1 ? 'EBUSY' : 'EPERM');
      },
      sleep: async (ms) => void slept.push(ms),
    });
    expect(calls).toBe(3);
    expect(slept).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2));
    // The change check runs before every attempt, so a file edited while waiting is never overwritten.
    expect(checks).toEqual([0, 1, 2]);
  });

  it('gives up with the last error after the last pause', async () => {
    let calls = 0;
    const error = await renameReplacing('a.tmp', 'a', undefined, {
      platform: 'win32',
      rename: async () => {
        calls += 1;
        throw locked('EACCES');
      },
      sleep: async () => undefined,
    }).catch((e: unknown) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1);
  });

  it.each([
    ['another platform', 'linux', 'EBUSY'],
    ['an error that is not a lock', 'win32', 'ENOENT'],
  ])('fails on the first attempt for %s', async (_label, platform, code) => {
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const error = await renameReplacing('a.tmp', 'a', undefined, {
      platform: platform as NodeJS.Platform,
      rename: async () => {
        calls += 1;
        throw locked(code);
      },
      sleep,
    }).catch((e: unknown) => e);
    expect((error as NodeJS.ErrnoException).code).toBe(code);
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops retrying when the file changed while waiting', async () => {
    let calls = 0;
    let checks = 0;
    const error = await renameReplacing(
      'a.tmp',
      'a',
      async () => {
        checks += 1;
        if (checks === 2) throw new SettingsFileChangedError('a');
      },
      {
        platform: 'win32',
        rename: async () => {
          calls += 1;
          throw locked('EBUSY');
        },
        sleep: async () => undefined,
      }
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettingsFileChangedError);
    expect(calls).toBe(1);
  });

  describe('through writeFileAtomicDefault', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'rename-replacing-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('replaces the file after a locked first attempt and leaves no temp file behind', async () => {
      const file = join(dir, 'settings.json');
      writeFileSync(file, '{"a":1}');
      const before = statSync(file);
      let calls = 0;
      await writeFileAtomicDefault(file, Buffer.from('{"a":2}'), {
        mode: 0o600,
        expected: { mtimeMs: before.mtimeMs, size: before.size },
        renameRetry: {
          platform: 'win32',
          sleep: async () => undefined,
          rename: async (from, to) => {
            calls += 1;
            if (calls === 1) throw locked('EBUSY');
            await fsRename(from, to);
          },
        },
      });
      expect(readFileSync(file, 'utf-8')).toBe('{"a":2}');
      expect(calls).toBe(2);
      expect(readdirSync(dir)).toEqual(['settings.json']);
    });
  });
});
