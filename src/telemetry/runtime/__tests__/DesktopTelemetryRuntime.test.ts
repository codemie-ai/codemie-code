import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '@/agents/core/session/types.js';

const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);
const mockSync = vi.fn().mockResolvedValue({ message: 'ok' });
const mockIndexSessionsByExternalId = vi.fn();
const mockFindSessionByExternalId = vi.fn().mockResolvedValue(null);
const mockFindActiveSessions = vi.fn();

// Persisted sessions shared by every SessionStore instance, so a new runtime instance sees
// what a previous one saved — the same as a restarted daemon reading ~/.codemie/sessions.
const persistedSessions = new Map<string, Session>();

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
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return { mtimeMs: transcript.mtimeMs, size: transcript.size };
    })
  };
});

vi.mock('@/providers/plugins/sso/index.js', () => ({
  MetricsSender: vi.fn(function (this: Record<string, unknown>) {
    this.sendSessionStart = mockSendSessionStart;
    this.sendSessionEnd = mockSendSessionEnd;
  })
}));

vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: vi.fn(function (this: Record<string, unknown>) {
    this.findSessionByExternalId = mockFindSessionByExternalId;
    this.indexSessionsByExternalId = mockIndexSessionsByExternalId;
    this.findActiveSessions = mockFindActiveSessions;
    this.saveSession = vi.fn(async (session: Session) => {
      persistedSessions.set(session.sessionId, structuredClone(session));
    });
    this.loadSession = vi.fn(async (sessionId: string) => {
      const session = persistedSessions.get(sessionId);
      return session ? structuredClone(session) : null;
    });
  })
}));

vi.mock('@/providers/plugins/sso/session/SessionSyncer.js', () => ({
  SessionSyncer: vi.fn(function (this: Record<string, unknown>) {
    this.sync = mockSync;
  })
}));

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function (this: Record<string, unknown>) {
    this.getStoredCredentials = vi.fn().mockResolvedValue({ cookies: { session: 'abc123' } });
  })
}));

vi.mock('@/utils/processes.js', () => ({
  detectGitRemoteRepo: vi.fn().mockResolvedValue('codemie-ai/codemie-code'),
  detectGitBranch: vi.fn().mockResolvedValue('main')
}));

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn().mockResolvedValue({}) }
}));

import { DesktopTelemetryRuntime } from '../DesktopTelemetryRuntime.js';
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
      const session = persistedSessions.get(parsed.sessionId)!;
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
        persistedSessions.set(session.sessionId, session);
      }

      return { success: true, processors: {}, totalRecords: historyIndices.length, failedProcessors: [] };
    }) as never,
    // Mirrors the real baseline: messages written before the cutoff count as synced.
    applyBaseline: vi.fn(async (parsed: { sessionId: string; metadata: { externalSessionId: string } }, cutoffMs: number) => {
      const session = persistedSessions.get(parsed.sessionId)!;
      const transcript = transcripts.get(transcriptPathFor(parsed.metadata.externalSessionId))!;
      const before = transcript.messageTimes.filter(time => time < cutoffMs).length;
      session.sync = {
        ...session.sync,
        conversations: { ...session.sync?.conversations, lastSyncedHistoryIndex: before - 1 }
      };
      delete session.runtimeCheckpoint!.baselineCutoffMs;
      persistedSessions.set(session.sessionId, session);
    }) as never
  };
}

