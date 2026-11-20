import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const readDaemonStatus = vi.fn();
vi.mock('../daemon-manager.js', () => ({
  readDaemonStatus: (...args: unknown[]) => readDaemonStatus(...args),
}));

const collectClientNotices = vi.fn();
const collectDesktopCollection = vi.fn();
vi.mock('../analytics-delivery-lines.js', () => ({
  collectClientNotices: (...args: unknown[]) => collectClientNotices(...args),
  collectDesktopCollection: (...args: unknown[]) => collectDesktopCollection(...args),
}));

/** The client-target table: one gateway client, connected unless a test says otherwise. */
const clientConnected = vi.fn();
const VSCODE_TARGET = {
  id: 'vscode-claude-code',
  flag: '--vscode-claude-code',
  label: 'VS Code Claude Code extension',
  carriesAnalytics: false,
  isConnected: () => clientConnected(),
  configLocation: () => '/settings.json',
};
/** A hook-based connector: the proxy starts on its next event, so a stopped proxy is only a warning for it. */
const hookConnected = vi.fn();
const HOOK_TARGET = {
  id: 'copilot-cli-otlp',
  flag: '--copilot-cli-otlp',
  label: 'Copilot CLI',
  carriesAnalytics: true,
  isConnected: () => hookConnected(),
  configLocation: () => '/hooks.json',
  readHookInstall: async () => null,
};
let clientCheckError: string | undefined;
vi.mock('../client-targets.js', () => ({
  CLIENT_TARGETS: [VSCODE_TARGET, HOOK_TARGET],
  readClientTargetStates: async () => [
    clientCheckError === undefined
      ? { target: VSCODE_TARGET, connected: await clientConnected() }
      : { target: VSCODE_TARGET, connected: false, error: clientCheckError },
    { target: HOOK_TARGET, connected: await hookConnected() },
  ],
}));

