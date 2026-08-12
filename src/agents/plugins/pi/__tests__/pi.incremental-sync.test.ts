/**
 * Pi incremental sync timer.
 *
 * The timer exists so a run killed hard still reports the work it did. What it must
 * never do is guess which transcripts that work lives in: the ledger the CodeMie
 * extension writes from inside Pi is the only source, and the last describe block
 * guards that boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMetadata } from '@/agents/core/types.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';
import type { SessionAdapter } from '@/agents/core/session/BaseSessionAdapter.js';
import { logger } from '@/utils/logger.js';
import type { PiRunLedger } from '../pi.extension.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const readPiRunLedger = vi.fn();
vi.mock('../pi.extension.js', () => ({ readPiRunLedger }));

const mockLoadSession = vi.fn();
vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: class {
    loadSession = mockLoadSession;
  },
}));

const mockSync = vi.fn();
vi.mock('@/providers/plugins/sso/session/SessionSyncer.js', () => ({
  SessionSyncer: class {
    sync = mockSync;
  },
}));

const mockGetStoredCredentials = vi.fn();
vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = mockGetStoredCredentials;
  },
}));

const mockDetectGitBranch = vi.fn();
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  detectGitBranch: mockDetectGitBranch,
}));

const processSession = vi.fn();
const discoverSessions = vi.fn();
const parseSessionFile = vi.fn();

const adapter = {
  agentName: 'pi',
  processSession,
  discoverSessions,
  parseSessionFile,
  registerProcessor: vi.fn(),
} as unknown as SessionAdapter;

const metadata = { name: 'pi', dataPaths: { home: '.pi' } } as unknown as AgentMetadata;

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

function ledger(overrides: Partial<PiRunLedger> = {}): PiRunLedger {
  return {
    loaded: true,
    transcripts: [],
    commandInvocations: {},
    skillCommandInvocations: {},
    ...overrides,
  };
}

let testCounter = 0;
let sessionId = '';

function options(overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    metadata,
    adapter,
    intervalMs: 25,
    buildContext: (): ProcessingContext =>
      ({
        sessionId,
        apiBaseUrl: '',
        cookies: '',
        clientType: 'codemie-pi',
        version: '0.1.0',
        dryRun: false,
      }) as ProcessingContext,
    ...overrides,
  };
}

beforeEach(() => {
  readPiRunLedger.mockReset();
  processSession.mockReset();
  discoverSessions.mockReset();
  parseSessionFile.mockReset();
  mockSync.mockReset();
  mockGetStoredCredentials.mockReset();
  mockLoadSession.mockReset();
  mockDetectGitBranch.mockReset();
  vi.mocked(logger.debug).mockClear();
  delete process.env.CODEMIE_PI_SYNC_ENABLED;
  delete process.env.CODEMIE_PI_SYNC_INTERVAL_MS;

  testCounter++;
  sessionId = `pi-session-${testCounter}`;

  readPiRunLedger.mockResolvedValue(ledger());
  mockLoadSession.mockResolvedValue(null);
  processSession.mockResolvedValue({
    success: true,
    processors: {},
    totalRecords: 1,
    failedProcessors: [],
  });
});

afterEach(async () => {
  const { stopPiIncrementalSync } = await import('../pi.incremental-sync.js');
  // stop drains the in-flight tick, so no mock is reset out from under one.
  await stopPiIncrementalSync(sessionId);
  processSession.mockReset();
  readPiRunLedger.mockReset();
});

describe('startPiIncrementalSync', () => {
  it('processes every transcript the ledger reports, on each tick', async () => {
    readPiRunLedger.mockResolvedValue(
      ledger({ transcripts: ['/pi/a.jsonl', '/pi/b.jsonl'], primaryTranscript: '/pi/b.jsonl' })
    );

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 2);
    expect(processSession.mock.calls[0]).toEqual([
      '/pi/a.jsonl',
      sessionId,
      expect.any(Object),
    ]);
    expect(processSession.mock.calls[1]).toEqual([
      '/pi/b.jsonl',
      sessionId,
      expect.any(Object),
    ]);
    expect(readPiRunLedger).toHaveBeenCalledWith(sessionId);
  });

  it('re-reads the ledger every tick, so a transcript opened mid-run is picked up', async () => {
    readPiRunLedger.mockResolvedValueOnce(ledger({ transcripts: ['/pi/a.jsonl'] }));
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl', '/pi/b.jsonl'] }));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() =>
      processSession.mock.calls.some((call) => call[0] === '/pi/b.jsonl')
    );
  });

  it('does nothing when the ledger reports no transcripts', async () => {
    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => readPiRunLedger.mock.calls.length >= 2);
    expect(processSession).not.toHaveBeenCalled();
  });

  it('keeps processing the remaining transcripts when one of them fails', async () => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/bad.jsonl', '/pi/good.jsonl'] }));
    processSession.mockImplementation(async (path: string) => {
      if (path === '/pi/bad.jsonl') throw new Error('unreadable');
      return { success: true, processors: {}, totalRecords: 1, failedProcessors: [] };
    });

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() =>
      processSession.mock.calls.some((call) => call[0] === '/pi/good.jsonl')
    );
  });

  it('survives a ledger read that throws and ticks again', async () => {
    readPiRunLedger.mockRejectedValueOnce(new Error('ledger gone'));
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 1);
  });

  it('does not overlap ticks when one runs longer than the interval', async () => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/slow.jsonl'] }));
    let release: () => void = () => {};
    processSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ success: true, processors: {}, totalRecords: 0, failedProcessors: [] });
        })
    );

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options({ intervalMs: 20 }));

    await waitFor(() => processSession.mock.calls.length >= 1);
    // Several intervals elapse while the first tick is still parked.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(processSession).toHaveBeenCalledTimes(1);

    release();
  });

  it('does not start when CODEMIE_PI_SYNC_ENABLED=false', async () => {
    process.env.CODEMIE_PI_SYNC_ENABLED = 'false';
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readPiRunLedger).not.toHaveBeenCalled();
  });

  it('reads the interval from CODEMIE_PI_SYNC_INTERVAL_MS when none is injected', async () => {
    process.env.CODEMIE_PI_SYNC_INTERVAL_MS = '25';
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options({ intervalMs: undefined }));

    await waitFor(() => processSession.mock.calls.length >= 2);
  });

  /**
   * `setInterval` clamps any delay below 1 to 1 ms rather than rejecting it, so an env
   * var of `-5` does not fall back to the default — it re-parses every transcript a
   * thousand times a second.
   */
  it('falls back to the default when CODEMIE_PI_SYNC_INTERVAL_MS is not positive', async () => {
    process.env.CODEMIE_PI_SYNC_INTERVAL_MS = '-5';
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options({ intervalMs: undefined }));

    await new Promise((resolve) => setTimeout(resolve, 120));
    // The 30 s default cannot have fired; a 1 ms hot loop would have fired ~100 times.
    expect(readPiRunLedger).not.toHaveBeenCalled();
  });

  it('is idempotent — a second start for the same session is a no-op', async () => {
    const { startPiIncrementalSync, stopPiIncrementalSync } = await import(
      '../pi.incremental-sync.js'
    );
    startPiIncrementalSync(options({ intervalMs: 15 }));
    startPiIncrementalSync(options({ intervalMs: 15 }));

    expect(vi.mocked(logger.debug).mock.calls.flat()).toContain(
      `[pi-incremental-sync] Already running for session ${sessionId}`
    );

    // A single stop must silence the session completely: a second, unreachable timer
    // would keep ticking past it.
    await waitFor(() => readPiRunLedger.mock.calls.length >= 1);
    await stopPiIncrementalSync(sessionId);
    const ticksAtStop = readPiRunLedger.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readPiRunLedger.mock.calls.length).toBe(ticksAtStop);
  });
});

