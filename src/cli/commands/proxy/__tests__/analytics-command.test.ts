/**
 * Tests for `codemie proxy analytics` write commands (disable/enable/exclude/include).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    vi.stubEnv('TZ', 'America/New_York'); // times print in the local zone; the fixtures are in November, after DST ended (EST, -05:00)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
    await runCommand(['disable', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ enabled: false });
  });

  it('every real enable/disable change bumps collectionGeneration, a no-op does not', async () => {
    await runCommand(['disable', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ enabled: false, collectionGeneration: 1 });
    await runCommand(['disable', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ collectionGeneration: 1 });
    await runCommand(['enable', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ enabled: true, collectionGeneration: 2 });
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ collectionGeneration: 2 });
  });

  it('a failed preferences write fails closed: the command errors and nothing is changed', async () => {
    const { getClaudeAnalyticsPreferencesPath } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(getClaudeAnalyticsPreferencesPath(), { recursive: true }); // a directory where the file belongs
    await runCommand(['disable', '--claude-code-otlp']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('enable sets enabled back to true after disable', async () => {
    await runCommand(['disable', '--claude-code-otlp']);
    await runCommand(['enable', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ enabled: true });
  });

  it('exclude with an explicit path adds its canonical form', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    const canonical = await canonicalizePath('/work/a');
    expect(await readPreferences()).toMatchObject({ excludedProjects: [canonical] });
  });

  it('exclude with no path argument excludes the resolved project root', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '--claude-code-otlp']);
    const canonical = await canonicalizePath(projectRoot);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [canonical] });
  });

  it('exclude twice keeps a single entry and prints Nothing to change', async () => {
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [expect.any(String)] });
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
  });

  it('include removes a previously excluded path', async () => {
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    await runCommand(['include', '/work/a', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [] });
  });

  it('include on a path that was never excluded prints Nothing to change and leaves the file unchanged', async () => {
    await runCommand(['disable', '--claude-code-otlp']);
    const before = await readPreferences();
    logSpy.mockClear();
    await runCommand(['include', '/work/z', '--claude-code-otlp']);
    expect(await readPreferences()).toEqual(before);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
  });

  const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

  it.runIf(isCaseInsensitiveFs)('exclude twice with different casing keeps a single entry (CR-003)', async () => {
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await runCommand(['exclude', '/WORK/A', '--claude-code-otlp']);
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
  });

  it.runIf(isCaseInsensitiveFs)('include with different casing removes a previously excluded path (CR-003)', async () => {
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    await runCommand(['include', '/WORK/A', '--claude-code-otlp']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [] });
  });

  it('include of a subdirectory still excluded via its parent names the parent instead of claiming nothing is tracked (CR-003)', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await runCommand(['include', '/work/a/nested', '--claude-code-otlp']);

    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    const parent = await canonicalizePath('/work/a');
    expect(prefs.excludedProjects).toEqual([parent]);
    expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
  });

  it('include of a redundant nested entry does not claim success while the parent still excludes it', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    // Excluding a path already covered by a stored parent still creates a direct entry today
    // (addProjectPath only dedupes exact matches) — this reproduces a redundant child entry.
    await runCommand(['exclude', '/work/a/nested', '--claude-code-otlp']);
    logSpy.mockClear();
    await runCommand(['include', '/work/a/nested', '--claude-code-otlp']);

    const parent = await canonicalizePath('/work/a');
    const nested = await canonicalizePath('/work/a/nested');
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).not.toContain(nested);
    expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
  });

  it('exclude of a path already covered by a stored parent reports Nothing to change instead of adding a redundant entry', async () => {
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await runCommand(['exclude', '/work/a/nested', '--claude-code-otlp']);

    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change');
  });

  it('excluding a parent after a child was already excluded drops the now-redundant child entry', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a/nested', '--claude-code-otlp']);
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);

    const parent = await canonicalizePath('/work/a');
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toEqual([parent]);
  });

  it('status prints formatted output through the real command wiring (CR-004)', async () => {
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await runCommand(['status']);
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Hooks:');
    expect(output).toContain('Excluded:');
    expect(output).not.toContain('Delivery:');
    expect(output).toContain('Consented folders: none');
    expect(output).toContain('Delivery health — run: codemie proxy doctor');
  });

  it('status --json prints parseable JSON through the real command wiring (CR-004)', async () => {
    await runCommand(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await runCommand(['status', '--json']);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ delivery: null, consentedFolders: [] });
    expect(parsed.connectors).toHaveLength(1);
    expect(parsed.connectors[0]).toMatchObject({ connector: 'claude-code-otlp', excludedProjects: [expect.any(String)] });
  });

  describe('status delivery section', () => {
    const connectors: Array<[string[], string]> = [
      [[], 'Claude:'],
      [['--claude-code-otlp'], 'Claude:'],
      [['--copilot-cli-otlp'], 'Copilot CLI:'],
      [['--copilot-chat-otlp'], 'Copilot Chat:'],
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
        readDaemonStatus: vi.fn().mockResolvedValue({ running: true, state: daemonState }),
      }));
      vi.doMock('../health-check.js', () => ({ checkProxyHealth }));
      vi.doMock('../delivery-health.js', async () => {
        const actual = await vi.importActual<typeof import('../delivery-health.js')>('../delivery-health.js');
        return { ...actual, collectDeliveryHealth };
      });
      return { checkProxyHealth, collectDeliveryHealth };
    }

    it.each(connectors)('%j text shows the connector section, consented folders and the doctor hint, with no delivery lines', async (flags, title) => {
      await runCommand(['status', ...flags]);
      const lines = plainOutput().split('\n');
      expect(lines[0]).toBe(title);
      expect(lines.some((l) => l.includes('Collection:'))).toBe(true);
      expect(lines.some((l) => l.includes('Excluded:'))).toBe(true);
      expect(lines).toContain('Consented folders: none');
      expect(lines[lines.length - 1]).toBe('Delivery health — run: codemie proxy doctor');
      expect(plainOutput()).not.toContain('Delivery:');
      expect(plainOutput()).not.toContain('Unsent data');
    });

    it('lists consented folders in text and in --json', async () => {
      const { connectFolder } = await import('@/agents/core/evidence/consent-store.js');
      const folder = await (await import('@/agents/core/project-allowlist.js')).canonicalizePath(projectRoot);
      await connectFolder({ owner_hash: 'o', api_identity: 'a', project: 'proj-x' }, folder);
      // Another account's consent on the same machine is not this account's.
      await connectFolder({ owner_hash: 'someone-else', api_identity: 'a', project: 'proj-other' }, folder);
      vi.doMock('@/agents/core/evidence/hook-identity.js', () => ({
        currentEvidenceIdentity: async () => ({ owner_hash: 'o', api_identity: 'a' }),
      }));
      await runCommand(['status', '--claude-code-otlp']);
      const out = plainOutput();
      expect(out).toContain('Consented folders:');
      expect(out).toContain(`${folder} (proj-x)`);
      expect(out).not.toContain('proj-other');
      logSpy.mockClear();
      await runCommand(['status', '--claude-code-otlp', '--json']);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.consentedFolders).toEqual([{ folder, project: 'proj-x' }]);
      vi.doUnmock('@/agents/core/evidence/hook-identity.js');
    });

    it('does not read the daemon in text mode', async () => {
      const { checkProxyHealth, collectDeliveryHealth } = mockRunningDaemon({ status: 'healthy', pendingBytes: 0 });
      await runCommand(['status', '--claude-code-otlp']);
      expect(checkProxyHealth).not.toHaveBeenCalled();
      expect(collectDeliveryHealth).not.toHaveBeenCalled();
    });

    it.each(connectors)('%j --json adds delivery: null when the daemon is stopped', async (flags) => {
      await runCommand(['status', ...flags, '--json']);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed).toHaveProperty('delivery', null);
    });

    function mockActiveConnectors(ids: string[]): void {
      vi.doMock('../analytics-connectors.js', async () => {
        const actual = await vi.importActual<typeof import('../analytics-connectors.js')>('../analytics-connectors.js');
        return {
          ...actual,
          hasActiveAnalyticsConnector: vi.fn().mockResolvedValue(ids.length > 0),
          listActiveAnalyticsConnectors: vi.fn().mockResolvedValue(
            actual.ANALYTICS_CONNECTORS.filter((entry) => ids.includes(entry.id))
          ),
        };
      });
    }

    it('shows a section for every connected tool, separated by an empty line', async () => {
      mockActiveConnectors(['claude-code-otlp', 'copilot-cli-otlp']);
      await runCommand(['status']);
      const lines = plainOutput().split('\n');
      const headings = lines.filter((line) => /^(Claude|Copilot CLI|Copilot Chat):$/.test(line));
      expect(headings).toEqual(['Claude:', 'Copilot CLI:']);
      expect(lines[lines.indexOf('Copilot CLI:') - 1]).toBe('');
    });

    it('gives the two Copilot tools different headings when both are connected', async () => {
      mockActiveConnectors(['copilot-cli-otlp', 'copilot-chat-otlp']);
      await runCommand(['status']);
      const headings = plainOutput().split('\n').filter((line) => /^Copilot[^:]*:$/.test(line));
      expect(headings).toEqual(['Copilot CLI:', 'Copilot Chat:']);
    });

    it('shows only the connected tool, not Claude, when only Copilot is connected', async () => {
      mockActiveConnectors(['copilot-cli-otlp']);
      await runCommand(['status']);
      const output = plainOutput();
      expect(output).toContain('Copilot CLI:');
      expect(output).not.toContain('Claude:');
      expect(output).not.toContain('codemie proxy connect --claude-otlp');
    });

    it('shows only the tool a flag selects even when others are connected', async () => {
      mockActiveConnectors(['claude-code-otlp', 'copilot-cli-otlp']);
      await runCommand(['status', '--copilot-cli-otlp']);
      const output = plainOutput();
      expect(output).toContain('Copilot CLI:');
      expect(output).not.toContain('Claude:');
    });

    it('lists every connected tool in --json, after the delivery, with consentedFolders last', async () => {
      mockActiveConnectors(['claude-code-otlp', 'copilot-chat-otlp']);
      await runCommand(['status', '--json']);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(Object.keys(parsed)).toEqual(['delivery', 'connectors', 'consentedFolders']);
      expect(parsed.connectors.map((c: { connector: string }) => c.connector)).toEqual([
        'claude-code-otlp',
        'copilot-chat-otlp',
      ]);
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
    expect(names).toEqual(['connect-folder', 'consent', 'disable', 'disconnect-folder', 'enable', 'exclude', 'include', 'status']);
  });

  it('the group description names what the group does now: enable/disable, include/exclude, consent, status', async () => {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    const description = createProxyAnalyticsCommand().description();
    expect(description).toBe(
      'Control analytics collection: enable/disable, include/exclude projects, work-folder consent, and status'
    );
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
    await runCommand(['disable', '--claude-code-otlp']);

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

    it('no connector flag with nothing connected fails, names codemie proxy connect and its flags, and writes nothing', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const { getClaudeAnalyticsPreferencesPath } = await import(
        '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
      );
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;
      await runCommand(['disable']);
      expect(process.exitCode).toBe(1);
      const err = stripVTControlCharacters(errSpy.mock.calls.flat().join('\n'));
      expect(err).toContain('codemie proxy connect');
      for (const flag of ['--claude-otlp', '--copilot-otlp']) {
        expect(err).toContain(flag);
      }
      expect(await fileExists(getCopilotAnalyticsPreferencesPath())).toBe(false);
      expect(await fileExists(getClaudeAnalyticsPreferencesPath())).toBe(false);
      process.exitCode = undefined;
    });

    it('--claude-code-otlp is equivalent to the default', async () => {
      await runCommand(['disable', '--claude-code-otlp']);
      expect(await readPreferences()).toMatchObject({ enabled: false });
    });

    it('registers the three connector options on every subcommand', async () => {
      const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
      // `consent list` takes no connector; `consent` is a group node whose leaves are checked instead.
      const leaves = createProxyAnalyticsCommand().commands.flatMap((c) => (c.name() === 'consent' ? [...c.commands] : [c]));
      for (const sub of leaves.filter((c) => c.name() !== 'list')) {
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
      expect(output).not.toContain('Current:');
    });

    it('status --json prints a single parseable JSON document for this connector', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['status', flag, '--json']);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.connectors).toHaveLength(1);
      expect(parsed.connectors[0]).toMatchObject({
        connector: connectorId,
        enabled: true,
        excludedProjects: [expect.any(String)],
        preferencesCorrupt: false,
        connected: false,
      });
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

  describe('no connector flag fans out to every connected connector', () => {
    const output = (): string => stripVTControlCharacters(logSpy.mock.calls.flat().join('\n'));
    let errSpy: ReturnType<typeof vi.spyOn>;
    const errors = (): string => stripVTControlCharacters(errSpy.mock.calls.flat().join('\n'));

    beforeEach(() => {
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = undefined;
    });

    async function connectClaude(allowlist?: string[]): Promise<void> {
      const { mkdir } = await import('node:fs/promises');
      const dir = join(tempDir, 'home', '.claude');
      await mkdir(dir, { recursive: true });
      const settings = {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp' }] }] },
        ...(allowlist ? { env: { CODEMIE_ANALYTICS_PROJECT_FILTER: JSON.stringify(allowlist) } } : {}),
      };
      await writeFile(join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    }

    async function readClaudeAllowlist(): Promise<string[]> {
      const raw = JSON.parse(await readFile(join(tempDir, 'home', '.claude', 'settings.json'), 'utf-8')) as {
        env: Record<string, string>;
      };
      return JSON.parse(raw.env.CODEMIE_ANALYTICS_PROJECT_FILTER) as string[];
    }

    async function connectCopilot(scopes: Record<string, unknown>): Promise<void> {
      const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
      await writeFile(getCopilotConnectorsConfigPath(), JSON.stringify({ version: 1, connectors: scopes }), 'utf-8');
    }

    async function readCopilotScope(id: string): Promise<{ paths?: string[] }> {
      const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
      return (JSON.parse(await readFile(getCopilotConnectorsConfigPath(), 'utf-8')) as {
        connectors: Record<string, { paths?: string[] }>;
      }).connectors[id];
    }

    async function readCopilotPrefs(id: string): Promise<{ enabled: boolean; excludedProjects: string[] } | undefined> {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      return (JSON.parse(await readFile(getCopilotAnalyticsPreferencesPath(), 'utf-8')) as {
        connectors: Record<string, { enabled: boolean; excludedProjects: string[] }>;
      }).connectors[id];
    }

    it('disable with a corrupt Copilot scope still writes the Copilot preference and names it as unreadable', async () => {
      const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
      await writeFile(getCopilotConnectorsConfigPath(), '{corrupt', 'utf-8');
      await runCommand(['disable']);
      expect(await readCopilotPrefs('copilot-cli-otlp')).toMatchObject({ enabled: false });
      expect(await readCopilotPrefs('copilot-chat-otlp')).toMatchObject({ enabled: false });
      const all = `${output()}\n${errors()}`;
      expect(all).toMatch(/Copilot CLI[^\n]*could not be read/);
      expect(all).toMatch(/Copilot Chat[^\n]*could not be read/);
    });

    it('disable targets a connector that is not active but has a stored preference, and no other', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      await writeFile(
        getCopilotAnalyticsPreferencesPath(),
        JSON.stringify({ version: 1, connectors: { 'copilot-cli-otlp': { enabled: true, excludedProjects: [] } } }),
        'utf-8'
      );
      await runCommand(['disable']);
      expect(await readCopilotPrefs('copilot-cli-otlp')).toMatchObject({ enabled: false });
      expect(await readCopilotPrefs('copilot-chat-otlp')).toBeUndefined();
      const { getClaudeAnalyticsPreferencesPath } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js');
      await expect(readFile(getClaudeAnalyticsPreferencesPath(), 'utf-8')).rejects.toThrow();
      expect(output()).toContain('Copilot CLI');
      expect(output()).not.toContain('Copilot Chat');
      expect(process.exitCode).toBeUndefined();
    });

    it('disable with no preference record and nothing readable or active fails with the connect hint', async () => {
      await runCommand(['disable']);
      expect(process.exitCode).toBe(1);
      expect(errors()).toContain('No analytics connector is connected');
      expect(errors()).toContain('codemie proxy connect');
    });

    it('disable acts on every connected connector and says which it changed', async () => {
      await connectClaude();
      await connectCopilot({ 'copilot-cli-otlp': { enabled: true, scope: 'user' } });
      await runCommand(['disable']);
      expect(await readPreferences()).toMatchObject({ enabled: false });
      expect(await readCopilotPrefs('copilot-cli-otlp')).toMatchObject({ enabled: false });
      expect(await readCopilotPrefs('copilot-chat-otlp')).toBeUndefined();
      expect(output()).toContain('Claude Code');
      expect(output()).toContain('Copilot CLI');
      expect(process.exitCode).toBeUndefined();
    });

    it('a connector that fails does not stop the next one; each is reported and the exit code is 1', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      await connectClaude();
      await connectCopilot({
        'copilot-cli-otlp': { enabled: true, scope: 'user' },
        'copilot-chat-otlp': { enabled: true, scope: 'user' },
      });
      await writeFile(
        getCopilotAnalyticsPreferencesPath(),
        JSON.stringify({ version: 1, connectors: { 'copilot-cli-otlp': { enabled: 'broken' } } }),
        'utf-8'
      );
      await runCommand(['disable']);
      expect(await readPreferences()).toMatchObject({ enabled: false });
      expect(await readCopilotPrefs('copilot-chat-otlp')).toMatchObject({ enabled: false });
      expect(errors()).toContain('Copilot CLI');
      expect(output()).toContain('Copilot Chat');
      expect(process.exitCode).toBe(1);
    });

    it('include/exclude with nothing connected fails and names codemie proxy connect', async () => {
      await runCommand(['exclude', '/work/a']);
      expect(process.exitCode).toBe(1);
      expect(errors()).toContain('codemie proxy connect');
    });

    it('exclude then include restores tracking for every connector', async () => {
      const { evaluateClaudeAnalyticsGate } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.gate.js');
      const { evaluateCopilotAnalyticsGate } = await import('@/agents/core/copilot-analytics-gate.js');
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      const target = await canonicalizePath(projectRoot);
      await connectClaude([target]);
      await connectCopilot({
        'copilot-cli-otlp': { enabled: true, scope: 'project', paths: [target] },
        'copilot-chat-otlp': { enabled: true, scope: 'user' },
      });
      await runCommand(['exclude', target]);
      expect((await evaluateClaudeAnalyticsGate(target)).tracked).toBe(false);
      expect((await evaluateCopilotAnalyticsGate('copilot-cli-otlp', target)).tracked).toBe(false);
      expect((await evaluateCopilotAnalyticsGate('copilot-chat-otlp', target)).tracked).toBe(false);
      await runCommand(['include', target]);
      expect((await evaluateClaudeAnalyticsGate(target)).tracked).toBe(true);
      expect((await evaluateCopilotAnalyticsGate('copilot-cli-otlp', target)).tracked).toBe(true);
      expect((await evaluateCopilotAnalyticsGate('copilot-chat-otlp', target)).tracked).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('include in project scope adds the path to each connector\'s own project list and confirms it is tracked', async () => {
      const { evaluateClaudeAnalyticsGate } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.gate.js');
      const { evaluateCopilotAnalyticsGate } = await import('@/agents/core/copilot-analytics-gate.js');
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      const other = await mkdtemp(join(tmpdir(), 'codemie-analytics-other-'));
      const target = await canonicalizePath(projectRoot);
      await connectClaude([other]);
      await connectCopilot({ 'copilot-cli-otlp': { enabled: true, scope: 'project', paths: [other] } });
      await runCommand(['include', target]);
      expect(await readClaudeAllowlist()).toContain(target);
      expect((await readCopilotScope('copilot-cli-otlp')).paths).toContain(target);
      expect((await evaluateClaudeAnalyticsGate(target)).tracked).toBe(true);
      expect((await evaluateCopilotAnalyticsGate('copilot-cli-otlp', target)).tracked).toBe(true);
      expect(output()).toMatch(/is tracked by Claude Code/);
      await rm(other, { recursive: true, force: true });
    });

    it('include writes the project list first and, when removing the exclusion fails, names the owed step and that a re-run is safe', async () => {
      const { getClaudeAnalyticsPreferencesPath } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js');
      const { mkdir } = await import('node:fs/promises');
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      const other = await mkdtemp(join(tmpdir(), 'codemie-analytics-other-'));
      const target = await canonicalizePath(projectRoot);
      await connectClaude([other]);
      await mkdir(getClaudeAnalyticsPreferencesPath(), { recursive: true }); // removing the exclusion will fail
      await runCommand(['include', target]);
      expect(await readClaudeAllowlist()).toContain(target);
      expect(process.exitCode).toBe(1);
      const err = errors();
      expect(err).toMatch(/exclusion/i);
      expect(err).toMatch(/re-run is safe/i);
      expect(output()).not.toMatch(/is tracked by/);
      await rm(other, { recursive: true, force: true });
    });

    it('include of a child excluded through its parent explains it, names the command that removes it, and reports no success', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await connectClaude();
      await runCommand(['exclude', '/work/a']);
      logSpy.mockClear();
      await runCommand(['include', '/work/a/nested']);
      const parent = await canonicalizePath('/work/a');
      const all = `${output()}\n${errors()}`;
      expect(all).toContain(`still excluded via ${parent}`);
      expect(all).toContain(`run: codemie proxy analytics include "${parent}" --claude-code-otlp`);
      expect(all).not.toMatch(/✓|is tracked by/);
    });
  });
});
