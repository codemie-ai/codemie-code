import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  managedSettingsPaths,
  readClaudeSettingsEnv,
  readManagedDropIns,
  readManagedPlist,
  readManagedRegistry,
  type CommandRunner,
  readSettingsLayer,
  settingsLayerPaths,
} from '../event-fields/claude-settings-env.js';

describe('claude settings env layers (CR-006)', () => {
  let root: string;
  const put = (rel: string, body: string) => {
    const file = join(root, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
  };
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    CLAUDE_CONFIG_DIR: join(root, 'user'),
    CLAUDE_PROJECT_DIR: join(root, 'proj'),
    ...extra,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-settings-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('follows CLAUDE_PROJECT_DIR (not a subdirectory cwd) and CLAUDE_CONFIG_DIR, later layers winning', async () => {
    put('user/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'user', A: 'u' } }));
    put('proj/.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'project' } }));
    put('proj/.claude/settings.local.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'local' } }));
    // The decoy layers a cwd/home-keyed lookup would have used.
    put('proj/sub/.claude/settings.local.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'cwd-decoy' } }));

    const r = await readClaudeSettingsEnv(join(root, 'proj', 'sub'), env(), 'linux');

    expect(r.env).toMatchObject({ ANTHROPIC_BASE_URL: 'local', A: 'u' });
    expect(r.complete).toBe(true);
  });

  it('falls back to the hook cwd without CLAUDE_PROJECT_DIR', async () => {
    put('proj/.claude/settings.json', JSON.stringify({ env: { B: '1' } }));
    const r = await readClaudeSettingsEnv(join(root, 'proj'), { CLAUDE_CONFIG_DIR: join(root, 'user') }, 'linux');
    expect(r).toEqual({ env: { B: '1' }, complete: true });
  });

  it('absent files (and no env block) are no override; complete stays true', async () => {
    put('proj/.claude/settings.json', JSON.stringify({ permissions: {} }));
    expect(await readClaudeSettingsEnv(root, env(), 'linux')).toEqual({ env: {}, complete: true });
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['non-object JSON', '[1]'],
    ['non-object env block', JSON.stringify({ env: 'ANTHROPIC_BASE_URL=x' })],
    ['array env block', JSON.stringify({ env: [] })],
  ])('%s is unknown (incomplete), never "no override"', async (_n, body) => {
    put('proj/.claude/settings.local.json', body);
    put('proj/.claude/settings.json', JSON.stringify({ env: { KEEP: 'y' } }));
    const r = await readClaudeSettingsEnv(root, env(), 'linux');
    expect(r.complete).toBe(false);
    expect(r.env).toMatchObject({ KEEP: 'y' });
  });

  it('an unreadable path that is not "missing" (a directory) is incomplete', async () => {
    mkdirSync(join(root, 'proj', '.claude', 'settings.json'), { recursive: true });
    expect((await readClaudeSettingsEnv(root, env(), 'linux')).complete).toBe(false);
  });

  it('uses only the managed settings file of the running platform', () => {
    expect(managedSettingsPaths('linux')).toEqual(['/etc/claude-code/managed-settings.json']);
    expect(managedSettingsPaths('darwin')).toEqual(['/Library/Application Support/ClaudeCode/managed-settings.json']);
    const win = managedSettingsPaths('win32');
    expect(win[0]).toBe('C:/Program Files/ClaudeCode/managed-settings.json');
    expect(settingsLayerPaths('/c', {}, 'linux').slice(-1)).toEqual(managedSettingsPaths('linux'));
    expect(settingsLayerPaths('/c', {}, 'win32').slice(-win.length)).toEqual(win);
  });

  describe('readSettingsLayer', () => {
    it('reports ok with the parsed object', async () => {
      put('a.json', JSON.stringify({ env: { X: '1' } }));
      const r = await readSettingsLayer(join(root, 'a.json'));
      expect(r).toEqual({ path: join(root, 'a.json'), state: 'ok', parsed: { env: { X: '1' } } });
    });

    it('reports absent for a missing file and for a path below a regular file', async () => {
      put('plain', 'x');
      expect((await readSettingsLayer(join(root, 'missing.json'))).state).toBe('absent');
      expect((await readSettingsLayer(join(root, 'plain', 'child.json'))).state).toBe('absent');
    });

    it('reports malformed for invalid JSON, with no parsed value', async () => {
      put('bad.json', '{nope');
      const r = await readSettingsLayer(join(root, 'bad.json'));
      expect(r.state).toBe('malformed');
      expect(r.parsed).toBeUndefined();
    });

    it.each([['an array root', '[1]'], ['a scalar root', '"s"'], ['a null root', 'null']])(
      'reports unreadable for %s',
      async (_n, body) => {
        put('odd.json', body);
        const r = await readSettingsLayer(join(root, 'odd.json'));
        expect(r.state).toBe('unreadable');
        expect(r.parsed).toBeUndefined();
      }
    );

    it('reports unreadable (not absent, not malformed) when the path is a directory', async () => {
      mkdirSync(join(root, 'dir.json'), { recursive: true });
      expect((await readSettingsLayer(join(root, 'dir.json'))).state).toBe('unreadable');
    });
  });

  describe('readManagedDropIns', () => {
    it('reads managed-settings.d/*.json in name order, ignoring other entries', async () => {
      put('managed/managed-settings.d/20-b.json', JSON.stringify({ n: 'b' }));
      put('managed/managed-settings.d/10-a.json', JSON.stringify({ n: 'a' }));
      put('managed/managed-settings.d/30-c.json', '{nope');
      put('managed/managed-settings.d/readme.txt', 'ignored');
      mkdirSync(join(root, 'managed', 'managed-settings.d', 'sub.json'), { recursive: true });

      const results = await readManagedDropIns('linux', [join(root, 'managed', 'managed-settings.d')]);

      expect(results.map((r) => [r.path.split(/[\\/]/).pop(), r.state])).toEqual([
        ['10-a.json', 'ok'],
        ['20-b.json', 'ok'],
        ['30-c.json', 'malformed'],
        ['sub.json', 'unreadable'],
      ]);
      expect(results[0].parsed).toEqual({ n: 'a' });
    });

    it('returns an empty list when the drop-in directory is absent or is not a directory', async () => {
      put('plain', 'x');
      expect(await readManagedDropIns('linux', [join(root, 'nope', 'managed-settings.d')])).toEqual([]);
      expect(await readManagedDropIns('linux', [join(root, 'plain')])).toEqual([]);
    });

    it('defaults to the managed-settings.d directory next to each managed-settings.json of the platform', async () => {
      // Real system locations are not asserted on; the default only needs to be derivable and not throw.
      expect(Array.isArray(await readManagedDropIns('linux'))).toBe(true);
    });
  });

  it('readClaudeSettingsEnv does not fold managed-settings.d drop-ins into its four layers', async () => {
    put('proj/.claude/settings.json', JSON.stringify({ env: { KEEP: 'y' } }));
    const r = await readClaudeSettingsEnv(root, env(), 'linux');
    expect(r).toEqual({ env: { KEEP: 'y' }, complete: true });
  });
  describe('readManagedPlist', () => {
    const FILE = '/Library/Managed Preferences/com.anthropic.claudecode.plist';

    it('treats a missing plist as absent without running plutil', async () => {
      let ran = 0;
      const run: CommandRunner = async () => {
        ran++;
        return { code: 0, stdout: '{}', stderr: '' };
      };
      const r = await readManagedPlist(run, () => false);
      expect(r.state).toBe('absent');
      expect(r.path).toBe(FILE);
      expect(ran).toBe(0);
    });

    it('converts an existing plist through plutil and returns its top-level keys as settings', async () => {
      const calls: Array<[string, string[]]> = [];
      const run: CommandRunner = async (cmd, args) => {
        calls.push([cmd, args]);
        return { code: 0, stdout: '{"env":{"A":"b"}}', stderr: '' };
      };
      const r = await readManagedPlist(run, async () => true);
      expect(r.state).toBe('ok');
      expect(r.parsed).toEqual({ env: { A: 'b' } });
      expect(calls).toEqual([['plutil', ['-convert', 'json', '-o', '-', FILE]]]);
    });

    it('reports an existing plist that plutil cannot convert, whose output is not an object, or whose runner throws as unreadable', async () => {
      const exists = () => true;
      expect((await readManagedPlist(async () => ({ code: 1, stdout: '', stderr: 'bad' }), exists)).state).toBe('unreadable');
      expect((await readManagedPlist(async () => ({ code: 0, stdout: 'not json', stderr: '' }), exists)).state).toBe('unreadable');
      expect((await readManagedPlist(async () => ({ code: 0, stdout: '[1]', stderr: '' }), exists)).state).toBe('unreadable');
      expect((await readManagedPlist(async () => { throw new Error('spawn plutil ENOENT'); }, exists)).state).toBe('unreadable');
    });

    it('reports a plutil run that exceeds the timeout as unreadable', async () => {
      const hang: CommandRunner = () => new Promise(() => undefined);
      const r = await readManagedPlist(hang, () => true, { timeoutMs: 20 });
      expect(r.state).toBe('unreadable');
    });
  });

  describe('readManagedRegistry', () => {
    const KEY = String.raw`SOFTWARE\Policies\ClaudeCode`;
    const valueOut = (hive: string, json: string): string =>
      `\r\n${hive}\\${KEY}\r\n    Settings    REG_SZ    ${json}\r\n`;

    /** Scripted reg: key = per-hive key query, value = per-hive value query. */
    function scripted(plan: Record<string, { code: number; stdout: string } | Error>): { run: CommandRunner; calls: string[][] } {
      const calls: string[][] = [];
      const run: CommandRunner = async (cmd, args) => {
        calls.push([cmd, ...args]);
        const entry = plan[args.join(' ')];
        if (entry === undefined) return { code: 1, stdout: '', stderr: 'unscripted' };
        if (entry instanceof Error) throw entry;
        return { ...entry, stderr: '' };
      };
      return { run, calls };
    }
    const q = (hive: string, value = false): string => `query ${hive}\\${KEY}${value ? ' /v Settings' : ''}`;

    it('queries the key then the value for HKLM then HKCU and parses the REG_SZ JSON data', async () => {
      const { run, calls } = scripted({
        [q('HKLM')]: { code: 0, stdout: 'HKLM key' },
        [q('HKLM', true)]: { code: 0, stdout: valueOut('HKEY_LOCAL_MACHINE', '{"env":{"A":"1"}}') },
        [q('HKCU')]: { code: 0, stdout: 'HKCU key' },
        [q('HKCU', true)]: { code: 0, stdout: valueOut('HKEY_CURRENT_USER', '{"model":"x"}') },
      });
      const r = await readManagedRegistry(run);
      expect(r.map((x) => [x.path, x.state])).toEqual([
        [String.raw`HKLM\SOFTWARE\Policies\ClaudeCode\Settings`, 'ok'],
        [String.raw`HKCU\SOFTWARE\Policies\ClaudeCode\Settings`, 'ok'],
      ]);
      expect(r[0].parsed).toEqual({ env: { A: '1' } });
      expect(r[1].parsed).toEqual({ model: 'x' });
      // Hives are queried in parallel; within one hive the key query precedes the value query.
      const lines = calls.map((c) => c.join(' '));
      for (const hive of ['HKLM', 'HKCU']) {
        expect(lines.filter((l) => l.includes(` ${hive}\\`))).toEqual([`reg ${q(hive)}`, `reg ${q(hive, true)}`]);
      }
    });

    it('treats a non-zero exit with empty stdout as absent whatever the message says (key or value)', async () => {
      const localized = async (): Promise<{ code: number; stdout: string; stderr: string }> =>
        ({ code: 1, stdout: '', stderr: 'FEHLER: Das System kann den angegebenen Registrierungsschluessel nicht finden.' });
      const noKey = await readManagedRegistry(localized);
      expect(noKey.map((x) => x.state)).toEqual(['absent', 'absent']);

      const { run } = scripted({
        [q('HKLM')]: { code: 0, stdout: 'key' },
        [q('HKLM', true)]: { code: 1, stdout: '' },
        [q('HKCU')]: { code: 1, stdout: '' },
      });
      expect((await readManagedRegistry(run)).map((x) => x.state)).toEqual(['absent', 'absent']);
    });

    it('reports a runner that cannot start, or times out, as unreadable for that hive only', async () => {
      const { run } = scripted({
        [q('HKLM')]: new Error('spawn reg ENOENT'),
        [q('HKCU')]: { code: 1, stdout: '' },
      });
      expect((await readManagedRegistry(run)).map((x) => x.state)).toEqual(['unreadable', 'absent']);

      const hang: CommandRunner = () => new Promise(() => undefined);
      expect((await readManagedRegistry(hang, { timeoutMs: 20 })).map((x) => x.state)).toEqual(['unreadable', 'unreadable']);
    });

    it('reports unparseable output (no Settings line, wrong type, bad JSON, non-object) as unreadable', async () => {
      const cases = [
        'garbage',
        '    Settings    REG_DWORD    0x1',
        '    Settings    REG_SZ    {not json',
        '    Settings    REG_SZ    [1,2]',
      ];
      for (const out of cases) {
        const { run } = scripted({
          [q('HKLM')]: { code: 0, stdout: 'k' },
          [q('HKLM', true)]: { code: 0, stdout: out },
          [q('HKCU')]: { code: 1, stdout: '' },
        });
        expect((await readManagedRegistry(run))[0].state).toBe('unreadable');
      }
    });

    it('reports a non-zero exit with output on the key query as unreadable', async () => {
      const { run } = scripted({ [q('HKLM')]: { code: 5, stdout: 'partial' }, [q('HKCU')]: { code: 1, stdout: '' } });
      expect((await readManagedRegistry(run))[0].state).toBe('unreadable');
    });
  });
});
