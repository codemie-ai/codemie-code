/**
 * SessionEnd finalization and delivery, `/clear` generations and the completed_ rename.
 *
 * Seams: `processEvent` (in-process callers) and `createHookCommand` (the agent's own hook
 * process). The network boundary is `fetch`; the stored-credential lookup of a hook process
 * is stubbed; records and transcripts are real files under a per-test CODEMIE_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'node:stream';
import { rename } from 'fs/promises';
import type { Session } from '../../../agents/core/session/types.js';

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setSessionId: vi.fn(),
    setProfileName: vi.fn(),
    isDebugMode: () => false,
    close: vi.fn(async () => {}),
    runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

// Process spawns are a boundary: the hook must never spawn `ps` inside the agent's SessionEnd budget
vi.mock('@/utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/exec.js')>();
  return { ...actual, exec: vi.fn(actual.exec) };
});

vi.mock('../../../providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../providers/core/codemie-auth-helpers.js')>()),
  getStoredAnalyticsCredentials: vi.fn(async () => ({ credentials: { cookies: { session: 'abc' } } })),
}));

const { processEvent, createHookCommand } = await import('../hook.js');
const { renameSessionFiles } = await import('../../../agents/core/session/session-generation.js');
const { finalizeOwnRecord, reconcileOtherSessions } = await import('../../../agents/core/session/stale-session-reconciliation.js');
const { noticeDeliveryAtExit } = await import('../../../agents/core/session/exit-notice.js');
const { logger } = await import('@/utils/logger.js');
const { ensureSessionFile } = await import('../../../agents/core/session/ensure-session.js');
const { exec } = await import('@/utils/exec.js');
const { MetricsDataLoader } = await import('../analytics/data-loader.js');
const { PiPluginMetadata } = await import('../../../agents/plugins/pi/pi.plugin.js');
const { stopPiIncrementalSync } = await import('../../../agents/plugins/pi/pi.incremental-sync.js');
const { CodeMieCodePluginMetadata } = await import('../../../agents/plugins/codemie-code.plugin.js');

const HOST = 'https://codemie.example.com';
const API = 'http://127.0.0.1:4999';
/** Set by the started proxy: CODEMIE_BASE_URL is the proxy, a send path */
const UPSTREAM = 'https://codemie.example.com/code-assistant-api';
/** A profile's LLM host: CODEMIE_BASE_URL when no proxy started, never a send path */
const LLM_HOST = 'https://llm.example.com';
const SECOND = 1000;

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;
const envBefore = { ...process.env };

interface Captured {
  name: string;
  attributes: Record<string, unknown>;
}
let requests: Captured[];
let urls: string[];
let respond: (metric: Captured) => Promise<Response> | Response;

function ok(): Response {
  return new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function endMetrics(): Captured[] {
  return requests.filter((r) => r.name === 'codemie_cli_session_total' && r.attributes.status === 'completed');
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `11111111-2222-4333-8444-${String(idCounter).padStart(12, '0')}`;
}

function writeRecord(session: Session, prefix = ''): void {
  writeFileSync(join(sessionsDir, `${prefix}${session.sessionId}.json`), JSON.stringify(session));
}

function readRecord(sessionId: string, prefix = ''): Session {
  return JSON.parse(readFileSync(join(sessionsDir, `${prefix}${sessionId}.json`), 'utf-8')) as Session;
}

function baseRecord(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: newId(),
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: Date.parse('2026-10-01T10:00:00Z'),
    workingDirectory: home,
    status: 'active',
    activeDurationMs: 0,
    codemieUrl: HOST,
    correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-1' },
    ...overrides,
  };
}

