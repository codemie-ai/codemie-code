/**
 * Parses argv through the real root program (`createProgram()`), the tree the shipped CLI
 * uses, rather than through a subcommand factory on its own.
 *
 * Regression: the root did not call `.enablePositionalOptions()`, so commander handed
 * `analytics` the options without `sync install` in front. `analytics` consumed
 * `--include-external` as its own boolean, left the policy (`always`) as a stray argument,
 * and `sync install` fell back to the default `never` with no error. Tests that parsed
 * `createAnalyticsCommand()` directly took the working path and passed.
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';

const runBootstrapMock = vi.fn();
vi.mock('../commands/analytics/sync/bootstrap/run-bootstrap.js', () => ({
  runBootstrap: (...a: unknown[]) => runBootstrapMock(...a),
  createRealBootstrapDeps: () => ({ fake: 'bootstrap-deps' }),
}));

const runInstallMock = vi.fn();
vi.mock('../commands/analytics/sync/install.js', () => ({
  runInstall: (...a: unknown[]) => runInstallMock(...a),
  createRealInstallDeps: () => ({ fake: 'install-deps' }),
}));

const runStatusMock = vi.fn();
vi.mock('../commands/analytics/sync/status.js', () => ({
  runStatus: (...a: unknown[]) => runStatusMock(...a),
  createRealStatusDeps: () => ({ fake: 'status-deps' }),
}));

const runSyncMock = vi.fn();
vi.mock('../commands/analytics/sync/run-sync.js', () => ({
  runSync: (...a: unknown[]) => runSyncMock(...a),
  realSyncDeps: () => ({ fake: 'sync-deps' }),
}));

const runUninstallMock = vi.fn();
vi.mock('../commands/analytics/sync/uninstall.js', () => ({
  runUninstall: (...a: unknown[]) => runUninstallMock(...a),
  createRealUninstallDeps: () => ({ fake: 'uninstall-deps' }),
}));

const loadAnalyticsMock = vi.fn();
vi.mock('../commands/analytics/analytics-core.js', () => ({
  loadAnalytics: (...a: unknown[]) => loadAnalyticsMock(...a),
}));

/** Commander's `exitOverride()` is per command and `addCommand()` does not copy it, so set
 * it on every level: a parse error anywhere then throws instead of calling process.exit. */
function throwInsteadOfExit(command: Command): void {
  command.exitOverride();
  command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  for (const sub of command.commands) {
    throwInsteadOfExit(sub);
  }
}

async function parse(argv: string[]): Promise<void> {
  const { createProgram } = await import('../program.js');
  const program = createProgram();
  throwInsteadOfExit(program);
  await program.parseAsync(argv, { from: 'user' });
}

const GIT_REPO = 'https://example.invalid/team/repo.git';

const sub = (cmd: Command, name: string): Command | undefined =>
  cmd.commands.find(c => c.name() === name);

describe('createProgram structure', () => {
  it('builds the command tree without parsing argv', async () => {
    const { createProgram } = await import('../program.js');
    const program = createProgram();

    expect(program.name()).toBe('codemie');
    expect(sub(program, 'proxy')).toBeDefined();
    expect(sub(program, 'analytics')).toBeDefined();
    expect(sub(program, 'doctor')).toBeDefined();
    expect(sub(program, 'tips')).toBeDefined();
  });

  it('exposes proxy status, proxy connect and analytics sync', async () => {
    const { createProgram } = await import('../program.js');
    const program = createProgram();

    expect(sub(sub(program, 'proxy')!, 'status')).toBeDefined();
    expect(sub(sub(program, 'proxy')!, 'connect')).toBeDefined();
    expect(sub(sub(program, 'analytics')!, 'sync')).toBeDefined();
  });

  it('returns a fresh tree per call', async () => {
    const { createProgram } = await import('../program.js');
    expect(createProgram()).not.toBe(createProgram());
  });
});

