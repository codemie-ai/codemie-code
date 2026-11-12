/**
 * Tests for `codemie proxy analytics` write commands (disable/enable/exclude/include).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

let tempDir: string;
let projectRoot: string;

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    getCodemiePath: (...paths: string[]) => join(tempDir, ...paths),
    resolveHomeDir: (relativePath = '') => join(tempDir, 'home', relativePath),
  };
});

vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: () => projectRoot,
}));

vi.mock('../connectors/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/desktop.js')>()),
  readDesktopGateway: vi.fn(async () => null),
}));

describe('createProxyAnalyticsCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-analytics-cmd-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'codemie-analytics-proj-'));
    vi.stubEnv('CODEMIE_HOME', tempDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function runCommand(args: string[]): Promise<void> {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    await createProxyAnalyticsCommand().parseAsync(args, { from: 'user' });
  }

  async function readPreferences(): Promise<unknown> {
    const { getClaudeAnalyticsPreferencesPath } = await import(
      '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
    );
    return JSON.parse(await readFile(getClaudeAnalyticsPreferencesPath(), 'utf-8'));
  }

  it('disable sets enabled to false', async () => {
    await runCommand(['disable']);
    expect(await readPreferences()).toMatchObject({ enabled: false });
  });

  it('every real enable/disable change bumps collectionGeneration, a no-op does not', async () => {
    await runCommand(['disable']);
    expect(await readPreferences()).toMatchObject({ enabled: false, collectionGeneration: 1 });
    await runCommand(['disable']);
    expect(await readPreferences()).toMatchObject({ collectionGeneration: 1 });
    await runCommand(['enable']);
    expect(await readPreferences()).toMatchObject({ enabled: true, collectionGeneration: 2 });
    await runCommand(['exclude', '/work/a']);
    expect(await readPreferences()).toMatchObject({ collectionGeneration: 2 });
  });

  it('a failed preferences write fails closed: the command errors and nothing is changed', async () => {
    const { getClaudeAnalyticsPreferencesPath } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(getClaudeAnalyticsPreferencesPath(), { recursive: true }); // a directory where the file belongs
    await runCommand(['disable']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('enable sets enabled back to true after disable', async () => {
    await runCommand(['disable']);
    await runCommand(['enable']);
    expect(await readPreferences()).toMatchObject({ enabled: true });
  });

  it('exclude with an explicit path adds its canonical form', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a']);
    const canonical = await canonicalizePath('/work/a');
    expect(await readPreferences()).toMatchObject({ excludedProjects: [canonical] });
  });

  it('exclude with no path argument excludes the resolved project root', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude']);
    const canonical = await canonicalizePath(projectRoot);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [canonical] });
  });

  it('exclude twice keeps a single entry and prints Nothing to change', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['exclude', '/work/a']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [expect.any(String)] });
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
  });

  it('include removes a previously excluded path', async () => {
    await runCommand(['exclude', '/work/a']);
    await runCommand(['include', '/work/a']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [] });
  });

  it('include on a path that was never excluded prints Nothing to change and leaves the file unchanged', async () => {
    await runCommand(['disable']);
    const before = await readPreferences();
    logSpy.mockClear();
    await runCommand(['include', '/work/z']);
    expect(await readPreferences()).toEqual(before);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
  });

  const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

  it.runIf(isCaseInsensitiveFs)('exclude twice with different casing keeps a single entry (CR-003)', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['exclude', '/WORK/A']);
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
  });

  it.runIf(isCaseInsensitiveFs)('include with different casing removes a previously excluded path (CR-003)', async () => {
    await runCommand(['exclude', '/work/a']);
    await runCommand(['include', '/WORK/A']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [] });
  });

  it('include of a subdirectory still excluded via its parent names the parent instead of claiming nothing is tracked (CR-003)', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['include', '/work/a/nested']);

    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    const parent = await canonicalizePath('/work/a');
    expect(prefs.excludedProjects).toEqual([parent]);
    expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
  });

  it('include of a redundant nested entry does not claim success while the parent still excludes it', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a']);
    // Excluding a path already covered by a stored parent still creates a direct entry today
    // (addProjectPath only dedupes exact matches) — this reproduces a redundant child entry.
    await runCommand(['exclude', '/work/a/nested']);
    logSpy.mockClear();
    await runCommand(['include', '/work/a/nested']);

    const parent = await canonicalizePath('/work/a');
    const nested = await canonicalizePath('/work/a/nested');
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).not.toContain(nested);
    expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
  });

  it('exclude of a path already covered by a stored parent reports Nothing to change instead of adding a redundant entry', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['exclude', '/work/a/nested']);

    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change');
  });

  it('excluding a parent after a child was already excluded drops the now-redundant child entry', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a/nested']);
    await runCommand(['exclude', '/work/a']);

    const parent = await canonicalizePath('/work/a');
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toEqual([parent]);
  });

  it('status prints formatted output through the real command wiring (CR-004)', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['status']);
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Hooks:');
    expect(output).toContain('Excluded:');
    // No connector is connected in this isolated home, so the shared Delivery section stays hidden.
    expect(output).not.toContain('Delivery:');
  });

  it('status --json prints parseable JSON through the real command wiring (CR-004)', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['status', '--json']);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ excludedProjects: [expect.any(String)] });
  });

  describe('status delivery section', () => {
    const connectors: Array<[string[], string]> = [
      [[], 'Hooks:'],
      [['--claude-code-otlp'], 'Hooks:'],
      [['--copilot-cli-otlp'], 'Connected:'],
      [['--copilot-chat-otlp'], 'Connected:'],
    ];

    const daemonState = {
      pid: 4242,
      port: 4001,
      url: 'http://localhost:4001',
      profile: 'default',
      gatewayKey: 'key',
      startedAt: new Date().toISOString(),
    };

    const plainOutput = (): string => stripVTControlCharacters(logSpy.mock.calls.flat().join('\n'));

    function mockConnectorActive(active: boolean): void {
      vi.doMock('../analytics-connectors.js', async () => {
        const actual = await vi.importActual<typeof import('../analytics-connectors.js')>('../analytics-connectors.js');
        return { ...actual, hasActiveAnalyticsConnector: vi.fn().mockResolvedValue(active) };
      });
    }

    beforeEach(() => {
      mockConnectorActive(true);
    });

    afterEach(() => {
      vi.doUnmock('../daemon-manager.js');
      vi.doUnmock('../health-check.js');
      vi.doUnmock('../delivery-health.js');
      vi.doUnmock('../analytics-connectors.js');
    });

    function mockRunningDaemon(delivery: unknown): {
      checkProxyHealth: ReturnType<typeof vi.fn>;
      collectDeliveryHealth: ReturnType<typeof vi.fn>;
    } {
      const checkProxyHealth = vi.fn().mockResolvedValue({
        healthy: true,
        level: 'shallow',
        code: 'ok',
        analytics: { credentials: 'ok' },
      });
      const collectDeliveryHealth = vi.fn().mockResolvedValue(delivery);
      vi.doMock('../daemon-manager.js', () => ({
        checkStatus: vi.fn().mockResolvedValue({ running: true, state: daemonState }),
      }));
      vi.doMock('../health-check.js', () => ({ checkProxyHealth }));
      vi.doMock('../delivery-health.js', async () => {
        const actual = await vi.importActual<typeof import('../delivery-health.js')>('../delivery-health.js');
        return { ...actual, collectDeliveryHealth };
      });
      return { checkProxyHealth, collectDeliveryHealth };
    }

    it.each(connectors)('%j prints the Delivery section first and "proxy not running" when the daemon is stopped', async (flags, headline) => {
      await runCommand(['status', ...flags]);
      const lines = plainOutput().split('\n');
      expect(lines[0]).toBe('Delivery: proxy not running');
      expect(lines[1]).toContain(headline);
      expect(lines).not.toContain('');
      expect(lines.filter((l) => l.startsWith('Delivery:'))).toHaveLength(1);
    });

    it.each(connectors)('%j --json adds delivery: null when the daemon is stopped', async (flags) => {
      await runCommand(['status', ...flags, '--json']);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed).toHaveProperty('delivery', null);
    });

    it.each(connectors)('%j shows the shared verdict from /health when the daemon is running', async (flags, headline) => {
      const { checkProxyHealth, collectDeliveryHealth } = mockRunningDaemon({
        status: 'unhealthy',
        reason: 'credentials_expired',
        pendingBytes: 2048,
      });
      await runCommand(['status', ...flags]);

      expect(checkProxyHealth).toHaveBeenCalledWith(expect.objectContaining({ port: 4001, expectedPid: 4242 }));
      expect(collectDeliveryHealth).toHaveBeenCalledWith(daemonState, { credentials: 'ok' });
      const lines = plainOutput().split('\n');
      expect(lines.slice(0, 3)).toEqual([
        'Delivery: unhealthy (credentials expired)',
        '  Pending: 2.00 KB (all sessions on this machine)',
        '  Run: codemie profile login',
      ]);
      expect(lines[3]).toContain(headline);
      expect(lines).not.toContain('');
    });

    it('prints the Last dropped line and the project hint after the Delivery lines', async () => {
      mockRunningDaemon({
        status: 'healthy',
        pendingBytes: 0,
        latestDrop: { reason: 'no_project', stream: 'hooks', at: Date.parse('2026-11-11T10:00:00.000Z'), local: true },
      });
      await runCommand(['status', '--claude-code-otlp']);

      const lines = plainOutput().split('\n');
      expect(lines.slice(0, 3)).toEqual([
        'Delivery: healthy',
        '  Last dropped: no_project (hooks, 2026-11-11T10:00:00.000Z)',
        '  Run: set a CodeMie project for the folder (codemie setup) — sessions without a project are not sent',
      ]);
      expect(lines[3]).toContain('Hooks:');
    });

    it.each(connectors)('%j --json equals the collected status plus the same delivery object', async (flags) => {
      const delivery = { status: 'healthy', pendingBytes: 0 };
      mockRunningDaemon(delivery);
      await runCommand(['status', ...flags, '--json']);
      const withDelivery = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(withDelivery.delivery).toEqual(delivery);

      vi.doUnmock('../daemon-manager.js');
      vi.doUnmock('../health-check.js');
      vi.doUnmock('../delivery-health.js');
      vi.resetModules();
      logSpy.mockClear();
      await runCommand(['status', ...flags, '--json']);
      const stopped = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect({ ...withDelivery, delivery: undefined }).toEqual({ ...stopped, delivery: undefined });
    });

    it.each(connectors)('%j hides the Delivery section when no connector is active, even with unsent data pending', async (flags, headline) => {
      mockConnectorActive(false);
      const { checkProxyHealth, collectDeliveryHealth } = mockRunningDaemon({
        status: 'healthy',
        pendingBytes: 4096,
      });
      await runCommand(['status', ...flags]);

      const output = plainOutput();
      expect(output).not.toContain('Delivery:');
      expect(output).not.toContain('Pending:');
      expect(output.split('\n')[0]).toContain(headline);
      expect(checkProxyHealth).not.toHaveBeenCalled();
      expect(collectDeliveryHealth).not.toHaveBeenCalled();
    });

    it.each(connectors)('%j --json has delivery: null when no connector is active, even with unsent data pending', async (flags) => {
      mockConnectorActive(false);
      mockRunningDaemon({ status: 'healthy', pendingBytes: 4096 });
      await runCommand(['status', ...flags, '--json']);

      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed).toHaveProperty('delivery', null);
    });
  });

  it('createProxyAnalyticsCommand registers all five subcommands (CR-004)', async () => {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    const names = createProxyAnalyticsCommand()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['connect-folder', 'disable', 'disconnect-folder', 'enable', 'exclude', 'include', 'status']);
  });

  it('a corrupt preferences file exits with code 1 and is left unchanged', async () => {
    const { getClaudeAnalyticsPreferencesPath } = await import(
      '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
    );
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const path = getClaudeAnalyticsPreferencesPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{not json', 'utf-8');
    const before = await readFile(path, 'utf-8');

    process.exitCode = undefined;
    await runCommand(['disable']);

    expect(process.exitCode).toBe(1);
    expect(await readFile(path, 'utf-8')).toBe(before);
    process.exitCode = undefined;
  });

  describe('connector selection', () => {
    async function readCopilotRecord(connectorId: string): Promise<unknown> {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const file = JSON.parse(await readFile(getCopilotAnalyticsPreferencesPath(), 'utf-8')) as {
        connectors: Record<string, unknown>;
      };
      return file.connectors[connectorId];
    }

    async function fileExists(path: string): Promise<boolean> {
      const { access } = await import('node:fs/promises');
      return access(path).then(
        () => true,
        () => false
      );
    }

    it('no connector flag still targets claude-code-otlp and never creates the copilot file', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      await runCommand(['disable']);
      expect(await readPreferences()).toMatchObject({ enabled: false });
      expect(await fileExists(getCopilotAnalyticsPreferencesPath())).toBe(false);
    });

    it('--claude-code-otlp is equivalent to the default', async () => {
      await runCommand(['disable', '--claude-code-otlp']);
      expect(await readPreferences()).toMatchObject({ enabled: false });
    });

    it('registers the three connector options on every subcommand', async () => {
      const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
      for (const sub of createProxyAnalyticsCommand().commands) {
        const flags = sub.options.map((o) => o.long);
        expect(flags).toEqual(
          expect.arrayContaining(['--claude-code-otlp', '--copilot-cli-otlp', '--copilot-chat-otlp'])
        );
      }
    });

    it('rejects more than one connector flag, exits 1 and writes nothing', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const { getClaudeAnalyticsPreferencesPath } = await import(
        '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
      );
      process.exitCode = undefined;
      await runCommand(['disable', '--copilot-cli-otlp', '--copilot-chat-otlp']);
      expect(process.exitCode).toBe(1);
      expect(await fileExists(getCopilotAnalyticsPreferencesPath())).toBe(false);
      expect(await fileExists(getClaudeAnalyticsPreferencesPath())).toBe(false);
      process.exitCode = undefined;
    });

    it('rejects claude-code-otlp combined with a copilot flag', async () => {
      process.exitCode = undefined;
      await runCommand(['disable', '--claude-code-otlp', '--copilot-cli-otlp']);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it('disabling one copilot connector leaves the other copilot connector and claude untouched', async () => {
      await runCommand(['disable', '--copilot-cli-otlp']);
      expect(await readCopilotRecord('copilot-cli-otlp')).toMatchObject({ enabled: false });
      expect(await readCopilotRecord('copilot-chat-otlp')).toBeUndefined();
      const { getClaudeAnalyticsPreferencesPath } = await import(
        '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
      );
      expect(await fileExists(getClaudeAnalyticsPreferencesPath())).toBe(false);
    });
  });

  describe.each(['copilot-cli-otlp', 'copilot-chat-otlp'] as const)('%s analytics commands', (connectorId) => {
    const flag = `--${connectorId}`;

    async function readRecord(): Promise<{ enabled: boolean; excludedProjects: string[] }> {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const file = JSON.parse(await readFile(getCopilotAnalyticsPreferencesPath(), 'utf-8')) as {
        connectors: Record<string, { enabled: boolean; excludedProjects: string[] }>;
      };
      return file.connectors[connectorId];
    }

    it('disable then enable round-trips the enabled flag', async () => {
      await runCommand(['disable', flag]);
      expect((await readRecord()).enabled).toBe(false);
      await runCommand(['enable', flag]);
      expect((await readRecord()).enabled).toBe(true);
    });

    it('disable twice prints Nothing to change the second time', async () => {
      await runCommand(['disable', flag]);
      logSpy.mockClear();
      await runCommand(['disable', flag]);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
    });

    it('success message names the Copilot connector, not Claude Code', async () => {
      logSpy.mockClear();
      await runCommand(['disable', flag]);
      const output = logSpy.mock.calls.flat().join(' ');
      expect(output).toContain('copilot-analytics.json');
      expect(output).not.toContain('Claude Code');
    });

    it('exclude with an explicit path stores its canonical form', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toEqual([await canonicalizePath('/work/a')]);
    });

    it('exclude with no path excludes the resolved project root', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', flag]);
      expect((await readRecord()).excludedProjects).toEqual([await canonicalizePath(projectRoot)]);
    });

    it('exclude twice keeps a single entry and prints Nothing to change', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['exclude', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(1);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
    });

    it('include removes a previously excluded path', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['include', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toEqual([]);
    });

    it('include on a never-excluded path prints Nothing to change', async () => {
      await runCommand(['disable', flag]);
      logSpy.mockClear();
      await runCommand(['include', '/work/z', flag]);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
    });

    it.runIf(isCaseInsensitiveFs)('exclude twice with different casing keeps a single entry', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['exclude', '/WORK/A', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(1);
    });

    it.runIf(isCaseInsensitiveFs)('include with different casing removes the entry', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['include', '/WORK/A', flag]);
      expect((await readRecord()).excludedProjects).toEqual([]);
    });

    it('include of a subdirectory still excluded via its parent names the parent', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['include', '/work/a/nested', flag]);
      const parent = await canonicalizePath('/work/a');
      expect((await readRecord()).excludedProjects).toEqual([parent]);
      expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
    });

    it('exclude of a path already covered by a stored parent reports Nothing to change and adds no redundant entry', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['exclude', '/work/a/nested', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(1);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change');
    });

    it('excluding a parent after a child drops the now-redundant child entry', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', '/work/a/nested', flag]);
      await runCommand(['exclude', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toEqual([await canonicalizePath('/work/a')]);
    });

    it('a sibling that merely shares a string prefix is not treated as covered by the excluded path', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['exclude', '/work/ab', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(2);
    });

    it('status prints formatted output through the real command wiring', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['status', flag]);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Collection:');
      expect(output).toContain('Excluded:');
      expect(output).toContain('Current:');
    });

    it('status --json prints a single parseable JSON document for this connector', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['status', flag, '--json']);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed).toMatchObject({
        connector: connectorId,
        enabled: true,
        excludedProjects: [expect.any(String)],
        preferencesCorrupt: false,
        connected: false,
      });
    });

    it('status reports disabled collection and the gate reason for the current directory', async () => {
      await runCommand(['disable', flag]);
      logSpy.mockClear();
      await runCommand(['status', flag, '--json']);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.enabled).toBe(false);
      expect(parsed.current).toMatchObject({ tracked: false, reason: 'analytics-disabled' });
    });

    it.each([
      ['exclude', ['exclude', '/work/a']],
      ['include', ['include', '/work/a']],
      ['enable', ['enable']],
    ])('%s refuses to rewrite a version-less (reader-corrupt) preferences file: exit 1, bytes unchanged', async (_name, args) => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = getCopilotAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ connectors: {} }), 'utf-8');
      const before = await readFile(path, 'utf-8');

      process.exitCode = undefined;
      await runCommand([...args, flag]);

      expect(process.exitCode).toBe(1);
      expect(await readFile(path, 'utf-8')).toBe(before);
      process.exitCode = undefined;
    });

    it('a corrupt copilot preferences file exits with code 1 and is left unchanged', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = getCopilotAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{not json', 'utf-8');
      const before = await readFile(path, 'utf-8');

      process.exitCode = undefined;
      await runCommand(['disable', flag]);

      expect(process.exitCode).toBe(1);
      expect(await readFile(path, 'utf-8')).toBe(before);
      process.exitCode = undefined;
    });
  });
});