/** A claude transcript whose records carry the given ISO times. */
function writeTranscript(times: string[]): string {
  const path = join(home, `transcript-${idCounter}.jsonl`);
  const lines = times.map((timestamp, i) => JSON.stringify({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: `msg-${idCounter}-${i}`,
    sessionId: 'claude-native-1',
    timestamp,
    message: i % 2 === 0
      ? { role: 'user', content: `prompt ${i}` }
      : { role: 'assistant', id: `api-${idCounter}-${i}`, content: [{ type: 'text', text: `reply ${i}` }], usage: { input_tokens: 1, output_tokens: 1 } },
  }));
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function writeDeltas(sessionId: string, deltas: Array<{ timestamp: number; syncStatus?: string; syncAttempts?: number }>, prefix = ''): void {
  const lines = deltas.map((d, i) => JSON.stringify({
    recordId: `rec-${sessionId}-${i}`,
    sessionId,
    agentSessionId: 'claude-native-1',
    timestamp: d.timestamp,
    gitBranch: 'main',
    tools: { Read: 1 },
    toolStatus: { Read: { success: 1, failure: 0 } },
    fileOperations: [],
    syncStatus: d.syncStatus ?? 'pending',
    syncAttempts: d.syncAttempts ?? 0,
  }));
  writeFileSync(join(sessionsDir, `${prefix}${sessionId}_metrics.jsonl`), `${lines.join('\n')}\n`);
}

function readDeltas(sessionId: string, prefix = ''): Array<{ syncStatus: string; timestamp: number | string }> {
  const path = join(sessionsDir, `${prefix}${sessionId}_metrics.jsonl`);
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function config(session: Session, extra: Record<string, unknown> = {}) {
  return {
    agentName: session.agentName,
    sessionId: session.sessionId,
    provider: 'ai-run-sso',
    apiBaseUrl: API,
    ssoUrl: HOST,
    cookies: 'session=abc',
    env: { CODEMIE_TARGET_API_URL: UPSTREAM } as NodeJS.ProcessEnv,
    ...extra,
  };
}

function syntheticEnd(transcript = '') {
  return {
    hook_event_name: 'SessionEnd',
    session_id: 'claude-native-1',
    transcript_path: transcript,
    permission_mode: 'default',
    cwd: home,
    reason: 'interrupted',
    endTimeFromActivity: true,
  };
}

/** The end metric answers 200 at once; every other request is answered only by its abort. Times are the fake clock's. */
function endMetricOkOthersHang(): { endMetricAt: number[]; abortedAt: number[] } {
  const times = { endMetricAt: [] as number[], abortedAt: [] as number[] };
  vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
    const metric = JSON.parse(String((init as RequestInit).body)) as Captured;
    requests.push(metric);
    if (metric.name === 'codemie_cli_session_total') {
      times.endMetricAt.push(Date.now());
      return Promise.resolve(ok());
    }
    return new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => {
        times.abortedAt.push(Date.now());
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  });
  return times;
}

/** Runs `work` on a fake clock (setTimeout and Date) in 25 ms steps, real I/O running between them. */
async function onFakeClock(work: () => Promise<void>): Promise<void> {
  const realSetTimeout = setTimeout;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let finished = false;
    const run = work().then(() => { finished = true; });
    for (let step = 0; !finished && step < 2000; step++) {
      await vi.advanceTimersByTimeAsync(25);
      await new Promise((resolve) => realSetTimeout(resolve, 1));
    }
    await run;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codemie-delivery-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  requests = [];
  urls = [];
  respond = () => ok();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    urls.push(String(url));
    const metric = JSON.parse(String((init as RequestInit).body)) as Captured;
    requests.push(metric);
    return respond(metric);
  });
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(rename).mockReset();
  for (const key of Object.keys(process.env)) {
    if (!(key in envBefore)) delete process.env[key];
  }
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('SessionEnd with endTimeFromActivity (the synthetic end)', () => {
  it('ends at the last transcript record, caps the active time there and sends that one end', async () => {
    const lastDelta = Date.parse('2026-10-01T10:30:00Z');
    const transcript = writeTranscript(['2026-10-01T10:29:58Z', '2026-10-01T10:30:02Z']);
    const session = baseRecord({
      activityStartedAt: Date.parse('2026-10-01T10:20:00Z'),
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-1', agentSessionFile: transcript },
    });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: lastDelta, syncStatus: 'synced' }]);

    await processEvent(syntheticEnd(transcript), config(session));

    const end = Date.parse('2026-10-01T10:30:02Z');
    const done = readRecord(session.sessionId, 'completed_');
    expect(done.endTime).toBe(end);
    expect(done.activeDurationMs).toBe(end - Date.parse('2026-10-01T10:20:00Z'));
    expect(done.reason).toBe('interrupted');
    const [metric] = endMetrics();
    expect(metric.attributes.session_id).toBe('claude-native-1');
    expect(metric.attributes.session_duration_ms).toBe(end - session.startTime);
    expect(metric.attributes.end_time).toBe(end);
  });

  it('ends at the latest delta when the transcript is gone', async () => {
    const lastDelta = Date.parse('2026-10-01T11:00:00Z');
    const session = baseRecord({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-1', agentSessionFile: join(home, 'deleted.jsonl') },
    });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: lastDelta - 60 * SECOND, syncStatus: 'synced' }, { timestamp: lastDelta, syncStatus: 'synced' }]);

    await processEvent(syntheticEnd(), config(session));

    expect(readRecord(session.sessionId, 'completed_').endTime).toBe(lastDelta);
  });

  it('flushes a record that never had a Stop and ends it at its last record', async () => {
    const transcript = writeTranscript(['2026-10-01T10:05:00Z', '2026-10-01T10:06:00Z']);
    const session = baseRecord({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-1', agentSessionFile: transcript },
    });
    writeRecord(session);

    await processEvent(syntheticEnd(transcript), config(session));

    expect(readRecord(session.sessionId, 'completed_').endTime).toBe(Date.parse('2026-10-01T10:06:00Z'));
    expect(readDeltas(session.sessionId, 'completed_').length).toBeGreaterThan(0);
  });

  it('a later record over the same transcript (a live --resume run) bounds the end; that record stays untouched', async () => {
    const transcript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:11:00Z', '2026-10-01T12:00:00Z', '2026-10-01T12:01:00Z']);
    const correlation = { status: 'matched' as const, retryCount: 0, agentSessionId: 'claude-native-1', agentSessionFile: transcript };
    const stranded = baseRecord({ correlation });
    const resumed = baseRecord({ startTime: Date.parse('2026-10-01T11:59:00Z'), correlation });
    writeRecord(stranded);
    writeRecord(resumed);
    const resumedBefore = readFileSync(join(sessionsDir, `${resumed.sessionId}.json`), 'utf-8');

    await processEvent(syntheticEnd(transcript), config(stranded));

    expect(readRecord(stranded.sessionId, 'completed_').endTime).toBe(Date.parse('2026-10-01T10:11:00Z'));
    expect(readFileSync(join(sessionsDir, `${resumed.sessionId}.json`), 'utf-8')).toBe(resumedBefore);
  });

  it('a normal SessionEnd still ends now', async () => {
    const session = baseRecord();
    writeRecord(session);
    const before = Date.now();

    await processEvent({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, config(session));

    const endTime = readRecord(session.sessionId, 'completed_').endTime!;
    expect(endTime).toBeGreaterThanOrEqual(before);
    expect(endTime).toBeLessThanOrEqual(Date.now());
  });

  it('a record written by the ensureSessionFile safety net ends with an endTime and loads as a session_end', async () => {
    const sessionId = newId();
    const env = { CODEMIE_AGENT: 'claude', CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_URL: HOST, CODEMIE_REPOSITORY: 'org/repo' } as NodeJS.ProcessEnv;
    await ensureSessionFile(sessionId, env, 'claude');
    const placeholder = readRecord(sessionId);
    expect(placeholder.endTime).toBeUndefined();

    await processEvent({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, config(placeholder));

    const done = readRecord(sessionId, 'completed_');
    expect(done.status).toBe('completed');
    expect(done.endTime).toBeTypeOf('number');
    expect(done.endTime!).toBeGreaterThanOrEqual(done.startTime);
    const [loaded] = new MetricsDataLoader(sessionsDir).loadSessions({ sessionId });
    expect(loaded.endEvent?.type).toBe('session_end');
    expect(loaded.endEvent?.data.endTime).toBe(done.endTime);
  });
});