describe('stopPiIncrementalSync', () => {
  it('clears the timer so no further tick runs', async () => {
    const { startPiIncrementalSync, stopPiIncrementalSync } = await import(
      '../pi.incremental-sync.js'
    );
    startPiIncrementalSync(options());
    await stopPiIncrementalSync(sessionId);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(readPiRunLedger).not.toHaveBeenCalled();
  });

  it('is safe to call for a session that was never started', async () => {
    const { stopPiIncrementalSync } = await import('../pi.incremental-sync.js');
    await expect(stopPiIncrementalSync('never-started')).resolves.toBeUndefined();
  });

  /**
   * `clearInterval` cancels the schedule, not the tick already running. The caller stops
   * the timer and immediately runs the end-of-session flush over the same metrics JSONL;
   * if stop returns while a tick is mid-parse, both read the file's record ids before
   * either appends and every delta lands twice.
   */
  it('does not resolve until the tick that is already running has finished', async () => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/slow.jsonl'] }));
    let release: () => void = () => {};
    let tickFinished = false;
    processSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            tickFinished = true;
            resolve({ success: true, processors: {}, totalRecords: 0, failedProcessors: [] });
          };
        })
    );

    const { startPiIncrementalSync, stopPiIncrementalSync } = await import(
      '../pi.incremental-sync.js'
    );
    startPiIncrementalSync(options({ intervalMs: 15 }));
    await waitFor(() => processSession.mock.calls.length >= 1);

    let stopResolved = false;
    const stopped = stopPiIncrementalSync(sessionId).then(() => {
      stopResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stopResolved).toBe(false);

    release();
    await stopped;
    expect(tickFinished).toBe(true);
  });

  it('leaves no in-flight state behind, so a later start cannot overlap it', async () => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/slow.jsonl'] }));
    let release: () => void = () => {};
    processSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ success: true, processors: {}, totalRecords: 0, failedProcessors: [] });
        })
    );

    const { startPiIncrementalSync, stopPiIncrementalSync } = await import(
      '../pi.incremental-sync.js'
    );
    startPiIncrementalSync(options({ intervalMs: 15 }));
    await waitFor(() => processSession.mock.calls.length >= 1);

    const stopped = stopPiIncrementalSync(sessionId);
    release();
    await stopped;

    // A stale "tick in flight" entry would make every tick of the restarted timer a no-op.
    startPiIncrementalSync(options({ intervalMs: 15 }));
    await waitFor(() => processSession.mock.calls.length >= 2);
  });
});