describe('root program', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    runBootstrapMock.mockResolvedValue(0);
    runInstallMock.mockResolvedValue(0);
    runStatusMock.mockResolvedValue(0);
    runSyncMock.mockResolvedValue(0);
    runUninstallMock.mockResolvedValue(0);
    loadAnalyticsMock.mockResolvedValue({ kind: 'empty-raw' });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
  });

  describe('analytics sync --include-external <policy>', () => {
    it('"analytics sync install ... --include-external always" passes "always" to runInstall', async () => {
      await parse([
        'analytics', 'sync', 'install',
        '--git-repo', GIT_REPO, '--git-branch', 'main', '--git-path', 'reports/ai-enablement',
        '--include-external', 'always',
      ]);

      expect(runInstallMock).toHaveBeenCalledTimes(1);
      const [opts] = runInstallMock.mock.calls[0];
      expect(opts).toEqual(expect.objectContaining({
        gitRepo: GIT_REPO,
        gitBranch: 'main',
        gitPath: 'reports/ai-enablement',
        includeExternal: 'always',
      }));
      expect(loadAnalyticsMock).not.toHaveBeenCalled();
    });

    it('"analytics sync bootstrap ... --include-external always" passes "always" to runBootstrap', async () => {
      await parse(['analytics', 'sync', 'bootstrap', '--git-repo', GIT_REPO, '--include-external', 'always']);

      expect(runBootstrapMock).toHaveBeenCalledTimes(1);
      const [opts] = runBootstrapMock.mock.calls[0];
      expect(opts).toEqual(expect.objectContaining({ gitRepo: GIT_REPO, includeExternal: 'always' }));
      expect(loadAnalyticsMock).not.toHaveBeenCalled();
    });

    it('"analytics --include-external always" is still consumed by analytics itself', async () => {
      await parse(['analytics', '--include-external', 'always']);

      expect(loadAnalyticsMock).toHaveBeenCalledTimes(1);
      expect(loadAnalyticsMock.mock.calls[0][2]).toBe(true);
      expect(runInstallMock).not.toHaveBeenCalled();
    });
  });

  describe('analytics sync install option validation order', () => {
    it('reports the invalid --include-external value, not --lookback-days, when both are bad', async () => {
      const printed: string[] = [];
      const preflight = vi.fn();
      // Run the real runInstall (and so the real validateInstallOptions) behind the CLI.
      runInstallMock.mockImplementation(async (opts: unknown) => {
        const actual = await vi.importActual<typeof import('../commands/analytics/sync/install.js')>(
          '../commands/analytics/sync/install.js'
        );
        const deps = { print: (m: string) => printed.push(m), scheduler: { preflight } };
        return actual.runInstall(opts as never, deps as never);
      });

      await parse([
        'analytics', 'sync', 'install',
        '--git-repo', GIT_REPO, '--include-external', 'bogus', '--lookback-days', '99',
      ]);

      const output = printed.join('\n');
      expect(output).toContain('include-external');
      expect(output).not.toContain('lookback');
      expect(preflight).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe('analytics sync subcommands reject stray arguments', () => {
    it.each([
      [['bootstrap', '--git-repo', GIT_REPO, 'stray']],
      [['install', '--git-repo', GIT_REPO, 'stray']],
      [['status', 'stray']],
      [['run', 'stray']],
      [['uninstall', 'stray']],
    ])('"analytics sync %j" fails instead of ignoring the extra word', async (args) => {
      await expect(parse(['analytics', 'sync', ...args])).rejects.toMatchObject({
        code: 'commander.excessArguments',
      });

      expect(runBootstrapMock).not.toHaveBeenCalled();
      expect(runInstallMock).not.toHaveBeenCalled();
      expect(runStatusMock).not.toHaveBeenCalled();
      expect(runSyncMock).not.toHaveBeenCalled();
      expect(runUninstallMock).not.toHaveBeenCalled();
    });

    it('"analytics sync run --scheduled" (the scheduled job command) still reaches runSync', async () => {
      await parse(['analytics', 'sync', 'run', '--scheduled']);

      expect(runSyncMock).toHaveBeenCalledWith({ fake: 'sync-deps' });
      expect(process.exitCode).toBe(0);
    });
  });

  it('"--version" before any subcommand still prints the CLI version', async () => {
    await expect(parse(['--version'])).rejects.toMatchObject({ code: 'commander.version' });
  });
});
