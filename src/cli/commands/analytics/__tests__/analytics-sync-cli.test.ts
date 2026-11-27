/**
 * CLI wiring tests for `codemie analytics sync` (EPMCDME-16488 Task 7).
 *
 * `sync` is now a pure group (no action, no `--from/--to/--last` of its own) with four
 * subcommands — `install`, `status`, `run`, `uninstall` — each a thin dynamic-import action
 * over its runner (`sync/install.ts`, `sync/status.ts`, `sync/run-sync.ts`,
 * `sync/uninstall.ts`), setting `process.exitCode` from the runner's returned number. The
 * old `sync config` surface (`createSyncConfigCommand`/`runSyncConfig`/`SyncConfigCliOptions`)
 * was removed in Task 1; this file covers the new group/subcommand wiring instead.
 *
 * Covers:
 *  - the `sync` group's and each subcommand's `--help` description (story AC, "Command surface").
 *  - `sync install` forwards its own options (including `--include-external`, which also
 *    exists on `analytics` and on `otel`'s --user) to `runInstall`, unambiguously.
 *  - `sync run --scheduled` is accepted and hidden from help.
 *  - `sync status` / `sync uninstall` reach their runners.
 *  - `sync config` and `--from`/`--to`/`--last` directly on `sync` are unknown (removed surface).
 *  - the parent's boolean `--include-external` and `analytics otel --file f --from <date>`
 *    still work (regression for `.enablePositionalOptions()`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runBootstrapMock = vi.fn();
const createRealBootstrapDepsMock = vi.fn();
vi.mock('../sync/bootstrap/run-bootstrap.js', () => ({
  runBootstrap: (...a: unknown[]) => runBootstrapMock(...a),
  createRealBootstrapDeps: (...a: unknown[]) => createRealBootstrapDepsMock(...a),
}));

const runInstallMock = vi.fn();
const createRealInstallDepsMock = vi.fn();
vi.mock('../sync/install.js', () => ({
  runInstall: (...a: unknown[]) => runInstallMock(...a),
  createRealInstallDeps: (...a: unknown[]) => createRealInstallDepsMock(...a),
}));

const runStatusMock = vi.fn();
const createRealStatusDepsMock = vi.fn();
vi.mock('../sync/status.js', () => ({
  runStatus: (...a: unknown[]) => runStatusMock(...a),
  createRealStatusDeps: (...a: unknown[]) => createRealStatusDepsMock(...a),
}));

const runSyncMock = vi.fn();
const realSyncDepsMock = vi.fn();
vi.mock('../sync/run-sync.js', () => ({
  runSync: (...a: unknown[]) => runSyncMock(...a),
  realSyncDeps: (...a: unknown[]) => realSyncDepsMock(...a),
}));

const runUninstallMock = vi.fn();
const createRealUninstallDepsMock = vi.fn();
vi.mock('../sync/uninstall.js', () => ({
  runUninstall: (...a: unknown[]) => runUninstallMock(...a),
  createRealUninstallDeps: (...a: unknown[]) => createRealUninstallDepsMock(...a),
}));

vi.mock('@/utils/processes.js', async (importOriginal) => {
  const { isPidAlive } = await import('../../shared/analytics-collection/__tests__/stand.js');
  return {
    ...(await importOriginal<typeof import('@/utils/processes.js')>()),
    // The start-time comparison runs `ps`: a live pid is the daemon.
    isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => isPidAlive(pid)),
    // No `codemie` on PATH: the hook commands name this build.
    getCommandPath: vi.fn(async () => null),
  };
});

const loadAnalyticsMock = vi.fn();
vi.mock('../analytics-core.js', () => ({
  loadAnalytics: (...a: unknown[]) => loadAnalyticsMock(...a),
}));

async function buildCommand(): Promise<Command> {
  const { createAnalyticsCommand } = await import('../index.js');
  return createAnalyticsCommand();
}

async function parse(argv: string[]): Promise<Command> {
  const command = await buildCommand();
  // Swallow commander's own process.exit on parse errors (e.g. unknown option) so a
  // mis-wired test fails on an assertion instead of killing the test process.
  command.exitOverride();
  await command.parseAsync(argv, { from: 'user' });
  return command;
}

function findSync(command: Command): Command {
  const sync = command.commands.find((c) => c.name() === 'sync');
  if (!sync) {
    throw new Error('sync command not registered');
  }
  return sync;
}

describe('analytics sync CLI wiring — command surface', () => {
  it('the sync group names one-way delivery to the webhook on a daily schedule', async () => {
    const sync = findSync(await buildCommand());
    const description = sync.description();
    expect(description).toMatch(/one way/i);
    expect(description).toMatch(/webhook/i);
    expect(description).toMatch(/daily/i);
  });

  it('lists bootstrap, install, status, run, uninstall, each with a "who runs it / what it changes" description', async () => {
    const sync = findSync(await buildCommand());
    const names = sync.commands.map((c) => c.name());
    expect(names).toEqual(['bootstrap', 'install', 'status', 'run', 'uninstall']);

    const bootstrap = sync.commands.find((c) => c.name() === 'bootstrap')!;
    expect(bootstrap.description()).toBe(
      'Lead: choose where your team delivers reports (Teams webhook, git repository, or both), set it up, then print the install command for your team (installs nothing on this machine)'
    );

    const install = sync.commands.find((c) => c.name() === 'install')!;
    expect(install.description()).toBe(
      'Developer: register the daily delivery job on this machine; on a machine with no CLI profile also turn on the local analytics mode (the local proxy and the hooks of Claude Code, Copilot CLI and Copilot Chat)'
    );

    const run = sync.commands.find((c) => c.name() === 'run')!;
    expect(run.description()).toBe(
      'Developer or the daily scheduled job: send the pending analytics report (in the local analytics mode, the OTLP files and the report) to the configured webhook and/or team git repository now'
    );

    for (const name of ['status', 'run', 'uninstall']) {
      const sub = sync.commands.find((c) => c.name() === name)!;
      expect(sub.description().length).toBeGreaterThan(0);
    }
  });

  it('"sync bootstrap --help" lists the git options next to --webhook', async () => {
    const sync = findSync(await buildCommand());
    const bootstrap = sync.commands.find((c) => c.name() === 'bootstrap')!;
    const help = bootstrap.helpInformation();

    expect(help).toContain('--webhook <url>');
    expect(help).toContain('--git-repo <url>');
    expect(help).toContain('--git-branch <name>');
    expect(help).toContain('--git-path <dir>');
  });

  it('"sync install --help" lists the git options and --format next to --webhook', async () => {
    const sync = findSync(await buildCommand());
    const install = sync.commands.find((c) => c.name() === 'install')!;
    const help = install.helpInformation();

    expect(help).toContain('--webhook <url>');
    expect(help).toContain('--git-repo <url>');
    expect(help).toContain('--git-branch <name>');
    expect(help).toContain('--git-path <dir>');
    expect(help).toContain('--format <json>');
  });

  it('--help lists every subcommand and hides --scheduled', async () => {
    const sync = findSync(await buildCommand());
    const help = sync.helpInformation();
    expect(help).toContain('bootstrap');
    expect(help).toContain('install');
    expect(help).toContain('status');
    expect(help).toContain('run');
    expect(help).toContain('uninstall');
    expect(help).not.toContain('--scheduled');
  });

  it('rejects the removed "sync config" subcommand', async () => {
    await expect(parse(['sync', 'config'])).rejects.toThrow();
  });

  it.each([['--from', '2026-10-01'], ['--to', '2026-10-01'], ['--last', '7d']])(
    'rejects %s directly on "sync" (backfill flags removed)',
    async (flag, value) => {
      await expect(parse(['sync', flag, value])).rejects.toThrow();
    }
  );
});

describe('analytics sync CLI wiring — subcommand dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRealBootstrapDepsMock.mockReturnValue({ fake: 'bootstrap-deps' });
    createRealInstallDepsMock.mockReturnValue({ fake: 'install-deps' });
    createRealStatusDepsMock.mockReturnValue({ fake: 'status-deps' });
    realSyncDepsMock.mockReturnValue({ fake: 'sync-deps' });
    createRealUninstallDepsMock.mockReturnValue({ fake: 'uninstall-deps' });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('"sync bootstrap --webhook <url> --include-external always" reaches runBootstrap with createRealBootstrapDeps(), exitCode from its result', async () => {
    runBootstrapMock.mockResolvedValue(0);
    await parse(['sync', 'bootstrap', '--webhook', 'https://h/x?sig=1', '--include-external', 'always']);

    expect(runBootstrapMock).toHaveBeenCalledTimes(1);
    const [opts, deps] = runBootstrapMock.mock.calls[0];
    expect(opts.webhook).toBe('https://h/x?sig=1');
    expect(opts.includeExternal).toBe('always');
    expect(deps).toEqual({ fake: 'bootstrap-deps' });
    expect(process.exitCode).toBe(0);
  });

  it('"sync bootstrap" forwards --lookback-days too', async () => {
    runBootstrapMock.mockResolvedValue(0);
    await parse(['sync', 'bootstrap', '--webhook', 'https://h/x?sig=1', '--lookback-days', '14']);

    const [opts] = runBootstrapMock.mock.calls[0];
    expect(opts.lookbackDays).toBe('14');
  });

  it('"sync bootstrap" forwards --git-repo, --git-branch and --git-path to runBootstrap', async () => {
    runBootstrapMock.mockResolvedValue(0);
    await parse([
      'sync', 'bootstrap', '--git-repo', 'git@h:o/r.git', '--git-branch', 'main', '--git-path', 'reports'
    ]);

    expect(runBootstrapMock).toHaveBeenCalledTimes(1);
    const [opts] = runBootstrapMock.mock.calls[0];
    expect(opts.gitRepo).toBe('git@h:o/r.git');
    expect(opts.gitBranch).toBe('main');
    expect(opts.gitPath).toBe('reports');
  });

  it('sets a non-zero exitCode when runBootstrap fails', async () => {
    runBootstrapMock.mockResolvedValue(1);
    await parse(['sync', 'bootstrap', '--webhook', 'https://h/x?sig=1']);

    expect(process.exitCode).toBe(1);
  });

  it('"sync install --webhook <url> --include-external windows" reaches runInstall unambiguously', async () => {
    runInstallMock.mockResolvedValue(0);
    await parse(['sync', 'install', '--webhook', 'https://h/x', '--include-external', 'windows']);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    const [opts, deps] = runInstallMock.mock.calls[0];
    expect(opts.webhook).toBe('https://h/x');
    expect(opts.includeExternal).toBe('windows');
    expect(deps).toEqual({ fake: 'install-deps' });
    expect(process.exitCode).toBe(0);
  });

  it('"sync install" forwards --git-repo, --git-branch, --git-path and --format too', async () => {
    runInstallMock.mockResolvedValue(0);
    await parse([
      'sync', 'install',
      '--git-repo', 'https://example.invalid/team/repo.git',
      '--git-branch', 'reports',
      '--git-path', 'analytics',
      '--format', 'json',
    ]);

    const [opts] = runInstallMock.mock.calls[0];
    expect(opts.gitRepo).toBe('https://example.invalid/team/repo.git');
    expect(opts.gitBranch).toBe('reports');
    expect(opts.gitPath).toBe('analytics');
    expect(opts.format).toBe('json');
  });

  it('"sync install" forwards --at and --lookback-days too', async () => {
    runInstallMock.mockResolvedValue(0);
    await parse(['sync', 'install', '--webhook', 'https://h/x', '--at', '04:30', '--lookback-days', '14']);

    const [opts] = runInstallMock.mock.calls[0];
    expect(opts.at).toBe('04:30');
    expect(opts.lookbackDays).toBe('14');
  });

  it('sets a non-zero exitCode when runInstall fails', async () => {
    runInstallMock.mockResolvedValue(1);
    await parse(['sync', 'install', '--webhook', 'https://h/x']);

    expect(process.exitCode).toBe(1);
  });

  it('"sync status" reaches runStatus with createRealStatusDeps(), exitCode from its result', async () => {
    runStatusMock.mockResolvedValue(0);
    await parse(['sync', 'status']);

    expect(runStatusMock).toHaveBeenCalledWith({ fake: 'status-deps' });
    expect(process.exitCode).toBe(0);
  });

  it('"sync run" reaches runSync with realSyncDeps(), exitCode from its result', async () => {
    runSyncMock.mockResolvedValue(0);
    await parse(['sync', 'run']);

    expect(runSyncMock).toHaveBeenCalledWith({ fake: 'sync-deps' });
    expect(process.exitCode).toBe(0);
  });

  it('"sync run --scheduled" is accepted (no "unexpected argument") and still reaches runSync', async () => {
    runSyncMock.mockResolvedValue(0);
    await parse(['sync', 'run', '--scheduled']);

    expect(runSyncMock).toHaveBeenCalledWith({ fake: 'sync-deps' });
    expect(process.exitCode).toBe(0);
  });

  it('sets a non-zero exitCode when runSync fails', async () => {
    runSyncMock.mockResolvedValue(1);
    await parse(['sync', 'run']);

    expect(process.exitCode).toBe(1);
  });

  it('"sync uninstall" reaches runUninstall with createRealUninstallDeps(), exitCode from its result', async () => {
    runUninstallMock.mockResolvedValue(0);
    await parse(['sync', 'uninstall']);

    expect(runUninstallMock).toHaveBeenCalledWith({ fake: 'uninstall-deps' });
    expect(process.exitCode).toBe(0);
  });
});

describe('analytics sync CLI wiring — the collection handed to each runner in the local mode', () => {
  const LOCAL_SETTINGS = {
    webhookUrl: 'https://example.invalid/hook?sig=FAKE',
    format: 'json',
    includeExternal: 'never',
    at: '03:00',
    local: true,
    localJob: { node: '/usr/bin/node', entry: '/opt/codemie/bin/codemie.js' },
  };
  let home: string;

  beforeEach(() => {
    vi.clearAllMocks();
    home = mkdtempSync(join(tmpdir(), 'codemie-sync-cli-local-'));
    for (const name of ['HOME', 'USERPROFILE', 'CODEMIE_HOME']) vi.stubEnv(name, home);
    runSyncMock.mockResolvedValue(0);
    runUninstallMock.mockResolvedValue(0);
    runStatusMock.mockResolvedValue(0);
    runInstallMock.mockResolvedValue(0);
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await (await import('@/utils/logger.js')).logger.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const writeLocalSettings = (): void => writeFileSync(join(home, 'analytics-sync.json'), JSON.stringify(LOCAL_SETTINGS));

  it('"sync run" hands realSyncDeps a collection that exports the OTLP folder beside the JSON report', async () => {
    writeLocalSettings();
    await parse(['sync', 'run']);

    const { LocalExportSource } = await import('../../shared/analytics-collection/local.js');
    const collection = realSyncDepsMock.mock.calls[0][0] as { exportSource(): unknown };
    expect(collection.exportSource()).toBeInstanceOf(LocalExportSource);
  });

  it('"sync uninstall" runs the local teardown: the local spool is removed before the install', async () => {
    writeLocalSettings();
    mkdirSync(join(home, 'analytics', 'spool'), { recursive: true });
    writeFileSync(join(home, 'analytics', 'spool', 's1.hooks.ndjson'), 'x\n');
    await parse(['sync', 'uninstall']);

    const teardown = createRealUninstallDepsMock.mock.calls[0][0] as (removeInstall: () => Promise<void>) => Promise<void>;
    let spoolAtRemoval: boolean | undefined;
    await teardown(async () => {
      spoolAtRemoval = existsSync(join(home, 'analytics', 'spool'));
    });
    expect(spoolAtRemoval).toBe(false);
  });

  it('"sync status" passes the local mode line', async () => {
    writeLocalSettings();
    await parse(['sync', 'status']);

    const statusLines = createRealStatusDepsMock.mock.calls[0][0] as () => string[];
    expect(statusLines()).toEqual([`Mode: local — delivers the OTLP files of ${join(home, 'analytics', 'sessions')} beside the JSON report`]);
  });

  it('"sync install" with no settings and no profile hands createRealInstallDeps the local plan that stands down with no client', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await parse(['sync', 'install', '--webhook', 'https://h/x']);
    log.mockRestore();

    const { standingDownLocalInstallPlan } = await import('../../shared/analytics-collection/local-install.js');
    expect(createRealInstallDepsMock.mock.calls[0][0]).toBe(standingDownLocalInstallPlan);
  });

  it('"sync install" over a global CLI config that is not valid JSON fails as an install, runInstall not called', async () => {
    writeFileSync(join(home, 'codemie-cli.config.json'), '{ not json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await parse(['sync', 'install', '--webhook', 'https://h/x']);
      const lines = log.mock.calls.map((call) => String(call[0]));

      expect(lines).toHaveLength(1);
      expect(lines[0].startsWith('Install failed: The CodeMie CLI config at')).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(runInstallMock).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe('analytics sync CLI wiring — "sync uninstall" past the border, by the real runner', () => {
  const UNINSTALLED = [
    'Analytics sync uninstalled.',
    '  The OS job and the sync settings were removed.',
    '  The last-sent markers (webhook and git) and the run log were kept.',
  ];
  const LOCAL_PART_ONLY = [
    'Analytics sync uninstalled.',
    '  The last-sent markers (webhook and git) and the run log were kept.',
  ];
  let home: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { setUpHome } = await import('../../shared/analytics-collection/__tests__/stand.js');
    home = setUpHome();
    vi.resetModules();
    const actual = await vi.importActual<typeof import('../sync/uninstall.js')>('../sync/uninstall.js');
    runUninstallMock.mockImplementation(actual.runUninstall);
    // The OS scheduler is the boundary: no job of this name is registered on the stand.
    createRealUninstallDepsMock.mockImplementation((teardown: Parameters<typeof actual.createRealUninstallDeps>[0]) => ({
      ...actual.createRealUninstallDeps(teardown),
      schedulerFor: () => ({ unregister: async () => false }),
    }));
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    log.mockRestore();
    process.exitCode = undefined;
    const { tearDownHome } = await import('../../shared/analytics-collection/__tests__/stand.js');
    await tearDownHome(home);
  });

  const claudeSettings = (): string => join(home, '.claude', 'settings.json');
  const spool = (): string => join(home, 'analytics', 'spool');
  const syncSettings = (): string => join(home, 'analytics-sync.json');

  /** CodeMie's entries in Claude Code's settings, a session in the local spool and a live local daemon; its pid. */
  async function stageLocalMachine(): Promise<number> {
    const { writeLiveState } = await import('../../shared/analytics-collection/__tests__/stand.js');
    const pid = await writeLiveState(home, { mode: 'local' });
    mkdirSync(join(home, '.claude'), { recursive: true });
    const { writeClaudeCodeOtlpConfig } = await import('../../proxy/connectors/claude-code-otlp.js');
    await writeClaudeCodeOtlpConfig({ promptStatus: null, keepProjectList: true });
    mkdirSync(spool(), { recursive: true });
    writeFileSync(join(spool(), 's1.hooks.ndjson'), 'x\n');
    return pid;
  }

  /**
   * CodeMie's entries in Claude Code's settings as `proxy connect` writes them for a backend daemon, then that proxy
   * stopped (its state gone): no trace of the local mode.
   */
  async function stageBackendClaudeEntries(): Promise<void> {
    const { stateFile, writeLiveState } = await import('../../shared/analytics-collection/__tests__/stand.js');
    await writeLiveState(home, { profile: 'work', targetUrl: 'https://codemie.example.invalid', provider: 'ai-run-sso' });
    mkdirSync(join(home, '.claude'), { recursive: true });
    const { CODEMIE_USER_PROMPT_HOOK_STATUS_MESSAGE, writeClaudeCodeOtlpConfig } = await import(
      '../../proxy/connectors/claude-code-otlp.js'
    );
    await writeClaudeCodeOtlpConfig({ promptStatus: CODEMIE_USER_PROMPT_HOOK_STATUS_MESSAGE });
    rmSync(stateFile(home));
  }

  async function claudeHooksLeft(): Promise<boolean> {
    const { hasClaudeCodeOtlpEntries } = await import('../../proxy/connectors/claude-code-otlp.js');
    return hasClaudeCodeOtlpEntries();
  }

  const printed = (): string[] => log.mock.calls.map((call) => String(call[0]));

  it('no profile and settings {} → removes the local part and the settings, the uninstalled lines', async () => {
    await stageLocalMachine();
    writeFileSync(syncSettings(), '{}');

    await parse(['sync', 'uninstall']);

    expect(process.exitCode).toBe(0);
    expect(await claudeHooksLeft()).toBe(false);
    expect(existsSync(spool())).toBe(false);
    expect(existsSync(syncSettings())).toBe(false);
    expect(printed()).toEqual(UNINSTALLED);
  });

  it('no profile and no settings file → the same removal, the uninstalled lines with no job-and-settings line', async () => {
    await stageLocalMachine();

    await parse(['sync', 'uninstall']);

    expect(process.exitCode).toBe(0);
    expect(await claudeHooksLeft()).toBe(false);
    expect(existsSync(spool())).toBe(false);
    expect(printed()).toEqual(LOCAL_PART_ONLY);
  });

  it.each([
    ['settings {}', '{}'],
    ["a backend install's settings", JSON.stringify({ webhookUrl: 'https://example.invalid/hook?sig=FAKE', format: 'json', includeExternal: 'never', at: '03:00' })],
  ])("no profile, no trace and %s → Claude Code's settings byte for byte, the settings removed", async (_name, text) => {
    await stageBackendClaudeEntries();
    writeFileSync(syncSettings(), text);
    const before = readFileSync(claudeSettings(), 'utf-8');

    await parse(['sync', 'uninstall']);

    expect(process.exitCode).toBe(0);
    expect(readFileSync(claudeSettings(), 'utf-8')).toBe(before);
    expect(existsSync(syncSettings())).toBe(false);
    expect(printed()).toEqual(UNINSTALLED);
  });

  it("no profile, no trace and no settings file → Claude Code's settings byte for byte, nothing to remove", async () => {
    await stageBackendClaudeEntries();
    const before = readFileSync(claudeSettings(), 'utf-8');

    await parse(['sync', 'uninstall']);

    expect(process.exitCode).toBe(0);
    expect(readFileSync(claudeSettings(), 'utf-8')).toBe(before);
    expect(printed()).toEqual(['Nothing to remove: analytics sync is not installed.']);
  });

  it("a profile and settings {} → Claude Code's settings byte for byte, the spool in place, the daemon running", async () => {
    const pid = await stageLocalMachine();
    writeFileSync(syncSettings(), '{}');
    writeFileSync(
      join(home, 'codemie-cli.config.json'),
      JSON.stringify({ version: 2, activeProfile: 'work', profiles: { work: { name: 'work', provider: 'ai-run-sso' } } })
    );
    const before = readFileSync(claudeSettings(), 'utf-8');

    await parse(['sync', 'uninstall']);

    expect(process.exitCode).toBe(0);
    expect(readFileSync(claudeSettings(), 'utf-8')).toBe(before);
    expect(existsSync(join(spool(), 's1.hooks.ndjson'))).toBe(true);
    const { isPidAlive } = await import('../../shared/analytics-collection/__tests__/stand.js');
    expect(isPidAlive(pid)).toBe(true);
    expect(printed()).toEqual([
      'Analytics sync uninstalled.',
      '  The OS job and the sync settings were removed.',
      '  The last-sent markers (webhook and git) and the run log were kept.',
    ]);
  });
});

