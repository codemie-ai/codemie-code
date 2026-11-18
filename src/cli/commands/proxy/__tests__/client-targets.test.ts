/**
 * The client-target table: `proxy clients`, the doctor client section and the `disconnect --all` target set
 * read it, so they agree on what is connected.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const STATE = {
  pid: 4242,
  port: 4001,
  url: 'http://127.0.0.1:4001',
  profile: 'default',
  gatewayKey: 'secret-gateway-key',
  version: '1.0.0',
  startedAt: new Date().toISOString(),
};

const TRACKED_PROJECT = '/work/secret-project-a';

const readDaemonStatus = vi.fn();
vi.mock('../daemon-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-manager.js')>()),
  readDaemonStatus: (...args: unknown[]) => readDaemonStatus(...args),
  readState: async () => null,
}));

// Fixture: Claude Desktop and Claude Code are connected; nothing else is.
vi.mock('@/telemetry/clients/claude-desktop/claude-desktop.gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/telemetry/clients/claude-desktop/claude-desktop.gateway.js')>()),
  readDesktopGatewayConfig: async () => ({ port: 4001, apiKey: 'secret-gateway-key.claude-desktop' }),
}));
vi.mock('../connectors/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/desktop.js')>()),
  readDesktopGateway: async () => ({ port: 4001 }),
}));
vi.mock('../connectors/vscode-claude-code.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode-claude-code.js')>()),
  readVsCodeClaudeCodeGateway: async () => null,
}));
vi.mock('../connectors/codex-desktop-named-key.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/codex-desktop-named-key.js')>()),
  readCodexDesktopGateway: async () => null,
}));
vi.mock('../connectors/vscode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode.js')>()),
  readVsCodeByokGateway: async () => null,
}));
vi.mock('../connectors/omp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/omp.js')>()),
  isOmpExtensionInstalled: () => false,
}));
vi.mock('../connectors/claude-code-otlp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/claude-code-otlp.js')>()),
  hasClaudeCodeOtlpHooks: async () => true,
  readClaudeCodeHookInstall: async () => null,
}));
vi.mock('../connectors/claude-code-otlp-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/claude-code-otlp-scope.js')>()),
  readClaudeCodeOtlpScope: async () => ({ scope: 'project', paths: [TRACKED_PROJECT] }),
}));
vi.mock('../connectors/copilot-cli-otlp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/copilot-cli-otlp.js')>()),
  readCopilotCliHookInstall: async () => null,
}));
vi.mock('../connectors/copilot-chat-otlp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/copilot-chat-otlp.js')>()),
  readCopilotChatHookInstall: async () => null,
}));
vi.mock('@/agents/core/copilot-connector-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agents/core/copilot-connector-scope.js')>()),
  readCopilotConnectorScope: async () => ({ kind: 'ok', value: { enabled: false } }),
  readCopilotConnectorScopeForAnalytics: async () => ({ scope: 'user', paths: [] }),
}));
vi.mock('../analytics-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics-status.js')>()),
  collectClaudeAnalyticsStatus: async () => ({
    hooksInstalled: true,
    scope: 'project',
    trackedProjects: [TRACKED_PROJECT],
    enabled: true,
    excludedProjects: [],
    preferencesCorrupt: false,
    preferencesPath: '/p',
  }),
  collectCopilotAnalyticsStatus: async (connector: string) => ({
    connector,
    connected: false,
    scope: 'not-connected',
    trackedProjects: [],
    enabled: true,
    excludedProjects: [],
    preferencesCorrupt: false,
    preferencesPath: '/p',
  }),
}));
vi.mock('../connectors/claude-code-otlp-endpoint.js', () => ({ checkClaudeCodeOtlpEndpoint: async () => null }));
vi.mock('../delivery-health.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delivery-health.js')>()),
  collectDeliveryHealth: async () => ({ status: 'healthy' }),
}));
vi.mock('../connect-orchestrator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connect-orchestrator.js')>()),
  findOlderCliOnPath: async () => null,
}));

// The analytics clients' lookups (PATH, application folders) are covered by analytics-clients.test.ts.
const collectAnalyticsClients = vi.hoisted(() => vi.fn());
vi.mock('../analytics-clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics-clients.js')>()),
  collectAnalyticsClients: (...args: unknown[]) => collectAnalyticsClients(...args),
}));
const ANALYTICS_ROWS = [
  { client: 'claude-code', label: 'Claude Code', found: true, connected: true, flag: '--claude-otlp', otherGateway: false },
  { client: 'vscode-claude-code', label: 'VS Code Claude Code extension', found: true, connected: false, flag: '--claude-otlp', otherGateway: false },
  { client: 'claude-desktop', label: 'Claude Desktop', found: true, connected: true, flag: '--claude-otlp', otherGateway: false },
  { client: 'copilot-chat', label: 'Copilot Chat', found: true, connected: false, flag: '--copilot-otlp', otherGateway: false },
  { client: 'copilot-cli', label: 'Copilot CLI', found: false, connected: false, flag: '--copilot-cli-otlp', otherGateway: false },
];

const removers = vi.hoisted(() => ({
  disconnectClaudeCodeOtlp: vi.fn(async () => {}),
  disconnectClaudeDesktop: vi.fn(async () => {}),
  disconnectCodexDesktop: vi.fn(async () => {}),
  disconnectCopilotChatOtlp: vi.fn(async () => {}),
  disconnectCopilotCliOtlp: vi.fn(async () => {}),
  disconnectOmp: vi.fn(async () => {}),
  disconnectVsCodeByok: vi.fn(async () => {}),
  disconnectVsCodeClaudeCode: vi.fn(async () => {}),
}));
vi.mock('../disconnect-orchestrator.js', () => removers);

let logs: string[];
let originalFetch: typeof globalThis.fetch;

interface ClientRow {
  id: string;
  label: string;
  flag: string;
  connected: boolean;
  configLocation: string;
  analytics: boolean;
  scope?: string;
  found?: boolean;
  hint?: string;
}

async function runClients(args: string[]): Promise<string> {
  const { createProxyClientsCommand } = await import('../clients-command.js');
  await createProxyClientsCommand().parseAsync(args, { from: 'user' });
  return logs.join('\n');
}

describe('client-target table', () => {
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    readDaemonStatus.mockResolvedValue({ running: true, state: STATE });
    collectAnalyticsClients.mockResolvedValue(ANALYTICS_ROWS);
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', pid: STATE.pid, analytics: { credentials: 'ok' } }),
      headers: { get: () => 'application/json' },
    })) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('a config location of a client that is not installed reads as not installed, not unavailable on this platform', async () => {
    const { describeConfigLocation } = await import('../client-targets.js');
    const { ClientNotInstalledError } = await import('@/utils/errors.js');
    const target = (configLocation: () => string) => ({
      id: 'x', flag: '--x', label: 'X', isConnected: async () => false, carriesAnalytics: false, configLocation,
    });

    expect(describeConfigLocation(target(() => { throw new ClientNotInstalledError('VS Code Insiders is not installed'); })))
      .toBe('not installed');
    expect(describeConfigLocation(target(() => { throw new Error('unsupported platform: aix'); })))
      .toBe('unavailable on this platform');
  });

  it('includes omp and every connect target, each id unique', async () => {
    const { CLIENT_TARGETS } = await import('../client-targets.js');
    const ids = CLIENT_TARGETS.map((target) => target.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'claude-desktop', 'vscode', 'vscode-claude-code', 'codex-desktop', 'omp',
      'claude-code-otlp', 'copilot-chat-otlp', 'copilot-cli-otlp',
    ]));
    expect(CLIENT_TARGETS.find((target) => target.id === 'omp')?.flag).toBe('--omp');
  });

  it('proxy clients --json, the doctor client section and the --all target set agree on what is connected', async () => {
    const out = await runClients(['--json']);
    const rows = (JSON.parse(out) as { clients: ClientRow[] }).clients;
    const connected = rows.filter((row) => row.connected);
    expect(connected.map((row) => row.id)).toEqual(['claude-desktop', 'claude-code-otlp']);

    const { listConnectedClientTargets } = await import('../client-targets.js');
    expect((await listConnectedClientTargets()).map((target) => target.id)).toEqual(connected.map((row) => row.id));

    const { composeProxyDoctor } = await import('../doctor/compose.js');
    const report = await composeProxyDoctor({ authProbe: false, verbose: false });
    const clients = report.sections.filter((section) => section.id === 'clients');
    expect(clients).toEqual([
      { id: 'clients', status: 'ok', message: `Clients connected: ${connected.map((row) => row.label).join(', ')}` },
    ]);
    expect(report.nothingConnected).toBe(false);
  });

  it('each row disconnects through its own remover, with the Insiders flag and the user scope', async () => {
    const { CLIENT_TARGETS } = await import('../client-targets.js');
    const expected: Record<string, [keyof typeof removers, unknown[]]> = {
      'claude-desktop': ['disconnectClaudeDesktop', []],
      'vscode-claude-code': ['disconnectVsCodeClaudeCode', [false]],
      'vscode-claude-code-insiders': ['disconnectVsCodeClaudeCode', [true]],
      'codex-desktop': ['disconnectCodexDesktop', []],
      vscode: ['disconnectVsCodeByok', [false]],
      'vscode-insiders': ['disconnectVsCodeByok', [true]],
      omp: ['disconnectOmp', []],
      'claude-code-otlp': ['disconnectClaudeCodeOtlp', ['user']],
      'copilot-cli-otlp': ['disconnectCopilotCliOtlp', ['user']],
      'copilot-chat-otlp': ['disconnectCopilotChatOtlp', ['user']],
    };
    expect(CLIENT_TARGETS.map((target) => target.id).sort()).toEqual(Object.keys(expected).sort());
    for (const target of CLIENT_TARGETS) {
      for (const remover of Object.values(removers)) remover.mockClear();
      await target.disconnect?.();
      const [name, args] = expected[target.id];
      const called = Object.entries(removers).filter(([, remover]) => remover.mock.calls.length > 0).map(([key]) => key);
      expect(called, target.id).toEqual([name]);
      expect(removers[name], target.id).toHaveBeenCalledWith(...args);
    }
  });

  it('analytics rows show scope from readScope and never the project list', async () => {
    const out = await runClients(['--json']);
    const rows = (JSON.parse(out) as { clients: ClientRow[] }).clients;
    const claude = rows.find((row) => row.id === 'claude-code-otlp');
    expect(claude).toMatchObject({ connected: true, analytics: true, scope: 'project', flag: '--claude-otlp' });
    expect(rows.find((row) => row.id === 'copilot-cli-otlp')).toMatchObject({ connected: false, analytics: true });
    expect(rows.find((row) => row.id === 'copilot-cli-otlp')?.scope).toBeUndefined();
    expect(rows.every((row) => typeof row.configLocation === 'string' && row.configLocation.length > 0)).toBe(true);
    expect(out).not.toContain(TRACKED_PROJECT);
  });

  it('text output lists every target with connected state and the analytics scope', async () => {
    const out = stripVTControlCharacters(await runClients([]));
    expect(out).toMatch(/Claude Desktop\s+connected/);
    expect(out).toMatch(/Claude Code\b.*connected.*scope project/);
    expect(out).toMatch(/oh-my-pi\s+not connected/);
    expect(out).not.toContain(TRACKED_PROJECT);
    expect(process.exitCode).toBeUndefined();
  });

  it('an analytics client that is not connected carries its hint, the vendor flag when found, its own when not', async () => {
    const rows = (JSON.parse(await runClients(['--json'])) as { clients: ClientRow[] }).clients;
    const byId = (id: string) => rows.find((row) => row.id === id);

    expect(collectAnalyticsClients).toHaveBeenLastCalledWith(STATE);
    expect(byId('claude-code-otlp')).toMatchObject({ connected: true, found: true });
    expect(byId('claude-code-otlp')?.hint).toBeUndefined();
    expect(byId('claude-desktop')?.hint).toBeUndefined();
    expect(byId('vscode-claude-code')).toMatchObject({
      found: true, hint: 'not connected — run: codemie proxy connect --claude-otlp',
    });
    expect(byId('copilot-chat-otlp')).toMatchObject({
      found: true, hint: 'not connected — run: codemie proxy connect --copilot-otlp',
    });
    expect(byId('copilot-cli-otlp')).toMatchObject({
      found: false, hint: 'not found — if it is installed, run: codemie proxy connect --copilot-cli-otlp',
    });
    for (const id of ['vscode-claude-code-insiders', 'codex-desktop', 'vscode', 'vscode-insiders', 'omp']) {
      expect(byId(id), id).not.toHaveProperty('hint');
      expect(byId(id), id).not.toHaveProperty('found');
    }
    expect(rows.map((row) => row.id)).toHaveLength(new Set(rows.map((row) => row.id)).size);
  });

  it('prints the hint on the not connected rows of the text output', async () => {
    const out = stripVTControlCharacters(await runClients([]));
    expect(out).toMatch(/Copilot Chat\s+not connected — run: codemie proxy connect --copilot-otlp/);
    expect(out).toMatch(/Copilot CLI\s+not found — if it is installed, run: codemie proxy connect --copilot-cli-otlp/);
    expect(out).not.toContain('Analytics clients:');
  });

  it('reads the analytics clients with no daemon when it is stopped, and names no command under an older CLI', async () => {
    readDaemonStatus.mockResolvedValue({ running: false, state: null });
    await runClients(['--json']);
    expect(collectAnalyticsClients).toHaveBeenLastCalledWith(null);

    logs = [];
    readDaemonStatus.mockResolvedValue({ running: true, state: { ...STATE, version: undefined } });
    const rows = (JSON.parse(await runClients(['--json'])) as { clients: ClientRow[] }).clients;
    expect(rows.find((row) => row.id === 'copilot-chat-otlp')?.hint).toBe('not connected');
  });
});