describe('delivery: the end metric marker, the pending lines and the rename', () => {
  it('a 200 sets endMetricSentAt, syncs the pending lines and renames', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session));

    const done = readRecord(session.sessionId, 'completed_');
    expect(done.endMetricSentAt).toBeTypeOf('number');
    expect(readDeltas(session.sessionId, 'completed_').map((d) => d.syncStatus)).toEqual(['synced']);
    expect(existsSync(join(sessionsDir, `${session.sessionId}.json`))).toBe(false);
  });

  it('a line failed past its sync-attempt cap counts as done: renamed, marked dropped', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND, syncStatus: 'failed', syncAttempts: 3 }]);
    const before = Date.now();

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session));

    const done = readRecord(session.sessionId, 'completed_');
    expect(done.endMetricSentAt).toBeTypeOf('number');
    expect(done.droppedAt).toBeGreaterThanOrEqual(before);
  });

  it('an end metric sent but a line left pending (sync stopped by the abort) keeps {id}.json', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    const controller = new AbortController();
    respond = (metric) => {
      if (metric.name === 'codemie_cli_session_total') controller.abort();
      return ok();
    };

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session, { abortSignal: controller.signal }));

    const kept = readRecord(session.sessionId);
    expect(kept.status).toBe('completed');
    expect(kept.endMetricSentAt).toBeTypeOf('number');
    expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
  });

  it('an in-process SessionEnd stops its end metric at the exit deadline its env carries; the record stays queued', async () => {
    const session = baseRecord();
    writeRecord(session);
    const abortedAt: number[] = [];
    // The server never answers; only the deadline's abort ends a request
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      requests.push(JSON.parse(String((init as RequestInit).body)) as Captured);
      return new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => {
          abortedAt.push(Date.now());
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    // Real I/O runs between fake-clock steps
    const realSetTimeout = setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let startedAt = 0;
    try {
      startedAt = Date.now();
      const env = { CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_EXIT_DEADLINE_MS: String(startedAt + 3 * SECOND) } as NodeJS.ProcessEnv;
      let finished = false;
      const end = processEvent({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, config(session, { env }))
        .then(() => { finished = true; });
      for (let step = 0; !finished && step < 2000; step++) {
        await vi.advanceTimersByTimeAsync(25);
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
      await end;
    } finally {
      vi.useRealTimers();
    }

    expect(endMetrics().length).toBeGreaterThan(0);
    expect(Math.max(...abortedAt) - startedAt).toBe(3 * SECOND);
    const kept = readRecord(session.sessionId);
    expect(kept.status).toBe('completed');
    expect(kept.endMetricSentAt).toBeUndefined();
  });

  it('everything sent but one conversation payload left pending keeps {id}.json', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND, syncStatus: 'synced' }]);
    writeFileSync(join(sessionsDir, `${session.sessionId}_conversation.jsonl`), `${JSON.stringify({
      payloadId: 'payload-1',
      timestamp: session.startTime + SECOND,
      isTurnContinuation: false,
      historyIndices: [0],
      messageCount: 1,
      payload: { conversationId: 'conv-1', history: [{ role: 'User', message: 'hi', history_index: 0 }] },
      status: 'pending',
    })}\n`);
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/v1/conversations/')) {
        return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      requests.push(JSON.parse(String((init as RequestInit).body)) as Captured);
      return ok();
    });

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session));

    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(false);
    expect(readRecord(session.sessionId).endMetricSentAt).toBeTypeOf('number');
  });

  it('an in-process caller\'s deadline past the 2 s budget bounds the sync alone', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    const times = endMetricOkOthersHang();
    let startedAt = 0;

    await onFakeClock(async () => {
      startedAt = Date.now();
      await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session, { deadlineMs: startedAt + 3500 }));
    });

    expect(times.endMetricAt).toHaveLength(1);
    expect(times.abortedAt.length).toBeGreaterThan(0);
    expect(Math.max(...times.abortedAt) - startedAt).toBe(3500);
    expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
  });

  it('a second SessionEnd on a record whose end metric was sent sends no end metric', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), endMetricSentAt: Date.now() });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session));

    expect(endMetrics()).toHaveLength(0);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
  });

  it('an unmatched record is renamed once its end metric is done, its lines not applicable', async () => {
    const session = baseRecord({ correlation: { status: 'failed', retryCount: 3 } });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    respond = (metric) => (metric.name === 'codemie_cli_session_total' ? ok() : new Response('{}', { status: 503 }));

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session));

    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
  });

  it('moves an existing completed_ set of another generation aside before renaming', async () => {
    const id = newId();
    const older = baseRecord({ sessionId: id, status: 'completed', correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-alpha' } });
    writeRecord(older, 'completed_');
    writeDeltas(id, [{ timestamp: older.startTime, syncStatus: 'synced' }], 'completed_');
    const current = baseRecord({ sessionId: id, correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-bravo' } });
    writeRecord(current);

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(current));

    expect(readRecord(id, 'completed_').correlation.agentSessionId).toBe('gen-bravo');
    expect(JSON.parse(readFileSync(join(sessionsDir, `completed_${id}-gen-alpha.json`), 'utf-8')).correlation.agentSessionId).toBe('gen-alpha');
    expect(existsSync(join(sessionsDir, `completed_${id}-gen-alpha_metrics.jsonl`))).toBe(true);
  });

  it('renames over an existing completed_ set of the same generation', async () => {
    const id = newId();
    const older = baseRecord({ sessionId: id, status: 'completed' });
    writeRecord(older, 'completed_');
    const current = baseRecord({ sessionId: id });
    writeRecord(current);

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(current));

    expect(readdirSync(sessionsDir).filter((n) => n.startsWith(`completed_${id}`) && n.endsWith('.json'))).toEqual([`completed_${id}.json`]);
  });

  it('moves an older completed_ set aside when neither record file is readable', async () => {
    const id = newId();
    writeFileSync(join(sessionsDir, `completed_${id}.json`), '{"older');
    writeFileSync(join(sessionsDir, `completed_${id}_metrics.jsonl`), 'older-metrics\n');
    writeFileSync(join(sessionsDir, `${id}.json`), '{"current');

    await renameSessionFiles(id);

    expect(readdirSync(sessionsDir).filter((n) => n.startsWith(`completed_${id}`)).sort())
      .toEqual([`completed_${id}-unknown.json`, `completed_${id}-unknown_metrics.jsonl`, `completed_${id}.json`]);
    expect(readFileSync(join(sessionsDir, `completed_${id}-unknown.json`), 'utf-8')).toBe('{"older');
    expect(readFileSync(join(sessionsDir, `completed_${id}-unknown_metrics.jsonl`), 'utf-8')).toBe('older-metrics\n');
    expect(readFileSync(join(sessionsDir, `completed_${id}.json`), 'utf-8')).toBe('{"current');
  });

  it('an agent session id of "unknown" is no generation: two starts are two generations', async () => {
    const id = newId();
    const unknown = { status: 'matched' as const, retryCount: 0, agentSessionId: 'unknown' };
    const older = baseRecord({ sessionId: id, status: 'completed', startTime: Date.parse('2026-10-01T09:00:00Z'), correlation: unknown });
    writeRecord(older, 'completed_');
    const current = baseRecord({ sessionId: id, correlation: unknown });
    writeRecord(current);

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(current));

    const movedPath = join(sessionsDir, `completed_${id}-${Date.parse('2026-10-01T09:00:00Z')}.json`);
    expect(existsSync(movedPath)).toBe(true);
    const moved = JSON.parse(readFileSync(movedPath, 'utf-8')) as Session;
    expect(moved.startTime).toBe(Date.parse('2026-10-01T09:00:00Z'));
    expect(readRecord(id, 'completed_').startTime).toBe(Date.parse('2026-10-01T10:00:00Z'));
  });
});