const collectDeliveryHealth = vi.fn();
vi.mock('../delivery-health.js', () => ({
  collectDeliveryHealth: (...args: unknown[]) => collectDeliveryHealth(...args),
  DELIVERY_REASONS: {
    credentials_expired: { label: 'CodeMie sign-in has expired', command: 'codemie profile login' },
    send_failed: { label: 'last send to CodeMie failed, retrying' },
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
const claudeReadScope = vi.fn();
const copilotReadScope = vi.fn();
vi.mock('../analytics-connectors.js', () => ({
  ANALYTICS_CONNECTORS: [
    { id: 'claude-code-otlp', collect: () => claudeCollect(), readScope: () => claudeReadScope() },
    { id: 'copilot-cli-otlp', collect: () => copilotCollect(), readScope: () => copilotReadScope() },
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
/** How `/health` answers: normally, by rejecting (nothing listens), or with a 503. */
let healthMode: 'ok' | 'reject' | '503';
let originalFetch: typeof globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/health')) {
      if (healthMode === 'reject') throw new Error('connect ECONNREFUSED');
      if (healthMode === '503') return { ok: false, status: 503, json: async () => ({}), headers: { get: () => 'application/json' } };
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
    healthMode = 'ok';
    clientCheckError = undefined;
    hookConnected.mockResolvedValue(false);
    readDaemonStatus.mockResolvedValue({ running: true, state: STATE });
    collectClientNotices.mockResolvedValue({ clientPortMismatch: [], clientSharedKey: [], hooksOfAnotherInstall: [], lines: [] });
    collectDesktopCollection.mockResolvedValue(null);
    clientConnected.mockResolvedValue(true);
    collectDeliveryHealth.mockResolvedValue({ status: 'healthy' });
    findOlderCliOnPath.mockResolvedValue(null);
    checkClaudeCodeOtlpEndpoint.mockResolvedValue(null);
    claudeCollect.mockResolvedValue(claudeStatus({ hooksInstalled: true, scope: 'user' }));
    copilotCollect.mockResolvedValue(copilotStatus());
    claudeReadScope.mockResolvedValue({ scope: 'user', paths: [] });
    copilotReadScope.mockResolvedValue({ scope: 'user', paths: [] });
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

  it('shows one sign-in message: delivery credentials_expired is dropped when auth errors', async () => {
    healthBody = { status: 'ok', pid: STATE.pid, analytics: { credentials: 'stale' } };
    collectDeliveryHealth.mockResolvedValue({ status: 'unhealthy', reason: 'credentials_expired' });

    const report = await compose();

    expect(report.sections.filter((s) => s.id === 'auth' && s.status === 'error')).toHaveLength(1);
    const delivery = report.sections.filter((s) => s.id === 'delivery');
    expect(delivery).toHaveLength(1);
    expect(delivery[0].status).toBe('info');
    expect(delivery[0].message).not.toContain('sign-in has expired');
  });

  it('keeps the delivery credentials_expired error when auth is not an error', async () => {
    collectDeliveryHealth.mockResolvedValue({ status: 'unhealthy', reason: 'credentials_expired' });

    const report = await compose({ authProbe: false, verbose: false });

    expect(report.sections.some((s) => s.id === 'delivery' && s.status === 'error')).toBe(true);
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
    clientConnected.mockResolvedValue(false);
    claudeCollect.mockResolvedValue(claudeStatus());

    const report = await compose();

    expect(report.nothingConnected).toBe(true);
    expect(report.sections.some((s) => s.status === 'error')).toBe(false);
    const hints = report.sections.map((s) => s.hint).filter(Boolean);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('— run: codemie proxy connect');
    expect(signIn).not.toHaveBeenCalled();
  });

  describe('every section always renders', () => {
    /** Section ids by display group: daemon, sign-in and upstream, clients, connectors, delivery, Desktop, environment. */
    const GROUPS: string[][] = [['daemon'], ['auth', 'upstream'], ['clients'], ['connectors', 'claude-code-otlp'], ['delivery'], ['desktop'], ['cli-path']];
    const missing = (report: Awaited<ReturnType<typeof compose>>): string[][] =>
      GROUPS.filter((ids) => !report.sections.some((s) => ids.includes(s.id)));

    it('a running daemon with only a gateway client still has a line in every group', async () => {
      claudeCollect.mockResolvedValue(claudeStatus());

      const report = await compose();

      expect(missing(report)).toEqual([]);
      const connectors = report.sections.find((s) => s.id === 'connectors');
      expect(connectors?.status).toBe('info');
      expect(connectors?.hint).toContain('codemie proxy connect --claude-otlp');
      const delivery = report.sections.find((s) => s.id === 'delivery');
      expect(delivery?.status).toBe('info');
      expect(delivery?.message).toMatch(/no analytics connector/i);
      expect(report.sections.find((s) => s.id === 'desktop')?.status).toBe('info');
      expect(report.sections.find((s) => s.id === 'cli-path')).toMatchObject({ status: 'ok' });
    });

    it('a stopped daemon with nothing connected has a line in every group, no error and no warning', async () => {
      readDaemonStatus.mockResolvedValue({ running: false, state: null });
      clientConnected.mockResolvedValue(false);
      claudeCollect.mockResolvedValue(claudeStatus());

      const report = await compose();

      expect(missing(report)).toEqual([]);
      expect(report.sections.filter((s) => s.status === 'error' || s.status === 'warn')).toEqual([]);
    });

    it('a stopped daemon lists the connected clients under the clients group', async () => {
      readDaemonStatus.mockResolvedValue({ running: false, state: null });

      const report = await compose();

      expect(missing(report)).toEqual([]);
      expect(report.sections.find((s) => s.id === 'clients')?.message).toContain('VS Code Claude Code extension');
    });
  });

  it.each([
    // A vendor flag with no --scope keeps a project list; --scope project would add the current directory to it.
    ['project', { scope: 'project', paths: ['/a'] }, 'codemie proxy connect --claude-otlp'],
    ['user', { scope: 'user', paths: [] }, 'codemie proxy connect --claude-otlp --scope user'],
  ])('the Claude Code OTLP repair hint for %s scope, read through the connector readScope', async (_name, read, command) => {
    claudeCollect.mockResolvedValue(claudeStatus({ hooksInstalled: true, scope: 'user' }));
    claudeReadScope.mockResolvedValue(read);
    checkClaudeCodeOtlpEndpoint.mockResolvedValue({
      configured: 'http://127.0.0.1:5000/v1/analytics/otlp',
      expected: 'http://127.0.0.1:4001/v1/analytics/otlp',
      matches: false,
    });

    const report = await compose();

    const otlp = report.sections.find((s) => s.id === 'claude-code-otlp');
    expect(otlp?.status).toBe('error');
    expect(otlp?.hint?.endsWith(`— run: ${command}`)).toBe(true);
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
  describe('daemon not answering', () => {
    it.each([
      ['rejects', 'reject' as const, /not responding/],
      ['returns 503', '503' as const, /returned 503/],
    ])('/health %s: daemon error with the restart hint, and no keyed request', async (_case, mode, message) => {
      healthMode = mode;

      const report = await compose();

      const daemon = report.sections.find((s) => s.id === 'daemon');
      expect(daemon?.status).toBe('error');
      expect(daemon?.message).toMatch(message);
      expect(daemon?.hint).toContain('— run: codemie proxy restart');
      expect(signIn).not.toHaveBeenCalled();
    });
  });

  describe('daemon stopped', () => {
    beforeEach(() => {
      readDaemonStatus.mockResolvedValue({ running: false, state: null });
    });

    it('a connected gateway client makes it an error naming the client and codemie proxy start', async () => {
      const report = await compose();

      const daemon = report.sections.find((s) => s.id === 'daemon');
      expect(daemon?.status).toBe('error');
      expect(daemon?.message).toContain('VS Code Claude Code extension');
      expect(daemon?.hint).toContain('— run: codemie proxy start');
    });

    it('only a hook-based connector connected makes it a warning, with no error section', async () => {
      clientConnected.mockResolvedValue(false);
      hookConnected.mockResolvedValue(true);
      claudeCollect.mockResolvedValue(claudeStatus());

      const report = await compose();

      expect(report.sections.find((s) => s.id === 'daemon')?.status).toBe('warn');
      expect(report.sections.some((s) => s.status === 'error')).toBe(false);
    });
  });

  describe('connector failures', () => {
    const connectorSections = (report: Awaited<ReturnType<typeof compose>>) =>
      report.sections.filter((s) => s.id === 'connectors');

    it('an invalid Claude tracked-project list warns with the --overwrite repair', async () => {
      claudeReadScope.mockResolvedValue({ invalid: 'not a JSON array' });

      const sections = connectorSections(await compose());

      const invalid = sections.find((s) => s.message.includes('tracked-project list'));
      expect(invalid?.status).toBe('warn');
      expect(invalid?.hint).toContain('— run: codemie proxy connect --claude-otlp --overwrite');
    });

    it('corrupt preferences warn naming the preferences file', async () => {
      claudeCollect.mockResolvedValue(claudeStatus({ hooksInstalled: true, preferencesCorrupt: true, preferencesPath: '/prefs/claude.json' }));

      const corrupt = connectorSections(await compose()).find((s) => s.message.includes('preferences'));

      expect(corrupt?.status).toBe('warn');
      expect(`${corrupt?.message} ${corrupt?.hint}`).toContain('/prefs/claude.json');
    });

    it('unreadable Copilot connector settings warn even when the connector reads as not connected', async () => {
      copilotReadScope.mockResolvedValue({ invalid: 'corrupt' });

      const unreadable = connectorSections(await compose()).find((s) => s.message.startsWith('Copilot CLI'));

      expect(unreadable?.status).toBe('warn');
      expect(unreadable?.hint).toContain('codemie proxy connect --copilot-otlp');
    });

    it('paused collection is info with the enable command', async () => {
      claudeCollect.mockResolvedValue(claudeStatus({ hooksInstalled: true, enabled: false }));

      const paused = connectorSections(await compose()).find((s) => s.message.includes('paused'));

      expect(paused?.status).toBe('info');
      expect(paused?.hint).toContain('— run: codemie proxy analytics enable --claude-otlp');
    });

    it('a failed connector check is an error with a command hint', async () => {
      claudeCollect.mockRejectedValue(new Error('EACCES'));

      const failed = connectorSections(await compose()).find((s) => s.status === 'error');

      expect(failed?.message).toContain('EACCES');
      expect(failed?.hint).toContain('— run: ');
    });

    it('points to codemie proxy analytics status for the tracked and excluded project lists', async () => {
      const pointer = connectorSections(await compose()).find((s) => s.hint?.includes('codemie proxy analytics status'));

      expect(pointer).toBeDefined();
    });
  });

  describe('fix hints', () => {
    it('the hooks-of-another-install hint of a project-scope connector names no --scope, keeping its project list', async () => {
      claudeReadScope.mockResolvedValue({ scope: 'project', paths: ['/a'] });
      collectClientNotices.mockResolvedValue({
        clientPortMismatch: [],
        clientSharedKey: [],
        hooksOfAnotherInstall: [{ connector: 'claude-code-otlp', flag: '--claude-code-otlp', path: '/old/codemie' }],
        lines: [],
      });

      const report = await compose();

      const hooks = report.sections.find((s) => s.message.includes('hooks run another install'));
      expect(hooks?.hint?.endsWith('— run: codemie proxy connect --claude-otlp')).toBe(true);
    });

    it('a failed client check carries a command hint', async () => {
      clientCheckError = 'EACCES';

      const report = await compose();

      const failed = report.sections.find((s) => s.id === 'clients' && s.message.includes('EACCES'));
      expect(failed?.status).toBe('warn');
      expect(failed?.hint).toContain('— run: codemie proxy connect --vscode-claude-code');
    });

    it('an unreadable proxy state is an error with a command hint', async () => {
      readDaemonStatus.mockRejectedValue(new Error('EIO'));

      const report = await compose();

      const daemon = report.sections.find((s) => s.id === 'daemon' && s.message.includes('EIO'));
      expect(daemon?.status).toBe('error');
      expect(daemon?.hint).toContain('— run: ');
    });

    it('every warn and error section carries a hint', async () => {
      collectDeliveryHealth.mockResolvedValue({ status: 'unhealthy', reason: 'send_failed' });
      clientCheckError = 'EACCES';
      claudeReadScope.mockResolvedValue({ invalid: 'x' });

      const report = await compose();

      const bare = report.sections.filter((s) => (s.status === 'warn' || s.status === 'error') && !s.hint);
      expect(bare).toEqual([]);
    });
  });

  it('delivery reports unsent data, the next retry with its error, and the last drop with its remedy', async () => {
    collectDeliveryHealth.mockResolvedValue({
      status: 'unhealthy',
      reason: 'send_failed',
      pendingBytes: 2048,
      heldBytes: 1024,
      sendFailure: { nextAt: Date.now() - 1000, detail: 'request_error' },
      latestDrop: { reason: 'no_project', stream: 'hooks', at: Date.now(), local: true },
    });

    const report = await compose();

    const delivery = report.sections.filter((s) => s.id === 'delivery');
    const text = delivery.map((s) => `${s.message} ${s.hint ?? ''}`).join('\n');
    expect(delivery[0].message).toContain('unhealthy');
    expect(text).toContain('Unsent data: 2.00 KB');
    expect(text).toContain('1.00 KB of it on hold');
    expect(text).toContain('Next retry: due now (backend unreachable)');
    expect(text).toMatch(/Last dropped: no_project \(hooks, \d{4}-\d{2}-\d{2} /);
    expect(delivery.find((s) => s.message.startsWith('Last dropped'))?.hint).toContain('codemie setup');
  });

  it('delivery explains a project-conflict discard as the last drop, with no command to run', async () => {
    collectDeliveryHealth.mockResolvedValue({
      status: 'healthy',
      pendingBytes: 0,
      latestDrop: { reason: 'project_conflict_discard', stream: 'hooks', at: Date.now(), local: true },
    });

    const report = await compose();

    const drop = report.sections.find((s) => s.id === 'delivery' && s.message.startsWith('Last dropped'));
    expect(drop?.message).toMatch(/Last dropped: project_conflict_discard \(hooks, \d{4}-\d{2}-\d{2} /);
    expect(drop?.hint).toBe('the session used folders that belong to different CodeMie projects; part of its data was not sent');
  });

  it('surfaces the daemon watcher recorded health problem', async () => {
    readDaemonStatus.mockResolvedValue({
      running: true,
      state: { ...STATE, health: 'unhealthy', healthReason: 'upstream refused 3 times' },
    });

    const report = await compose();

    const recorded = report.sections.find((s) => s.id === 'daemon' && s.message.includes('upstream refused 3 times'));
    expect(recorded?.status).toBe('warn');
    expect(recorded?.hint).toContain('— run: codemie proxy restart');
  });
});
