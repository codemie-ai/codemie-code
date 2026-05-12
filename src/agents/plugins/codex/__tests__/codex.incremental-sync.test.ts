import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const discoverSessions = vi.fn();
const parseSessionFile = vi.fn();
const processSession = vi.fn();

class FakeCodexSessionAdapter {
  discoverSessions = discoverSessions;
  parseSessionFile = parseSessionFile;
  processSession = processSession;
}

vi.mock('../codex.session.js', () => ({
  CodexSessionAdapter: FakeCodexSessionAdapter,
}));

const mockSync = vi.fn();
const mockGetStoredCredentials = vi.fn();

vi.mock('../../../../providers/plugins/sso/session/SessionSyncer.js', () => ({
  SessionSyncer: class {
    sync = mockSync;
  },
}));

vi.mock('../../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = mockGetStoredCredentials;
  },
}));

/** Wait until predicate returns true, polling every 10ms; fails after timeoutMs. */
async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let testCounter = 0;
let currentSessionId = '';

describe('codex.incremental-sync', () => {
  beforeEach(() => {
    discoverSessions.mockReset();
    parseSessionFile.mockReset();
    processSession.mockReset();
    mockSync.mockReset();
    mockGetStoredCredentials.mockReset();
    delete process.env.CODEMIE_CODEX_SYNC_ENABLED;
    delete process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS;
    testCounter++;
    currentSessionId = `s-${testCounter}`;
  });

  afterEach(async () => {
    const { stopCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    stopCodexIncrementalSync(currentSessionId);
    // Drain any in-flight tick that started before stop.
    await new Promise((resolve) => setTimeout(resolve, 60));
    discoverSessions.mockReset();
    parseSessionFile.mockReset();
    processSession.mockReset();
  });

  function commonOptions() {
    return {
      sessionId: currentSessionId,
      startedAt: Date.now(),
      cwd: process.cwd(),
      metadata: { name: 'codex', dataPaths: { home: '.codex' } } as never,
      buildContext: () =>
        ({
          sessionId: currentSessionId,
          apiBaseUrl: '',
          cookies: '',
          clientType: 'codemie-codex',
          version: '0.1.0',
          dryRun: false,
        }) as never,
    };
  }

  it('runs a tick on the configured interval and matches realpath cwd', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync(commonOptions());

    await waitFor(() => processSession.mock.calls.length >= 2);
    expect(processSession.mock.calls[0]).toEqual([
      '/tmp/rollout.jsonl',
      currentSessionId,
      expect.any(Object),
    ]);
  });

  it('skips rollouts whose projectPath does not realpath-match cwd', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '30';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: '/some/other/dir' } });

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync(commonOptions());

    await waitFor(() => parseSessionFile.mock.calls.length >= 1);
    // Give the tick a chance to finish; processSession must NOT be called.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(processSession).not.toHaveBeenCalled();
  });

  it('skips rollouts older than startedAt - 10s', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '30';
    const startedAt = Date.now();
    discoverSessions.mockResolvedValue([
      { sessionId: 'old', filePath: '/tmp/old.jsonl', createdAt: startedAt - 60_000, agentName: 'codex' },
    ]);

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync({ ...commonOptions(), startedAt });

    await waitFor(() => discoverSessions.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(parseSessionFile).not.toHaveBeenCalled();
    expect(processSession).not.toHaveBeenCalled();
  });

  it('does not start a timer when CODEMIE_CODEX_SYNC_ENABLED=false', async () => {
    process.env.CODEMIE_CODEX_SYNC_ENABLED = 'false';
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '20';

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync(commonOptions());

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(discoverSessions).not.toHaveBeenCalled();
  });

  it('is idempotent — second start with same sessionId is a no-op', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '40';
    discoverSessions.mockResolvedValue([]);

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync(commonOptions());
    startCodexIncrementalSync(commonOptions());

    await waitFor(() => discoverSessions.mock.calls.length >= 1);
    // Wait a bit longer to confirm no extra ticks pile up from a duplicate timer.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // One timer at 40ms over ~150ms produces ≈3-4 ticks; two timers would produce ≈6-8.
    expect(discoverSessions.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('stopCodexIncrementalSync clears the timer', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '30';
    discoverSessions.mockResolvedValue([]);

    const { startCodexIncrementalSync, stopCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync(commonOptions());
    stopCodexIncrementalSync(currentSessionId);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(discoverSessions).not.toHaveBeenCalled();
  });

  it('calls SessionSyncer.sync() on tick when ssoUrl/syncApiUrl set and credentials available', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
    mockSync.mockResolvedValue({ success: true, message: 'ok' });

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync({
      ...commonOptions(),
      ssoUrl: 'https://codemie.example.com',
      syncApiUrl: 'https://sync.example.com',
      cliVersion: '1.2.3',
    });

    await waitFor(() => mockSync.mock.calls.length >= 1);
    expect(mockGetStoredCredentials).toHaveBeenCalledWith('https://codemie.example.com');
    expect(mockSync).toHaveBeenCalledWith(
      currentSessionId,
      expect.objectContaining({
        apiBaseUrl: 'https://sync.example.com',
        cookies: 'session=abc123',
        clientType: 'codemie-codex',
        version: '1.2.3',
        dryRun: false,
        sessionId: currentSessionId,
      })
    );
  });

  it('skips upload when ssoUrl or syncApiUrl is not set', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync(commonOptions());

    await waitFor(() => processSession.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockGetStoredCredentials).not.toHaveBeenCalled();
  });

  it('skips upload when SSO credentials are not available', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
    mockGetStoredCredentials.mockResolvedValue(null);

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync({
      ...commonOptions(),
      ssoUrl: 'https://codemie.example.com',
      syncApiUrl: 'https://sync.example.com',
    });

    await waitFor(() => processSession.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('continues the tick even if the upload throws', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });
    mockSync.mockRejectedValue(new Error('network failure'));

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync({
      ...commonOptions(),
      ssoUrl: 'https://codemie.example.com',
      syncApiUrl: 'https://sync.example.com',
    });

    await waitFor(() => processSession.mock.calls.length >= 2);
  });
});
