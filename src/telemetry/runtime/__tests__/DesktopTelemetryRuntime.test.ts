import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '@/agents/core/session/types.js';

const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);
const mockSync = vi.fn().mockResolvedValue({ message: 'ok' });
const mockGetStoredCredentials = vi.fn();
/** When set, MetricsSender is the real one and `fetch` is the HTTP boundary. */
let realMetricsSender = false;
/** When set, SessionSyncer is the real one and `fetch` is the HTTP boundary. */
let realSessionSyncer = false;

/** The pid of a daemon that is gone. */
const DEAD_PID = 999_999;

// Simulated Claude Desktop transcripts: message count plus the stat() fingerprint.
interface FakeTranscript {
  messages: number;
  /** Write time of each message, so a baseline cutoff can tell old content from new. */
  messageTimes: number[];
  mtimeMs: number;
  size: number;
}
const transcripts = new Map<string, FakeTranscript>();

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(async (path: string) => {
      const transcript = transcripts.get(path);
      if (!transcript) {
        if (path.startsWith('/transcripts/')) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        }
        return actual.stat(path);
      }
      return { mtimeMs: transcript.mtimeMs, size: transcript.size };
    }),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink)
  };
});

vi.mock('@/providers/plugins/sso/index.js', async () => {
  const actual = await vi.importActual<typeof import('@/providers/plugins/sso/session/processors/metrics/metrics-api-client.js')>(
    '@/providers/plugins/sso/session/processors/metrics/metrics-api-client.js'
  );
  return {
    MetricsSender: vi.fn(function (this: Record<string, unknown>, options: ConstructorParameters<typeof actual.MetricsSender>[0]) {
      if (realMetricsSender) return new actual.MetricsSender(options);
      this.sendSessionStart = mockSendSessionStart;
      this.sendSessionEnd = mockSendSessionEnd;
    })
  };
});

vi.mock('@/providers/plugins/sso/session/SessionSyncer.js', async () => {
  const actual = await vi.importActual<typeof import('@/providers/plugins/sso/session/SessionSyncer.js')>(
    '@/providers/plugins/sso/session/SessionSyncer.js'
  );
  return {
    SessionSyncer: vi.fn(function (this: Record<string, unknown>) {
      if (realSessionSyncer) return new actual.SessionSyncer();
      this.sync = mockSync;
    })
  };
});

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
  ConfigLoader: { load: vi.fn(async (cwd: string) => ({ codeMieProject: `project-${cwd.split('/').pop()}` })) }
}));

import { rename, unlink } from 'fs/promises';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
import { reconcileLockPath } from '@/agents/core/session/stale-session-reconciliation.js';
import { acquirePidLock, PID_LOCK_WAIT_BUDGET_MS } from '@/utils/pid-lock.js';
import { processStartedAt } from '@/utils/processes.js';
import { clearAnalyticsAuthStatus, getAnalyticsAuthStatus, markAnalyticsAuthInvalid } from '@/utils/analytics-auth-status.js';
import { DesktopTelemetryRuntime } from '../DesktopTelemetryRuntime.js';
import { DESKTOP_REDELIVERY_INTERVAL_MS, DESKTOP_REOPEN_LOCK_BUDGET_MS } from '../desktop-session.js';
import type {
  LocalTelemetryAdapter,
  DesktopTelemetryRuntimeConfig,
  LocalTelemetryDiscoveredSession
} from '../types.js';

const POLL_INTERVAL_MS = 10_000;
const INACTIVITY_TIMEOUT_MS = 300_000;
const T0 = new Date('2026-09-29T10:00:00Z').getTime();

const config: DesktopTelemetryRuntimeConfig = {
  clientType: 'claude-desktop',
  targetApiUrl: 'https://api.example.com',
  provider: 'ai-run-sso',
  version: '1.0.0',
  pollIntervalMs: POLL_INTERVAL_MS,
  inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS
};

const HOUR_MS = 60 * 60 * 1000;

let codemieHome: string;
const previousCodemieHome = process.env.CODEMIE_HOME;

function sessionsDir(): string {
  return join(codemieHome, 'sessions');
}

/** A fresh, empty ~/.codemie, as on a machine the daemon never ran on. */
function resetCodemieHome(): void {
  if (codemieHome) rmSync(codemieHome, { recursive: true, force: true });
  codemieHome = mkdtempSync(join(tmpdir(), 'desktop-runtime-'));
  process.env.CODEMIE_HOME = codemieHome;
  mkdirSync(sessionsDir(), { recursive: true });
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

/** Every record file of the client, live and completed. */
function persistedRecords(): Session[] {
  return readdirSync(sessionsDir())
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(sessionsDir(), name), 'utf-8')) as Session);
}

/** A record a previous daemon (or the CLI) left on disk for the Desktop chat `externalSessionId`. */
function writeRecord(externalSessionId: string, fields: Partial<Session>): string {
  const sessionId = `00000000-0000-4000-8000-${String(persistedRecords().length + 1).padStart(12, '0')}`;
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

/** Waits (real time) until `condition` holds; fails the test after ~5 s. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

/** Starts a runtime with `start()` and waits for its start-up scan. */
async function startRuntime(adapter: LocalTelemetryAdapter): Promise<DesktopTelemetryRuntime> {
  const runtime = new DesktopTelemetryRuntime(adapter, config);
  await runtime.start();
  await (runtime as any).startupPass;
  return runtime;
}

/** Every delta the fake conversations processor queued for sync, per session. */
let sentDeltas: Array<{ externalSessionId: string; historyIndices: number[] }>;
/** Sessions Claude Desktop currently reports, keyed by external id. */
let desktopSessions: Map<string, LocalTelemetryDiscoveredSession>;

function transcriptPathFor(externalSessionId: string): string {
  return `/transcripts/${externalSessionId}.jsonl`;
}

/** Claude Desktop creates a chat with `messages` messages already in it. */
function openDesktopChat(externalSessionId: string, messages: number, createdAt: number): void {
  const transcriptPath = transcriptPathFor(externalSessionId);
  transcripts.set(transcriptPath, {
    messages,
    messageTimes: Array.from({ length: messages }, () => createdAt),
    mtimeMs: createdAt,
    size: messages * 100
  });
  desktopSessions.set(externalSessionId, {
    externalSessionId,
    agentSessionId: `agent-${externalSessionId}`,
    transcriptPath,
    metadataPath: `/metadata/${externalSessionId}.json`,
    workingDirectory: '/Users/test/codemie-ai/codemie-code',
    createdAt,
    updatedAt: createdAt,
    model: 'claude-sonnet-5'
  });
}

/** The user sends `count` more messages: transcript grows and Desktop bumps lastActivityAt. */
function appendMessages(externalSessionId: string, count: number): void {
  const transcript = transcripts.get(transcriptPathFor(externalSessionId))!;
  transcript.messages += count;
  transcript.messageTimes.push(...Array.from({ length: count }, () => Date.now()));
  transcript.mtimeMs = Date.now();
  transcript.size += count * 100;
  touchDesktopChat(externalSessionId);
}

/** Desktop bumps lastActivityAt without writing to the transcript (focus, open, scroll). */
function touchDesktopChat(externalSessionId: string): void {
  desktopSessions.get(externalSessionId)!.updatedAt = Date.now();
}

function createAdapter(): LocalTelemetryAdapter {
  return {
    clientType: 'claude-desktop',
    // Mirrors discovery: only sessions active since `sinceMs` are reported.
    discoverSessions: vi.fn(async (sinceMs: number) =>
      [...desktopSessions.values()]
        .filter(session => session.updatedAt >= sinceMs || session.createdAt >= sinceMs)
        .map(session => ({ ...session }))
    ),
    parseSession: vi.fn(async (discovered: LocalTelemetryDiscoveredSession, sessionId: string) => ({
      sessionId,
      agentName: 'claude-desktop',
      metadata: { externalSessionId: discovered.externalSessionId },
      messages: []
    }) as never),
    // Mirrors the conversations processor: queue only messages after lastSyncedHistoryIndex
    // and persist the advanced pointer on the session.
    processParsedSession: vi.fn(async (parsed: { sessionId: string; metadata: { externalSessionId: string } }) => {
      const session = readRecord(parsed.sessionId)!;
      const lastSyncedIndex = session.sync?.conversations?.lastSyncedHistoryIndex ?? -1;
      const total = transcripts.get(transcriptPathFor(parsed.metadata.externalSessionId))!.messages;
      const historyIndices: number[] = [];
      for (let index = lastSyncedIndex + 1; index < total; index++) {
        historyIndices.push(index);
      }

      if (historyIndices.length > 0) {
        sentDeltas.push({ externalSessionId: parsed.metadata.externalSessionId, historyIndices });
        session.sync = {
          ...session.sync,
          conversations: { ...session.sync?.conversations, lastSyncedHistoryIndex: total - 1 }
        };
        await new SessionStore().saveSession(session);
      }

      return { success: true, processors: {}, totalRecords: historyIndices.length, failedProcessors: [] };
    }) as never,
    // Mirrors the real baseline: messages written before the cutoff count as synced.
    applyBaseline: vi.fn(async (parsed: { sessionId: string; metadata: { externalSessionId: string } }, cutoffMs: number) => {
      const session = readRecord(parsed.sessionId)!;
      const transcript = transcripts.get(transcriptPathFor(parsed.metadata.externalSessionId))!;
      const before = transcript.messageTimes.filter(time => time < cutoffMs).length;
      session.sync = {
        ...session.sync,
        conversations: { ...session.sync?.conversations, lastSyncedHistoryIndex: before - 1 }
      };
      delete session.runtimeCheckpoint!.baselineCutoffMs;
      await new SessionStore().saveSession(session);
    }) as never
  };
}

function indexPersistedSessions(agentName: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const session of persistedRecords()) {
    const externalSessionId = session.runtimeCheckpoint?.externalSessionId;
    if (session.agentName === agentName && externalSessionId) {
      index.set(externalSessionId, session.sessionId);
    }
  }
  return index;
}

