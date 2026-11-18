import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const readDaemonStatus = vi.fn();
const readState = vi.fn();
vi.mock('../daemon-manager.js', () => ({
  readDaemonStatus: (...args: unknown[]) => readDaemonStatus(...args),
  readState: (...args: unknown[]) => readState(...args),
  DEFAULT_GATEWAY_KEY: 'codemie-proxy',
}));

const collectClientNotices = vi.fn();
const collectDesktopCollection = vi.fn();
const clientRead = vi.fn();
vi.mock('../analytics-delivery-lines.js', () => ({
  collectClientNotices: (...args: unknown[]) => collectClientNotices(...args),
  collectDesktopCollection: (...args: unknown[]) => collectDesktopCollection(...args),
  CLIENT_CONFIGS: [
    { client: 'vscode-claude-code', label: 'VS Code Claude Code extension', flag: '--vscode-claude-code', read: (...args: unknown[]) => clientRead(...args) },
  ],
}));

const collectDeliveryHealth = vi.fn();
vi.mock('../delivery-health.js', () => ({
  collectDeliveryHealth: (...args: unknown[]) => collectDeliveryHealth(...args),
  DELIVERY_REASONS: {
    credentials_expired: { label: 'CodeMie sign-in has expired', command: 'codemie profile login' },
  },
  unknownHint: () => 'restart the proxy to enable all checks',
}));

const findOlderCliOnPath = vi.fn();
vi.mock('../connect-orchestrator.js', () => ({
  findOlderCliOnPath: (...args: unknown[]) => findOlderCliOnPath(...args),
}));

const checkClaudeCodeOtlpEndpoint = vi.fn();
vi.mock('../connectors/claude-code-otlp-endpoint.js', () => ({
  checkClaudeCodeOtlpEndpoint: (...args: unknown[]) => checkClaudeCodeOtlpEndpoint(...args),
}));

const claudeCollect = vi.fn();
const copilotCollect = vi.fn();
vi.mock('../analytics-connectors.js', () => ({
  ANALYTICS_CONNECTORS: [
    { id: 'claude-code-otlp', collect: () => claudeCollect() },
    { id: 'copilot-cli-otlp', collect: () => copilotCollect() },
  ],
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

const claudeStatus = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hooksInstalled: false,
  scope: 'not-configured',
  trackedProjects: [],
  enabled: true,
  excludedProjects: [],
  preferencesCorrupt: false,
  preferencesPath: '/p',
  ...over,
});

const copilotStatus = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  connector: 'copilot-cli-otlp',
  connected: false,
  scope: 'not-connected',
  trackedProjects: [],
  enabled: true,
  excludedProjects: [],
  preferencesCorrupt: false,
  preferencesPath: '/p',
  ...over,
});

/** Any request other than the pre-auth `/health` is keyed: against an awaiting-login daemon it starts a sign-in. */
const signIn = vi.fn();
let healthBody: Record<string, unknown>;
let originalFetch: typeof globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/health')) {
      return { ok: true, status: 200, json: async () => healthBody, headers: { get: () => 'application/json' } };
    }
    signIn(String(url));
    return { ok: true, status: 200, json: async () => ({}), headers: { get: () => 'application/json' } };
  }) as unknown as typeof globalThis.fetch;
}

async function compose(opts = { authProbe: true, verbose: false }) {
  const { composeProxyDoctor } = await import('../doctor/compose.js');
  return composeProxyDoctor(opts);
}

describe('composeProxyDoctor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    installFetch();
    healthBody = { status: 'ok', pid: STATE.pid, analytics: { credentials: 'ok' } };
    readDaemonStatus.mockResolvedValue({ running: true, state: STATE });
    readState.mockResolvedValue(null);
    collectClientNotices.mockResolvedValue({ clientPortMismatch: [], clientSharedKey: [], hooksOfAnotherInstall: [], lines: [] });
    collectDesktopCollection.mockResolvedValue(null);
    clientRead.mockResolvedValue({ port: STATE.port, key: 'named' });
    collectDeliveryHealth.mockResolvedValue({ status: 'healthy' });
    findOlderCliOnPath.mockResolvedValue(null);
    checkClaudeCodeOtlpEndpoint.mockResolvedValue(null);
    claudeCollect.mockResolvedValue(claudeStatus({ hooksInstalled: true, scope: 'user' }));
    copilotCollect.mockResolvedValue(copilotStatus());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('awaiting-login daemon: auth error naming codemie profile login, and no keyed request is made', async () => {
    healthBody = { status: 'ok', pid: STATE.pid, analytics: { credentials: 'stale' } };

    const report = await compose();

    const auth = report.sections.find((s) => s.id === 'auth');
    expect(auth?.status).toBe('error');
    expect(`${auth?.message} ${auth?.hint}`).toContain('codemie profile login');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('runs the authenticated probe when the daemon is signed in', async () => {
    const report = await compose();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(report.sections.find((s) => s.id === 'auth')?.status).toBe('ok');
  });

  it('skips the authenticated probe when authProbe is false', async () => {
    await compose({ authProbe: false, verbose: false });

    expect(signIn).not.toHaveBeenCalled();
  });

  it('pid mismatch on /health is a daemon error and skips the authenticated probe', async () => {
    healthBody = { status: 'ok', pid: 9999, analytics: { credentials: 'ok' } };

    const report = await compose();

    expect(report.sections.find((s) => s.id === 'daemon')?.status).toBe('error');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('a throwing collector becomes an error section', async () => {
    collectClientNotices.mockRejectedValue(new Error('boom'));

    const report = await compose();

    const clients = report.sections.find((s) => s.id === 'clients');
    expect(clients?.status).toBe('error');
    expect(clients?.message).toContain('boom');
  });

  it('nothing connected and daemon stopped: nothingConnected, no error, hint codemie proxy connect', async () => {
    readDaemonStatus.mockResolvedValue({ running: false, state: null });
    clientRead.mockResolvedValue(null);
    claudeCollect.mockResolvedValue(claudeStatus());

    const report = await compose();

    expect(report.nothingConnected).toBe(true);
    expect(report.sections.some((s) => s.status === 'error')).toBe(false);
    const hints = report.sections.map((s) => s.hint).filter(Boolean);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('— run: codemie proxy connect');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('the Claude Code OTLP repair hint carries its current --scope', async () => {
    claudeCollect.mockResolvedValue(claudeStatus({ hooksInstalled: true, scope: 'project', trackedProjects: ['/a'] }));
    checkClaudeCodeOtlpEndpoint.mockResolvedValue({
      configured: 'http://127.0.0.1:5000/v1/analytics/otlp',
      expected: 'http://127.0.0.1:4001/v1/analytics/otlp',
      matches: false,
    });

    const report = await compose();

    const otlp = report.sections.find((s) => s.id === 'claude-code-otlp');
    expect(otlp?.status).toBe('error');
    expect(otlp?.hint).toContain('codemie proxy connect --claude-code-otlp --scope project');
  });

  it('never includes the gateway key in the report', async () => {
    collectClientNotices.mockResolvedValue({
      clientPortMismatch: [],
      clientSharedKey: [{ client: 'vscode-claude-code', flag: '--vscode-claude-code' }],
      hooksOfAnotherInstall: [],
      lines: [],
    });

    const report = await compose();

    expect(JSON.stringify(report)).not.toContain(STATE.gatewayKey);
  });
});
