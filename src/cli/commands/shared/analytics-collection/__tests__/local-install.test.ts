/**
 * The local mode's install plan through `runInstall`, on a home of its own with stand-in daemon processes: the
 * settings, the daemon and the clients found on the machine, each undone when the install fails after it.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InstallDeps } from '../../../analytics/sync/install.js';
import type { RegisterResult, Scheduler } from '../../../analytics/sync/scheduler/index.js';
import type { SyncSettings } from '../../../analytics/sync/types.js';
import type { InstallPlan } from '../types.js';
import { isPidAlive, setUpHome, spawnedArgs, stateFile, tearDownHome } from './stand.js';

vi.mock('@/utils/processes.js', async (importOriginal) => {
  const { isPidAlive: alive, standInSpawn } = await import('./stand.js');
  return {
    ...(await importOriginal<typeof import('@/utils/processes.js')>()),
    spawnDetached: vi.fn(standInSpawn),
    // The start-time comparison runs `ps`: a live pid is the daemon.
    isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => alive(pid)),
    // PATH holds the stand's `~/.local/bin` alone: Windows finds Claude Code nowhere but on PATH.
    getCommandPath: vi.fn(async (command: string) => {
      const path = join(process.env.HOME ?? '', '.local', 'bin', command);
      return existsSync(path) ? path : null;
    }),
  };
});
vi.mock('@/utils/cli-updater.js', async (importOriginal) => {
  const { OWN_VERSION } = await import('./stand.js');
  return {
    ...(await importOriginal<typeof import('@/utils/cli-updater.js')>()),
    getCurrentCliVersion: vi.fn(async () => OWN_VERSION),
  };
});
vi.mock('@/providers/plugins/sso/sso.auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/sso.auth.js')>()),
  CodeMieSSO: vi.fn(),
}));

const WEBHOOK = 'https://hooks.example.invalid/abc?sig=FAKE';
const SETTINGS: SyncSettings = { webhookUrl: WEBHOOK, format: 'json', includeExternal: 'never', at: '03:00' };

let home: string;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  home = setUpHome();
  vi.resetModules();
  vi.clearAllMocks();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  log.mockRestore();
  vi.restoreAllMocks();
  await tearDownHome(home);
});

const touch = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
};
const claudeCodeInstalled = (): void => touch(join(home, '.local', 'bin', 'claude'));
const copilotCliInstalled = (): void => touch(join(home, 'no-copilot'));
async function vsCodeInstalled(settings?: Record<string, unknown>): Promise<void> {
  const { getVsCodeProductDir } = await import('../../../proxy/connectors/vscode.js');
  const user = join(getVsCodeProductDir(false), 'User');
  mkdirSync(user, { recursive: true });
  if (settings) writeFileSync(join(user, 'settings.json'), JSON.stringify(settings));
}
const claudeSettingsPath = (): string => join(home, '.claude', 'settings.json');
const readClaudeSettings = (): Record<string, any> => JSON.parse(readFileSync(claudeSettingsPath(), 'utf-8'));
const settingsPath = (): string => join(home, 'analytics-sync.json');

async function localPlan(): Promise<InstallPlan> {
  return (await import('../local-install.js')).localInstallPlan;
}

/** The plan `sync install` runs on this home: the one `resolveInstallCollection` picks for the settings found. */
async function resolvedPlan(): Promise<InstallPlan> {
  const { loadSyncSettings } = await import('../../../analytics/sync/config-store.js');
  const { resolveInstallCollection } = await import('../resolve.js');
  const previous = await loadSyncSettings().catch(() => null);
  return (await resolveInstallCollection(previous)).collection.install;
}

const NOT_TURNED_ON =
  '  Local mode:       not turned on — no supported client could be set up (Claude Code, Copilot CLI, Copilot Chat); the JSON report is delivered';
const NO_CLIENT_FAILURE = 'No supported client could be set up (Claude Code, Copilot CLI, Copilot Chat).';

function scheduler(overrides: Partial<Scheduler> = {}): Scheduler {
  return {
    preflight: vi.fn(async () => {}),
    register: vi.fn(async (): Promise<RegisterResult> => ({})),
    unregister: vi.fn(async () => false),
    query: vi.fn(async () => 'disabled' as const),
    exists: vi.fn(async () => 'absent' as const),
    ...overrides,
  };
}