describe('--include-external scoping across analytics / sync (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadAnalyticsMock.mockResolvedValue({ kind: 'empty-raw' });
    createRealInstallDepsMock.mockReturnValue({ fake: 'install-deps' });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('"analytics otel --file f --from 2026-10-01" still receives --from', async () => {
    await parse(['otel', '--file', 'f', '--from', '2026-10-01']);

    expect(loadAnalyticsMock).toHaveBeenCalledTimes(1);
    const filter = loadAnalyticsMock.mock.calls[0][1];
    expect(filter.fromDate.toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('plain "analytics --include-external" still works', async () => {
    await parse(['--include-external']);

    expect(loadAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(loadAnalyticsMock.mock.calls[0][2]).toBe(true);
  });

  it('"analytics sync install --include-external windows" applies to install, not to analytics', async () => {
    runInstallMock.mockResolvedValue(0);
    await parse(['sync', 'install', '--webhook', 'https://h/x', '--include-external', 'windows']);

    expect(loadAnalyticsMock).not.toHaveBeenCalled();
    const [opts] = runInstallMock.mock.calls[0];
    expect(opts.includeExternal).toBe('windows');
  });

  it('"analytics sync bootstrap --webhook <url> --include-external always" applies to bootstrap, not to analytics', async () => {
    runBootstrapMock.mockResolvedValue(0);
    await parse(['sync', 'bootstrap', '--webhook', 'https://h/x?sig=1', '--include-external', 'always']);

    expect(loadAnalyticsMock).not.toHaveBeenCalled();
    const [opts] = runBootstrapMock.mock.calls[0];
    expect(opts.includeExternal).toBe('always');
  });
});