/**
 * `stop` runs on the way out of the CLI, immediately before the session-end flush.
 *
 * It has to outlast the phase that appends deltas — an overlap with the flush writes every
 * one of them twice — without outlasting the phase that uploads them, which is a 30 s API
 * timeout over three attempts per batch and would hold the exit open for minutes whenever
 * the sync host is unreachable.
 */
describe('stopping while a tick is in flight', () => {
  const syncUrls = {
    ssoUrl: 'https://codemie.example.com',
    syncApiUrl: 'https://sync.example.com',
  };

  beforeEach(() => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });
  });

  it('never starts an upload once a stop has been requested', async () => {
    mockSync.mockResolvedValue({ success: true, message: 'ok' });
    let release: () => void = () => {};
    processSession.mockImplementation(
      () =>
        new Promise((resolveProcess) => {
          release = () =>
            resolveProcess({ success: true, processors: {}, totalRecords: 0, failedProcessors: [] });
        })
    );

    const { startPiIncrementalSync, stopPiIncrementalSync } = await import(
      '../pi.incremental-sync.js'
    );
    startPiIncrementalSync(options({ ...syncUrls, intervalMs: 15 }));
    await waitFor(() => processSession.mock.calls.length >= 1);

    const stopped = stopPiIncrementalSync(sessionId);
    release();
    await stopped;

    // The parse still had to finish — it is what appends. The upload is what the
    // session-end flush is about to redo anyway.
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('gives up on an upload that never returns instead of hanging the exit', async () => {
    let release: () => void = () => {};
    mockSync.mockImplementation(
      () =>
        new Promise((resolveSync) => {
          release = () => resolveSync({ success: true, message: 'ok' });
        })
    );

    const { startPiIncrementalSync, stopPiIncrementalSync } = await import(
      '../pi.incremental-sync.js'
    );
    startPiIncrementalSync(options({ ...syncUrls, intervalMs: 15 }));
    // The tick is now parked inside the upload, where no signal can reach it.
    await waitFor(() => mockSync.mock.calls.length >= 1);

    try {
      const outcome = await Promise.race([
        stopPiIncrementalSync(sessionId, 30).then(() => 'stopped' as const),
        new Promise<'hung'>((resolveHung) => setTimeout(() => resolveHung('hung'), 500)),
      ]);
      expect(outcome).toBe('stopped');
    } finally {
      // Let the abandoned tick settle before the suite resets the mocks under it —
      // including when the assertion above fails, or teardown waits on it forever.
      release();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  });
});

describe('the tick context', () => {
  beforeEach(() => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));
  });

  /**
   * The metrics aggregator emits one record per distinct branch, so deltas written
   * without one are attributed to a separate, empty-branch bucket for the same session.
   */
  it('carries the git branch recorded for the CodeMie session', async () => {
    mockLoadSession.mockResolvedValue({ sessionId, gitBranch: 'feat/codemie-pi-metrics-parity' });

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 1);
    expect(processSession.mock.calls[0][2]).toMatchObject({
      gitBranch: 'feat/codemie-pi-metrics-parity',
    });
  });

  /**
   * `codemie pi --session /other/repo/x.jsonl` runs the whole session in the transcript's
   * checkout, and `correlateRunToSession` rewrites the session record's branch to match —
   * but only at session end. A tick that stamped the launch branch would leave the
   * aggregator emitting two branch records for one session, split at the last tick.
   */
  it('uses the branch of the checkout the transcript actually ran in', async () => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'], cwd: '/other/repo' }));
    mockLoadSession.mockResolvedValue({
      sessionId,
      gitBranch: 'launch-branch',
      workingDirectory: '/launch/repo',
    });
    mockDetectGitBranch.mockResolvedValue('transcript-branch');

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(
      options({
        // The launch branch is all the caller can know, and it is the wrong one here.
        buildContext: (): ProcessingContext =>
          ({ sessionId, gitBranch: 'launch-branch' }) as ProcessingContext,
      })
    );

    await waitFor(() => processSession.mock.calls.length >= 1);
    expect(mockDetectGitBranch).toHaveBeenCalledWith('/other/repo');
    expect(processSession.mock.calls[0][2]).toMatchObject({ gitBranch: 'transcript-branch' });
  });

  it('keeps the session branch, and shells out to no git, when the run stayed put', async () => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'], cwd: '/launch/repo' }));
    mockLoadSession.mockResolvedValue({
      sessionId,
      gitBranch: 'launch-branch',
      workingDirectory: '/launch/repo',
    });

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 1);
    expect(mockDetectGitBranch).not.toHaveBeenCalled();
    expect(processSession.mock.calls[0][2]).toMatchObject({ gitBranch: 'launch-branch' });
  });

  it('survives a session record that cannot be read', async () => {
    mockLoadSession.mockRejectedValue(new Error('session file gone'));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 1);
    expect(processSession.mock.calls[0][2]).not.toHaveProperty('gitBranch');
  });

  /**
   * Pi writes the assistant message carrying a toolCall before running the tool, so a
   * long call is unresolved every time a tick lands on it. Reporting it as status-less
   * mid-run claims its record id and permanently erases the real outcome.
   */
  it('tells the processor that a missing tool result is not yet final', async () => {
    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 1);
    expect(processSession.mock.calls[0][2]).toMatchObject({ emitUnresolvedToolCalls: false });
  });
});