/** `runInstall` with the real settings store and `plan`; the OS job, the identity and the prompts are stand-ins. */
async function install(plan: InstallPlan, job: Scheduler = scheduler(), extra: Partial<InstallDeps> = {}): Promise<{ code: number; printed: string[] }> {
  const store = await import('../../../analytics/sync/config-store.js');
  const { runInstall } = await import('../../../analytics/sync/install.js');
  const printed: string[] = [];
  const deps: InstallDeps = {
    plan,
    schedulerFor: () => job,
    writeSettings: (settings) => store.writeSyncSettings(settings),
    deleteSettings: () => store.deleteSyncSettings(),
    readSettingsRaw: () => store.readSyncSettingsRaw(),
    restoreSettingsRaw: (raw) => store.restoreSyncSettingsRaw(raw),
    resolveIdentity: async () => 'dev@example.com',
    isTTY: false,
    promptEmail: async () => 'dev@example.com',
    promptTaskName: async () => '',
    confirmOverwrite: async () => false,
    saveUserEmail: async () => {},
    collectorDirExists: () => false,
    resolveJobCommand: async () => ({ node: '/usr/bin/node', entry: '/opt/codemie/bin/codemie.js', args: ['analytics', 'sync', 'run', '--scheduled'] }),
    testGitPush: async () => {},
    removeWorkingCopy: async () => {},
    print: (line) => printed.push(line),
    ...extra,
  };
  return { code: await runInstall({ webhook: WEBHOOK }, deps), printed };
}