describe('SessionEnd inside the agent hook process', () => {
  async function runHook(event: Record<string, unknown>, session: Session, env: Record<string, string> = {}): Promise<void> {
    Object.assign(process.env, {
      CODEMIE_AGENT: 'claude',
      CODEMIE_SESSION_ID: session.sessionId,
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_URL: HOST,
      CODEMIE_BASE_URL: API,
      CODEMIE_TARGET_API_URL: UPSTREAM,
      ...env,
    });
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: Readable.from([JSON.stringify(event)]), configurable: true });
    try {
      await createHookCommand().parseAsync(['--agent', 'claude'], { from: 'user' });
    } finally {
      if (stdin) Object.defineProperty(process, 'stdin', stdin);
    }
  }

  it('a /clear synthetic end inside the hook keeps the lower bound only (no later-record scan)', async () => {
    const transcript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:11:00Z', '2026-10-01T12:00:00Z', '2026-10-01T12:01:00Z']);
    const correlation = { status: 'matched' as const, retryCount: 0, agentSessionId: 'gen-hook', agentSessionFile: transcript };
    const previous = baseRecord({ correlation });
    writeRecord(previous);
    writeRecord(baseRecord({ startTime: Date.parse('2026-10-01T11:59:00Z'), correlation }));

    await runHook({
      hook_event_name: 'SessionStart',
      session_id: 'claude-native-next',
      transcript_path: join(home, 'next.jsonl'),
      permission_mode: 'default',
      cwd: home,
      source: 'clear',
    }, previous);

    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${previous.sessionId}-gen-hook.json`), 'utf-8')) as Session;
    expect(moved.endTime).toBe(Date.parse('2026-10-01T12:01:00Z'));
  });

  it('skips the whole finalization when another process holds the reconcile lock, and exits 0', async () => {
    const session = baseRecord();
    writeRecord(session);
    const before = readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8');
    // A live holder: this process, with its real start time
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(join(sessionsDir, `${session.sessionId}.reconcile.lock`), JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));

    await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session);

    expect(process.exitCode).toBe(0);
    expect(readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8')).toBe(before);
    expect(endMetrics()).toHaveLength(0);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes('being finalized by another process'))).toBe(true);
  });

  it('bounds its sync by CODEMIE_SESSION_END_SYNC_BUDGET_MS, though it has an abort signal', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    delete process.env.CODEMIE_WRAPPER_PID;
    const times = endMetricOkOthersHang();

    await onFakeClock(() => runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session, { CODEMIE_SESSION_END_SYNC_BUDGET_MS: '700' }));

    expect(times.endMetricAt).toHaveLength(1);
    expect(times.abortedAt.length).toBeGreaterThan(0);
    // The budget starts when the sync does, after the end metric's answer; the fake clock runs on during that I/O
    const syncSpent = Math.max(...times.abortedAt) - times.endMetricAt[0];
    expect(syncSpent).toBeGreaterThanOrEqual(700);
    expect(syncSpent).toBeLessThan(2000);
    expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
  });

  it('sends the end metric once, without retries, and keeps the record queued on a 503', async () => {
    const session = baseRecord();
    writeRecord(session);
    respond = () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });

    await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session);

    expect(endMetrics()).toHaveLength(1);
    const kept = readRecord(session.sessionId);
    expect(kept.status).toBe('completed');
    expect(kept.endMetricSentAt).toBeUndefined();
  });

  describe('SSO credentials go only through the send path', () => {
    const noProxy = { CODEMIE_BASE_URL: LLM_HOST, CODEMIE_TARGET_API_URL: '', CODEMIE_SYNC_API_URL: '' };
    const startEvent = () => ({
      hook_event_name: 'SessionStart',
      session_id: 'claude-native-1',
      transcript_path: join(home, 'start.jsonl'),
      permission_mode: 'default',
      cwd: home,
      source: 'startup',
    });

    it('no started proxy: SessionEnd sends nothing to the LLM host, the end metric marked no-send-path, the line kept pending', async () => {
      const session = baseRecord();
      writeRecord(session);
      writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);

      await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session, noProxy);

      expect(urls).toEqual([]);
      const kept = readRecord(session.sessionId);
      expect(kept.endMetricSkipped).toBe('no-send-path');
      expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
    });

    it('no started proxy: SessionStart sends no start metric to the LLM host', async () => {
      const session = baseRecord();

      await runHook(startEvent(), session, noProxy);

      expect(urls).toEqual([]);
      expect(readRecord(session.sessionId).status).toBe('active');
    });

    it('the proxy started: SessionStart and SessionEnd send to the proxy', async () => {
      const session = baseRecord();

      await runHook(startEvent(), session);
      await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session);

      expect(requests.map((r) => r.attributes.status)).toEqual(['started', 'completed']);
      expect(urls.every((url) => url.startsWith(API))).toBe(true);
    });

    it('no started proxy: the pi plugin\'s mid-run flush uploads nothing to the LLM host, the line kept pending', async () => {
      const sessionId = newId();
      const transcript = join(home, 'pi-transcript.jsonl');
      writeFileSync(transcript, '');
      writeFileSync(
        join(sessionsDir, `${sessionId}_pi-run.jsonl`),
        `${JSON.stringify({ t: 'boot' })}\n${JSON.stringify({ t: 'session', file: transcript, cwd: home })}\n`
      );
      writeDeltas(sessionId, [{ timestamp: Date.now() }]);
      process.env.CODEMIE_PI_SYNC_INTERVAL_MS = '10';
      const env = { CODEMIE_URL: HOST, CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_SESSION_ID: sessionId, CODEMIE_BASE_URL: LLM_HOST };

      await PiPluginMetadata.lifecycle!.onSessionStart!(sessionId, env);
      // A tick has processed the transcript and reached its upload step; stop waits for that tick to finish
      await vi.waitFor(() => expect(vi.mocked(logger.debug).mock.calls.flat().join('\n')).toContain('[pi-incremental-sync] tick ok'));
      await stopPiIncrementalSync(sessionId);

      expect(urls).toEqual([]);
      expect(readDeltas(sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
    });

    it('CODEMIE_SYNC_API_URL with no started proxy: the codemie-code plugin\'s SessionStart sends its start metric there', async () => {
      const sessionId = newId();

      await CodeMieCodePluginMetadata.lifecycle!.onSessionStart!(sessionId, {
        CODEMIE_URL: HOST,
        CODEMIE_PROVIDER: 'ai-run-sso',
        CODEMIE_BASE_URL: LLM_HOST,
        CODEMIE_SYNC_API_URL: API,
      });

      expect(requests.map((r) => r.attributes.status)).toEqual(['started']);
      expect(urls).toEqual([`${API}/v1/metrics`]);
    });
  });

  it('the hook finalizes first: the wrapper own-record step finds completed_ and sends nothing more', async () => {
    const session = baseRecord();
    writeRecord(session);

    await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session);
    await finalizeOwnRecord(session.sessionId, {
      env: { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM },
      deadlineMs: Date.now() + 10 * SECOND,
    });

    expect(endMetrics()).toHaveLength(1);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
  });

  it('the wrapper holds the lock: the hook skips without spawning ps, the wrapper finalizes — one end metric', async () => {
    const session = baseRecord();
    writeRecord(session);
    const { acquirePidLock } = await import('../../../utils/pid-lock.js');
    const { reconcileLockPath } = await import('../../../agents/core/session/stale-session-reconciliation.js');
    const wrapperLock = await acquirePidLock(reconcileLockPath(session.sessionId), { mode: 'try' });
    vi.mocked(exec).mockClear();

    await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session);
    expect(readRecord(session.sessionId).status).toBe('active');
    expect(vi.mocked(exec).mock.calls.filter(([command]) => command === 'ps')).toEqual([]);
    await wrapperLock!.release();
    await finalizeOwnRecord(session.sessionId, {
      env: { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROVIDER: 'ai-run-sso' },
      deadlineMs: Date.now() + 10 * SECOND,
    });

    expect(endMetrics()).toHaveLength(1);
    expect(readRecord(session.sessionId, 'completed_').reason).toBe('interrupted');
  });

  it('a /clear meets the reconcile lock another live process holds: no ps spawned, the previous generation left in place', async () => {
    const session = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-locked' } });
    writeRecord(session);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(join(sessionsDir, `${session.sessionId}.reconcile.lock`), JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    vi.mocked(exec).mockClear();

    // The fake clock runs out the lock wait without waiting it in real time
    await onFakeClock(() => runHook({
      hook_event_name: 'SessionStart',
      session_id: 'claude-native-next',
      transcript_path: join(home, 'next.jsonl'),
      permission_mode: 'default',
      cwd: home,
      source: 'clear',
    }, session));

    expect(vi.mocked(exec).mock.calls.filter(([command]) => command === 'ps')).toEqual([]);
    expect(readdirSync(sessionsDir).filter((name) => name.includes('gen-locked'))).toEqual([]);
    expect(readRecord(session.sessionId).startTime).toBe(session.startTime);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('locked by another process; left in place'))).toBe(true);
  });

  it('the hook\'s sync meets a sync lock another live process holds: no ps spawned, the line kept pending', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(join(sessionsDir, `${session.sessionId}.sync.lock`), JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    vi.mocked(exec).mockClear();

    await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session);

    expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
    expect(vi.mocked(exec).mock.calls.filter(([command]) => command === 'ps')).toEqual([]);
  });

  it('a SessionEnd that met a failing server is delivered by the next start: once, then nothing more', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    writeFileSync(join(sessionsDir, `${session.sessionId}_conversation.jsonl`), `${JSON.stringify({
      payloadId: 'payload-1',
      timestamp: session.startTime + SECOND,
      isTurnContinuation: false,
      historyIndices: [0],
      messageCount: 1,
      payload: { conversationId: 'conv-1', history: [{ role: 'User', message: 'hi', history_index: 0 }] },
      status: 'pending',
    })}\n`);
    delete process.env.CODEMIE_WRAPPER_PID;
    const conversationPuts: string[] = [];
    let serverUp = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/v1/conversations/')) conversationPuts.push(String(url));
      else requests.push(JSON.parse(String((init as RequestInit).body)) as Captured);
      return serverUp ? ok() : new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    });

    await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'prompt_input_exit' }, session);

    expect(endMetrics()).toHaveLength(1);
    const kept = readRecord(session.sessionId);
    expect(kept.status).toBe('completed');
    expect(kept.endMetricSentAt).toBeUndefined();
    expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);

    serverUp = true;
    requests = [];
    conversationPuts.length = 0;
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };
    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(requests.map((r) => r.name)).toEqual(['codemie_cli_session_total', 'codemie_cli_tool_usage_total']);
    expect(endMetrics()).toHaveLength(1);
    expect(conversationPuts).toEqual([`${API}/v1/conversations/conv-1/history`]);
    expect(readRecord(session.sessionId, 'completed_').endMetricSentAt).toBeTypeOf('number');
    expect(readDeltas(session.sessionId, 'completed_').map((d) => d.syncStatus)).toEqual(['synced']);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}_conversation.jsonl`))).toBe(true);
    expect(readdirSync(sessionsDir).filter((n) => n.startsWith(session.sessionId))).toEqual([]);

    requests = [];
    conversationPuts.length = 0;
    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(requests).toEqual([]);
    expect(conversationPuts).toEqual([]);
  });

  it('a start whose request the server never answers spends its attempt; the start after the 3rd renames unsent', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(session);
    // The server never answers; only the attempt's 10 s deadline ends a request
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      requests.push(JSON.parse(String((init as RequestInit).body)) as Captured);
      return new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };
    // Real I/O runs between fake-clock steps
    const realSetTimeout = setTimeout;
    const runStart = async (): Promise<void> => {
      let finished = false;
      const pass = reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done.then(() => { finished = true; });
      for (let step = 0; !finished && step < 2000; step++) {
        await vi.advanceTimersByTimeAsync(25);
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
      await pass;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const attempts: Array<number | undefined> = [];
      for (let start = 0; start < 3; start++) {
        await runStart();
        attempts.push(readRecord(session.sessionId).deliveryAttempts);
      }
      expect(attempts).toEqual([1, 2, 3]);
      expect(endMetrics().length).toBeGreaterThanOrEqual(3);

      requests = [];
      await runStart();
    } finally {
      vi.useRealTimers();
    }

    expect(requests).toEqual([]);
    expect(existsSync(join(sessionsDir, `${session.sessionId}.json`))).toBe(false);
    expect(readRecord(session.sessionId, 'completed_').endMetricSentAt).toBeUndefined();
  });

  describe('a live wrapper (CODEMIE_WRAPPER_PID) on a normal exit', () => {
    const liveWrapper = { CODEMIE_WRAPPER_PID: String(process.pid) };
    const DEAD_WRAPPER_PID = '999999';
    const exitEnd = (reason: string) => ({ ...syntheticEnd(), endTimeFromActivity: undefined, reason });

    it.each(['prompt_input_exit', 'logout'])('reason %s: the hook finalizes locally and sends nothing', async (reason) => {
      const session = baseRecord();
      writeRecord(session);
      writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);

      await runHook(exitEnd(reason), session, liveWrapper);

      expect(requests).toHaveLength(0);
      const kept = readRecord(session.sessionId);
      expect(kept.status).toBe('completed');
      expect(kept.reason).toBe(reason);
      expect(kept.endTime).toBeTypeOf('number');
      expect(kept.endMetricSentAt).toBeUndefined();
      expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
    });

    it('the wrapper own-record step then delivers the record: one end metric, synced, renamed', async () => {
      const session = baseRecord();
      writeRecord(session);
      writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);

      await runHook(exitEnd('prompt_input_exit'), session, liveWrapper);
      await finalizeOwnRecord(session.sessionId, {
        env: { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_AGENT: 'claude' },
        deadlineMs: Date.now() + 10 * SECOND,
      });

      expect(endMetrics()).toHaveLength(1);
      expect(readRecord(session.sessionId, 'completed_').endMetricSentAt).toBeTypeOf('number');
      expect(readDeltas(session.sessionId, 'completed_').map((d) => d.syncStatus)).toEqual(['synced']);
    });

    it.each(['clear', 'resume', 'other'])('reason %s: the hook still delivers and renames', async (reason) => {
      const session = baseRecord();
      writeRecord(session);

      await runHook(exitEnd(reason), session, liveWrapper);

      expect(endMetrics()).toHaveLength(1);
      expect(readRecord(session.sessionId, 'completed_').endMetricSentAt).toBeTypeOf('number');
    });

    it('a dead wrapper pid: the hook still delivers and renames', async () => {
      const session = baseRecord();
      writeRecord(session);

      await runHook(exitEnd('prompt_input_exit'), session, { CODEMIE_WRAPPER_PID: DEAD_WRAPPER_PID });

      expect(endMetrics()).toHaveLength(1);
      expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
    });

    it('no CODEMIE_WRAPPER_PID: the hook still delivers and renames', async () => {
      const session = baseRecord();
      writeRecord(session);
      delete process.env.CODEMIE_WRAPPER_PID;

      await runHook(exitEnd('prompt_input_exit'), session);

      expect(endMetrics()).toHaveLength(1);
      expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
    });

    it('no send path: the hook marks the end metric skipped and renames, as without a wrapper', async () => {
      const session = baseRecord({ provider: 'litellm' });
      writeRecord(session);

      await runHook(exitEnd('prompt_input_exit'), session, { ...liveWrapper, CODEMIE_PROVIDER: 'litellm', CODEMIE_URL: '' });

      expect(requests).toHaveLength(0);
      expect(readRecord(session.sessionId, 'completed_').endMetricSkipped).toBe('no-analytics-config');
    });

    it('ai-run-sso without CODEMIE_URL (the wrapper exit step cannot send): the hook delivers, no completed {id}.json left', async () => {
      const session = baseRecord();
      writeRecord(session);

      await runHook(exitEnd('prompt_input_exit'), session, { ...liveWrapper, CODEMIE_URL: '' });

      expect(existsSync(join(sessionsDir, `${session.sessionId}.json`))).toBe(false);
      expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
    });
  });
});