function sessionIdFor(externalSessionId: string): string | undefined {
  return indexPersistedSessions(config.clientType).get(externalSessionId);
}

/** Runs `count` poll ticks, advancing the clock by one poll interval before each. */
async function pollTicks(runtime: DesktopTelemetryRuntime, count: number): Promise<void> {
  for (let tick = 0; tick < count; tick++) {
    vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
    await runtime.triggerPoll();
  }
}

/** Starts a daemon at the current time; polling is driven manually via triggerPoll(). */
async function startDaemon(adapter: LocalTelemetryAdapter): Promise<DesktopTelemetryRuntime> {
  const runtime = new DesktopTelemetryRuntime(adapter, config);
  await runtime.triggerPoll();
  return runtime;
}

describe('DesktopTelemetryRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    resetCodemieHome();
    transcripts.clear();
    sentDeltas = [];
    desktopSessions = new Map();
    mockSendSessionStart.mockResolvedValue(undefined);
    mockSendSessionEnd.mockResolvedValue(undefined);
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
    realMetricsSender = false;
    realSessionSyncer = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(codemieHome, { recursive: true, force: true });
    if (previousCodemieHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousCodemieHome;
  });

  describe('repository attribution', () => {
    it('forwards session.repository to MetricsSender.sendSessionStart', async () => {
      openDesktopChat('ext-1', 1, T0);
      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      await (runtime as any).ensureSession(desktopSessions.get('ext-1'));

      expect(mockSendSessionStart).toHaveBeenCalledOnce();
      const [sessionArg] = mockSendSessionStart.mock.calls[0];
      expect(sessionArg).toMatchObject({ repository: 'codemie-ai/codemie-code' });
    });

    it('forwards session.repository to MetricsSender.sendSessionEnd', async () => {
      openDesktopChat('ext-1', 1, T0);
      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      const session = await (runtime as any).ensureSession(desktopSessions.get('ext-1'));

      await (runtime as any).finalizeSession(session.sessionId, 'test-reason');

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const [sessionArg] = mockSendSessionEnd.mock.calls[0];
      expect(sessionArg).toMatchObject({ repository: 'codemie-ai/codemie-code' });
    });
  });

  describe('daemon restart with pre-existing sessions', () => {
    it('does not resync an already synced active session after a restart', async () => {
      openDesktopChat('ext-1', 3, T0);
      await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1');
      expect(mockSync).toHaveBeenCalledTimes(1);

      // Restart (crash, sleep/wake, upgrade) without a clean stop; the chat stays open.
      vi.clearAllMocks();
      vi.setSystemTime(Date.now() + 60_000);
      touchDesktopChat('ext-1');
      const adapter = createAdapter();
      const restartedDaemon = await startDaemon(adapter);
      for (let tick = 0; tick < 30; tick++) {
        touchDesktopChat('ext-1');
        await pollTicks(restartedDaemon, 1);
      }

      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionStart).not.toHaveBeenCalled();
      expect(sessionIdFor('ext-1')).toBe(sessionId);
      // One parse to re-check the reopened session, then skipped while the transcript is unchanged.
      expect(adapter.processParsedSession).toHaveBeenCalledTimes(1);
    });

    it('syncs only new messages written after the restart', async () => {
      openDesktopChat('ext-1', 3, T0);
      const firstDaemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(firstDaemon, 1);

      vi.setSystemTime(Date.now() + 60_000);
      touchDesktopChat('ext-1');
      const restartedDaemon = await startDaemon(createAdapter());
      sentDeltas = [];
      vi.clearAllMocks();

      appendMessages('ext-1', 2);
      await pollTicks(restartedDaemon, 3);

      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-1', historyIndices: [4, 5] }]);
    });

    it('keeps sync requests flat for multiple concurrently open sessions across restarts', async () => {
      const chats = ['ext-1', 'ext-2', 'ext-3', 'ext-4'];
      chats.forEach(chat => openDesktopChat(chat, 2, T0));
      await startDaemon(createAdapter());
      expect(mockSync).toHaveBeenCalledTimes(chats.length);

      vi.clearAllMocks();
      for (let restart = 0; restart < 3; restart++) {
        vi.setSystemTime(Date.now() + 60_000);
        chats.forEach(touchDesktopChat);
        const daemon = await startDaemon(createAdapter());
        for (let tick = 0; tick < 10; tick++) {
          chats.forEach(touchDesktopChat);
          await pollTicks(daemon, 1);
        }
      }

      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionStart).not.toHaveBeenCalled();
      expect(new Set(chats.map(sessionIdFor)).size).toBe(chats.length);
    });

    it('scans the session directory once per daemon instead of once per session per tick', async () => {
      const mockIndexSessionsByExternalId = vi.spyOn(SessionStore.prototype, 'indexSessionsByExternalId');
      const mockFindSessionByExternalId = vi.spyOn(SessionStore.prototype, 'findSessionByExternalId');
      ['ext-1', 'ext-2', 'ext-3'].forEach(chat => openDesktopChat(chat, 1, T0));
      const daemon = await startDaemon(createAdapter());
      for (let tick = 0; tick < 5; tick++) {
        ['ext-1', 'ext-2', 'ext-3'].forEach(chat => appendMessages(chat, 1));
        await pollTicks(daemon, 1);
      }

      expect(mockIndexSessionsByExternalId).toHaveBeenCalledOnce();
      expect(mockFindSessionByExternalId).not.toHaveBeenCalled();
    });

    it('still ignores sessions idle since before the daemon started', async () => {
      openDesktopChat('ext-idle', 5, T0 - 60_000);
      const adapter = createAdapter();
      // Discovery can still report it (e.g. created inside the first poll's lookback window).
      vi.mocked(adapter.discoverSessions).mockResolvedValue([{ ...desktopSessions.get('ext-idle')! }]);

      const daemon = await startDaemon(adapter);
      await pollTicks(daemon, 3);

      expect(adapter.processParsedSession).not.toHaveBeenCalled();
      expect(sessionIdFor('ext-idle')).toBeUndefined();
    });
  });

  describe('new session discovery', () => {
    it('adopts a session created after the daemon started and syncs its full history', async () => {
      const adapter = createAdapter();
      const daemon = await startDaemon(adapter);
      vi.setSystemTime(Date.now() + 5_000);
      openDesktopChat('ext-new', 3, Date.now());

      await pollTicks(daemon, 1);

      expect(mockSendSessionStart).toHaveBeenCalledOnce();
      expect(mockSync).toHaveBeenCalledOnce();
      expect(adapter.applyBaseline).not.toHaveBeenCalled();
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-new', historyIndices: [0, 1, 2] }]);
    });

    it('does not backfill a pre-existing chat never seen before, but syncs what is written after start', async () => {
      openDesktopChat('ext-old', 4, T0 - 3_600_000);
      const adapter = createAdapter();
      const daemon = await startDaemon(adapter);

      vi.setSystemTime(Date.now() + 1_000);
      appendMessages('ext-old', 1);
      await pollTicks(daemon, 1);
      for (let tick = 0; tick < 5; tick++) {
        touchDesktopChat('ext-old');
        await pollTicks(daemon, 1);
      }

      expect(adapter.applyBaseline).toHaveBeenCalledOnce();
      expect(vi.mocked(adapter.applyBaseline!).mock.calls[0][1]).toBe(T0);
      expect(mockSync).toHaveBeenCalledOnce();
      // Only the message written after the daemon started; the four older ones stay local.
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-old', historyIndices: [4] }]);
    });

    it('starts the tracked session at the daemon start for a chat adopted without backfill', async () => {
      openDesktopChat('ext-old', 4, T0 - 3_600_000);
      const daemon = await startDaemon(createAdapter());

      appendMessages('ext-old', 1);
      await pollTicks(daemon, 1);

      expect(readRecord(sessionIdFor('ext-old')!)!.startTime).toBe(T0);
      const [startMetric] = mockSendSessionStart.mock.calls[0];
      expect(startMetric).toMatchObject({ startTime: T0 });
    });

    it('applies a pending baseline after a crash instead of backfilling', async () => {
      openDesktopChat('ext-old', 4, T0 - 3_600_000);
      const firstAdapter = createAdapter();
      const firstDaemon = await startDaemon(firstAdapter);
      appendMessages('ext-old', 1);
      // The daemon dies after persisting the new session but before the baseline lands.
      vi.mocked(firstAdapter.applyBaseline!).mockRejectedValueOnce(new Error('killed'));
      vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
      await firstDaemon.triggerPoll();
      expect(readRecord(sessionIdFor('ext-old')!)!.runtimeCheckpoint!.baselineCutoffMs).toBe(T0);

      vi.setSystemTime(Date.now() + 60_000);
      touchDesktopChat('ext-old');
      const restartedAdapter = createAdapter();
      await startDaemon(restartedAdapter);

      expect(restartedAdapter.applyBaseline).toHaveBeenCalledOnce();
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-old', historyIndices: [4] }]);
    });

    it('keeps a pending baseline while a subagent transcript of the parsed session is unreadable', async () => {
      openDesktopChat('ext-old', 4, T0 - 3_600_000);
      const adapter = createAdapter();
      vi.mocked(adapter.parseSession).mockImplementation(async (discovered, sessionId) => ({
        sessionId,
        agentName: 'claude-desktop',
        metadata: { externalSessionId: discovered.externalSessionId },
        messages: [],
        subagentsIncomplete: true
      }) as never);
      // The real baseline keeps its marker on an incomplete parse.
      vi.mocked(adapter.applyBaseline!).mockResolvedValue(undefined);
      const runtime = new DesktopTelemetryRuntime(adapter, config);
      const discovered = desktopSessions.get('ext-old')!;
      const session = await (runtime as any).ensureSession(discovered);

      await (runtime as any).delivery.processSession(session, discovered, true);

      expect(session.runtimeCheckpoint.baselineCutoffMs).toBe(T0);
    });
  });

  describe('transcript fingerprint', () => {
    it('skips parsing while the transcript mtime and size are unchanged', async () => {
      openDesktopChat('ext-1', 2, T0);
      const adapter = createAdapter();
      const daemon = await startDaemon(adapter);
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      vi.mocked(adapter.parseSession).mockClear();

      for (let tick = 0; tick < 10; tick++) {
        touchDesktopChat('ext-1');
        await pollTicks(daemon, 1);
      }

      expect(adapter.parseSession).not.toHaveBeenCalled();
    });

    it('goes on with the other sessions when one fails, and retries the failed one on the next tick', async () => {
      ['ext-1', 'ext-2', 'ext-3'].forEach(chat => openDesktopChat(chat, 2, T0));
      const adapter = createAdapter();
      const daemon = await startDaemon(adapter);
      sentDeltas = [];
      vi.clearAllMocks();

      ['ext-1', 'ext-2', 'ext-3'].forEach(chat => appendMessages(chat, 1));
      const processParsed = vi.mocked(adapter.processParsedSession);
      const realProcess = processParsed.getMockImplementation()!;
      processParsed.mockImplementation((async (parsed: { metadata: { externalSessionId: string } }, context: never) => {
        if (parsed.metadata.externalSessionId === 'ext-2') throw new Error('disk full');
        return realProcess(parsed as never, context);
      }) as never);
      vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
      await daemon.triggerPoll();
      expect(sentDeltas).toEqual([
        { externalSessionId: 'ext-1', historyIndices: [2] },
        { externalSessionId: 'ext-3', historyIndices: [2] }
      ]);

      // Transcript unchanged since the failed attempt: it must not be treated as handled.
      processParsed.mockImplementation(realProcess);
      ['ext-1', 'ext-2', 'ext-3'].forEach(touchDesktopChat);
      await pollTicks(daemon, 1);

      expect(sentDeltas).toEqual([
        { externalSessionId: 'ext-1', historyIndices: [2] },
        { externalSessionId: 'ext-3', historyIndices: [2] },
        { externalSessionId: 'ext-2', historyIndices: [2] }
      ]);
    });

    it('processes the session when the transcript cannot be stat-ed', async () => {
      openDesktopChat('ext-1', 2, T0);
      const adapter = createAdapter();
      const daemon = await startDaemon(adapter);
      const { stat } = await import('fs/promises');
      vi.mocked(stat).mockRejectedValueOnce(new Error('EACCES'));
      vi.mocked(adapter.parseSession).mockClear();

      touchDesktopChat('ext-1');
      await pollTicks(daemon, 1);

      expect(adapter.parseSession).toHaveBeenCalledOnce();
    });
  });

  describe('inactivity timeout', () => {
    it('finalizes a session after five minutes without activity', async () => {
      openDesktopChat('ext-1', 2, T0);
      const daemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      mockSendSessionEnd.mockClear();

      await pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const session = readRecord(sessionIdFor('ext-1')!)!;
      expect(session.status).toBe('completed');
      expect(session.reason).toBe('desktop-inactive-timeout');
    });

    it('keeps a session alive while Desktop reports activity without transcript writes', async () => {
      openDesktopChat('ext-1', 2, T0);
      const daemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      mockSendSessionEnd.mockClear();

      for (let tick = 0; tick < INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 5; tick++) {
        touchDesktopChat('ext-1');
        await pollTicks(daemon, 1);
      }

      expect(mockSendSessionEnd).not.toHaveBeenCalled();
    });

    it('reopens the same session when activity resumes after the timeout', async () => {
      openDesktopChat('ext-1', 2, T0);
      const daemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      const sessionId = sessionIdFor('ext-1');
      await pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
      sentDeltas = [];
      mockSendSessionStart.mockClear();

      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);

      expect(mockSendSessionStart).not.toHaveBeenCalled();
      expect(readRecord(sessionId!)!.status).toBe('active');
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-1', historyIndices: [3] }]);
    });
  });

  describe('a failure never stops the daemon', () => {
    it('resolves start() and keeps polling when the first poll fails', async () => {
      const adapter = createAdapter();
      vi.mocked(adapter.discoverSessions).mockRejectedValueOnce(new Error('EACCES'));
      const runtime = new DesktopTelemetryRuntime(adapter, { ...config, pollIntervalMs: 20 });

      await expect(runtime.start()).resolves.toBeUndefined();
      // The timer is armed: the next ticks poll again (real 20 ms interval)
      await waitFor(() => vi.mocked(adapter.discoverSessions).mock.calls.length >= 3);
      await runtime.stop();
    });

    it('keeps one record for a conversation whose START metric failed', async () => {
      const daemon = await startDaemon(createAdapter());
      mockSendSessionStart.mockRejectedValueOnce(new Error('HTTP 503'));
      vi.setSystemTime(Date.now() + 5_000);
      openDesktopChat('ext-new', 1, Date.now());

      await pollTicks(daemon, 1);
      appendMessages('ext-new', 1);
      await pollTicks(daemon, 2);

      expect(persistedRecords()).toHaveLength(1);
      expect(sessionIdFor('ext-new')).toBeDefined();
      expect(mockSendSessionStart).toHaveBeenCalledOnce();
    });

    it('finalizes the other sessions on stop() when one finalization fails', async () => {
      openDesktopChat('ext-1', 1, T0);
      openDesktopChat('ext-2', 1, T0);
      const daemon = await startDaemon(createAdapter());
      const [first, second] = [sessionIdFor('ext-1')!, sessionIdFor('ext-2')!];
      // Another process holds the first record past the lock's wait budget
      const held = (await acquirePidLock(reconcileLockPath(first), { mode: 'try' }))!;

      const stopping = daemon.stop();
      await new Promise(resolve => setTimeout(resolve, 50));
      vi.setSystemTime(Date.now() + PID_LOCK_WAIT_BUDGET_MS + 1);
      await stopping;
      await held.release();

      expect(readRecord(first)!.status).toBe('active');
      expect(readRecord(second)).toMatchObject({ status: 'completed', reason: 'desktop-daemon-stop' });
    });
  });

  describe('end at the last activity', () => {
    it('ends an idle session at its last activity, not at the finalize moment', async () => {
      const daemon = await startDaemon(createAdapter());
      vi.setSystemTime(T0 + 20_000);
      openDesktopChat('ext-1', 1, T0 + 20_000);
      await pollTicks(daemon, 1);
      const sessionId = sessionIdFor('ext-1')!;
      // Desktop reports activity with no transcript write: newer in memory than on disk
      vi.setSystemTime(T0 + 90_000);
      touchDesktopChat('ext-1');
      await pollTicks(daemon, 1);

      await pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      const record = readRecord(sessionId)!;
      expect(record.runtimeCheckpoint!.lastSeenActivityAt).toBe(T0 + 20_000);
      expect(record).toMatchObject({ status: 'completed', reason: 'desktop-inactive-timeout', endTime: T0 + 90_000 });
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const [, , , durationMs, , , endTime] = mockSendSessionEnd.mock.calls[0];
      expect(durationMs).toBe(T0 + 90_000 - record.startTime);
      expect(endTime).toBe(T0 + 90_000);
    });

    it('reports a reopened stretch alone in its end metric, keeping the record\'s start', async () => {
      openDesktopChat('ext-1', 2, T0);
      const daemon = await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      vi.setSystemTime(T0 + 20_000);
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1 + INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const [firstSession, , , firstDurationMs] = mockSendSessionEnd.mock.calls[0];
      expect(firstDurationMs).toBe(20_000);
      expect(firstSession.startTime).toBe(T0);

      vi.setSystemTime(T0 + 1_000_000);
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      vi.setSystemTime(T0 + 1_030_000);
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1 + INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      expect(mockSendSessionEnd).toHaveBeenCalledTimes(2);
      const [secondSession, , , secondDurationMs, , , secondEndTime] = mockSendSessionEnd.mock.calls[1];
      expect(secondEndTime).toBe(T0 + 1_030_000);
      expect(secondDurationMs).toBe(30_000);
      expect(secondSession.startTime).toBe(T0 + 1_000_000);
      expect(readRecord(sessionId)).toMatchObject({ startTime: T0, stretchStartTime: T0 + 1_000_000 });
    });

    it('covers the earlier stretch in the next end metric when its own end metric never left', async () => {
      openDesktopChat('ext-1', 2, T0);
      const daemon = await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      mockSendSessionEnd.mockRejectedValueOnce(new Error('ECONNRESET'));
      vi.setSystemTime(T0 + 20_000);
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1 + INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const closed = readRecord(sessionId)!;
      expect(closed.status).toBe('completed');
      expect(closed.endMetricSentAt).toBeUndefined();

      vi.setSystemTime(T0 + 1_000_000);
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      vi.setSystemTime(T0 + 1_030_000);
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1 + INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      expect(mockSendSessionEnd).toHaveBeenCalledTimes(2);
      const [secondSession, , , secondDurationMs, , , secondEndTime] = mockSendSessionEnd.mock.calls[1];
      expect(secondEndTime).toBe(T0 + 1_030_000);
      expect(secondSession.startTime).toBe(T0);
      expect(secondDurationMs).toBe(1_030_000);
      const saved = readRecord(sessionId)!;
      expect(saved.stretchStartTime).toBeUndefined();
      expect(saved.endMetricSentAt).toBeDefined();
    });

    it('ends a record without a saved activity at its last discovery, else at its start', async () => {
      const discoveredOnly = writeRecord('ext-a', {
        ownerPid: DEAD_PID,
        runtimeCheckpoint: { externalSessionId: 'ext-a', transcriptPath: transcriptPathFor('ext-a'), lastDiscoveredAt: T0 - 50 * 60_000 }
      });
      const startOnly = writeRecord('ext-b', {
        ownerPid: DEAD_PID,
        runtimeCheckpoint: undefined
      });

      await startRuntime(createAdapter());

      expect(readRecord(discoveredOnly)).toMatchObject({ endTime: T0 - 50 * 60_000 });
      expect(readRecord(startOnly)).toMatchObject({ endTime: T0 - HOUR_MS });
      const durations = mockSendSessionEnd.mock.calls.map(call => call[3]).sort((a, b) => a - b);
      expect(durations).toEqual([0, 10 * 60_000]);
    });
  });

  describe('records a previous daemon left', () => {
    it('finalizes a gone daemon\'s active record at its last activity, delivers it once and renames it', async () => {
      const sessionId = writeRecord('ext-1', { ownerPid: DEAD_PID, ownerStartedAt: T0 - 2 * HOUR_MS });

      await startRuntime(createAdapter());

      expect(readRecord(sessionId)).toMatchObject({
        status: 'completed',
        reason: 'desktop-daemon-restart',
        endTime: T0 - 40 * 60_000
      });
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(mockSendSessionEnd.mock.calls[0][6]).toBe(T0 - 40 * 60_000);
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
    });

    it('leaves a live daemon\'s record and a young legacy record untouched', async () => {
      const live = writeRecord('ext-1', { ownerPid: process.pid, ownerStartedAt: processStartedAt() });
      const legacy = writeRecord('ext-2', {});

      await startRuntime(createAdapter());

      expect(readRecord(live)!.status).toBe('active');
      expect(readRecord(legacy)!.status).toBe('active');
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(recordFiles()).toEqual([`${live}.json`, `${legacy}.json`].sort());
    });

    it('reopens a completed_* set as one live set owned by this daemon, and ends the resumed stretch again', async () => {
      openDesktopChat('ext-1', 2, T0);
      const firstDaemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(firstDaemon, 1);
      const sessionId = sessionIdFor('ext-1')!;
      await pollTicks(firstDaemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
      const { startTime } = readRecord(sessionId)!;
      // The CLI or an earlier attempt left counters; the resumed stretch starts clean
      const completedPath = join(sessionsDir(), `completed_${sessionId}.json`);
      writeFileSync(completedPath, JSON.stringify({ ...readRecord(sessionId), ownerPid: DEAD_PID, finalizeAttempts: 2, droppedAt: T0 }));
      writeFileSync(join(sessionsDir(), `completed_${sessionId}_metrics.jsonl`), '');

      const daemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);

      expect(recordFiles()).toEqual([`${sessionId}.json`, `${sessionId}_metrics.jsonl`]);
      const reopened = readRecord(sessionId)!;
      expect(reopened).toMatchObject({ status: 'active', ownerPid: process.pid, ownerStartedAt: processStartedAt(), startTime });
      for (const field of ['endMetricSentAt', 'endMetricSkipped', 'deliveryAttempts', 'finalizeAttempts', 'droppedAt', 'endTime', 'reason']) {
        expect(reopened).not.toHaveProperty(field);
      }

      mockSendSessionEnd.mockClear();
      await pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(readRecord(sessionId)).toMatchObject({ status: 'completed', reason: 'desktop-inactive-timeout' });
    });

    it.each(['rename', 'unlink'] as const)(
      'restores each line of a completed_* set once when the %s after the merge fails and the reopen reruns',
      async (failingStep) => {
        const sessionId = writeRecord('ext-1', {
          status: 'completed',
          reason: 'desktop-inactive-timeout',
          endTime: T0 - 40 * 60_000,
          endMetricSentAt: T0 - 40 * 60_000,
          ownerPid: DEAD_PID
        });
        const dir = sessionsDir();
        renameSync(join(dir, `${sessionId}.json`), join(dir, `completed_${sessionId}.json`));
        writeFileSync(join(dir, `completed_${sessionId}_metrics.jsonl`), '{"line":1}\n{"line":2}\n');
        writeFileSync(join(dir, `${sessionId}_metrics.jsonl`), '{"line":3}\n');
        openDesktopChat('ext-1', 2, T0);
        const livePath = join(dir, `${sessionId}_metrics.jsonl`);
        const completedPath = join(dir, `completed_${sessionId}_metrics.jsonl`);
        const actualRename = vi.mocked(rename).getMockImplementation()!;
        const actualUnlink = vi.mocked(unlink).getMockImplementation()!;
        // The process dies at that step once: the next poll reruns the reopen
        let crashed = false;
        const crashOnce = (hit: boolean) => {
          if (crashed || !hit) return false;
          crashed = true;
          return true;
        };
        const crash = () => Promise.reject(Object.assign(new Error('EIO: crash'), { code: 'EIO' }));
        vi.mocked(rename).mockImplementation(async (from, to) => (
          crashOnce(failingStep === 'rename' && String(to) === livePath) ? crash() : actualRename(from, to)
        ));
        vi.mocked(unlink).mockImplementation(async (path) => (
          crashOnce(failingStep === 'unlink' && String(path) === completedPath) ? crash() : actualUnlink(path)
        ));

        try {
          const daemon = await startDaemon(createAdapter());
          expect(crashed).toBe(true);
          appendMessages('ext-1', 1);
          await pollTicks(daemon, 1);
        } finally {
          vi.mocked(rename).mockImplementation(actualRename);
          vi.mocked(unlink).mockImplementation(actualUnlink);
        }

        expect(readFileSync(livePath, 'utf-8')).toBe('{"line":1}\n{"line":2}\n{"line":3}\n');
        expect(existsSync(completedPath)).toBe(false);
        expect(readRecord(sessionId)).toMatchObject({ status: 'active', ownerPid: process.pid });
      }
    );

    it.each([
      ['live sidecars with lines of their own', '{"metric":3}\n', '{"line":3}\n', false],
      ['a completed_<id>.json beside the live one', '{"metric":3}\n', '{"line":3}\n', true]
    ])('restores the completed_* sidecars of a reopened record whose .json stayed live (%s)', async (_case, liveMetrics, liveConversation, completedRecord) => {
      const sessionId = writeRecord('ext-1', {
        status: 'completed',
        reason: 'desktop-inactive-timeout',
        endTime: T0 - 40 * 60_000,
        endMetricSentAt: T0 - 40 * 60_000,
        ownerPid: DEAD_PID
      });
      const dir = sessionsDir();
      writeFileSync(join(dir, `completed_${sessionId}_metrics.jsonl`), '{"metric":1}\n{"metric":2}\n');
      writeFileSync(join(dir, `completed_${sessionId}_conversation.jsonl`), '{"line":1}\n{"line":2}\n');
      if (liveMetrics) writeFileSync(join(dir, `${sessionId}_metrics.jsonl`), liveMetrics);
      if (liveConversation) writeFileSync(join(dir, `${sessionId}_conversation.jsonl`), liveConversation);
      // An earlier generation's record: a copy of the same generation would make the live save drop the live one
      const completedRecordPath = join(dir, `completed_${sessionId}.json`);
      const completedRecordText = JSON.stringify({ ...readRecord(sessionId), startTime: T0 - 2 * HOUR_MS });
      if (completedRecord) writeFileSync(completedRecordPath, completedRecordText);
      openDesktopChat('ext-1', 2, T0);

      const daemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);

      expect(recordFiles()).toEqual([
        `${sessionId}.json`,
        `${sessionId}_conversation.jsonl`,
        `${sessionId}_metrics.jsonl`,
        ...(completedRecord ? [`completed_${sessionId}.json`] : [])
      ]);
      if (completedRecord) expect(readFileSync(completedRecordPath, 'utf-8')).toBe(completedRecordText);
      expect(readFileSync(join(dir, `${sessionId}_metrics.jsonl`), 'utf-8')).toBe(`{"metric":1}\n{"metric":2}\n${liveMetrics}`);
      expect(readFileSync(join(dir, `${sessionId}_conversation.jsonl`), 'utf-8')).toBe(`{"line":1}\n{"line":2}\n${liveConversation}`);
      // One record, not two concatenated
      expect(JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf-8'))).toMatchObject({ sessionId, status: 'active' });
    });

    it('leaves the CLI wrapper\'s records of another agent alone at start and in a re-delivery pass', async () => {
      const desktop = writeRecord('ext-1', { ownerPid: DEAD_PID, ownerStartedAt: T0 - 2 * HOUR_MS });
      const wrapperOwner = { agentName: 'claude', ownerPid: DEAD_PID, ownerStartedAt: T0 - 2 * HOUR_MS };
      const wrapperActive = writeRecord('ext-c1', { ...wrapperOwner });
      const wrapperCompleted = writeRecord('ext-c2', {
        ...wrapperOwner,
        status: 'completed',
        reason: 'interrupted',
        endTime: T0 - 40 * 60_000,
        deliveryAttempts: 1
      });
      const wrapperFiles = [wrapperActive, wrapperCompleted].map(id => join(sessionsDir(), `${id}.json`));
      const before = wrapperFiles.map(path => readFileSync(path, 'utf-8'));

      const runtime = await startRuntime(createAdapter());
      await pollTicks(runtime, DESKTOP_REDELIVERY_INTERVAL_MS / POLL_INTERVAL_MS);
      await (runtime as any).redeliveryPass;
      await runtime.stop();

      // The Desktop record beside them was delivered: the passes ran
      expect(readRecord(desktop)).toMatchObject({ status: 'completed', reason: 'desktop-daemon-restart' });
      expect(mockSendSessionEnd.mock.calls.map(([session]) => session.sessionId)).toEqual(['agent-ext-1']);
      expect(mockSync.mock.calls.map(([sessionId]) => sessionId)).not.toContain(wrapperActive);
      expect(mockSync.mock.calls.map(([sessionId]) => sessionId)).not.toContain(wrapperCompleted);
      expect(wrapperFiles.map(path => readFileSync(path, 'utf-8'))).toEqual(before);
      expect(readRecord(wrapperActive)).toMatchObject({ status: 'active' });
      expect(readRecord(wrapperCompleted)).toMatchObject({ status: 'completed', deliveryAttempts: 1 });
    });

    it('finalizes an ownerless record idle past 72 h locally, sending nothing; a 71 h one stays', async () => {
      const old = writeRecord('ext-1', {
        runtimeCheckpoint: { externalSessionId: 'ext-1', transcriptPath: transcriptPathFor('ext-1'), lastDiscoveredAt: T0 - 74 * HOUR_MS, lastSeenActivityAt: T0 - 73 * HOUR_MS }
      });
      const young = writeRecord('ext-2', {
        runtimeCheckpoint: { externalSessionId: 'ext-2', transcriptPath: transcriptPathFor('ext-2'), lastDiscoveredAt: T0 - 72 * HOUR_MS, lastSeenActivityAt: T0 - 71 * HOUR_MS }
      });

      await startRuntime(createAdapter());

      expect(readRecord(old)).toMatchObject({ status: 'completed', reason: 'interrupted', endTime: T0 - 73 * HOUR_MS });
      expect(readRecord(young)!.status).toBe('active');
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
      expect(recordFiles()).toEqual([`completed_${old}.json`, `${young}.json`].sort());
    });

    it('lets a daemon restarted with --force find nothing stranded after the old one stopped', async () => {
      openDesktopChat('ext-1', 1, T0);
      const oldDaemon = await startDaemon(createAdapter());
      vi.setSystemTime(T0 + 30_000);
      appendMessages('ext-1', 1);
      await pollTicks(oldDaemon, 1);
      const sessionId = sessionIdFor('ext-1')!;

      vi.setSystemTime(T0 + 120_000);
      await oldDaemon.stop();
      await startRuntime(createAdapter());

      expect(readRecord(sessionId)).toMatchObject({ status: 'completed', reason: 'desktop-daemon-stop', endTime: T0 + 30_000 });
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
    });
  });

  describe('delivery after a failure', () => {
    it('keeps an idle session whose END metric failed and delivers it within one re-delivery interval', async () => {
      openDesktopChat('ext-1', 1, T0);
      const daemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      const sessionId = sessionIdFor('ext-1')!;
      mockSendSessionEnd.mockRejectedValue(new Error('HTTP 503'));

      await expect(pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1)).resolves.toBeUndefined();

      expect(recordFiles()).toEqual([`${sessionId}.json`]);
      expect(readRecord(sessionId)).toMatchObject({ status: 'completed', deliveryAttempts: 1 });
      expect(readRecord(sessionId)).not.toHaveProperty('endMetricSentAt');
      const failedSends = mockSendSessionEnd.mock.calls.length;
      await pollTicks(daemon, 2);
      expect(mockSendSessionEnd).toHaveBeenCalledTimes(failedSends);

      mockSendSessionEnd.mockResolvedValue(undefined);
      await pollTicks(daemon, DESKTOP_REDELIVERY_INTERVAL_MS / POLL_INTERVAL_MS);
      await (daemon as any).redeliveryPass;

      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
      const delivered = readRecord(sessionId)!;
      expect(delivered.endMetricSentAt).toEqual(expect.any(Number));
      expect(delivered.deliveryAttempts).toBe(1);
    });

    it('spends one attempt per daemon start and renames unsent after the third', async () => {
      const sessionId = writeRecord('ext-1', {
        status: 'completed',
        reason: 'desktop-inactive-timeout',
        endTime: T0 - 40 * 60_000,
        ownerPid: DEAD_PID
      });
      mockSendSessionEnd.mockRejectedValue(new Error('HTTP 503'));

      for (let start = 1; start <= 3; start++) {
        const runtime = await startRuntime(createAdapter());
        await runtime.stop();
        expect(readRecord(sessionId)!.deliveryAttempts).toBe(start);
        expect(recordFiles()).toEqual([`${sessionId}.json`]);
      }
      mockSendSessionEnd.mockClear();
      const runtime = await startRuntime(createAdapter());
      await runtime.stop();

      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
      expect(readRecord(sessionId)!.droppedAt).toEqual(expect.any(Number));
    });

    it('never re-delivers a completed record without an owner', async () => {
      const sessionId = writeRecord('ext-1', { status: 'completed', reason: 'desktop-daemon-stop', endTime: T0 - HOUR_MS });

      const runtime = await startRuntime(createAdapter());
      await pollTicks(runtime, DESKTOP_REDELIVERY_INTERVAL_MS / POLL_INTERVAL_MS);
      await (runtime as any).redeliveryPass;

      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('flushes a record the CLI closed locally once, then delivers it', async () => {
      openDesktopChat('ext-1', 3, T0 - HOUR_MS);
      const sessionId = writeRecord('ext-1', {
        status: 'completed',
        reason: 'desktop-daemon-gone',
        endTime: T0 - 40 * 60_000,
        ownerPid: DEAD_PID
      });
      const adapter = createAdapter();
      vi.mocked(adapter.discoverSessions).mockImplementation(async () => [{ ...desktopSessions.get('ext-1')! }]);

      await startRuntime(adapter);

      expect(adapter.processParsedSession).toHaveBeenCalledOnce();
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-1', historyIndices: [0, 1, 2] }]);
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
    });

    it('counts a matched record with an unsent conversation as delivered when sync is off', async () => {
      openDesktopChat('ext-1', 1, T0);
      const daemon = new DesktopTelemetryRuntime(createAdapter(), { ...config, provider: 'litellm' });
      await daemon.triggerPoll();
      const sessionId = sessionIdFor('ext-1')!;
      writeFileSync(join(sessionsDir(), `${sessionId}_conversation.jsonl`), '{"status":"pending"}\n');

      await pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
      await pollTicks(daemon, DESKTOP_REDELIVERY_INTERVAL_MS / POLL_INTERVAL_MS);
      await (daemon as any).redeliveryPass;

      expect(recordFiles()).toEqual([`completed_${sessionId}.json`, `completed_${sessionId}_conversation.jsonl`]);
      const record = readRecord(sessionId)!;
      expect(record).toMatchObject({ status: 'completed', deliveryAttempts: 1 });
      expect(record).not.toHaveProperty('droppedAt');
    });

    it('keeps polling while a re-delivery pass hangs, and starts no second pass meanwhile', async () => {
      for (const externalSessionId of ['ext-1', 'ext-2']) {
        writeRecord(externalSessionId, {
          status: 'completed',
          reason: 'desktop-inactive-timeout',
          endTime: T0 - 40 * 60_000,
          ownerPid: DEAD_PID
        });
      }
      let releaseSends!: () => void;
      const sendsHang = new Promise<void>(resolve => { releaseSends = resolve; });
      mockSendSessionEnd.mockImplementation(() => sendsHang);
      const daemon = await startDaemon(createAdapter());

      vi.setSystemTime(Date.now() + DESKTOP_REDELIVERY_INTERVAL_MS);
      // Not awaited: on a poll that awaits the pass, this tick never ends
      const passTick = daemon.triggerPoll();
      await waitFor(() => mockSendSessionEnd.mock.calls.length > 0);
      openDesktopChat('ext-3', 1, Date.now());
      await pollTicks(daemon, 1);

      expect(mockSendSessionStart.mock.calls.map(([session]) => session.sessionId)).toContain('agent-ext-3');

      vi.setSystemTime(Date.now() + DESKTOP_REDELIVERY_INTERVAL_MS);
      touchDesktopChat('ext-3');
      await daemon.triggerPoll();
      // The hung pass holds the first record's lock; a second pass would go on to the other record
      expect(new Set(mockSendSessionEnd.mock.calls.map(([session]) => session.sessionId)).size).toBe(1);

      releaseSends();
      await passTick;
      await (daemon as any).redeliveryPass;
    });
  });

  describe('delivery credentials', () => {
    const API_URL = config.targetApiUrl;
    const unauthorized = () => new Response(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
    const loginPage = () => new Response('<html><body>Sign in</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });

    function undeliveredRecord(fields: Partial<Session> = {}): string {
      return writeRecord('ext-1', {
        status: 'completed',
        reason: 'desktop-inactive-timeout',
        endTime: T0 - 40 * 60_000,
        ownerPid: DEAD_PID,
        ...fields
      });
    }

    /** The end metric goes through the real MetricsSender, its `fetch` answered with `response`. */
    function answerEndMetricWith(response: () => Response) {
      realMetricsSender = true;
      const fetchMock = vi.fn(async () => response());
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('makes no request and spends no attempt at start while the analytics auth is marked invalid', async () => {
      await markAnalyticsAuthInvalid('HTTP 401: Unauthorized', API_URL);
      const undelivered = undeliveredRecord({ deliveryAttempts: 1 });
      const gone = writeRecord('ext-2', { ownerPid: DEAD_PID, ownerStartedAt: T0 - 2 * HOUR_MS });

      await startRuntime(createAdapter());

      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(readRecord(undelivered)).toMatchObject({ status: 'completed', deliveryAttempts: 1 });
      expect(readRecord(gone)).toMatchObject({
        status: 'completed',
        reason: 'desktop-daemon-restart',
        endTime: T0 - 40 * 60_000
      });
      expect(readRecord(gone)).not.toHaveProperty('deliveryAttempts');
      expect(recordFiles()).toEqual([`${undelivered}.json`, `${gone}.json`].sort());
    });

    it('closes an inactive session without a request or an attempt while the analytics auth is marked invalid', async () => {
      openDesktopChat('ext-1', 1, T0);
      const daemon = await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      await markAnalyticsAuthInvalid('HTTP 401: Unauthorized', API_URL);
      mockSync.mockClear();

      await pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(readRecord(sessionId)).toMatchObject({ status: 'completed', reason: 'desktop-inactive-timeout' });
      expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it.each([
      ['401', unauthorized],
      ['an SSO login page on 200', loginPage]
    ])('gives back the attempt whose end metric was answered with %s and marks the auth invalid', async (_, response) => {
      const fetchMock = answerEndMetricWith(response);
      const sessionId = undeliveredRecord({ deliveryAttempts: 1 });

      await startRuntime(createAdapter());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(readRecord(sessionId)!.deliveryAttempts).toBe(1);
      expect(await getAnalyticsAuthStatus()).toMatchObject({ status: 'invalid', baseUrl: API_URL });
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('never renames a record whose attempt at the cap meets rejected credentials', async () => {
      const fetchMock = answerEndMetricWith(unauthorized);
      const sessionId = undeliveredRecord({ deliveryAttempts: 2 });

      for (let start = 1; start <= 3; start++) {
        // A re-login the server rejects again
        await clearAnalyticsAuthStatus();
        const runtime = await startRuntime(createAdapter());
        await runtime.stop();
      }

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(readRecord(sessionId)!.deliveryAttempts).toBe(2);
      expect(readRecord(sessionId)).not.toHaveProperty('droppedAt');
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('sends nothing in a re-delivery pass while the mark is set, and delivers uncounted once it is cleared', async () => {
      const sessionId = undeliveredRecord({ deliveryAttempts: 1 });
      await markAnalyticsAuthInvalid('HTTP 401: Unauthorized', API_URL);
      const daemon = await startDaemon(createAdapter());

      await pollTicks(daemon, DESKTOP_REDELIVERY_INTERVAL_MS / POLL_INTERVAL_MS);
      await (daemon as any).redeliveryPass;

      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(recordFiles()).toEqual([`${sessionId}.json`]);

      await clearAnalyticsAuthStatus();
      await pollTicks(daemon, DESKTOP_REDELIVERY_INTERVAL_MS / POLL_INTERVAL_MS);
      await (daemon as any).redeliveryPass;

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(readRecord(sessionId)!.deliveryAttempts).toBe(1);
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
    });

    it('makes no request and spends no attempt without stored cookies', async () => {
      mockGetStoredCredentials.mockResolvedValue(null);
      const sessionId = undeliveredRecord({ deliveryAttempts: 1 });

      await startRuntime(createAdapter());

      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(readRecord(sessionId)!.deliveryAttempts).toBe(1);
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
    });

    it('gives back the attempt whose sync of pending data was answered with 401 and marks the auth invalid', async () => {
      realSessionSyncer = true;
      const fetchMock = vi.fn(async () => unauthorized());
      vi.stubGlobal('fetch', fetchMock);
      const sessionId = undeliveredRecord({ deliveryAttempts: 1, endMetricSentAt: T0 - 30 * 60_000 });
      writeFileSync(join(sessionsDir(), `${sessionId}_metrics.jsonl`), JSON.stringify({
        recordId: 'record-1',
        sessionId,
        agentSessionId: 'agent-ext-1',
        timestamp: T0 - 45 * 60_000,
        gitBranch: 'main',
        syncStatus: 'pending',
        syncAttempts: 0
      }) + '\n');

      await startRuntime(createAdapter());

      expect(fetchMock).toHaveBeenCalled();
      expect(readRecord(sessionId)!.deliveryAttempts).toBe(1);
      expect(await getAnalyticsAuthStatus()).toMatchObject({ status: 'invalid', baseUrl: API_URL });
      expect(recordFiles()).toEqual([`${sessionId}.json`, `${sessionId}_metrics.jsonl`]);
    });

    it('never renames a record at the cap while there are no stored cookies, and renames it unsent once they are back', async () => {
      mockGetStoredCredentials.mockResolvedValue(null);
      const sessionId = undeliveredRecord({ deliveryAttempts: 3 });

      const gated = await startRuntime(createAdapter());
      await gated.stop();

      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
      expect(readRecord(sessionId)).not.toHaveProperty('droppedAt');
      expect(readRecord(sessionId)!.deliveryAttempts).toBe(3);

      mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
      await clearAnalyticsAuthStatus();
      const runtime = await startRuntime(createAdapter());
      await runtime.stop();

      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
      expect(readRecord(sessionId)!.droppedAt).toEqual(expect.any(Number));
    });

    it('flushes a gone daemon\'s record locally while the analytics auth is marked invalid, and sends it once cleared', async () => {
      const fetchMock = vi.fn(async () => unauthorized());
      vi.stubGlobal('fetch', fetchMock);
      await markAnalyticsAuthInvalid('HTTP 401: Unauthorized', API_URL);
      openDesktopChat('ext-1', 3, T0 - HOUR_MS);
      const sessionId = writeRecord('ext-1', { ownerPid: DEAD_PID, ownerStartedAt: T0 - 2 * HOUR_MS });
      const adapter = createAdapter();
      vi.mocked(adapter.discoverSessions).mockImplementation(async () => [{ ...desktopSessions.get('ext-1')! }]);

      const runtime = await startRuntime(adapter);

      expect(readRecord(sessionId)).toMatchObject({ status: 'completed', reason: 'desktop-daemon-restart' });
      expect(readRecord(sessionId)).not.toHaveProperty('deliveryAttempts');
      expect(mockSync).not.toHaveBeenCalled();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(adapter.processParsedSession).toHaveBeenCalledOnce();
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-1', historyIndices: [0, 1, 2] }]);

      await clearAnalyticsAuthStatus();
      await pollTicks(runtime, DESKTOP_REDELIVERY_INTERVAL_MS / POLL_INTERVAL_MS);
      await (runtime as any).redeliveryPass;

      expect(mockSync).toHaveBeenCalledWith(sessionId, expect.objectContaining({ sessionId }));
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
    });
  });

  describe('a reopen and a delivery never interleave', () => {
    /** The first poll of a started runtime reaches the record only once the start-up scan holds its lock. */
    function adapterAfterLock(sessionId: string): LocalTelemetryAdapter {
      const adapter = createAdapter();
      const discover = vi.mocked(adapter.discoverSessions).getMockImplementation()!;
      vi.mocked(adapter.discoverSessions).mockImplementationOnce(async (sinceMs: number) => {
        await waitFor(() => existsSync(reconcileLockPath(sessionId)));
        return discover(sinceMs);
      });
      return adapter;
    }

    /** The END metric takes 300 ms, so the lock stays held across the poll's reopen. */
    function slowEndMetric(): void {
      mockSendSessionEnd.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 300)));
    }

    it('reopens an undelivered record after the re-delivery that holds it, 5 runs of 5', async () => {
      for (let run = 0; run < 5; run++) {
        resetCodemieHome();
        transcripts.clear();
        desktopSessions = new Map();
        openDesktopChat('ext-1', 2, T0 - HOUR_MS);
        const sessionId = writeRecord('ext-1', {
          status: 'completed',
          reason: 'desktop-inactive-timeout',
          endTime: T0 - 40 * 60_000,
          ownerPid: DEAD_PID
        });
        slowEndMetric();
        const runtime = new DesktopTelemetryRuntime(adapterAfterLock(sessionId), config);
        // A new line in the conversation before the daemon starts
        vi.setSystemTime(Date.now() + 1_000);
        appendMessages('ext-1', 1);

        await runtime.start();
        await (runtime as any).startupPass;

        expect(recordFiles()).toEqual([`${sessionId}.json`]);
        expect(readRecord(sessionId)).toMatchObject({ status: 'active', ownerPid: process.pid });
        await runtime.stop();
        vi.setSystemTime(T0);
      }
    });

    it('reopens a record after the start-up finalization that holds it', async () => {
      openDesktopChat('ext-1', 2, T0 - HOUR_MS);
      const sessionId = writeRecord('ext-1', { ownerPid: DEAD_PID });
      slowEndMetric();
      const runtime = new DesktopTelemetryRuntime(adapterAfterLock(sessionId), config);
      vi.setSystemTime(Date.now() + 1_000);
      appendMessages('ext-1', 1);

      await runtime.start();
      await (runtime as any).startupPass;

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(mockSendSessionEnd.mock.calls[0][2]).toMatchObject({ reason: 'desktop-daemon-restart' });
      expect(recordFiles()).toEqual([`${sessionId}.json`]);
      expect(readRecord(sessionId)).toMatchObject({ status: 'active', ownerPid: process.pid });
      await runtime.stop();
    });

    it('leaves a record whose lock stays held past the reopen budget to the next poll, creating no second record', async () => {
      const sessionId = writeRecord('ext-1', {
        status: 'completed',
        reason: 'desktop-inactive-timeout',
        endTime: T0 - 40 * 60_000,
        endMetricSentAt: T0 - 40 * 60_000,
        ownerPid: DEAD_PID
      });
      const dir = sessionsDir();
      renameSync(join(dir, `${sessionId}.json`), join(dir, `completed_${sessionId}.json`));
      openDesktopChat('ext-1', 2, T0);
      const daemon = new DesktopTelemetryRuntime(createAdapter(), config);
      const held = (await acquirePidLock(reconcileLockPath(sessionId), { mode: 'try' }))!;

      const pollStart = Date.now();
      let settledAt: number | undefined;
      const polling = daemon.triggerPoll().finally(() => { settledAt = Date.now(); });
      // The lock budget runs on the faked clock: step it until the poll gives up
      await waitFor(() => {
        if (settledAt === undefined) vi.setSystemTime(Date.now() + 1_000);
        return settledAt !== undefined;
      });
      await polling;

      expect(settledAt! - pollStart).toBeGreaterThanOrEqual(DESKTOP_REOPEN_LOCK_BUDGET_MS);
      expect(recordFiles()).toEqual([`completed_${sessionId}.json`]);
      expect(mockSendSessionStart).not.toHaveBeenCalled();

      await held.release();
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);

      expect(recordFiles()).toEqual([`${sessionId}.json`]);
      expect(readRecord(sessionId)).toMatchObject({ status: 'active', ownerPid: process.pid });
      expect(mockSendSessionStart).not.toHaveBeenCalled();
    });
  });

  describe('folder switch', () => {
    it('takes over the switched transcript and folder with its repository and project, keeping the start', async () => {
      openDesktopChat('ext-1', 2, T0);
      const daemon = await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      const { startTime } = readRecord(sessionId)!;

      // Desktop moves the conversation to folder B (a new transcript under B's slug, a new cwd); the user writes there
      const switchedPath = '/transcripts/folder-b/ext-1.jsonl';
      const previous = transcripts.get(transcriptPathFor('ext-1'))!;
      vi.setSystemTime(Date.now() + 5_000);
      transcripts.set(switchedPath, { ...previous, mtimeMs: Date.now(), size: previous.size + 100 });
      Object.assign(desktopSessions.get('ext-1')!, {
        transcriptPath: switchedPath,
        workingDirectory: '/Users/test/codemie-ai/codemie-docs'
      });
      touchDesktopChat('ext-1');
      await pollTicks(daemon, 1);

      expect(readRecord(sessionId)).toMatchObject({
        correlation: { agentSessionFile: switchedPath },
        workingDirectory: '/Users/test/codemie-ai/codemie-docs',
        gitBranch: 'branch-codemie-docs',
        repository: 'codemie-ai/codemie-docs',
        project: 'project-codemie-docs',
        startTime
      });
    });
  });
});
