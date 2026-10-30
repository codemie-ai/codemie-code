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

  it('lists install, status, run, uninstall, each with a "who runs it / what it changes" description', async () => {
    const sync = findSync(await buildCommand());
    const names = sync.commands.map((c) => c.name());
    expect(names).toEqual(['install', 'status', 'run', 'uninstall']);

    const install = sync.commands.find((c) => c.name() === 'install')!;
    expect(install.description()).toBe('Developer: register the daily delivery job on this machine');

    const run = sync.commands.find((c) => c.name() === 'run')!;
    expect(run.description()).toBe(
      'Developer or the daily scheduled job: send the pending analytics report to the webhook now'
    );

    for (const name of ['status', 'run', 'uninstall']) {
      const sub = sync.commands.find((c) => c.name() === name)!;
      expect(sub.description().length).toBeGreaterThan(0);
    }
  });

  it('--help lists every subcommand and hides --scheduled', async () => {
    const sync = findSync(await buildCommand());
    const help = sync.helpInformation();
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
    createRealInstallDepsMock.mockReturnValue({ fake: 'install-deps' });
    createRealStatusDepsMock.mockReturnValue({ fake: 'status-deps' });
    realSyncDepsMock.mockReturnValue({ fake: 'sync-deps' });
    createRealUninstallDepsMock.mockReturnValue({ fake: 'uninstall-deps' });
  });

  afterEach(() => {
    process.exitCode = undefined;
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
});
