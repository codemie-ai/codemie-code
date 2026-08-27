/**
 * OpenCode incremental-sync timer.
 *
 * Unlike codex/pi, this timer floors the interval at MIN_INTERVAL_MS (5s), so the
 * real-timer + waitFor polling used by those suites can never tick inside a test
 * budget. Every case here drives the async tick with fake timers via
 * advanceTimersByTimeAsync, which also flushes the tick's dynamic imports and the
 * (mocked) fs/promises realpath calls.
 *
 * Mirrors codex.incremental-sync.test.ts for the discover -> match cwd -> process ->
 * upload contract; pins the current behaviour as a regression baseline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// Replace ONLY realpath so safeRealpath resolves on the microtask queue (no real
// disk I/O), keeping fake-timer flushing deterministic. Every other fs/promises
// export stays real.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, realpath: vi.fn(async (p: string) => p) };
});

const discoverSessions = vi.fn();
const processSession = vi.fn();

class FakeOpenCodeSessionAdapter {
  discoverSessions = discoverSessions;
  processSession = processSession;
}

vi.mock('../opencode.session.js', () => ({
  OpenCodeSessionAdapter: FakeOpenCodeSessionAdapter,
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

/**
 * Advance the fake clock by roughly `ticks` intervals, yielding to the microtask
 * queue after each step so the async tick body (dynamic imports, mocked realpath)
 * runs to completion before the next assertion.
 */
async function runTicks(intervalMs: number, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await vi.advanceTimersByTimeAsync(intervalMs);
  }
}

const CWD = '/repo/project';

let testCounter = 0;
let currentSessionId = '';

function commonOptions(): Record<string, unknown> {
  return {
    sessionId: currentSessionId,
    startedAt: Date.now(),
    cwd: CWD,
    metadata: { name: 'opencode', dataPaths: { home: '.opencode' } } as never,
    buildContext: () =>
      ({
        sessionId: currentSessionId,
        apiBaseUrl: '',
        cookies: '',
        clientType: 'codemie-opencode',
        version: '0.1.0',
        dryRun: false,
      }) as never,
  };
}

function matchingDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'oc-uuid',
    filePath: '/tmp/opencode.db',
    createdAt: Date.now(),
    projectPath: CWD,
    ...overrides,
  };
}