describe('upload', () => {
  beforeEach(() => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));
  });

  it('uploads as codemie-pi once per tick when credentials are available', async () => {
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
    mockSync.mockResolvedValue({ success: true, message: 'ok' });

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(
      options({
        ssoUrl: 'https://codemie.example.com',
        syncApiUrl: 'https://sync.example.com',
        cliVersion: '1.2.3',
      })
    );

    await waitFor(() => mockSync.mock.calls.length >= 1);
    expect(mockGetStoredCredentials).toHaveBeenCalledWith('https://codemie.example.com');
    expect(mockSync).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        apiBaseUrl: 'https://sync.example.com',
        cookies: 'session=abc123',
        clientType: 'codemie-pi',
        version: '1.2.3',
        dryRun: false,
        sessionId,
      })
    );
  });

  it('skips the upload when no sync URLs are configured', async () => {
    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mockGetStoredCredentials).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('skips the upload when no SSO credentials are stored', async () => {
    mockGetStoredCredentials.mockResolvedValue(null);

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(
      options({
        ssoUrl: 'https://codemie.example.com',
        syncApiUrl: 'https://sync.example.com',
      })
    );

    await waitFor(() => processSession.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('keeps ticking after an upload failure, so the payloads are retried', async () => {
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });
    mockSync.mockRejectedValue(new Error('network failure'));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(
      options({
        ssoUrl: 'https://codemie.example.com',
        syncApiUrl: 'https://sync.example.com',
      })
    );

    await waitFor(() => processSession.mock.calls.length >= 2);
  });
});

/**
 * Regression guard for the redesign.
 *
 * Codex's timer discovers sessions and then filters the candidates by start time and
 * project path. That heuristic cross-attributes whenever two runs share a directory,
 * and it was deleted from this plugin. The timer must ask the ledger and nothing else.
 */
describe('the tick performs no run attribution', () => {
  it('never enumerates the session directory', async () => {
    readPiRunLedger.mockResolvedValue(ledger({ transcripts: ['/pi/a.jsonl'] }));

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 2);
    expect(discoverSessions).not.toHaveBeenCalled();
    expect(parseSessionFile).not.toHaveBeenCalled();
  });

  it('processes exactly the ledger transcripts, in ledger order, without filtering', async () => {
    readPiRunLedger.mockResolvedValue(
      ledger({ transcripts: ['/pi/c.jsonl', '/pi/a.jsonl', '/pi/b.jsonl'] })
    );

    const { startPiIncrementalSync } = await import('../pi.incremental-sync.js');
    startPiIncrementalSync(options());

    await waitFor(() => processSession.mock.calls.length >= 3);
    expect(processSession.mock.calls.slice(0, 3).map((call) => call[0])).toEqual([
      '/pi/c.jsonl',
      '/pi/a.jsonl',
      '/pi/b.jsonl',
    ]);
  });
});
