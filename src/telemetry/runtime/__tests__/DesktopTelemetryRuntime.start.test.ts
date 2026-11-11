/**
 * The start-up pass of a Desktop daemon: which failed sends spend a delivery attempt, how many records it takes, and
 * its order with the first poll.
 *
 * Seams: `DesktopTelemetryRuntime.start()` over a temp ~/.codemie; SessionSyncer, the SSO credentials, the process
 * table and the transcripts' stat() are the boundary and are stubbed. The end metric is a stub, or the real metrics
 * client with `fetch` stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '@/agents/core/session/types.js';
import { logger } from '@/utils/logger.js';

const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);
const mockSync = vi.fn().mockResolvedValue({ message: 'ok' });
const mockGetStoredCredentials = vi.fn();
const transcriptStats = new Map<string, { mtimeMs: number; size: number }>();

/** The pid of a daemon that is gone. */
const DEAD_PID = 999_999;

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(async (path: string) => transcriptStats.get(path) ?? actual.stat(path))
  };
});

vi.mock('@/providers/plugins/sso/index.js', async () => {
  const { MetricsSender } = await vi.importActual<typeof import('@/providers/plugins/sso/session/processors/metrics/metrics-api-client.js')>(
    '@/providers/plugins/sso/session/processors/metrics/metrics-api-client.js'
  );
  return {
    MetricsSender: vi.fn(function (this: Record<string, unknown>, options: ConstructorParameters<typeof MetricsSender>[0]) {
      this.real = new MetricsSender(options);
      this.sendSessionStart = mockSendSessionStart;
      this.sendSessionEnd = mockSendSessionEnd;
    })
  };
});

vi.mock('@/providers/plugins/sso/session/SessionSyncer.js', () => ({
  SessionSyncer: vi.fn(function (this: Record<string, unknown>) {
    this.sync = mockSync;
  })
}));

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function (this: Record<string, unknown>) {
    this.getStoredCredentials = mockGetStoredCredentials;
  })
}));

// The process table: this test process is the live daemon, every other owner is gone.
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  detectGitRemoteRepo: vi.fn(async (cwd: string) => `codemie-ai/${cwd.split('/').pop()}`),
  detectGitBranch: vi.fn(async (cwd: string) => `branch-${cwd.split('/').pop()}`),
  isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => pid === process.pid)
}));

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})) }
}));

import { RECONCILE_PER_START } from '@/agents/core/session/stale-session-reconciliation.js';
import { DesktopTelemetryRuntime } from '../DesktopTelemetryRuntime.js';
import type { DesktopTelemetryRuntimeConfig, LocalTelemetryAdapter, LocalTelemetryDiscoveredSession } from '../types.js';

const POLL_INTERVAL_MS = 10_000;
const T0 = new Date('2026-09-29T10:00:00Z').getTime();
const HOUR_MS = 60 * 60 * 1000;

const config: DesktopTelemetryRuntimeConfig = {
  clientType: 'claude-desktop',
  targetApiUrl: 'https://api.example.com',
  provider: 'ai-run-sso',
  version: '1.0.0',
  pollIntervalMs: POLL_INTERVAL_MS,
  inactivityTimeoutMs: 300_000
};

let codemieHome: string;
const previousCodemieHome = process.env.CODEMIE_HOME;
let desktopSessions: Map<string, LocalTelemetryDiscoveredSession>;
const startedRuntimes: DesktopTelemetryRuntime[] = [];

function sessionsDir(): string {
  return join(codemieHome, 'sessions');
}

function transcriptPathFor(externalSessionId: string): string {
  return `/transcripts/${externalSessionId}.jsonl`;
}