describe('opencode.incremental-sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    discoverSessions.mockReset();
    processSession.mockReset();
    mockSync.mockReset();
    mockGetStoredCredentials.mockReset();
    delete process.env.CODEMIE_OPENCODE_SYNC_ENABLED;
    delete process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS;
    testCounter++;
    currentSessionId = `oc-${testCounter}`;
  });

  afterEach(async () => {
    const { stopOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
    stopOpenCodeIncrementalSync(currentSessionId);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('toggle', () => {
    it('schedules a periodic tick when enabled (default)', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 3);
      // Enabled + periodic: discoverSessions runs once per tick.
      expect(discoverSessions.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('schedules nothing when CODEMIE_OPENCODE_SYNC_ENABLED=false', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_ENABLED = 'false';
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 5);
      expect(discoverSessions).not.toHaveBeenCalled();
    });

    it('is idempotent — a second start for the same session adds no extra timer', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      // A duplicate timer would double the discover calls; exactly one tick per interval.
      expect(discoverSessions.mock.calls.length).toBe(2);
    });
  });

  describe('interval env', () => {
    it('honours CODEMIE_OPENCODE_SYNC_INTERVAL_MS above the floor', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '8000';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      // Not yet due at 7999ms into the first interval.
      await vi.advanceTimersByTimeAsync(7999);
      expect(discoverSessions).not.toHaveBeenCalled();
      // Fires once the configured 8s elapses.
      await vi.advanceTimersByTimeAsync(1);
      expect(discoverSessions.mock.calls.length).toBe(1);
    });

    it('floors a too-small override to MIN_INTERVAL_MS (5s)', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '1000';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      // The 1s request is clamped to the 5s floor: nothing fires before 5s.
      await vi.advanceTimersByTimeAsync(4999);
      expect(discoverSessions).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(discoverSessions.mock.calls.length).toBe(1);
    });

    it('floors a non-positive override to MIN_INTERVAL_MS rather than hot-looping', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '-5';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await vi.advanceTimersByTimeAsync(4999);
      expect(discoverSessions).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(discoverSessions.mock.calls.length).toBe(1);
    });
  });

  describe('tick matching', () => {
    it('processes the most recent session whose projectPath realpath-matches cwd', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor()]);
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 1);
      expect(processSession.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(processSession.mock.calls[0][0]).toBe('/tmp/opencode.db');
      expect(processSession.mock.calls[0][1]).toBe(currentSessionId);
      // The agent session id from the descriptor is threaded into the context.
      expect(processSession.mock.calls[0][2]).toMatchObject({ agentSessionId: 'oc-uuid' });
    });

    it('skips a session whose projectPath does not match cwd', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor({ projectPath: '/some/other/dir' })]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 1);
      expect(discoverSessions.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(processSession).not.toHaveBeenCalled();
    });

    it('skips a session with no projectPath', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor({ projectPath: undefined })]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 1);
      expect(processSession).not.toHaveBeenCalled();
    });

    it('skips a session created before startedAt - 10s grace', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      const startedAt = Date.now();
      discoverSessions.mockResolvedValue([matchingDescriptor({ createdAt: startedAt - 60_000 })]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync({ ...commonOptions(), startedAt } as never);

      await runTicks(5000, 1);
      expect(discoverSessions.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(processSession).not.toHaveBeenCalled();
    });

    it('does nothing when discoverSessions returns no sessions', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      expect(processSession).not.toHaveBeenCalled();
    });
  });

  describe('resilience', () => {
    it('a failed processSession does not crash the timer and it retries next tick', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor()]);
      processSession.mockRejectedValue(new Error('parse blew up'));

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      // Two ticks each attempted processSession despite the rejection.
      expect(processSession.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(discoverSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('a failed discoverSessions does not crash the timer and it retries next tick', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockRejectedValue(new Error('db locked'));

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      expect(discoverSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('a failed SessionSyncer.sync does not crash the timer and it retries next tick', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor()]);
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
      mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });
      mockSync.mockRejectedValue(new Error('network failure'));

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync({
        ...commonOptions(),
        ssoUrl: 'https://codemie.example.com',
        syncApiUrl: 'https://sync.example.com',
      } as never);

      await runTicks(5000, 2);
      expect(mockSync.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(processSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('upload', () => {
    it('uploads via SessionSyncer as codemie-opencode when sync URLs and credentials are set', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor()]);
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
      mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
      mockSync.mockResolvedValue({ success: true, message: 'ok' });

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync({
        ...commonOptions(),
        ssoUrl: 'https://codemie.example.com',
        syncApiUrl: 'https://sync.example.com',
        cliVersion: '1.2.3',
      } as never);

      await runTicks(5000, 1);
      expect(mockGetStoredCredentials).toHaveBeenCalledWith('https://codemie.example.com');
      expect(mockSync).toHaveBeenCalledWith(
        currentSessionId,
        expect.objectContaining({
          apiBaseUrl: 'https://sync.example.com',
          cookies: 'session=abc123',
          clientType: 'codemie-opencode',
          version: '1.2.3',
          dryRun: false,
          sessionId: currentSessionId,
        })
      );
    });

    it('skips the upload when no sync URLs are configured', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor()]);
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 1);
      expect(processSession.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(mockGetStoredCredentials).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    });

    it('skips the upload when no SSO credentials are stored', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([matchingDescriptor()]);
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
      mockGetStoredCredentials.mockResolvedValue(null);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync({
        ...commonOptions(),
        ssoUrl: 'https://codemie.example.com',
        syncApiUrl: 'https://sync.example.com',
      } as never);

      await runTicks(5000, 1);
      expect(processSession.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(mockSync).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('stopOpenCodeIncrementalSync clears the timer so no further tick runs', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      discoverSessions.mockResolvedValue([]);

      const { startOpenCodeIncrementalSync, stopOpenCodeIncrementalSync } = await import(
        '../opencode.incremental-sync.js'
      );
      startOpenCodeIncrementalSync(commonOptions() as never);
      stopOpenCodeIncrementalSync(currentSessionId);

      await runTicks(5000, 4);
      expect(discoverSessions).not.toHaveBeenCalled();
    });

    it('is safe to call stop for a session that was never started', async () => {
      const { stopOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      expect(() => stopOpenCodeIncrementalSync('never-started')).not.toThrow();
    });
  });
});
