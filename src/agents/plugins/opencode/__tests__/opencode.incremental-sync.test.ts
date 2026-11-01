/**
 * OpenCode incremental-sync timer.
 *
 * Unlike codex/pi, this timer floors the interval at MIN_INTERVAL_MS (5s), so the
 * real-timer + waitFor polling used by those suites can never tick inside a test
 * budget. Every case here drives the async tick with fake timers via
 * advanceTimersByTimeAsync, which also flushes the tick's dynamic imports.
 *
 * The locate -> process -> upload contract; which session the record's run owns is the
 * shared selection's (opencode.run-session.test.ts).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const locateSessionTranscript = vi.fn();
const processSession = vi.fn();

class FakeOpenCodeSessionAdapter {
  locateSessionTranscript = locateSessionTranscript;
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
 * queue after each step so the async tick body (dynamic imports)
 * runs to completion before the next assertion.
 */
async function runTicks(intervalMs: number, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await vi.advanceTimersByTimeAsync(intervalMs);
  }
}

let testCounter = 0;
let currentSessionId = '';

function commonOptions(): Record<string, unknown> {
  return {
    sessionId: currentSessionId,
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

describe('opencode.incremental-sync', () => {
  beforeAll(async () => {
    // The upload path lazily imports the credential helper; load it once up front so
    // the fake-timer ticks below don't have to wait for real module I/O.
    await import('../../../../providers/core/codemie-auth-helpers.js');
  });

  beforeEach(() => {
    vi.useFakeTimers();
    locateSessionTranscript.mockReset();
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
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 3);
      // Enabled + periodic: the lookup runs once per tick.
      expect(locateSessionTranscript.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('schedules nothing when CODEMIE_OPENCODE_SYNC_ENABLED=false', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_ENABLED = 'false';
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 5);
      expect(locateSessionTranscript).not.toHaveBeenCalled();
    });

    it('is idempotent — a second start for the same session adds no extra timer', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      // A duplicate timer would double the lookups; exactly one tick per interval.
      expect(locateSessionTranscript.mock.calls.length).toBe(2);
    });
  });

  describe('interval env', () => {
    it('honours CODEMIE_OPENCODE_SYNC_INTERVAL_MS above the floor', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '8000';
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      // Not yet due at 7999ms into the first interval.
      await vi.advanceTimersByTimeAsync(7999);
      expect(locateSessionTranscript).not.toHaveBeenCalled();
      // Fires once the configured 8s elapses.
      await vi.advanceTimersByTimeAsync(1);
      expect(locateSessionTranscript.mock.calls.length).toBe(1);
    });

    it('floors a too-small override to MIN_INTERVAL_MS (5s)', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '1000';
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      // The 1s request is clamped to the 5s floor: nothing fires before 5s.
      await vi.advanceTimersByTimeAsync(4999);
      expect(locateSessionTranscript).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(locateSessionTranscript.mock.calls.length).toBe(1);
    });

    it('floors a non-positive override to MIN_INTERVAL_MS rather than hot-looping', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '-5';
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await vi.advanceTimersByTimeAsync(4999);
      expect(locateSessionTranscript).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(locateSessionTranscript.mock.calls.length).toBe(1);
    });
  });

  describe('tick', () => {
    it('processes the transcript the shared selection located for the record, as the record', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 1);
      expect(locateSessionTranscript).toHaveBeenCalledWith(currentSessionId);
      // The located session's id: processing takes it without selecting again
      expect(processSession).toHaveBeenCalledWith(
        '/tmp/opencode.db',
        currentSessionId,
        expect.objectContaining({ agentSessionId: 'ses_run' })
      );
    });

    it('processes each located session of the run in turn, under its own id', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_newer', 'ses_older'] });
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 1);
      expect(processSession.mock.calls.map(([, , context]) => context.agentSessionId)).toEqual(['ses_newer', 'ses_older']);
    });

    it('bounds the tick by the located run\'s upper bound; none when no later record exists', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript
        .mockResolvedValueOnce({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'], recordsBeforeMs: 1_700_000_060_000 })
        .mockResolvedValueOnce({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      expect(processSession.mock.calls.map(([, , context]) => context.recordsBeforeMs)).toEqual([1_700_000_060_000, undefined]);
    });

    it('does nothing when no session of the run is located', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      expect(processSession).not.toHaveBeenCalled();
    });
  });

  describe('resilience', () => {
    it('a failed processSession does not crash the timer and it retries next tick', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
      processSession.mockRejectedValue(new Error('parse blew up'));

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      // Two ticks each attempted processSession despite the rejection.
      expect(processSession.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(locateSessionTranscript.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('a failed lookup does not crash the timer and it retries next tick', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockRejectedValue(new Error('db locked'));

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync(commonOptions() as never);

      await runTicks(5000, 2);
      expect(locateSessionTranscript.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('a failed SessionSyncer.sync does not crash the timer and it retries next tick', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
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
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
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

    it('uploads with the clientType returned by buildContext() (e.g. codemie-opencode-acp)', async () => {
      // Regression guard: the upload context used to hardcode 'codemie-opencode'
      // regardless of what buildContext() returned, so opencode-acp sessions
      // were mistagged in the upload path even though onSessionStart's
      // buildContext() already carried the correct clientType.
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
      processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
      mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
      mockSync.mockResolvedValue({ success: true, message: 'ok' });

      const { startOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      startOpenCodeIncrementalSync({
        ...commonOptions(),
        buildContext: () =>
          ({
            sessionId: currentSessionId,
            apiBaseUrl: '',
            cookies: '',
            clientType: 'codemie-opencode-acp',
            version: '0.1.0',
            dryRun: false,
          }) as never,
        ssoUrl: 'https://codemie.example.com',
        syncApiUrl: 'https://sync.example.com',
        cliVersion: '1.2.3',
      } as never);

      await runTicks(5000, 1);
      expect(mockSync).toHaveBeenCalledWith(
        currentSessionId,
        expect.objectContaining({ clientType: 'codemie-opencode-acp' })
      );
    });

    it('skips the upload when no sync URLs are configured', async () => {
      process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS = '5000';
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
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
      locateSessionTranscript.mockResolvedValue({ transcript: '/tmp/opencode.db', sessionIds: ['ses_run'] });
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
      locateSessionTranscript.mockResolvedValue(undefined);

      const { startOpenCodeIncrementalSync, stopOpenCodeIncrementalSync } = await import(
        '../opencode.incremental-sync.js'
      );
      startOpenCodeIncrementalSync(commonOptions() as never);
      stopOpenCodeIncrementalSync(currentSessionId);

      await runTicks(5000, 4);
      expect(locateSessionTranscript).not.toHaveBeenCalled();
    });

    it('is safe to call stop for a session that was never started', async () => {
      const { stopOpenCodeIncrementalSync } = await import('../opencode.incremental-sync.js');
      expect(() => stopOpenCodeIncrementalSync('never-started')).not.toThrow();
    });
  });
});
