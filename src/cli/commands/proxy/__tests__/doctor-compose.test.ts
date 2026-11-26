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
  const { backendDoctorPlan } = await import('../doctor/backend-plan.js');
  return composeProxyDoctor({ ...opts, plan: backendDoctorPlan });
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

  describe('the Desktop section', () => {
    it('is ok while collecting', async () => {
      collectDesktopCollection.mockResolvedValue({ connected: true, collecting: true });

      const desktop = (await compose()).sections.find((s) => s.id === 'desktop');

      expect(desktop).toMatchObject({ status: 'ok', message: 'Claude Desktop: collecting' });
    });

    it('is info, with the enable command, while analytics are disabled: a choice, not a fault', async () => {
      collectDesktopCollection.mockResolvedValue({
        connected: true,
        collecting: false,
        analyticsDisabled: true,
        reason: 'analytics are disabled',
        remedy: 'run: codemie proxy analytics enable --claude-otlp',
      });

      const desktop = (await compose()).sections.find((s) => s.id === 'desktop');

      expect(desktop?.status).toBe('info');
      expect(desktop?.message).toBe('Claude Desktop: not collecting — analytics are disabled');
      expect(desktop?.hint).toContain('codemie proxy analytics enable --claude-otlp');
    });

    it('stays a warning when Desktop is not collecting for another reason', async () => {
      collectDesktopCollection.mockResolvedValue({
        connected: true,
        collecting: false,
        reason: 'the analytics preferences file is unreadable (fix or delete /p)',
      });

      expect((await compose()).sections.find((s) => s.id === 'desktop')?.status).toBe('warn');
    });
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
      expect(connectors?.message).toBe('None connected');
      expect(connectors?.hint).toBe('no analytics collected — run: codemie proxy connect --claude-otlp (or --copilot-otlp)');
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

  describe('unsent data on hold, per reason', () => {
    const unsent = async (): Promise<string[]> => {
      const report = await compose();
      return report.sections.filter((s) => s.id === 'delivery' && s.message.startsWith('Unsent data')).map((s) => s.message);
    };

    it('stays one line without a hold (f)', async () => {
      collectDeliveryHealth.mockResolvedValue({ status: 'healthy', pendingBytes: 16650 });
      expect(await unsent()).toEqual(['Unsent data: 16.26 KB (all sessions on this machine)']);
    });

    it('lists a reason the table does not know as On hold with its size and no Fix', async () => {
      collectDeliveryHealth.mockResolvedValue({ status: 'healthy', pendingBytes: 16650, heldBytes: 16650, heldByReason: { some_unlisted_reason: 16650 } });
      expect(await unsent()).toEqual([
        [
          'Unsent data: 16.26 KB (all sessions on this machine), 16.26 KB of it on hold',
          '      On hold: some unlisted reason (16.26 KB)',
        ].join('\n'),
      ]);
    });

    it('adds an On hold / Fix block for one reason', async () => {
      collectDeliveryHealth.mockResolvedValue({ status: 'healthy', pendingBytes: 16650, heldBytes: 16650, heldByReason: { work_consent_required: 16650 } });
      expect(await unsent()).toEqual([
        [
          'Unsent data: 16.26 KB (all sessions on this machine), 16.26 KB of it on hold',
          '      On hold: personal Claude subscription sessions need work consent',
          '      Fix: codemie proxy analytics consent grant, then codemie proxy analytics resend (run in this repository, or add --all to grant for every repository)',
        ].join('\n'),
      ]);
    });

    it('adds one block per reason, in table order', async () => {
      const { HOLD_REASONS } = await import('../doctor/delivery-sections.js');
      HOLD_REASONS.test_second_reason = { text: 'second reason text', fix: 'second fix text' };
      try {
        collectDeliveryHealth.mockResolvedValue({
          status: 'healthy',
          pendingBytes: 20480,
          heldBytes: 20480,
          heldByReason: { test_second_reason: 4096, work_consent_required: 16384 },
        });
        expect(await unsent()).toEqual([
          [
            'Unsent data: 20.00 KB (all sessions on this machine), 20.00 KB of it on hold',
            '      On hold: personal Claude subscription sessions need work consent',
            '      Fix: codemie proxy analytics consent grant, then codemie proxy analytics resend (run in this repository, or add --all to grant for every repository)',
            '      On hold: second reason text',
            '      Fix: second fix text',
          ].join('\n'),
        ]);
      } finally {
        delete HOLD_REASONS.test_second_reason;
      }
    });
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
  describe('local plan', () => {
    const JOB = 'CodeMieLocalTestJob';
    const NEWEST = new Date('2026-11-20T10:00:00.000Z');
    let home: string;
    let settings: Record<string, unknown>;
    let jobState: 'enabled' | 'disabled';
    let marker: Date | null;
    let unreadableMarker: string | undefined;
    let runLog: string;
    let loadError: Error | undefined;

    beforeEach(async () => {
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      home = await mkdtemp(join(tmpdir(), 'doctor-local-'));
      vi.stubEnv('CODEMIE_HOME', home);
      await writeFile(join(home, 'node'), '');
      await writeFile(join(home, 'codemie.js'), '');
      settings = {
        webhookUrl: 'https://hooks.example.invalid/x?sig=FAKE',
        format: 'json',
        includeExternal: 'never',
        at: '03:00',
        taskName: JOB,
        local: true,
        localJob: { node: join(home, 'node'), entry: join(home, 'codemie.js') },
      };
      jobState = 'enabled';
      marker = new Date('2026-11-21T03:00:05.000Z');
      unreadableMarker = undefined;
      runLog = '2026-11-21T03:00:05.000Z ok sent codemie-analytics-a-2026-11-21.otlp.jsonl.gz 512 target=webhook';
      loadError = undefined;
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      const { rm } = await import('node:fs/promises');
      await rm(home, { recursive: true, force: true });
    });

    async function sessionsFolder(names: string[]): Promise<void> {
      const { mkdir, writeFile, utimes } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const folder = join(home, 'analytics', 'sessions');
      await mkdir(folder, { recursive: true });
      for (const [index, name] of names.entries()) {
        await writeFile(join(folder, name), '{}\n');
        const at = new Date(NEWEST.getTime() - index * 60_000);
        await utimes(join(folder, name), at, at);
      }
    }

    async function localPlan() {
      const { localDoctorPlan } = await import('../../shared/analytics-collection/local-doctor.js');
      return localDoctorPlan({
        loadSettings: async () => {
          if (loadError) throw loadError;
          return settings as never;
        },
        schedulerFor: (name: string) => ({
          preflight: async () => undefined,
          register: async () => ({}),
          unregister: async () => false,
          query: async () => (name === JOB ? jobState : 'disabled'),
          exists: async () => 'present' as const,
        }),
        readLog: async () => runLog,
        readMarker: async (target: string) => {
          if (target === unreadableMarker) throw new Error('EACCES: permission denied, open \'last-push\'');
          return marker;
        },
        now: () => new Date('2026-11-22T00:00:00.000Z'),
        print: () => undefined,
        modeLines: () => [],
      });
    }

    async function composeLocal(authProbe = true) {
      const { composeProxyDoctor } = await import('../doctor/compose.js');
      return composeProxyDoctor({ authProbe, verbose: false, plan: await localPlan() });
    }

    const localRows = (report: { sections: Array<{ id: string; status: string; message: string; hint?: string }> }) =>
      report.sections.filter((s) => s.id === 'local').map(({ status, message, hint }) => ({ status, message, ...(hint && { hint }) }));

    it('shows no sign-in, upstream or delivery section, runs no keyed request, and names the daemon by the mode', async () => {
      hookConnected.mockResolvedValue(true);
      await sessionsFolder(['s1.hooks.jsonl']);

      const report = await composeLocal();

      expect(report.sections.filter((s) => ['auth', 'upstream', 'delivery'].includes(s.id))).toEqual([]);
      expect(signIn).not.toHaveBeenCalled();
      expect(collectDeliveryHealth).not.toHaveBeenCalled();
      expect(report.sections.find((s) => s.id === 'daemon')?.message)
        .toBe('Running at http://127.0.0.1:4001 (pid 4242, local analytics mode, version 1.0.0)');
      expect((await localPlan()).groups.map((group) => group.title)).toEqual([
        'Daemon', 'Clients', 'Analytics connectors', 'Local analytics', 'Claude Desktop collection', 'Environment', 'Details',
      ]);
    });

    it('a present folder, an enabled job and a delivered target are ok', async () => {
      await sessionsFolder(['s1.hooks.jsonl', 's1.otel_logs.jsonl', 's2.hooks.jsonl', 's3.moving']);

      expect(localRows(await composeLocal())).toEqual([
        { status: 'ok', message: 'Local analytics folder: 2 sessions, newest 2026-11-20T10:00:00.000Z' },
        { status: 'ok', message: `Scheduled job ${JOB}: enabled` },
        { status: 'info', message: 'Last run (webhook): 2026-11-21T03:00:05.000Z — sent (codemie-analytics-a-2026-11-21.otlp.jsonl.gz 512)' },
        { status: 'ok', message: 'Last delivery to webhook: 2026-11-21T03:00:05.000Z' },
      ]);
    });

    it('a missing folder, a disabled job and a missing Node are problems with the install hint; a never-sent target is none', async () => {
      const { join } = await import('node:path');
      jobState = 'disabled';
      marker = null;
      settings = { ...settings, localJob: { node: join(home, 'gone', 'node'), entry: join(home, 'codemie.js') } };
      const hint = 'Run `codemie analytics sync install` again.';

      expect(localRows(await composeLocal())).toEqual([
        { status: 'warn', message: `Local analytics folder is missing (${join(home, 'analytics', 'sessions')})`, hint },
        { status: 'error', message: `Scheduled job ${JOB}: not registered or disabled`, hint },
        { status: 'error', message: `The scheduled job points at a missing Node or CLI (${join(home, 'gone', 'node')})`, hint },
        { status: 'info', message: 'Last run (webhook): 2026-11-21T03:00:05.000Z — sent (codemie-analytics-a-2026-11-21.otlp.jsonl.gz 512)' },
        { status: 'info', message: 'Nothing delivered yet to webhook' },
      ]);
    });

    it('a last run that failed warns with the run hint', async () => {
      runLog = '2026-11-22T03:00:05.000Z fail delivery webhook answered 500 target=webhook\n';
      await sessionsFolder(['s1.hooks.jsonl']);

      expect(localRows(await composeLocal())).toEqual([
        { status: 'ok', message: 'Local analytics folder: 1 session, newest 2026-11-20T10:00:00.000Z' },
        { status: 'ok', message: `Scheduled job ${JOB}: enabled` },
        {
          status: 'warn',
          message: 'Last run (webhook): 2026-11-22T03:00:05.000Z — failed (delivery webhook answered 500)',
          hint: 'Run `codemie analytics sync run` to try again.',
        },
        { status: 'ok', message: 'Last delivery to webhook: 2026-11-21T03:00:05.000Z' },
      ]);
    });

    it.each([
      'OTLP files not built, the marker stays and the next run tries them again: boom',
      'last-sent marker not saved, the next run re-sends this window: boom',
    ])('a last run that delivered with the warning "%s" warns with the run hint', async (warning) => {
      runLog = `2026-11-22T03:00:05.000Z ok sent f.otlp.jsonl.gz 512 (warning: ${warning}) target=webhook\n`;
      await sessionsFolder(['s1.hooks.jsonl']);

      expect(localRows(await composeLocal())).toContainEqual({
        status: 'warn',
        message: `Last run (webhook): 2026-11-22T03:00:05.000Z — sent (f.otlp.jsonl.gz 512 (warning: ${warning}))`,
        hint: 'Run `codemie analytics sync run` to try again.',
      });
    });

    it('a last run that skipped for no sessions in its window is no problem', async () => {
      runLog = '2026-11-22T03:00:05.000Z skip no sessions in window 2026-11-15-to-2026-11-22 target=webhook\n';
      await sessionsFolder(['s1.hooks.jsonl']);

      expect(localRows(await composeLocal())).toContainEqual({
        status: 'info',
        message: 'Last run (webhook): 2026-11-22T03:00:05.000Z — skipped (no sessions in window 2026-11-15-to-2026-11-22)',
      });
    });

    it('a last run that skipped with sessions left out warns with the run hint', async () => {
      runLog =
        '2026-11-22T03:00:05.000Z skip no sessions in window 2026-11-15-to-2026-11-22 (warning: OTLP files built without 1 session: s1 (boom)) target=webhook\n';
      await sessionsFolder(['s1.hooks.jsonl']);

      expect(localRows(await composeLocal())).toContainEqual({
        status: 'warn',
        message:
          'Last run (webhook): 2026-11-22T03:00:05.000Z — skipped (no sessions in window 2026-11-15-to-2026-11-22 (warning: OTLP files built without 1 session: s1 (boom)))',
        hint: 'Run `codemie analytics sync run` to try again.',
      });
    });

    it('a stopped daemon warns with the start remedy, and the local rows are still produced', async () => {
      readDaemonStatus.mockResolvedValue({ running: false, state: null });
      clientConnected.mockResolvedValue(false);
      hookConnected.mockResolvedValue(true);
      await sessionsFolder(['s1.hooks.jsonl']);

      const report = await composeLocal();

      expect(report.sections.find((s) => s.id === 'daemon')).toEqual({
        id: 'daemon',
        status: 'warn',
        message: 'Proxy is not running; analytics hooks start it on their next event',
        hint: 'the proxy is stopped — run: codemie proxy start, or the next Claude Code or Copilot event starts it',
      });
      expect(localRows(report).map((row) => row.message)).toContain(`Scheduled job ${JOB}: enabled`);
    });

    it('an unreadable marker of one target of two warns on that target alone, and every other row stays', async () => {
      settings = { ...settings, git: { repoUrl: 'https://git.example.invalid/analytics.git' } };
      await sessionsFolder(['s1.hooks.jsonl']);
      const readable = localRows(await composeLocal());
      unreadableMarker = 'git';

      const rows = localRows(await composeLocal());

      expect(rows).toEqual([
        { status: 'ok', message: 'Local analytics folder: 1 session, newest 2026-11-20T10:00:00.000Z' },
        { status: 'ok', message: `Scheduled job ${JOB}: enabled` },
        { status: 'info', message: 'Last run (webhook): 2026-11-21T03:00:05.000Z — sent (codemie-analytics-a-2026-11-21.otlp.jsonl.gz 512)' },
        { status: 'ok', message: 'Last delivery to webhook: 2026-11-21T03:00:05.000Z' },
        { status: 'info', message: 'Last run (git): never' },
        { status: 'warn', message: "Last delivery to git: unknown (EACCES: permission denied, open 'last-push')", hint: 'Remove the delivery marker (`analytics-last-sent*` in the CodeMie home); the next delivery writes it again.' },
      ]);
      expect(rows.slice(0, 5)).toEqual(readable.slice(0, 5));
    });

    it('a local section builder that throws is one local error row, and the composition resolves', async () => {
      loadError = new Error('Sync settings at /x is not valid JSON.');
      await sessionsFolder(['s1.hooks.jsonl']);

      const rows = localRows(await composeLocal());

      expect(rows).toEqual([{
        status: 'error',
        message: 'Local analytics check failed: Sync settings at /x is not valid JSON.',
        hint: 'the check could not run — run: CODEMIE_DEBUG=true codemie proxy doctor',
      }]);
    });

    it('no hint of any row names proxy connect or proxy disconnect', async () => {
      const reports: Array<Awaited<ReturnType<typeof composeLocal>>> = [];
      // Running, with every client and connector problem the kept sections report.
      collectClientNotices.mockResolvedValue({
        clientPortMismatch: [{ flag: '--vscode-claude-code', configuredPort: 4999 }],
        clientSharedKey: [{ flag: '--vscode-claude-code', refused: false }, { flag: '--vscode-claude-code', refused: true }],
        hooksOfAnotherInstall: [{ connector: 'claude-code-otlp', flag: '--claude-code-otlp', path: '/other/codemie' }],
        lines: [],
      });
      checkClaudeCodeOtlpEndpoint.mockResolvedValue({ matches: false, configured: 'http://127.0.0.1:4999/v1/analytics/otlp', expected: 'http://127.0.0.1:4001/v1/analytics/otlp' });
      claudeReadScope.mockResolvedValue({ invalid: 'not an array' });
      copilotReadScope.mockResolvedValue({ invalid: 'corrupt' });
      collectDesktopCollection.mockResolvedValue({ connected: true, collecting: false, reason: 'not connected', remedy: 'run: codemie analytics sync install' });
      reports.push(await composeLocal());
      // Running with nothing connected, then stopped with a gateway client and with nothing.
      clientConnected.mockResolvedValue(false);
      claudeCollect.mockResolvedValue(claudeStatus());
      collectClientNotices.mockResolvedValue({ clientPortMismatch: [], clientSharedKey: [], hooksOfAnotherInstall: [], lines: [] });
      reports.push(await composeLocal());
      readDaemonStatus.mockResolvedValue({ running: false, state: null });
      reports.push(await composeLocal());
      clientConnected.mockResolvedValue(true);
      reports.push(await composeLocal());

      const hints = reports.flatMap((report) => report.sections.map((s) => s.hint ?? ''));
      expect(hints.filter((hint) => hint.includes('codemie analytics sync install')).length).toBeGreaterThan(0);
      expect(hints.filter((hint) => /proxy (connect|disconnect)/.test(hint))).toEqual([]);
    });

    it('a gateway client connected and no connector: the None connected hint names the install command and no connect flag', async () => {
      claudeCollect.mockResolvedValue(claudeStatus());
      await sessionsFolder(['s1.hooks.jsonl']);

      const connectors = (await composeLocal()).sections.find((s) => s.id === 'connectors');

      expect(connectors?.message).toBe('None connected');
      expect(connectors?.hint).toContain('codemie analytics sync install');
      expect(connectors?.hint).not.toMatch(/--copilot-otlp|--claude-otlp/);
    });
  });
});