function indexPersistedSessions(agentName: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const session of persistedSessions.values()) {
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

function findActiveSessions(agentName: string): Session[] {
  return [...persistedSessions.values()].filter(
    (session) => session.agentName === agentName && session.status === 'active'
  );
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
    persistedSessions.clear();
    transcripts.clear();
    sentDeltas = [];
    desktopSessions = new Map();
    mockIndexSessionsByExternalId.mockImplementation(async (agentName: string) =>
      indexPersistedSessions(agentName)
    );
    mockFindActiveSessions.mockImplementation(async (agentName: string) =>
      findActiveSessions(agentName)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
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

  describe('restart reconciliation of already-active sessions', () => {
    it('finalizes a session that was already idle past the timeout when the daemon died', async () => {
      openDesktopChat('ext-1', 2, T0);
      await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      mockSendSessionEnd.mockClear();

      // The daemon is hard-killed and only restarted after the session has already been
      // idle longer than the timeout; Desktop reports no activity in between.
      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS + 60_000);
      const restartedDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await (restartedDaemon as any).reconcilePersistedSessions();

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const session = persistedSessions.get(sessionId)!;
      expect(session.status).toBe('completed');
      expect(session.reason).toBe('desktop-daemon-restart-stale');
    });

    it('stamps endTime at the last known activity, not at reconciliation time', async () => {
      openDesktopChat('ext-1', 2, T0);
      await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      mockSendSessionEnd.mockClear();

      // The daemon is hard-killed right after the session's last real activity (T0) and
      // only restarts well past the inactivity timeout — reconciliation must not blame the
      // dead-daemon gap on the session itself.
      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS + 60_000);
      const restartedDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await (restartedDaemon as any).reconcilePersistedSessions();

      const session = persistedSessions.get(sessionId)!;
      expect(session.endTime).toBe(T0);

      const [, , , durationMs] = mockSendSessionEnd.mock.calls[0];
      expect(durationMs).toBe(0);
    });

    it('re-tracks a not-yet-stale session so the normal idle timeout still finalizes it later', async () => {
      openDesktopChat('ext-1', 2, T0);
      await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      mockSendSessionEnd.mockClear();

      // Restart shortly after the last activity, well within the idle timeout.
      vi.setSystemTime(Date.now() + 60_000);
      const restartedDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await (restartedDaemon as any).reconcilePersistedSessions();

      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(persistedSessions.get(sessionId)!.status).toBe('active');

      // No further Desktop activity ever arrives. poll()'s own discovery would never
      // re-surface this session (its last activity predates the new startedAt), so only
      // the seeded trackedSessions entry lets the regular idle check catch it.
      await pollTicks(restartedDaemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const session = persistedSessions.get(sessionId)!;
      expect(session.status).toBe('completed');
      expect(session.reason).toBe('desktop-inactive-timeout');
    });

    it('never finalizes a stale session through poll() alone, without restart reconciliation', async () => {
      openDesktopChat('ext-1', 2, T0);
      await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      mockSendSessionEnd.mockClear();

      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS + 60_000);
      // Mirrors the pre-fix daemon: a fresh runtime driven only by poll(), the same way
      // startDaemon()/pollTicks() exercise every other test in this file.
      const restartedDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await pollTicks(restartedDaemon, 5);

      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(persistedSessions.get(sessionId)!.status).toBe('active');
    });

    it('runs reconciliation from start() before scheduling the poll loop', async () => {
      openDesktopChat('ext-1', 2, T0);
      await startDaemon(createAdapter());
      const sessionId = sessionIdFor('ext-1')!;
      mockSendSessionEnd.mockClear();

      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS + 60_000);
      const restartedDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await restartedDaemon.start();
      await restartedDaemon.stop();

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      const session = persistedSessions.get(sessionId)!;
      expect(session.status).toBe('completed');
      expect(session.reason).toBe('desktop-daemon-restart-stale');
    });

    it('finalizes a session whose last activity is far older than 24h — overdue reconciliation is not exempt', async () => {
      // A session abandoned on Monday and not restarted until Wednesday is exactly the case
      // this fallback exists to close. A cap that excludes anything inactive for "too long"
      // would permanently orphan precisely the sessions most overdue for finalization.
      const THIRTEEN_DAYS_MS = 13 * 24 * 60 * 60 * 1000;
      const ancientActivity = T0 - THIRTEEN_DAYS_MS;
      persistedSessions.set('ancient-session', {
        sessionId: 'ancient-session',
        agentName: 'claude-desktop',
        provider: 'ai-run-sso',
        startTime: ancientActivity,
        workingDirectory: '/tmp/ancient',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', retryCount: 0 },
        runtimeCheckpoint: { externalSessionId: 'ext-ancient', lastSeenActivityAt: ancientActivity }
      });

      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      await (runtime as any).reconcilePersistedSessions();

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(persistedSessions.get('ancient-session')!.status).toBe('completed');
      expect(persistedSessions.get('ancient-session')!.reason).toBe('desktop-daemon-restart-stale');
    });

    it('does finalize a long-lived session whose startTime is ancient but whose last activity is still within lookback', async () => {
      const THIRTEEN_DAYS_MS = 13 * 24 * 60 * 60 * 1000;
      const recentActivity = T0 - 2 * 60 * 60 * 1000;
      persistedSessions.set('old-but-recently-active-session', {
        sessionId: 'old-but-recently-active-session',
        agentName: 'claude-desktop',
        provider: 'ai-run-sso',
        startTime: T0 - THIRTEEN_DAYS_MS,
        workingDirectory: '/tmp/old-but-recent',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', retryCount: 0 },
        runtimeCheckpoint: {
          externalSessionId: 'ext-old-but-recent',
          lastSeenActivityAt: recentActivity
        }
      });

      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      await (runtime as any).reconcilePersistedSessions();

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(persistedSessions.get('old-but-recently-active-session')!.status).toBe('completed');
      expect(persistedSessions.get('old-but-recently-active-session')!.reason).toBe('desktop-daemon-restart-stale');
    });

    it('finalizes a session abandoned Monday at 09:00, closed at 09:40, and not restarted until Wednesday', async () => {
      const monday0900 = new Date('2026-10-12T09:00:00Z').getTime();
      const monday0940 = monday0900 + 40 * 60 * 1000;
      const wednesday = new Date('2026-10-14T09:00:00Z').getTime(); // ~47h after the session's last activity

      persistedSessions.set('monday-session', {
        sessionId: 'monday-session',
        agentName: 'claude-desktop',
        provider: 'ai-run-sso',
        startTime: monday0900,
        workingDirectory: '/tmp/monday',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', retryCount: 0 },
        runtimeCheckpoint: { externalSessionId: 'ext-monday', lastSeenActivityAt: monday0940 }
      });

      vi.setSystemTime(wednesday);
      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      await (runtime as any).reconcilePersistedSessions();

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(persistedSessions.get('monday-session')!.status).toBe('completed');
      expect(persistedSessions.get('monday-session')!.reason).toBe('desktop-daemon-restart-stale');
    });

    it('finalizes a session that legitimately ran for about 23.5h once it goes idle — session age is not a cap on reconciliation', async () => {
      const twentyThreeAndHalfHours = 23.5 * 60 * 60 * 1000;
      const startTime = T0 - twentyThreeAndHalfHours;
      const lastActivity = T0 - 35 * 60 * 1000; // just past the inactivity timeout

      persistedSessions.set('long-running-session', {
        sessionId: 'long-running-session',
        agentName: 'claude-desktop',
        provider: 'ai-run-sso',
        startTime,
        workingDirectory: '/tmp/long-running',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', retryCount: 0 },
        runtimeCheckpoint: { externalSessionId: 'ext-long-running', lastSeenActivityAt: lastActivity }
      });

      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      await (runtime as any).reconcilePersistedSessions();

      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
      expect(persistedSessions.get('long-running-session')!.status).toBe('completed');
      expect(persistedSessions.get('long-running-session')!.reason).toBe('desktop-daemon-restart-stale');
    });

    it('keeps finalizing the stranded session no matter how much later the daemon restarts — no point past 24h starts skipping it', async () => {
      const delays = [25 * 60 * 60 * 1000, 3 * 24 * 60 * 60 * 1000, 14 * 24 * 60 * 60 * 1000];

      for (const delay of delays) {
        persistedSessions.clear();
        mockSendSessionEnd.mockClear();
        persistedSessions.set('repeat-session', {
          sessionId: 'repeat-session',
          agentName: 'claude-desktop',
          provider: 'ai-run-sso',
          startTime: T0,
          workingDirectory: '/tmp/repeat',
          status: 'active',
          activeDurationMs: 0,
          correlation: { status: 'matched', retryCount: 0 },
          runtimeCheckpoint: { externalSessionId: 'ext-repeat', lastSeenActivityAt: T0 }
        });

        vi.setSystemTime(T0 + delay);
        const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
        await (runtime as any).reconcilePersistedSessions();

        expect(mockSendSessionEnd).toHaveBeenCalledOnce();
        expect(persistedSessions.get('repeat-session')!.status).toBe('completed');
        expect(persistedSessions.get('repeat-session')!.reason).toBe('desktop-daemon-restart-stale');
      }
    });

    it('does nothing when there are no persisted active sessions', async () => {
      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);

      await expect((runtime as any).reconcilePersistedSessions()).resolves.toBeUndefined();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
    });

    it('ignores active sessions belonging to a different agent', async () => {
      persistedSessions.set('other-agent-session', {
        sessionId: 'other-agent-session',
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: T0,
        workingDirectory: '/tmp/other',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', retryCount: 0 },
        runtimeCheckpoint: { externalSessionId: 'claude-ext-1', lastSeenActivityAt: T0 }
      });

      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS + 60_000);
      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);
      await (runtime as any).reconcilePersistedSessions();

      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(persistedSessions.get('other-agent-session')!.status).toBe('active');
    });

    it('skips a persisted active session with no externalSessionId instead of throwing', async () => {
      persistedSessions.set('no-external-id', {
        sessionId: 'no-external-id',
        agentName: 'claude-desktop',
        provider: 'ai-run-sso',
        startTime: T0,
        workingDirectory: '/tmp/no-ext',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', retryCount: 0 }
      });

      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS + 60_000);
      const runtime = new DesktopTelemetryRuntime(createAdapter(), config);

      await expect((runtime as any).reconcilePersistedSessions()).resolves.toBeUndefined();
      expect(mockSendSessionEnd).not.toHaveBeenCalled();
      expect(persistedSessions.get('no-external-id')!.status).toBe('active');
    });

    it('handles several concurrently open sessions independently in the same reconciliation pass', async () => {
      openDesktopChat('ext-stale', 1, T0);
      openDesktopChat('ext-fresh', 1, T0);
      const firstDaemon = await startDaemon(createAdapter());
      const staleId = sessionIdFor('ext-stale')!;
      const freshId = sessionIdFor('ext-fresh')!;

      // ext-fresh gets new activity (persisting a bumped lastSeenActivityAt) right
      // before the restart; ext-stale gets none.
      vi.setSystemTime(Date.now() + 60_000);
      appendMessages('ext-fresh', 1);
      await pollTicks(firstDaemon, 1);
      mockSendSessionEnd.mockClear();

      // Restart long enough after T0 that ext-stale is already past the timeout, but
      // shortly enough after ext-fresh's bumped activity that it is not.
      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS - 30_000);
      const restartedDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await (restartedDaemon as any).reconcilePersistedSessions();

      expect(persistedSessions.get(staleId)!.status).toBe('completed');
      expect(persistedSessions.get(staleId)!.reason).toBe('desktop-daemon-restart-stale');
      expect(persistedSessions.get(freshId)!.status).toBe('active');

      await pollTicks(restartedDaemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      expect(persistedSessions.get(freshId)!.status).toBe('completed');
      expect(persistedSessions.get(freshId)!.reason).toBe('desktop-inactive-timeout');
    });

    it('does not let one failed finalization abort reconciliation of the rest, or crash start()', async () => {
      openDesktopChat('ext-bad', 1, T0);
      openDesktopChat('ext-ok', 1, T0);
      await startDaemon(createAdapter());
      const badId = sessionIdFor('ext-bad')!;
      const okId = sessionIdFor('ext-ok')!;
      mockSendSessionEnd.mockClear();

      vi.setSystemTime(Date.now() + INACTIVITY_TIMEOUT_MS + 60_000);
      // Simulates a transient failure (network blip, SSO cookie hiccup) while finalizing
      // the first stranded session found during reconciliation.
      mockSync.mockRejectedValueOnce(new Error('network blip'));

      const restartedDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await expect(restartedDaemon.start()).resolves.toBeUndefined();
      await restartedDaemon.stop();

      // A failed finalization must not wedge the record as "completed" before its final
      // transcript/sync/end-metric path succeeded, or there would be nothing left for the
      // next daemon start to retry. The failure is still isolated: start() completed, and
      // the next stale session in the same pass finalized normally end-to-end.
      expect(persistedSessions.get(badId)!.status).toBe('active');
      expect(persistedSessions.get(okId)!.status).toBe('completed');
      expect(persistedSessions.get(okId)!.reason).toBe('desktop-daemon-restart-stale');
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();

      mockSendSessionEnd.mockClear();
      const retryDaemon = new DesktopTelemetryRuntime(createAdapter(), config);
      await expect(retryDaemon.start()).resolves.toBeUndefined();
      await retryDaemon.stop();

      expect(persistedSessions.get(badId)!.status).toBe('completed');
      expect(persistedSessions.get(badId)!.reason).toBe('desktop-daemon-restart-stale');
      expect(mockSendSessionEnd).toHaveBeenCalledOnce();
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

      expect(persistedSessions.get(sessionIdFor('ext-old')!)!.startTime).toBe(T0);
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
      await expect(firstDaemon.triggerPoll()).rejects.toThrow('killed');
      expect(persistedSessions.get(sessionIdFor('ext-old')!)!.runtimeCheckpoint!.baselineCutoffMs).toBe(T0);

      vi.setSystemTime(Date.now() + 60_000);
      touchDesktopChat('ext-old');
      const restartedAdapter = createAdapter();
      await startDaemon(restartedAdapter);

      expect(restartedAdapter.applyBaseline).toHaveBeenCalledOnce();
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-old', historyIndices: [4] }]);
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

    it('retries processing on the next tick when processing fails', async () => {
      openDesktopChat('ext-1', 2, T0);
      const adapter = createAdapter();
      const daemon = await startDaemon(adapter);
      sentDeltas = [];
      vi.clearAllMocks();

      appendMessages('ext-1', 1);
      vi.mocked(adapter.processParsedSession).mockRejectedValueOnce(new Error('disk full'));
      vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
      await expect(daemon.triggerPoll()).rejects.toThrow('disk full');

      // Transcript unchanged since the failed attempt: it must not be treated as handled.
      touchDesktopChat('ext-1');
      await pollTicks(daemon, 1);

      expect(mockSync).toHaveBeenCalledOnce();
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-1', historyIndices: [2] }]);
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
      const session = persistedSessions.get(sessionIdFor('ext-1')!)!;
      expect(session.status).toBe('completed');
      expect(session.reason).toBe('desktop-inactive-timeout');
    });

    it('stamps endTime at the last known activity, not at the time the timeout check runs', async () => {
      openDesktopChat('ext-1', 2, T0);
      const daemon = await startDaemon(createAdapter());
      appendMessages('ext-1', 1);
      await pollTicks(daemon, 1);
      mockSendSessionEnd.mockClear();

      await pollTicks(daemon, INACTIVITY_TIMEOUT_MS / POLL_INTERVAL_MS + 1);

      const session = persistedSessions.get(sessionIdFor('ext-1')!)!;
      expect(session.endTime).toBe(T0);
      expect(session.endTime).toBeLessThan(Date.now());
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
      expect(persistedSessions.get(sessionId!)!.status).toBe('active');
      expect(sentDeltas).toEqual([{ externalSessionId: 'ext-1', historyIndices: [3] }]);
    });
  });
});