/** The record as on disk: its live `{id}.json`, else its `completed_{id}.json`. */
function readRecord(sessionId: string): Session | undefined {
  for (const name of [`${sessionId}.json`, `completed_${sessionId}.json`]) {
    const path = join(sessionsDir(), name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as Session;
  }
  return undefined;
}

function recordFiles(): string[] {
  return readdirSync(sessionsDir()).filter(name => !name.endsWith('.lock')).sort();
}

/** A record a previous daemon left on disk for the Desktop chat `externalSessionId`. */
function writeRecord(externalSessionId: string, fields: Partial<Session>): string {
  const sessionId = fields.sessionId ?? '00000000-0000-4000-8000-000000000001';
  const record: Session = {
    sessionId,
    agentName: 'claude-desktop',
    provider: 'ai-run-sso',
    startTime: T0 - HOUR_MS,
    workingDirectory: '/Users/test/codemie-ai/codemie-code',
    status: 'active',
    activeDurationMs: 0,
    correlation: {
      status: 'matched',
      agentSessionId: `agent-${externalSessionId}`,
      agentSessionFile: transcriptPathFor(externalSessionId),
      retryCount: 0
    },
    runtimeCheckpoint: {
      externalSessionId,
      transcriptPath: transcriptPathFor(externalSessionId),
      lastDiscoveredAt: T0 - 30 * 60_000,
      lastSeenActivityAt: T0 - 40 * 60_000
    },
    ...fields
  };
  writeFileSync(join(sessionsDir(), `${sessionId}.json`), JSON.stringify(record));
  return sessionId;
}

/** Claude Desktop reports activity in the chat `externalSessionId` at `updatedAt`. */
function desktopActivity(externalSessionId: string, updatedAt: number): void {
  transcriptStats.set(transcriptPathFor(externalSessionId), { mtimeMs: updatedAt, size: 200 });
  desktopSessions.set(externalSessionId, {
    externalSessionId,
    agentSessionId: `agent-${externalSessionId}`,
    transcriptPath: transcriptPathFor(externalSessionId),
    metadataPath: `/metadata/${externalSessionId}.json`,
    workingDirectory: '/Users/test/codemie-ai/codemie-code',
    createdAt: T0 - HOUR_MS,
    updatedAt,
    model: 'claude-sonnet-5'
  });
}

function createAdapter(): LocalTelemetryAdapter {
  return {
    clientType: 'claude-desktop',
    discoverSessions: vi.fn(async (sinceMs: number) =>
      [...desktopSessions.values()].filter(session => session.updatedAt >= sinceMs).map(session => ({ ...session }))
    ),
    parseSession: vi.fn(async (_discovered: LocalTelemetryDiscoveredSession, sessionId: string) => ({
      sessionId, agentName: 'claude-desktop', metadata: {}, messages: []
    }) as never),
    processParsedSession: vi.fn(async () => ({ success: true, processors: {}, totalRecords: 0, failedProcessors: [] })) as never
  };
}

/** Starts a runtime and waits for its start-up pass and first poll. */
async function startRuntime(): Promise<DesktopTelemetryRuntime> {
  const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
  startedRuntimes.push(runtime);
  await runtime.start();
  await (runtime as any).startupChain;
  return runtime;
}

/** Waits (real time) until `condition` holds; fails the test after ~5 s. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

type FetchOutcome = 'refused' | '503' | '429' | 'blocked' | 'not-success' | 'ok' | 'timeout';

const jsonAnswer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The end metric goes through the real metrics client (three tries); `fetch` meets each try with the next
 * outcome, the last one repeating: refused before the connection opened, a JSON 503 or 429, a WAF's HTML 403 block
 * page, a 200 reporting `success: false`, a 200 accepting it, or no answer until the request's own timeout aborts it.
 */
function endMetricMeets(...outcomes: FetchOutcome[]): void {
  mockSendSessionEnd.mockImplementation(function (this: { real: { sendSessionEnd: (...args: unknown[]) => Promise<unknown> } }, ...args: unknown[]) {
    return this.real.sendSessionEnd(...args);
  });
  let call = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
    if (outcome === 'refused') {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    }
    if (outcome === '503') return jsonAnswer(503, { message: 'unavailable' });
    if (outcome === '429') return jsonAnswer(429, { message: 'too many requests' });
    if (outcome === 'not-success') return jsonAnswer(200, { success: false, message: 'rejected' });
    if (outcome === 'ok') return jsonAnswer(200, { success: true, message: 'ok' });
    if (outcome === 'blocked') {
      return new Response('<html><body>403 Forbidden</body></html>', { status: 403, headers: { 'content-type': 'text/html' } });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    });
  });
}