describe('localInstallPlan', () => {
  it('names its steps in order: settings, daemon, then the three clients', async () => {
    expect((await localPlan()).steps(SETTINGS).map((step) => step.name))
      .toEqual(['settings', 'daemon', 'claude-code', 'copilot-cli', 'copilot-chat']);
  });

  it('with only Claude Code found: the local daemon, its hooks with no status text, the Copilot writers not called', async () => {
    claudeCodeInstalled();
    const plan = await localPlan();
    const { CodeMieSSO } = await import('@/providers/plugins/sso/sso.auth.js');
    // The provider registry builds its SSO clients when it loads; no sign-in runs after that.
    vi.mocked(CodeMieSSO).mockClear();
    const outcomes: unknown[] = [];
    for (const step of plan.steps(SETTINGS)) outcomes.push(await step.apply());

    expect(outcomes).toEqual([
      { name: 'settings', state: 'done' },
      { name: 'daemon', state: 'done' },
      { name: 'claude-code', state: 'done' },
      { name: 'copilot-cli', state: 'absent' },
      { name: 'copilot-chat', state: 'absent' },
    ]);
    expect(await spawnedArgs()).toEqual([['--mode', 'local', '--gateway-key', 'codemie-proxy', '--state-file', stateFile(home), '--port', '4001']]);
    const claude = readClaudeSettings();
    expect(claude.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4001/v1/analytics/otlp');
    expect(JSON.stringify(claude.hooks.UserPromptSubmit)).not.toContain('statusMessage');
    expect(existsSync(join(home, '.copilot', 'hooks'))).toBe(false);
    expect(existsSync(join(home, '.codemie', 'copilot-connectors.json'))).toBe(false);
    expect(CodeMieSSO).not.toHaveBeenCalled();
  });

  it('the settings step writes the settings of this install with local: true, as the loader reads them back', async () => {
    const [settingsStep] = (await localPlan()).steps({ ...SETTINGS, includeExternal: 'always', lookbackDays: 30 });
    await settingsStep.apply();
    const { loadSyncSettings } = await import('../../../analytics/sync/config-store.js');

    expect(await loadSyncSettings()).toEqual({ ...SETTINGS, includeExternal: 'always', lookbackDays: 30, local: true });
  });

  it('the settings step creates the analytics folder when it is absent, and leaves one that holds sessions', async () => {
    const folder = join(home, 'analytics', 'sessions');
    const [settingsStep] = (await localPlan()).steps(SETTINGS);
    await settingsStep.apply();
    expect(existsSync(folder)).toBe(true);
    // Windows keeps no owner-only mode bits.
    if (process.platform !== 'win32') expect(statSync(folder).mode & 0o777).toBe(0o700);

    writeFileSync(join(folder, 's1.hooks.jsonl'), '{}\n');
    await settingsStep.apply();
    expect(readFileSync(join(folder, 's1.hooks.jsonl'), 'utf-8')).toBe('{}\n');
  });

  it('an analytics folder that cannot be made fails the settings step, and no settings are written', async () => {
    touch(join(home, 'analytics'));
    const [settingsStep] = (await localPlan()).steps(SETTINGS);

    await expect(settingsStep.apply()).rejects.toThrow();
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('keeps each client\'s project list', async () => {
    claudeCodeInstalled();
    copilotCliInstalled();
    touch(claudeSettingsPath());
    writeFileSync(claudeSettingsPath(), JSON.stringify({ env: { CODEMIE_ANALYTICS_PROJECT_FILTER: JSON.stringify(['/work/a']) } }));
    const { writeCopilotConnectorScope, readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotConnectorScope('copilot-cli-otlp', { enabled: true, scope: 'project', paths: ['/work/b'] });

    const { code } = await install(await localPlan());

    expect(code).toBe(0);
    expect(JSON.parse(readClaudeSettings().env.CODEMIE_ANALYTICS_PROJECT_FILTER)).toEqual(['/work/a']);
    expect(await readCopilotConnectorScope('copilot-cli-otlp')).toEqual({ kind: 'ok', value: { enabled: true, scope: 'project', paths: ['/work/b'] } });
  });

  it('a local proxy that died before the Claude Code step fails the install, and the steps are undone', async () => {
    claudeCodeInstalled();
    const local = await localPlan();
    const plan: InstallPlan = {
      ...local,
      steps: (settings) => local.steps(settings).map((step) => (step.name !== 'daemon' ? step : {
        ...step,
        apply: async () => {
          const outcome = await step.apply();
          const { stopDaemon } = await import('../../../proxy/daemon-manager.js');
          await stopDaemon();
          return outcome;
        },
      })),
    };

    const { code, printed } = await install(plan);

    expect(code).toBe(1);
    expect(printed).toContain('Install failed: The local proxy stopped during the install.');
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(claudeSettingsPath())).toBe(false);
  });

  /** The local plan whose daemon step kills the daemon once it is up, leaving its state file behind. */
  async function daemonDiesAfterItsStep(): Promise<InstallPlan> {
    const local = await localPlan();
    return {
      ...local,
      steps: (settings) => local.steps(settings).map((step) => (step.name !== 'daemon' ? step : {
        ...step,
        apply: async () => {
          const outcome = await step.apply();
          const { pid } = JSON.parse(readFileSync(stateFile(home), 'utf-8')) as { pid: number };
          process.kill(pid, 'SIGKILL');
          for (const deadline = Date.now() + 10_000; isPidAlive(pid);) {
            if (Date.now() > deadline) throw new Error(`the stand-in daemon ${pid} did not exit`);
            await new Promise((resolve) => setImmediate(resolve));
          }
          return outcome;
        },
      })),
    };
  }

  it('a state file left by a local proxy that died before the Claude Code step fails the install, and the steps are undone', async () => {
    claudeCodeInstalled();

    const { code, printed } = await install(await daemonDiesAfterItsStep());

    expect(code).toBe(1);
    expect(printed).toContain('Install failed: The local proxy stopped during the install.');
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(claudeSettingsPath())).toBe(false);
    expect(existsSync(join(home, 'analytics'))).toBe(false);
  });

  it('a local proxy that died before the Claude Code step leaves the user\'s own telemetry env and the settings backup', async () => {
    claudeCodeInstalled();
    touch(claudeSettingsPath());
    const own = JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp' } }, null, 2);
    writeFileSync(claudeSettingsPath(), own);
    const backup = join(home, '.claude', 'settings.json.codemie-backup');
    writeFileSync(backup, '{}');

    const { code, printed } = await install(await daemonDiesAfterItsStep());

    expect(code).toBe(1);
    expect(printed).toContain('Install failed: The local proxy stopped during the install.');
    expect(readFileSync(claudeSettingsPath(), 'utf-8')).toBe(own);
    expect(existsSync(backup)).toBe(true);
  });

  it('the daemon undo restores the settings and stops the daemon it started, even when the restore throws', async () => {
    const [settingsStep, daemonStep] = (await localPlan()).steps(SETTINGS);
    await settingsStep.apply();
    await daemonStep.apply();
    const { pid } = JSON.parse(readFileSync(stateFile(home), 'utf-8')) as { pid: number };
    // A settings path that is a directory: the restore (a delete, there being no settings before) fails.
    unlinkSync(settingsPath());
    mkdirSync(join(settingsPath(), 'held'), { recursive: true });

    await expect(daemonStep.undo()).rejects.toThrow();
    expect(isPidAlive(pid)).toBe(false);

    rmSync(settingsPath(), { recursive: true });
    writeFileSync(settingsPath(), '{}');
    await settingsStep.undo();
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('Copilot Chat refusing is skipped with its reason, and the install stands', async () => {
    copilotCliInstalled();
    await vsCodeInstalled({ 'chat.useHooks': false });

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    expect(printed).toContain(`  Mode:             local — delivers the OTLP files of ${join(home, 'analytics', 'sessions')} beside the JSON report`);
    expect(printed.join('\n')).toContain('Skipped:          Copilot Chat — VS Code setting "chat.useHooks" is disabled');
    expect(printed.join('\n')).toContain('Clients set up:   Claude Code, Copilot CLI');
  });

  it('Copilot Chat skipped for a VS Code settings write that fails leaves no hook file', async () => {
    copilotCliInstalled();
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs/promises')>();
      return {
        ...actual,
        rename: async (from: string, to: string) => {
          if (to.endsWith(join('User', 'settings.json'))) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          return actual.rename(from, to);
        },
      };
    });
    try {
      await vsCodeInstalled({});
      const { code, printed } = await install(await localPlan());

      expect(code).toBe(0);
      expect(printed.join('\n')).toContain('Skipped:          Copilot Chat — Failed to update VS Code settings at ');
      expect(existsSync(join(home, 'hooks', 'copilot-chat-hooks.json'))).toBe(false);
    } finally {
      vi.doUnmock('fs/promises');
    }
  });

  it('the Claude Code env conflict is skipped, its note naming the keys and no --overwrite', async () => {
    claudeCodeInstalled();
    copilotCliInstalled();
    touch(claudeSettingsPath());
    writeFileSync(claudeSettingsPath(), JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }));

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    const skipped = printed.find((line) => line.includes('Skipped:'));
    expect(skipped).toBe('  Skipped:          Claude Code — its settings already set OTEL_LOGS_EXPORTER');
    expect(printed.join('\n')).not.toContain('--overwrite');
    expect(printed.join('\n')).not.toContain('proxy start');
  });

  it.each([
    [{ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://logs.example.invalid/v1/logs' }, 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'],
    [{ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.example.invalid/v1/metrics' }, 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
    [{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.invalid/v1/traces' }, 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    [
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.invalid/v1/traces', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://logs.example.invalid/v1/logs' },
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    ],
  ])('a per-signal endpoint of the user\'s %j skips Claude Code, its settings byte for byte; another client set up', async (env, keys) => {
    claudeCodeInstalled();
    copilotCliInstalled();
    touch(claudeSettingsPath());
    const before = JSON.stringify({ env }, null, 2);
    writeFileSync(claudeSettingsPath(), before);

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    expect(printed).toContain(`  Skipped:          Claude Code — its settings already set ${keys}`);
    expect(readFileSync(claudeSettingsPath(), 'utf-8')).toBe(before);
    expect(printed).toContain('  Clients set up:   Copilot CLI');
    expect(JSON.parse(readFileSync(settingsPath(), 'utf-8'))).toMatchObject({ local: true });
  });

  it.each([
    ['no client found', () => undefined],
    ['the one client found refusing', () => {
      claudeCodeInstalled();
      touch(claudeSettingsPath());
      writeFileSync(claudeSettingsPath(), JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }));
    }],
  ])('%s on a machine not local before goes on without the local mode: the job registered, no daemon, no folder', async (name, arrange) => {
    arrange();
    const job = scheduler();

    const { code, printed } = await install(await resolvedPlan(), job);

    expect(code).toBe(0);
    expect(printed).toContain(NOT_TURNED_ON);
    if (name === 'the one client found refusing') {
      expect(printed).toContain('  Skipped:          Claude Code — its settings already set OTEL_LOGS_EXPORTER');
    }
    expect(job.register).toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('local');
    expect(saved).not.toHaveProperty('localJob');
    expect(existsSync(stateFile(home))).toBe(false);
    expect(existsSync(join(home, 'analytics'))).toBe(false);
  });

  it('on a machine not local before, the conclusion for no client stands down with the local mode\'s undo-failure text', async () => {
    expect((await resolvedPlan()).conclude([]).standDown).toEqual({
      undoFailed: 'The local mode was not turned on, and a step of the attempt could not be undone.',
    });
  });

  it('a machine already local where no client is found now fails, registers nothing and keeps its settings byte for byte', async () => {
    claudeCodeInstalled();
    expect((await install(await resolvedPlan())).code).toBe(0);
    unlinkSync(join(home, '.local', 'bin', 'claude'));
    const before = readFileSync(settingsPath(), 'utf-8');
    const hooksBefore = readClaudeSettings().hooks;
    expect(JSON.stringify(hooksBefore.UserPromptSubmit)).toContain('codemie');
    const stateBefore = readFileSync(stateFile(home), 'utf-8');
    const job = scheduler();

    const { code, printed } = await install(await resolvedPlan(), job);

    expect(code).toBe(1);
    expect(printed).toContain(NO_CLIENT_FAILURE);
    expect(job.register).not.toHaveBeenCalled();
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(before);
    expect(readClaudeSettings().hooks).toEqual(hooksBefore);
    expect(readFileSync(stateFile(home), 'utf-8')).toBe(stateBefore);
  });

  it('a machine with a job from before the local mode and no client: the job registered with the new time, no local', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ ...SETTINGS, at: '02:00' }));
    const job = scheduler();

    const { code } = await install(await resolvedPlan(), job);

    expect(code).toBe(0);
    expect(job.register).toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(saved.at).toBe('03:00');
    expect(saved).not.toHaveProperty('local');
  });

  it('a sync settings file that does not load, no profile and no client fails and keeps the file byte for byte', async () => {
    writeFileSync(settingsPath(), '{ not json');
    const job = scheduler();

    const { code, printed } = await install(await resolvedPlan(), job);

    expect(code).toBe(1);
    expect(printed).toContain(NO_CLIENT_FAILURE);
    expect(job.register).not.toHaveBeenCalled();
    expect(readFileSync(settingsPath(), 'utf-8')).toBe('{ not json');
  });

  it('a sync settings file that does not load, no profile and a supported client: the file replaced with local: true', async () => {
    writeFileSync(settingsPath(), '{ not json');
    claudeCodeInstalled();

    const { code } = await install(await resolvedPlan());

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf-8'))).toMatchObject({ local: true });
  });

  it('a sync settings file that cannot be read, no profile and no client fails the install, not the process', async () => {
    mkdirSync(settingsPath());
    const job = scheduler();
    const plan = resolvedPlan();
    await expect(plan).resolves.toBeDefined();

    const { code, printed } = await install(await plan, job);

    expect(code).toBe(1);
    expect(printed.some((line) => line.startsWith('Install failed:'))).toBe(true);
    expect(job.register).not.toHaveBeenCalled();
  });

  it('an undone install leaves analytics/ and a local spool that holds a file, and removes the folder it made', async () => {
    const spooled = join(home, 'analytics', 'spool', 's1', 'hooks.ndjson');
    touch(spooled);

    const { code } = await install(await localPlan());

    expect(code).toBe(1);
    expect(existsSync(spooled)).toBe(true);
    expect(existsSync(join(home, 'analytics', 'sessions'))).toBe(false);
  });

  it('an undone install leaves an empty analytics/ that was there before it, and removes the folder it made', async () => {
    mkdirSync(join(home, 'analytics'));

    const { code } = await install(await localPlan());

    expect(code).toBe(1);
    expect(existsSync(join(home, 'analytics'))).toBe(true);
    expect(existsSync(join(home, 'analytics', 'sessions'))).toBe(false);
  });

  it('an undone install that made analytics/ removes an empty local spool made after it, then analytics/', async () => {
    const local = await localPlan();
    const plan: InstallPlan = {
      ...local,
      steps: (settings) => local.steps(settings).map((step) => (step.name !== 'daemon' ? step : {
        ...step,
        apply: async () => {
          const outcome = await step.apply();
          mkdirSync(join(home, 'analytics', 'spool'));
          return outcome;
        },
      })),
    };

    const { code } = await install(plan);

    expect(code).toBe(1);
    expect(existsSync(join(home, 'analytics'))).toBe(false);
  });

  it('an undone install leaves an analytics folder that was there before it', async () => {
    mkdirSync(join(home, 'analytics', 'sessions'), { recursive: true });

    const { code } = await install(await localPlan());

    expect(code).toBe(1);
    expect(existsSync(join(home, 'analytics', 'sessions'))).toBe(true);
  });

  it('an undone install leaves the folder it made once a session file is in it', async () => {
    const session = join(home, 'analytics', 'sessions', 's1.hooks.jsonl');
    const local = await localPlan();
    const plan: InstallPlan = {
      ...local,
      steps: (settings) => local.steps(settings).map((step) => (step.name !== 'daemon' ? step : {
        ...step,
        apply: async () => {
          const outcome = await step.apply();
          writeFileSync(session, '{}\n');
          return outcome;
        },
      })),
    };

    const { code } = await install(plan);

    expect(code).toBe(1);
    expect(readFileSync(session, 'utf-8')).toBe('{}\n');
  });

  it('a settings write that fails after the folder was made removes that folder', async () => {
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs/promises')>();
      return {
        ...actual,
        rename: async (from: string, to: string) => {
          if (to.endsWith('analytics-sync.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          return actual.rename(from, to);
        },
      };
    });
    try {
      const [settingsStep] = (await localPlan()).steps(SETTINGS);

      await expect(settingsStep.apply()).rejects.toThrow('EACCES');
      expect(existsSync(join(home, 'analytics', 'sessions'))).toBe(false);
      expect(existsSync(settingsPath())).toBe(false);
    } finally {
      vi.doUnmock('fs/promises');
    }
  });

  it('a settings write that fails, with a folder removal that fails too, rejects with the settings write\'s error', async () => {
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs/promises')>();
      return {
        ...actual,
        rename: async (from: string, to: string) => {
          if (to.endsWith('analytics-sync.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          return actual.rename(from, to);
        },
        rmdir: async () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        },
      };
    });
    try {
      const [settingsStep] = (await localPlan()).steps(SETTINGS);

      await expect(settingsStep.apply()).rejects.toThrow('EACCES: permission denied');
      expect(existsSync(join(home, 'analytics', 'sessions'))).toBe(true);
    } finally {
      vi.doUnmock('fs/promises');
    }
  });

  it('a daemon lock another process holds fails the install', async () => {
    claudeCodeInstalled();
    writeFileSync(join(home, 'proxy-daemon.lock'), JSON.stringify({ pid: process.pid }));
    const realNow = Date.now.bind(Date);
    let reads = 0;
    // Each clock read is a second later, so the lock's wait budget runs out in a few polls.
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 1000 * ++reads);

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(1);
    expect(printed).toContain('Install failed: Another codemie process is starting or stopping the proxy; try again.');
    expect(await spawnedArgs()).toEqual([]);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('a re-install over the local mode that fails leaves the hooks and the daemon found before', async () => {
    claudeCodeInstalled();
    copilotCliInstalled();
    expect((await install(await localPlan())).code).toBe(0);
    const before = JSON.parse(readFileSync(stateFile(home), 'utf-8')) as { pid: number };
    const failing = scheduler({ register: vi.fn(async () => { throw new Error('launchctl bootstrap failed: boom'); }) });

    const { code } = await install(await localPlan(), failing);

    expect(code).toBe(1);
    expect(isPidAlive(before.pid)).toBe(true);
    const { hasClaudeCodeOtlpHooks } = await import('../../../proxy/connectors/claude-code-otlp.js');
    const { readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    expect(await hasClaudeCodeOtlpHooks()).toBe(true);
    expect(await readCopilotConnectorScope('copilot-cli-otlp')).toEqual({ kind: 'ok', value: { enabled: true, scope: 'user' } });
  });

  it('an install that fails over a leftover Copilot CLI hook file with no scope record undoes what it wrote', async () => {
    copilotCliInstalled();
    const { getCopilotCliHookFilePath, writeCopilotCliOtlpConfig } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    const { getCopilotConnectorsConfigPath, readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotCliOtlpConfig({ keepProjectList: true });
    unlinkSync(getCopilotConnectorsConfigPath());
    const failing = scheduler({ register: vi.fn(async () => { throw new Error('launchctl bootstrap failed: boom'); }) });

    const { code } = await install(await localPlan(), failing);

    expect(code).toBe(1);
    expect(await readCopilotConnectorScope('copilot-cli-otlp')).toEqual({ kind: 'ok', value: { enabled: false } });
    expect(existsSync(getCopilotCliHookFilePath())).toBe(false);
  });

  /** Copilot CLI's scope record cannot be written: a directory stands where its writer puts the temp file. */
  async function copilotScopeUnwritable(): Promise<void> {
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    mkdirSync(`${getCopilotConnectorsConfigPath()}.${process.pid}.tmp`, { recursive: true });
  }

  it('a Copilot CLI writer that fails after its hook file, on a client not set up before, is skipped and takes the hook file back', async () => {
    claudeCodeInstalled();
    copilotCliInstalled();
    await copilotScopeUnwritable();
    const { getCopilotCliHookFilePath } = await import('../../../proxy/connectors/copilot-cli-otlp.js');

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    expect(printed).toContain('  Skipped:          Copilot CLI — its files could not be written (EISDIR)');
    expect(printed).toContain('  Clients set up:   Claude Code');
    expect(existsSync(getCopilotCliHookFilePath())).toBe(false);
  });

  it('a Claude Code settings file that does not parse skips the client with the reader\'s reason, the file untouched', async () => {
    claudeCodeInstalled();
    copilotCliInstalled();
    touch(claudeSettingsPath());
    writeFileSync(claudeSettingsPath(), '{ not json');

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    expect(printed).toContain(`  Skipped:          Claude Code — Claude Code settings at ${claudeSettingsPath()} is not valid JSON and was not changed.`);
    expect(printed).toContain('  Clients set up:   Copilot CLI');
    expect(readFileSync(claudeSettingsPath(), 'utf-8')).toBe('{ not json');
  });

  it('a writer failing with an error that has a code and no errno fails the install', async () => {
    copilotCliInstalled();
    vi.doMock('../../../proxy/connectors/copilot-cli-otlp.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../proxy/connectors/copilot-cli-otlp.js')>()),
      writeCopilotCliOtlpConfig: async () => {
        throw Object.assign(new Error('not a system error'), { code: 'ERR_INVALID_STATE' });
      },
    }));

    try {
      const { code, printed } = await install(await localPlan());

      expect(code).toBe(1);
      expect(printed.join('\n')).not.toContain('Skipped:');
    } finally {
      vi.doUnmock('../../../proxy/connectors/copilot-cli-otlp.js');
    }
  });

  it('a Copilot CLI connectors config that does not parse skips the client and takes its hook file back', async () => {
    claudeCodeInstalled();
    copilotCliInstalled();
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    touch(getCopilotConnectorsConfigPath());
    writeFileSync(getCopilotConnectorsConfigPath(), '{ not json');
    const { getCopilotCliHookFilePath } = await import('../../../proxy/connectors/copilot-cli-otlp.js');

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    expect(printed.join('\n')).toContain('Skipped:          Copilot CLI — Copilot connector config is corrupt and was not changed');
    expect(printed.join('\n')).toContain('Clients set up:   Claude Code');
    expect(existsSync(getCopilotCliHookFilePath())).toBe(false);
  });

  it('a Copilot CLI set up before whose connectors config no longer parses is skipped and keeps its hook file', async () => {
    claudeCodeInstalled();
    copilotCliInstalled();
    expect((await install(await localPlan())).code).toBe(0);
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    writeFileSync(getCopilotConnectorsConfigPath(), '{ not json');
    const { getCopilotCliHookFilePath } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    expect(existsSync(getCopilotCliHookFilePath())).toBe(true);

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    expect(printed.join('\n')).toContain('Skipped:          Copilot CLI — Copilot connector config is corrupt and was not changed');
    expect(existsSync(getCopilotCliHookFilePath())).toBe(true);
  });

  it('a Copilot CLI writer that fails after its hook file, on a client set up before, is skipped and leaves its entries', async () => {
    copilotCliInstalled();
    expect((await install(await localPlan())).code).toBe(0);
    claudeCodeInstalled();
    await copilotScopeUnwritable();
    const { getCopilotCliHookFilePath } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    const { readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');

    const { code, printed } = await install(await localPlan());

    expect(code).toBe(0);
    expect(printed).toContain('  Skipped:          Copilot CLI — its files could not be written (EISDIR)');
    expect(printed).toContain('  Clients set up:   Claude Code');
    expect(existsSync(getCopilotCliHookFilePath())).toBe(true);
    expect(await readCopilotConnectorScope('copilot-cli-otlp')).toEqual({ kind: 'ok', value: { enabled: true, scope: 'user' } });
  });

  it('an install that fails over a leftover Copilot Chat hook key with no scope record undoes what it wrote', async () => {
    await vsCodeInstalled();
    const chat = await import('../../../proxy/connectors/copilot-chat-otlp.js');
    const { getCopilotConnectorsConfigPath, readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    await chat.writeCopilotChatOtlpConfig({ keepProjectList: true });
    unlinkSync(getCopilotConnectorsConfigPath());
    expect(existsSync(chat.getCopilotChatHookFilePath())).toBe(true);
    const failing = scheduler({ register: vi.fn(async () => { throw new Error('launchctl bootstrap failed: boom'); }) });

    const { code } = await install(await localPlan(), failing);

    expect(code).toBe(1);
    expect(await readCopilotConnectorScope('copilot-chat-otlp')).toEqual({ kind: 'ok', value: { enabled: false } });
    const vsCodeSettings = JSON.parse(readFileSync(chat.getVsCodeChatSettingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys((vsCodeSettings['chat.hookFilesLocations'] ?? {}) as Record<string, boolean>))
      .not.toContain(chat.getCopilotChatHookFileLocationKey());
    expect(existsSync(chat.getCopilotChatHookFilePath())).toBe(false);
  });

  it('install twice: one daemon, the same hooks', async () => {
    claudeCodeInstalled();
    expect((await install(await localPlan())).code).toBe(0);
    const hooks = readClaudeSettings().hooks;
    expect((await install(await localPlan())).code).toBe(0);

    expect(await spawnedArgs()).toHaveLength(1);
    expect(readClaudeSettings().hooks).toEqual(hooks);
    const { loadSyncSettings } = await import('../../../analytics/sync/config-store.js');
    expect(await loadSyncSettings()).toMatchObject({ local: true, localJob: { node: '/usr/bin/node', entry: '/opt/codemie/bin/codemie.js' } });
  });

  it('on a first install, a hook between the settings step and the job replace gets the local collection', async () => {
    claudeCodeInstalled();
    const store = await import('../../../analytics/sync/config-store.js');
    const { resolveCollection } = await import('../resolve.js');
    const { LocalExportSource } = await import('../local.js');
    const seen: unknown[] = [];

    const { code } = await install(await localPlan(), scheduler(), {
      writeSettings: async (settings) => {
        seen.push((await resolveCollection()).exportSource());
        await store.writeSyncSettings(settings);
      },
    });

    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(LocalExportSource);
  });

  it('a first install undone after a hook started the local daemon in its window stops that daemon', async () => {
    claudeCodeInstalled();
    const { resolveCollection } = await import('../resolve.js');
    const local = await localPlan();
    let hookDaemon: number | undefined;
    const plan: InstallPlan = {
      ...local,
      steps: (settings) => local.steps(settings).map((step) => (step.name !== 'settings' ? step : {
        ...step,
        apply: async () => {
          const outcome = await step.apply();
          await (await resolveCollection()).launcher('claude-code-otlp', 'SessionStart');
          hookDaemon = (JSON.parse(readFileSync(stateFile(home), 'utf-8')) as { pid: number }).pid;
          return outcome;
        },
      })),
    };
    const failing = scheduler({ register: vi.fn(async () => { throw new Error('launchctl bootstrap failed: boom'); }) });

    const { code } = await install(plan, failing);

    expect(code).toBe(1);
    expect(await spawnedArgs()).toHaveLength(1);
    expect(isPidAlive(hookDaemon as number)).toBe(false);
  });
});
