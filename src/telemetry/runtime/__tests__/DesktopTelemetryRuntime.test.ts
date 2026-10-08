import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '@/agents/core/session/types.js';

const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);
const mockSync = vi.fn().mockResolvedValue({ message: 'ok' });
const mockIndexSessionsByExternalId = vi.fn();
const mockFindSessionByExternalId = vi.fn().mockResolvedValue(null);

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