/** Runs `work` with the client's backoff and request timeouts on the fake clock from the current fake time. */
async function onDaemonClock(work: () => Promise<void>): Promise<void> {
  const realSetTimeout = setTimeout;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
  try {
    let finished = false;
    const run = work().finally(() => { finished = true; });
    for (let step = 0; !finished && step < 2000; step++) {
      await vi.advanceTimersByTimeAsync(25);
      await new Promise(resolve => realSetTimeout(resolve, 1));
    }
    await run;
  } finally {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  }
}

/** One daemon start and stop on the fake clock (see {@link onDaemonClock}). */
async function startAndStopOnFakeClock(): Promise<void> {
  await onDaemonClock(() => startRuntime().then(runtime => runtime.stop()));
}

describe('DesktopTelemetryRuntime start-up pass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    codemieHome = mkdtempSync(join(tmpdir(), 'desktop-runtime-start-'));
    process.env.CODEMIE_HOME = codemieHome;
    mkdirSync(sessionsDir(), { recursive: true });
    transcriptStats.clear();
    desktopSessions = new Map();
    mockSendSessionStart.mockResolvedValue(undefined);
    mockSendSessionEnd.mockResolvedValue(undefined);
    mockSync.mockResolvedValue({ message: 'ok' });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
  });

  afterEach(async () => {
    for (const runtime of startedRuntimes.splice(0)) clearInterval((runtime as any).timer);
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Closed before the removal: Windows cannot delete an open file
    await logger.close();
    rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (previousCodemieHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousCodemieHome;
  });

  describe('a delivery whose request no server served spends no attempt', () => {
    const undelivered = (fields: Partial<Session> = {}) => writeRecord('ext-1', {
      status: 'completed',
      reason: 'desktop-inactive-timeout',
      endTime: T0 - 40 * 60_000,
      ownerPid: DEAD_PID,
      ...fields
    });

    it('an end metric refused at the connection gives the attempt back and keeps the record live', async () => {
      const sessionId = undelivered();
      endMetricMeets('refused');

      await startAndStopOnFakeClock();

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('an end metric answered 503 gives the attempt back and keeps the record live', async () => {
      const sessionId = undelivered();
      endMetricMeets('503');

      await startAndStopOnFakeClock();

      expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('an end metric answered 503, then timed out on its retry, spends the attempt', async () => {
      const sessionId = undelivered();
      endMetricMeets('503', 'timeout');

      await startAndStopOnFakeClock();

      expect(readRecord(sessionId)!.deliveryAttempts).toBe(1);
    });

    it('an end metric answered 429 with a JSON body gives the attempt back', async () => {
      const sessionId = undelivered();
      endMetricMeets('429');

      await startAndStopOnFakeClock();

      expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
    });

    it('an end metric answered 200 with success false spends the attempt', async () => {
      const sessionId = undelivered();
      endMetricMeets('not-success');

      await startAndStopOnFakeClock();

      expect(readRecord(sessionId)!.deliveryAttempts).toBe(1);
    });

    it('a record at 2 attempts stays at 2 through three starts under a 503: never renamed, never dropped', async () => {
      const sessionId = undelivered({ deliveryAttempts: 2 });
      endMetricMeets('503');

      for (let start = 0; start < 3; start++) await startAndStopOnFakeClock();

      expect(readRecord(sessionId)!.deliveryAttempts).toBe(2);
      expect(readRecord(sessionId)).not.toHaveProperty('droppedAt');
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('starts under a 403 HTML block page spend no attempt, never rename the record and mark no credentials invalid', async () => {
      const sessionId = undelivered();
      endMetricMeets('blocked');

      for (let start = 0; start < 4; start++) {
        await startAndStopOnFakeClock();
        expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
        expect(recordFiles()).toEqual([`${sessionId}.json`]);
      }
      expect(existsSync(join(codemieHome, 'analytics-auth-status.json'))).toBe(false);
    });

    it('an outage answering 503 through an inactivity finalize and 4 starts spends nothing; the first start under a working server delivers once', async () => {
      endMetricMeets('503');
      desktopActivity('ext-1', T0);
      const runtime = await startRuntime();
      const sessionId = readdirSync(sessionsDir()).find(name => name.endsWith('.json'))!.replace(/\.json$/, '');
      vi.setSystemTime(T0 + config.inactivityTimeoutMs + 1);
      await onDaemonClock(() => runtime.triggerPoll());
      await runtime.stop();
      expect(readRecord(sessionId)).toMatchObject({ status: 'completed', reason: 'desktop-inactive-timeout' });
      expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
      expect(recordFiles()).toEqual([`${sessionId}.json`]);

      for (let start = 0; start < 4; start++) {
        await startAndStopOnFakeClock();
        expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
        expect(recordFiles()).toEqual([`${sessionId}.json`]);
      }

      endMetricMeets('ok');
      const fetchSpy = vi.mocked(globalThis.fetch);
      fetchSpy.mockClear();
      await startAndStopOnFakeClock();
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
      expect(readRecord(sessionId)!.endMetricSentAt).toBeTypeOf('number');
      expect(readRecord(sessionId)).not.toHaveProperty('droppedAt');

      fetchSpy.mockClear();
      await startAndStopOnFakeClock();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a try that timed out spends the attempt though its retries were refused', async () => {
      const sessionId = undelivered();
      endMetricMeets('timeout', 'refused');

      await startAndStopOnFakeClock();

      expect(readRecord(sessionId)!.deliveryAttempts).toBe(1);
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('after two counted failures, starts under a refused connection stay at 2 and never rename it', async () => {
      const sessionId = undelivered();
      endMetricMeets('timeout');
      for (let start = 0; start < 2; start++) await startAndStopOnFakeClock();
      expect(readRecord(sessionId)!.deliveryAttempts).toBe(2);

      endMetricMeets('refused');
      for (let start = 0; start < 2; start++) {
        await startAndStopOnFakeClock();
        expect(readRecord(sessionId)!.deliveryAttempts).toBe(2);
        expect(recordFiles()).toEqual([`${sessionId}.json`]);
      }
    });
  });

  it('finalizes a predecessor\'s active record before the first poll reopens it as a new stretch', async () => {
    const T1 = T0 - 40 * 60_000;
    const recordStart = T0 - HOUR_MS;
    const sessionId = writeRecord('ext-1', {
      startTime: recordStart,
      ownerPid: DEAD_PID,
      ownerStartedAt: T0 - 2 * HOUR_MS,
      runtimeCheckpoint: {
        externalSessionId: 'ext-1',
        transcriptPath: transcriptPathFor('ext-1'),
        lastDiscoveredAt: T1,
        lastSeenActivityAt: T1
      }
    });
    const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
    startedRuntimes.push(runtime);
    const T3 = T0 + 1_000;
    vi.setSystemTime(T3);
    desktopActivity('ext-1', T3);
    // The pass's end metric resolves only when the test lets it: a poll racing the pass would run meanwhile
    let resolveEndMetric!: () => void;
    mockSendSessionEnd.mockImplementationOnce(() => new Promise<void>(resolve => { resolveEndMetric = resolve; }));

    const started = runtime.start();
    await waitFor(() => mockSendSessionEnd.mock.calls.length === 1);
    expect((runtime as any).isPolling).toBe(false);
    expect(readRecord(sessionId)).toMatchObject({ status: 'completed', reason: 'desktop-daemon-restart', endTime: T1 });
    resolveEndMetric();
    await started;
    await (runtime as any).startupChain;

    const [, , , durationMs, , , endTime] = mockSendSessionEnd.mock.calls[0];
    expect(durationMs).toBe(20 * 60_000);
    expect(endTime).toBe(T1);
    expect(recordFiles()).toEqual([`${sessionId}.json`]);
    expect(readRecord(sessionId)).toMatchObject({ status: 'active', ownerPid: process.pid, startTime: recordStart, stretchStartTime: T3 });
    await runtime.stop();
  });

  it('takes at most RECONCILE_PER_START records, newest first, and leaves the rest untouched', async () => {
    // Minutes before T0 - 1 h, out of file-name order; the two oldest are ids[2] and ids[4]
    const ages = [3, 0, 6, 1, 5, 2, 4];
    expect(ages).toHaveLength(RECONCILE_PER_START + 2);
    const ids = ages.map((age, index) => writeRecord(`ext-${index}`, {
      sessionId: `00000000-0000-4000-8000-00000000001${index}`,
      status: 'completed',
      reason: 'desktop-inactive-timeout',
      startTime: T0 - HOUR_MS - age * 60_000,
      endTime: T0 - 40 * 60_000,
      ownerPid: DEAD_PID
    }));
    const oldest = [ids[2], ids[4]];
    const before = oldest.map(id => readFileSync(join(sessionsDir(), `${id}.json`), 'utf-8'));
    // Fails each send, so the taken records stay live with their attempt spent
    mockSendSessionEnd.mockRejectedValue(new Error('HTTP 503'));

    await startRuntime();

    expect(mockSendSessionEnd).toHaveBeenCalledTimes(RECONCILE_PER_START);
    for (const id of ids.filter(id => !oldest.includes(id))) expect(readRecord(id)!.deliveryAttempts).toBe(1);
    expect(oldest.map(id => readFileSync(join(sessionsDir(), `${id}.json`), 'utf-8'))).toEqual(before);
  });

  it('finalizes a dead daemon\'s active record past the cap and sends RECONCILE_PER_START undelivered ones', async () => {
    const T1 = T0 - 40 * 60_000;
    const recordStart = T0 - 2 * HOUR_MS;
    // The oldest `startTime` of all: a cap over every kind would cut it first
    const activeId = writeRecord('ext-active', {
      startTime: recordStart,
      ownerPid: DEAD_PID,
      ownerStartedAt: T0 - 3 * HOUR_MS,
      runtimeCheckpoint: {
        externalSessionId: 'ext-active',
        transcriptPath: transcriptPathFor('ext-active'),
        lastDiscoveredAt: T1,
        lastSeenActivityAt: T1
      }
    });
    // Minutes before T0 - 1 h; the oldest of them is ids[3]
    const ages = [1, 0, 4, 6, 2, 5];
    expect(ages).toHaveLength(RECONCILE_PER_START + 1);
    const ids = ages.map((age, index) => writeRecord(`ext-${index}`, {
      sessionId: `00000000-0000-4000-8000-00000000001${index}`,
      status: 'completed',
      reason: 'desktop-inactive-timeout',
      startTime: T0 - HOUR_MS - age * 60_000,
      endTime: T0 - 50 * 60_000,
      ownerPid: DEAD_PID
    }));
    const oldestBefore = readFileSync(join(sessionsDir(), `${ids[3]}.json`), 'utf-8');
    const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
    startedRuntimes.push(runtime);
    const T3 = T0 + 1_000;
    vi.setSystemTime(T3);
    desktopActivity('ext-active', T3);
    let resolveEndMetric!: () => void;
    mockSendSessionEnd.mockImplementationOnce(() => new Promise<void>(resolve => { resolveEndMetric = resolve; }));

    await runtime.start();
    await waitFor(() => mockSendSessionEnd.mock.calls.length === 1);
    expect(readRecord(activeId)).toMatchObject({ status: 'completed', reason: 'desktop-daemon-restart', endTime: T1 });
    resolveEndMetric();
    await (runtime as any).startupChain;

    expect(mockSendSessionEnd).toHaveBeenCalledTimes(RECONCILE_PER_START + 1);
    const [, , , , , , endTime] = mockSendSessionEnd.mock.calls[0];
    expect(endTime).toBe(T1);
    expect(recordFiles()).toEqual([
      `${activeId}.json`,
      `${ids[3]}.json`,
      ...ids.filter(id => id !== ids[3]).map(id => `completed_${id}.json`)
    ].sort());
    expect(readFileSync(join(sessionsDir(), `${ids[3]}.json`), 'utf-8')).toBe(oldestBefore);
    expect(readRecord(activeId)).toMatchObject({ status: 'active', ownerPid: process.pid, startTime: recordStart, stretchStartTime: T3 });
    await runtime.stop();
  });

  describe('start() does not wait for the start-up pass', () => {
    /** An undelivered record whose end metric stays pending until the returned release is called. */
    function pendingEndMetric(): () => void {
      writeRecord('ext-1', { status: 'completed', reason: 'desktop-inactive-timeout', endTime: T0 - 40 * 60_000, ownerPid: DEAD_PID });
      let release!: () => void;
      mockSendSessionEnd.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      return () => release();
    }

    it('resolves while the pass\'s end metric is still pending', async () => {
      const release = pendingEndMetric();
      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      startedRuntimes.push(runtime);
      let resolved = false;
      void runtime.start().then(() => { resolved = true; });

      await waitFor(() => mockSendSessionEnd.mock.calls.length === 1);
      expect(resolved).toBe(true);
      release();
      await (runtime as any).startupChain;
      await runtime.stop();
    });

    it('runs no poll and arms no timer after the pass when stop() came first', async () => {
      const release = pendingEndMetric();
      const adapter = createAdapter();
      const runtime = new DesktopTelemetryRuntime(adapter, config);
      startedRuntimes.push(runtime);
      await runtime.start();
      await waitFor(() => mockSendSessionEnd.mock.calls.length === 1);

      await runtime.stop();
      // stop()'s own final poll
      expect(adapter.discoverSessions).toHaveBeenCalledTimes(1);
      release();
      await (runtime as any).startupChain;

      expect(adapter.discoverSessions).toHaveBeenCalledTimes(1);
      expect((runtime as any).timer).toBeUndefined();
    });

    it('arms no timer when stop() came during the chain\'s first poll', async () => {
      const adapter = createAdapter();
      let inPoll!: () => void;
      const pollReached = new Promise<void>(resolve => { inPoll = resolve; });
      let releasePoll!: () => void;
      vi.mocked(adapter.discoverSessions).mockImplementationOnce(async () => {
        inPoll();
        await new Promise<void>(resolve => { releasePoll = resolve; });
        return [];
      });
      const runtime = new DesktopTelemetryRuntime(adapter, config);
      startedRuntimes.push(runtime);
      await runtime.start();
      await pollReached;

      await runtime.stop();
      releasePoll();
      await (runtime as any).startupChain;

      expect((runtime as any).timer).toBeUndefined();
    });

    it('polls nothing and arms no timer on a start() after stop()', async () => {
      const adapter = createAdapter();
      const runtime = new DesktopTelemetryRuntime(adapter, config);
      startedRuntimes.push(runtime);
      await runtime.start();
      await (runtime as any).startupChain;
      await runtime.stop();
      // the first chain's poll and stop()'s final poll
      expect(adapter.discoverSessions).toHaveBeenCalledTimes(2);

      await runtime.start();
      await (runtime as any).startupChain;

      expect(adapter.discoverSessions).toHaveBeenCalledTimes(2);
      expect((runtime as any).timer).toBeUndefined();
    });
  });
});