describe('SessionStart source=clear closes the previous generation', () => {
  function clearStart() {
    return {
      hook_event_name: 'SessionStart',
      session_id: 'claude-native-next',
      transcript_path: join(home, 'next-transcript.jsonl'),
      permission_mode: 'default',
      cwd: home,
      source: 'clear',
    };
  }

  it('an active generation gets its synthetic end over its own transcript, moves aside, and a fresh record starts', async () => {
    const transcript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:12:00Z']);
    const session = baseRecord({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-one', agentSessionFile: transcript },
    });
    writeRecord(session);
    const before = Date.now();

    await processEvent(clearStart(), config(session));

    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-one.json`), 'utf-8')) as Session;
    expect(moved.status).toBe('completed');
    expect(moved.endTime).toBe(Date.parse('2026-10-01T10:12:00Z'));
    const fresh = readRecord(session.sessionId);
    expect(fresh.status).toBe('active');
    expect(fresh.startTime).toBeGreaterThanOrEqual(before);
    expect(fresh.correlation.agentSessionId).toBe('claude-native-next');
  });

  it('an undelivered completed generation is delivered (end metric and lines), then moved', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-two' } });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);

    await processEvent(clearStart(), config(session));

    expect(endMetrics()).toHaveLength(1);
    const moved = readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-two_metrics.jsonl`), 'utf-8');
    expect(JSON.parse(moved.split('\n')[0]).syncStatus).toBe('synced');
    expect(readRecord(session.sessionId).status).toBe('active');
  });

  it('a completed_ generation is only moved', async () => {
    const session = baseRecord({ status: 'completed', endMetricSentAt: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-three' } });
    writeRecord(session, 'completed_');

    await processEvent(clearStart(), config(session));

    expect(endMetrics()).toHaveLength(0);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-three.json`))).toBe(true);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(false);
  });

  it('a move whose 2nd rename fails puts the 1st file back: the set stays under its names, the error logged', async () => {
    const session = baseRecord({ status: 'completed', endMetricSentAt: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-stuck-move' } });
    writeRecord(session, 'completed_');
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    writeFileSync(join(sessionsDir, `completed_${session.sessionId}_conversation.jsonl`), '{}\n');
    // A directory under the conversation target name: renaming a file onto it fails
    mkdirSync(join(sessionsDir, `completed_${session.sessionId}-gen-stuck-move_conversation.jsonl`, 'occupied'), { recursive: true });

    await processEvent(clearStart(), config(session));

    for (const suffix of ['.json', '_metrics.jsonl', '_conversation.jsonl']) {
      expect(existsSync(join(sessionsDir, `completed_${session.sessionId}${suffix}`))).toBe(true);
    }
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-stuck-move.json`))).toBe(false);
    expect(readRecord(session.sessionId, 'completed_').correlation.agentSessionId).toBe('gen-stuck-move');
    expect(vi.mocked(logger.error).mock.calls.some(([line]) => String(line).includes('failed to close the previous generation'))).toBe(true);
  });

  it('a completed {id}.json the close could not move stays as it is: no fresh record over it, the error logged', async () => {
    // Another host's generation: closed locally, sent nothing, so only the failed move touches it
    const session = baseRecord({ status: 'completed', endTime: Date.now(), codemieUrl: 'https://other.example.com', correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-unmoved' } });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    const recordBefore = readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8');
    const deltasBefore = readFileSync(join(sessionsDir, `${session.sessionId}_metrics.jsonl`), 'utf-8');
    const actualRename = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith('-gen-unmoved.json')) throw new Error('EPERM: rename');
      return actualRename(from, to);
    });

    await processEvent(clearStart(), config(session));

    expect(readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8')).toBe(recordBefore);
    expect(readFileSync(join(sessionsDir, `${session.sessionId}_metrics.jsonl`), 'utf-8')).toBe(deltasBefore);
    expect(vi.mocked(logger.error).mock.calls.some(([line]) => String(line).includes('could not be closed; the fresh record is not written'))).toBe(true);
  });

  it('a move killed after its first rename leaves the .json under its own name', async () => {
    const session = baseRecord({ status: 'completed', endMetricSentAt: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-killed' } });
    writeRecord(session, 'completed_');
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    writeFileSync(join(sessionsDir, `completed_${session.sessionId}_conversation.jsonl`), '{}\n');
    const actualRename = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).rename;
    let moves = 0;
    let resume: () => void = () => {};
    const killed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // The process dies at the 2nd rename of the move: it never gets past it.
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).includes('-gen-killed') && ++moves === 2) await killed;
      return actualRename(from, to);
    });

    const closing = processEvent(clearStart(), config(session));
    await vi.waitFor(() => expect(moves).toBe(2));

    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-killed.json`))).toBe(false);
    resume();
    await closing;
  });

  it('a move resumed after a kill appends the sidecar lines written since to the one already moved', async () => {
    const session = baseRecord({ status: 'completed', endMetricSentAt: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-resumed' } });
    writeRecord(session, 'completed_');
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    const movedMetrics = join(sessionsDir, `completed_${session.sessionId}-gen-resumed_metrics.jsonl`);
    writeFileSync(movedMetrics, '{"recordId":"moved-before-the-kill"}\n');

    await processEvent(clearStart(), config(session));

    const lines = readFileSync(movedMetrics, 'utf-8').trim().split('\n').map((line) => JSON.parse(line).recordId);
    expect(lines).toEqual(['moved-before-the-kill', `rec-${session.sessionId}-0`]);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}_metrics.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-resumed.json`))).toBe(true);
  });

  it('a resumed move whose .json rename fails leaves the appended sidecar in place with both parts', async () => {
    const session = baseRecord({ status: 'completed', endMetricSentAt: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-append-undo' } });
    writeRecord(session, 'completed_');
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    const movedMetrics = join(sessionsDir, `completed_${session.sessionId}-gen-append-undo_metrics.jsonl`);
    writeFileSync(movedMetrics, '{"recordId":"moved-before-the-kill"}\n');
    const actualRename = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith('-gen-append-undo.json')) throw new Error('EPERM: rename');
      return actualRename(from, to);
    });

    await processEvent(clearStart(), config(session));

    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}_metrics.jsonl`))).toBe(false);
    expect(existsSync(movedMetrics)).toBe(true);
    const lines = readFileSync(movedMetrics, 'utf-8').trim().split('\n').map((line) => JSON.parse(line).recordId);
    expect(lines).toEqual(['moved-before-the-kill', `rec-${session.sessionId}-0`]);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
    expect(vi.mocked(logger.error).mock.calls.some(([line]) => String(line).includes('failed to close the previous generation'))).toBe(true);
  });

  it('a delivery slower than the 2 s budget is cut, the generation moved anyway and logged', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-slow' } });
    writeRecord(session);
    // The server never answers the end metric; only the budget's abort ends that request
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      const metric = JSON.parse(String((init as RequestInit).body)) as Captured;
      if (metric.attributes.status !== 'completed') return Promise.resolve(ok());
      return new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const startedAt = Date.now();

    await processEvent(clearStart(), config(session));

    expect(Date.now() - startedAt).toBeLessThan(4 * SECOND);
    const movedPath = join(sessionsDir, `completed_${session.sessionId}-gen-slow.json`);
    expect((JSON.parse(readFileSync(movedPath, 'utf-8')) as Session).droppedAt).toBeGreaterThanOrEqual(startedAt);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes('delivery budget spent'))).toBe(true);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('a generation of another CodeMie host left undelivered is moved, not marked dropped', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), codemieUrl: 'https://other.example.com', correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-other-host' } });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    respond = () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });

    await processEvent(clearStart(), config(session));

    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-other-host.json`), 'utf-8')) as Session;
    expect(moved.droppedAt).toBeUndefined();
  });

  it.each([
    ['active', 'gen-other-active'],
    ['completed', 'gen-other-completed'],
  ] as const)('a %s generation of another CodeMie host is sent nothing through this launch, moved, not marked dropped', async (status, generation) => {
    const transcript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:12:00Z']);
    const session = baseRecord({
      status,
      ...(status === 'completed' ? { endTime: Date.now() } : {}),
      codemieUrl: 'https://other.example.com',
      correlation: { status: 'matched', retryCount: 0, agentSessionId: generation, agentSessionFile: transcript },
    });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);

    await processEvent(clearStart(), config(session));

    // Only the fresh generation's start metric
    expect(requests.map((r) => [r.name, r.attributes.status])).toEqual([['codemie_cli_session_total', 'started']]);
    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-${generation}.json`), 'utf-8')) as Session;
    expect(moved.droppedAt).toBeUndefined();
  });

  /** Runs `/clear` while another live process holds the lock, which it lets go of `releaseAfterMs` in (never when undefined). */
  async function clearAgainstHeldLock(session: Session, releaseAfterMs: number | undefined): Promise<number> {
    const lockPath = join(sessionsDir, `${session.sessionId}.reconcile.lock`);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    // Real I/O runs between fake-clock steps
    const realSetTimeout = setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const startedAt = Date.now();
      if (releaseAfterMs !== undefined) setTimeout(() => rmSync(lockPath), releaseAfterMs);
      let finishedAt: number | undefined;
      const start = processEvent(clearStart(), config(session)).then(() => {
        finishedAt = Date.now();
      });
      while (finishedAt === undefined && Date.now() - startedAt < 30 * SECOND) {
        await vi.advanceTimersByTimeAsync(25);
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
      await start;
      return finishedAt! - startedAt;
    } finally {
      vi.useRealTimers();
    }
  }

  it('a lock another process holds for 4 s is waited for: the generation is closed and moved, the fresh record written after it', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-held' } });
    writeRecord(session);

    await clearAgainstHeldLock(session, 4 * SECOND);

    expect(endMetrics()).toHaveLength(1);
    const movedPath = join(sessionsDir, `completed_${session.sessionId}-gen-held.json`);
    expect(existsSync(movedPath)).toBe(true);
    const moved = JSON.parse(readFileSync(movedPath, 'utf-8')) as Session;
    expect(moved.correlation.agentSessionId).toBe('gen-held');
    expect(readRecord(session.sessionId)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
  });

  it('a lock still held at 10 s is given up: logged, the generation neither delivered nor moved', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-stuck' } });
    writeRecord(session);

    const waitedMs = await clearAgainstHeldLock(session, undefined);

    expect(waitedMs).toBeGreaterThanOrEqual(10 * SECOND);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('locked by another process; left in place'))).toBe(true);
    expect(endMetrics()).toHaveLength(0);
    expect(readdirSync(sessionsDir).some((n) => n.startsWith(`completed_${session.sessionId}-`))).toBe(false);
  });

  it.each(['startup', 'resume', 'compact'])('source=%s over a live record of the same id re-enters it, nothing moved', async (source) => {
    const session = baseRecord();
    writeRecord(session);

    await processEvent({ ...clearStart(), source }, config(session));

    expect(readRecord(session.sessionId).startTime).toBe(session.startTime);
    expect(readdirSync(sessionsDir).some((n) => n.startsWith(`completed_${session.sessionId}-`))).toBe(false);
  });
});

describe('the own-record step at exit', () => {
  it('spends one 10 s budget on the lock wait and the sends together', async () => {
    const session = baseRecord();
    writeRecord(session);
    const lockPath = join(sessionsDir, `${session.sessionId}.reconcile.lock`);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    const sentAt: number[] = [];
    const abortedAt: number[] = [];
    // The server never answers; only the budget's abort ends a request
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      sentAt.push(Date.now());
      return new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => {
          abortedAt.push(Date.now());
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    // Real I/O runs between fake-clock steps
    const realSetTimeout = setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const exitStart = Date.now();
      // The other holder lets go of the lock 6 s into the exit
      setTimeout(() => rmSync(lockPath), 6 * SECOND);
      let finishedAt: number | undefined;
      const step = finalizeOwnRecord(session.sessionId, {
        env: { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROVIDER: 'ai-run-sso' },
        deadlineMs: exitStart + 10 * SECOND,
      }).then(() => {
        finishedAt = Date.now();
      });
      while (finishedAt === undefined && Date.now() - exitStart < 30 * SECOND) {
        await vi.advanceTimersByTimeAsync(25);
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
      await step;

      expect(sentAt.length).toBeGreaterThan(0);
      expect(sentAt[0] - exitStart).toBeGreaterThanOrEqual(6 * SECOND);
      expect(Math.max(...abortedAt) - exitStart).toBe(10 * SECOND);
      // Past the deadline only local file work is left (each loop step adds 25 ms of fake time)
      expect(finishedAt! - exitStart).toBeLessThan(10 * SECOND + 500);
      expect(readRecord(session.sessionId)).toMatchObject({ status: 'completed' });
      expect(readRecord(session.sessionId).endMetricSentAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the exit notice', () => {
  const PENDING = "CodeMie: this session's analytics are not delivered yet; they will be sent at the next codemie start. Nothing is lost.";
  const DROPPED_ONE = 'CodeMie: analytics of 1 session(s) could not be delivered and were dropped. Check the connection to CodeMie with `codemie doctor`.';
  const wrapperEnv = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

  function stderrLines(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map((args) => args.map(String).join(' '));
  }

  /** The exit step of a wrapper started at `startedAt`: its own record, then the notice. */
  async function exitStep(sessionId: string, startedAt: number): Promise<void> {
    await finalizeOwnRecord(sessionId, { env: wrapperEnv, deadlineMs: Date.now() + 10 * SECOND });
    await noticeDeliveryAtExit(sessionId, startedAt, true);
  }

  it('its own record left {id}.json by a 503: the pending line, no dropped line', async () => {
    const startedAt = Date.now();
    const own = baseRecord({ ownerPid: process.pid });
    writeRecord(own);
    respond = () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await exitStep(own.sessionId, startedAt);

    expect(existsSync(join(sessionsDir, `${own.sessionId}.json`))).toBe(true);
    const lines = stderrLines(stderr);
    expect(lines).toEqual([expect.stringContaining(PENDING)]);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes(PENDING))).toBe(true);
  });

  it('its own completed {id}.json with no CodeMie host (the next start renames it unsent): no line', async () => {
    const startedAt = Date.now();
    const own = baseRecord({ ownerPid: process.pid, provider: 'litellm', status: 'completed', endTime: Date.now(), codemieUrl: undefined });
    writeRecord(own);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await noticeDeliveryAtExit(own.sessionId, startedAt, true);

    expect(existsSync(join(sessionsDir, `${own.sessionId}.json`))).toBe(true);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('a record the start pass dropped at its attempt cap: droppedAt on its completed_ record, one dropped line', async () => {
    const startedAt = Date.now();
    const capped = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), deliveryAttempts: 3 });
    writeRecord(capped);
    const own = baseRecord({ ownerPid: process.pid });
    writeRecord(own);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await reconcileOtherSessions({ env: wrapperEnv, ownSessionId: own.sessionId }).done;
    expect(readRecord(capped.sessionId, 'completed_').droppedAt).toBeGreaterThanOrEqual(startedAt);
    await exitStep(own.sessionId, startedAt);

    expect(stderrLines(stderr)).toEqual([expect.stringContaining(DROPPED_ONE)]);
  });

  it.each([
    { lines: ['failed'], dropped: true },
    { lines: ['pending', 'success'], dropped: false },
  ])('a capped record whose conversation payload lines are $lines: dropped $dropped at the rename', async ({ lines, dropped }) => {
    const capped = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), endMetricSentAt: Date.now(), deliveryAttempts: 3 });
    writeRecord(capped);
    writeDeltas(capped.sessionId, [{ timestamp: capped.startTime + SECOND, syncStatus: 'synced' }]);
    writeFileSync(join(sessionsDir, `${capped.sessionId}_conversation.jsonl`), lines.map((status) => `${JSON.stringify({
      payloadId: 'payload-1',
      timestamp: capped.startTime + SECOND,
      isTurnContinuation: false,
      historyIndices: [0],
      messageCount: 1,
      payload: { conversationId: 'conv-1', history: [{ role: 'User', message: 'hi', history_index: 0 }] },
      status,
    })}\n`).join(''));
    const own = baseRecord({ ownerPid: process.pid });
    writeRecord(own);

    await reconcileOtherSessions({ env: wrapperEnv, ownSessionId: own.sessionId }).done;

    expect(readRecord(capped.sessionId, 'completed_').droppedAt !== undefined).toBe(dropped);
  });

  it('a record dropped before this wrapper started is not counted', async () => {
    const startedAt = Date.now();
    writeRecord(baseRecord({ status: 'completed', endMetricSkipped: 'no-send-path', droppedAt: startedAt - 60 * 60 * SECOND }), 'completed_');
    writeRecord(baseRecord({ status: 'completed', endMetricSkipped: 'no-send-path', droppedAt: startedAt + SECOND }), 'completed_');
    const own = baseRecord({ ownerPid: process.pid });
    writeRecord(own);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await exitStep(own.sessionId, startedAt);

    expect(stderrLines(stderr)).toEqual([expect.stringContaining(DROPPED_ONE)]);
  });

  it('a clean exit with everything delivered prints nothing', async () => {
    const startedAt = Date.now();
    const own = baseRecord({ ownerPid: process.pid });
    writeRecord(own);
    writeDeltas(own.sessionId, [{ timestamp: own.startTime + SECOND }]);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await exitStep(own.sessionId, startedAt);

    expect(existsSync(join(sessionsDir, `completed_${own.sessionId}.json`))).toBe(true);
    expect(stderr).not.toHaveBeenCalled();
  });
});
