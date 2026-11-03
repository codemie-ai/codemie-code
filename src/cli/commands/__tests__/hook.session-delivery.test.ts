/**
 * SessionEnd finalization and delivery, `/clear` generations and the completed_ rename.
 *
 * Seams: `processEvent` (in-process callers) and `createHookCommand` (the agent's own hook
 * process). The network boundary is `fetch`; the stored-credential lookup of a hook process
 * is stubbed; records and transcripts are real files under a per-test CODEMIE_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { Readable } from 'node:stream';
import { rename, writeFile } from 'fs/promises';
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
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
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
const { clearAnalyticsAuthStatus } = await import('@/utils/analytics-auth-status.js');
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

/** Forgets the log lines earlier tests left on the logger mock. */
function clearLogs(): void {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.mocked(logger[level]).mockClear();
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

function readDeltas(sessionId: string, prefix = ''): Array<{ recordId: string; syncStatus: string; timestamp: number | string }> {
  const path = join(sessionsDir, `${prefix}${sessionId}_metrics.jsonl`);
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Fails the first `statusWrites` writes of `{id}.json` carrying `"status": "completed"` (a close's status write: logged,
 * the record stays active); every later write and move is real.
 */
async function failCloses(session: Session, statusWrites: number): Promise<{ statusWrites: number }> {
  const livePath = join(sessionsDir, `${session.sessionId}.json`);
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  const seen = { statusWrites: 0 };
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (seen.statusWrites < statusWrites && String(to) === livePath && (await actual.readFile(from, 'utf-8')).includes('"status": "completed"')) {
      seen.statusWrites += 1;
      throw new Error('EIO: status write');
    }
    return actual.rename(from, to);
  });
  return seen;
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
    const env = { CODEMIE_AGENT: 'claude', CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_URL: HOST, CODEMIE_REPOSITORY: 'org/repo', CODEMIE_CLIENT_TYPE: 'codemie-cli', CODEMIE_MODEL: 'claude-sonnet-4-5' } as NodeJS.ProcessEnv;
    await ensureSessionFile(sessionId, env, 'claude');
    const placeholder = readRecord(sessionId);
    // @case cli-analytics-ensuresessionfile-fallback-writes_TC_003
    expect(placeholder.codemieUrl).toBe(HOST);
    expect(placeholder.clientType).toBe('codemie-cli');
    expect(placeholder.model).toBe('claude-sonnet-4-5');
    expect(placeholder.endTime).toBeUndefined();
    expect(placeholder.status).toBe('active');

    await processEvent({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, config(placeholder));

    const done = readRecord(sessionId, 'completed_');
    expect(done.status).toBe('completed');
    expect(done).toMatchObject({ codemieUrl: HOST, clientType: 'codemie-cli', model: 'claude-sonnet-4-5' });
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

  it('an in-process plugin\'s own SessionEnd whose flush fails still completes and delivers the record', async () => {
    const session = baseRecord();
    writeRecord(session);
    const transcript = join(home, 'unparseable.jsonl');
    writeFileSync(transcript, '{"type":"user","uuid":\n');

    // The plugin's own hook config (as codex.plugin.ts builds it) holds no reconcile lock
    await expect(processEvent({ ...syntheticEnd(transcript), reason: 'exit', endTimeFromActivity: undefined }, config(session)))
      .resolves.toBeUndefined();

    expect(endMetrics()).toHaveLength(1);
    expect(readRecord(session.sessionId, 'completed_')).toMatchObject({ status: 'completed', reason: 'exit' });
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

    await processEvent({ ...syntheticEnd(), session_id: 'gen-bravo', reason: 'exit', endTimeFromActivity: undefined }, config(current));

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

  describe('SIGTERM while the SessionEnd sends', () => {
    let listenersBefore: ReturnType<typeof process.listeners>;

    beforeEach(() => {
      listenersBefore = [...process.listeners('SIGTERM'), ...process.listeners('SIGINT')];
      delete process.env.CODEMIE_WRAPPER_PID;
    });

    afterEach(() => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(signal)) {
          if (!listenersBefore.includes(listener)) process.removeListener(signal, listener);
        }
      }
    });

    it('the first aborts the send in flight: the record finalized, the line kept pending, the hook resolves without exiting', async () => {
      const session = baseRecord();
      writeRecord(session);
      writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
      const times = endMetricOkOthersHang();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      // A budget far past the test's: only the signal can end the hung send
      const run = runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session, { CODEMIE_SESSION_END_SYNC_BUDGET_MS: '600000' });
      await vi.waitFor(() => expect(requests.some((r) => r.name !== 'codemie_cli_session_total')).toBe(true));
      process.emit('SIGTERM');
      await vi.waitFor(() => expect(times.abortedAt.length).toBeGreaterThan(0));
      await run;

      const kept = readRecord(session.sessionId);
      expect(kept.status).toBe('completed');
      expect(kept.endTime).toBeTypeOf('number');
      expect(kept.endMetricSentAt).toBeTypeOf('number');
      expect(readDeltas(session.sessionId).map((d) => d.syncStatus)).toEqual(['pending']);
      expect(exit).not.toHaveBeenCalled();
    });

    it('a second, while a send ignores the abort, forces exit 1', async () => {
      const session = baseRecord();
      writeRecord(session);
      writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
      let answer: (response: Response) => void = () => {};
      let sends = 0;
      // A hung HTTP request: deaf to its abort signal
      vi.mocked(globalThis.fetch).mockImplementation(() => {
        sends += 1;
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      const run = runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session, { CODEMIE_SESSION_END_SYNC_BUDGET_MS: '600000' });
      await vi.waitFor(() => expect(sends).toBe(1));
      process.emit('SIGTERM');
      expect(exit).not.toHaveBeenCalled();
      // The second signal arrives while the action is still pending in the deaf send
      await new Promise((resolve) => setImmediate(resolve));
      process.emit('SIGTERM');
      expect(exit).toHaveBeenCalledWith(1);

      vi.mocked(globalThis.fetch).mockImplementation(async () => ok());
      answer(ok());
      await run;
    });
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
    const oldTranscript = join(home, 'gen-locked.jsonl');
    const session = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-locked', agentSessionFile: oldTranscript } });
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
    expect(readRecord(session.sessionId).correlation).toMatchObject({ agentSessionId: 'gen-locked', agentSessionFile: oldTranscript });
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes('Session re-entered'))).toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes(
      `${session.sessionId}.reconcile.lock is still held; the previous generation (active) of ${session.sessionId} left in place, the fresh record is not written`
    ))).toBe(true);
  });

  /** An event of generation B (native id `claude-native-next`) over the transcript at `transcript`. */
  function eventOfB(name: string, transcript: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { hook_event_name: name, session_id: 'claude-native-next', transcript_path: transcript, permission_mode: 'default', cwd: home, ...extra };
  }

  it('generation A\'s SessionEnd holds the lock 12 s while its line waits on the server: B\'s /clear start gives up at 10 s; B\'s Stop then writes a fresh record of its own, B\'s SessionEnd delivers it; no sidecar of A overwritten', async () => {
    const a = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a' } });
    const id = a.sessionId;
    writeRecord(a);
    writeDeltas(id, [{ timestamp: a.startTime + SECOND }]);
    const lockPath = join(sessionsDir, `${id}.reconcile.lock`);
    // The server answers A's metric line 12 s after it arrives; every other request at once
    let lineHeld = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      urls.push(String(url));
      const metric = JSON.parse(String((init as RequestInit).body)) as Captured;
      requests.push(metric);
      if (!lineHeld && metric.name !== 'codemie_cli_session_total') {
        lineHeld = true;
        await new Promise((resolve) => setTimeout(resolve, 12 * SECOND));
      }
      return ok();
    });
    const budget = { CODEMIE_SESSION_END_SYNC_BUDGET_MS: '20000' };

    const realSetTimeout = setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let startGaveUpAfter: number | undefined;
    try {
      const t0 = Date.now();
      let endADone = false;
      const endA = runHook({ ...syntheticEnd(), session_id: 'gen-a', reason: 'exit', endTimeFromActivity: undefined }, a, budget)
        .then(() => { endADone = true; });
      for (let i = 0; i < 5000 && !existsSync(lockPath); i++) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
      expect(existsSync(lockPath)).toBe(true);
      const startB = runHook(eventOfB('SessionStart', join(home, 'b-start.jsonl'), { source: 'clear' }), a, budget)
        .then(() => { startGaveUpAfter = Date.now() - t0; });
      while ((!endADone || startGaveUpAfter === undefined) && Date.now() - t0 < 30 * SECOND) {
        await vi.advanceTimersByTimeAsync(25);
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
      await Promise.all([endA, startB]);
    } finally {
      vi.useRealTimers();
    }

    expect(startGaveUpAfter).toBeGreaterThanOrEqual(10 * SECOND);
    expect(startGaveUpAfter).toBeLessThan(12 * SECOND);
    expect(existsSync(join(sessionsDir, `${id}.json`))).toBe(false);
    const aRecordBytes = readFileSync(join(sessionsDir, `completed_${id}.json`), 'utf-8');
    const aMetricsBytes = readFileSync(join(sessionsDir, `completed_${id}_metrics.jsonl`), 'utf-8');
    const aEnd = (JSON.parse(aRecordBytes) as Session).endTime!;
    const transcript = writeTranscript([aEnd + SECOND, aEnd + 2 * SECOND].map((t) => new Date(t).toISOString()));
    const bLines = [`msg-${idCounter}-1`];

    await runHook(eventOfB('Stop', transcript), a, budget);

    expect(existsSync(join(sessionsDir, `${id}.json`))).toBe(true);
    const fresh = readRecord(id);
    expect(fresh.correlation).toMatchObject({ agentSessionId: 'claude-native-next', agentSessionFile: transcript });
    expect(fresh.startTime).toBe(aEnd);
    expect(readDeltas(id).map((d) => d.recordId)).toEqual(bLines);
    expect(readFileSync(join(sessionsDir, `completed_${id}_metrics.jsonl`), 'utf-8')).toBe(aMetricsBytes);
    expect(readFileSync(join(sessionsDir, `completed_${id}.json`), 'utf-8')).toBe(aRecordBytes);

    await runHook(eventOfB('SessionEnd', transcript, { reason: 'exit' }), a, budget);

    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['gen-a', 'claude-native-next']);
    expect(readFileSync(join(sessionsDir, `completed_${id}-gen-a.json`), 'utf-8')).toBe(aRecordBytes);
    expect(readFileSync(join(sessionsDir, `completed_${id}-gen-a_metrics.jsonl`), 'utf-8')).toBe(aMetricsBytes);
    expect(readRecord(id, 'completed_')).toMatchObject({ status: 'completed', correlation: { agentSessionId: 'claude-native-next' } });
    expect(readDeltas(id, 'completed_').map((d) => d.recordId)).toEqual(bLines);
    expect(existsSync(join(sessionsDir, `${id}.json`))).toBe(false);
  });

  it('generation B\'s SessionEnd over generation A\'s completed_ record only: a fresh record of B finalized with B\'s transcript and delivered under B\'s native id; A\'s set only moved to its generation name', async () => {
    const a = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), endMetricSentAt: Date.parse('2026-10-01T10:30:01Z'), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a' } });
    const id = a.sessionId;
    writeRecord(a, 'completed_');
    writeDeltas(id, [{ timestamp: a.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    const aRecordBytes = readFileSync(join(sessionsDir, `completed_${id}.json`), 'utf-8');
    const aMetricsBytes = readFileSync(join(sessionsDir, `completed_${id}_metrics.jsonl`), 'utf-8');
    const transcript = writeTranscript([Date.now() - 2 * SECOND, Date.now() - SECOND].map((t) => new Date(t).toISOString()));
    const bLines = [`msg-${idCounter}-1`];

    await runHook(eventOfB('SessionEnd', transcript, { reason: 'exit' }), a);

    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['claude-native-next']);
    expect(readRecord(id, 'completed_')).toMatchObject({ status: 'completed', startTime: a.endTime, correlation: { agentSessionId: 'claude-native-next', agentSessionFile: transcript } });
    expect(readDeltas(id, 'completed_').map((d) => d.recordId)).toEqual(bLines);
    expect(readFileSync(join(sessionsDir, `completed_${id}-gen-a.json`), 'utf-8')).toBe(aRecordBytes);
    expect(readFileSync(join(sessionsDir, `completed_${id}-gen-a_metrics.jsonl`), 'utf-8')).toBe(aMetricsBytes);
  });

  it('generation B\'s SessionEnd over generation A\'s live active record (A\'s finalizer never came, the lock free): A closed over its own transcript, its end metric and lines sent under A\'s id, moved aside; B\'s fresh record finalized and delivered with B\'s transcript', async () => {
    clearLogs();
    const aTranscript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:11:00Z', '2026-10-01T10:12:00Z', '2026-10-01T10:13:00Z']);
    const aLines = [`msg-${idCounter}-1`, `msg-${idCounter}-3`];
    const a = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a', agentSessionFile: aTranscript } });
    const id = a.sessionId;
    writeRecord(a);
    const transcript = writeTranscript([Date.now() - 2 * SECOND, Date.now() - SECOND].map((t) => new Date(t).toISOString()));
    const bLines = [`msg-${idCounter}-1`];

    await runHook(eventOfB('SessionEnd', transcript, { reason: 'exit' }), a);

    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['gen-a', 'claude-native-next']);
    expect(JSON.parse(readFileSync(join(sessionsDir, `completed_${id}-gen-a.json`), 'utf-8'))).toMatchObject({
      status: 'completed', endTime: Date.parse('2026-10-01T10:13:00Z'), correlation: { agentSessionId: 'gen-a' },
    });
    expect(readDeltas(`${id}-gen-a`, 'completed_').map((d) => [d.recordId, d.syncStatus])).toEqual(aLines.map((line) => [line, 'synced']));
    expect(readRecord(id, 'completed_')).toMatchObject({
      status: 'completed', startTime: Date.parse('2026-10-01T10:13:00Z'), correlation: { agentSessionId: 'claude-native-next', agentSessionFile: transcript },
    });
    expect(readDeltas(id, 'completed_').map((d) => [d.recordId, d.syncStatus])).toEqual(bLines.map((line) => [line, 'synced']));
    expect(existsSync(join(sessionsDir, `${id}.json`))).toBe(false);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes('Session re-entered'))).toBe(false);
  });

  it('two hook processes of B at once over A\'s live active record: the first closes A and writes B\'s record under the same lock hold; the second, its lock attempt landing after that, finds B\'s own record under the lock and closes nothing', async () => {
    clearLogs();
    const aTranscript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:13:00Z']);
    const a = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a', agentSessionFile: aTranscript } });
    const id = a.sessionId;
    writeRecord(a);
    const transcript = writeTranscript([Date.now() - 4 * SECOND, Date.now() - 3 * SECOND].map((t) => new Date(t).toISOString()));
    const firstLine = `msg-${idCounter}-1`;
    const lockPath = join(sessionsDir, `${id}.reconcile.lock`);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const gate = { secondAtLock: false, firstDone: false, bStartTime: undefined as number | undefined };
    const until = (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 20 * SECOND, interval: 5 });
    // The second process's lock attempt is let through only once the first process has finished
    let lockWrites = 0;
    vi.mocked(writeFile).mockImplementation(async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]) === lockPath && ++lockWrites === 2) {
        gate.secondAtLock = true;
        await until(() => gate.firstDone);
        gate.bStartTime = readRecord(id).startTime;
        appendFileSync(transcript, `${[
          { type: 'user', uuid: 'msg-late-0', sessionId: 'claude-native-1', timestamp: new Date(Date.now() - 2 * SECOND).toISOString(), message: { role: 'user', content: 'late prompt' } },
          { type: 'assistant', uuid: 'msg-late-1', sessionId: 'claude-native-1', timestamp: new Date(Date.now() - SECOND).toISOString(), message: { role: 'assistant', id: 'api-late-1', content: [{ type: 'text', text: 'late reply' }], usage: { input_tokens: 1, output_tokens: 1 } } },
        ].map((line) => JSON.stringify(line)).join('\n')}\n`);
      }
      return actual.writeFile(...args);
    });
    // The server answers once the second process has read A's record and reached the lock: A stays live until then
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      urls.push(String(url));
      requests.push(JSON.parse(String((init as RequestInit).body)) as Captured);
      await until(() => gate.secondAtLock);
      return ok();
    });

    // Each save of B's record over a {id}.json that is not yet B's, and whether the reconcile lock was held at it
    const livePath = join(sessionsDir, `${id}.json`);
    const freshSavesOfB: string[] = [];
    vi.mocked(rename).mockImplementation(async (from, to) => {
      const holdsB = (raw: string) => (JSON.parse(raw) as Session).correlation.agentSessionId === 'claude-native-next';
      if (String(to) === livePath && holdsB(await actual.readFile(from, 'utf-8')) && !(existsSync(livePath) && holdsB(readFileSync(livePath, 'utf-8')))) {
        freshSavesOfB.push(existsSync(lockPath) ? 'under the lock' : 'outside the lock');
      }
      return actual.rename(from, to);
    });

    try {
      const first = runHook(eventOfB('SubagentStop', transcript, { agent_id: 'sub-1', agent_transcript_path: '', stop_hook_active: false }), a)
        .then(() => { gate.firstDone = true; });
      await until(() => existsSync(lockPath));
      const second = runHook(eventOfB('Stop', transcript), a);
      await Promise.all([first, second]);
    } finally {
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
    }

    expect(freshSavesOfB).toEqual(['under the lock']);
    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['gen-a']);
    expect(readdirSync(sessionsDir).filter((name) => name.startsWith(`completed_${id}`) && name.endsWith('.json'))).toEqual([`completed_${id}-gen-a.json`]);
    expect(readRecord(id)).toMatchObject({ status: 'active', startTime: Date.parse('2026-10-01T10:13:00Z'), correlation: { agentSessionId: 'claude-native-next' } });
    expect(gate.bStartTime).toBe(Date.parse('2026-10-01T10:13:00Z'));
    expect(readDeltas(id).map((d) => d.recordId)).toEqual([firstLine, 'msg-late-1']);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes(`${id}.json already holds the record of claude-native-next; nothing closed`))).toBe(true);
  });

  it.each([
    ['not a number', 'x'],
    ['in the future', Date.parse('2099-01-01T00:00:00Z')],
    ['in the past', Date.parse('2026-10-01T09:00:00Z')],
  ])('a SessionStart payload carrying a startTime (%s) starts now', async (_label, startTime) => {
    const session = baseRecord();
    const before = Date.now();

    await runHook({ hook_event_name: 'SessionStart', session_id: 'claude-native-1', transcript_path: join(home, 'start.jsonl'), permission_mode: 'default', cwd: home, source: 'startup', startTime }, session);

    const { startTime: recorded } = readRecord(session.sessionId);
    expect(recorded).toEqual(expect.any(Number));
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(Date.now());
  });

  it('generation B\'s SessionEnd over generation A\'s live completed record left undelivered (the server answers now): A\'s end metric and line delivered under A\'s id, moved aside under its generation name; B finalized', async () => {
    const a = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a' } });
    const id = a.sessionId;
    writeRecord(a);
    writeDeltas(id, [{ timestamp: a.startTime + SECOND }]);
    const transcript = writeTranscript([Date.now() - 2 * SECOND, Date.now() - SECOND].map((t) => new Date(t).toISOString()));

    await runHook(eventOfB('SessionEnd', transcript, { reason: 'exit' }), a);

    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['gen-a', 'claude-native-next']);
    const movedA = JSON.parse(readFileSync(join(sessionsDir, `completed_${id}-gen-a.json`), 'utf-8')) as Session;
    expect(movedA.endMetricSentAt).toEqual(expect.any(Number));
    expect(movedA.droppedAt).toBeUndefined();
    expect(readDeltas(`${id}-gen-a`, 'completed_').map((d) => [d.recordId, d.syncStatus])).toEqual([[`rec-${id}-0`, 'synced']]);
    expect(readRecord(id, 'completed_')).toMatchObject({ status: 'completed', startTime: a.endTime, correlation: { agentSessionId: 'claude-native-next' } });
  });

  it('generation B\'s SessionEnd over generation A\'s live completed record left undelivered, the server down (503): A moved aside marked dropped', async () => {
    const a = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a' } });
    const id = a.sessionId;
    writeRecord(a);
    writeDeltas(id, [{ timestamp: a.startTime + SECOND }]);
    respond = () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const transcript = writeTranscript([Date.now() - 2 * SECOND, Date.now() - SECOND].map((t) => new Date(t).toISOString()));

    await runHook(eventOfB('SessionEnd', transcript, { reason: 'exit' }), a);

    expect(endMetrics().map((m) => m.attributes.session_id)).toContain('gen-a');
    const movedA = JSON.parse(readFileSync(join(sessionsDir, `completed_${id}-gen-a.json`), 'utf-8')) as Session;
    expect(movedA.endMetricSentAt).toBeUndefined();
    expect(movedA.droppedAt).toEqual(expect.any(Number));
    expect(readRecord(id)).toMatchObject({ status: 'completed', correlation: { agentSessionId: 'claude-native-next' } });
  });

  /** B's live record with its sidecars, and A's closed set under `completed_<id><aSuffix>.json` (its generation name by default). */
  function closedAUnderLiveB(aSuffix = '-gen-a'): { b: Session; aTranscript: string; bytes: () => string[] } {
    const aTranscript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:11:00Z']);
    const b = baseRecord({
      startTime: Date.parse('2026-10-01T10:20:00Z'),
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-next', agentSessionFile: join(home, 'b.jsonl') },
    });
    const id = b.sessionId;
    writeRecord(b);
    writeDeltas(id, [{ timestamp: b.startTime + SECOND }]);
    writeFileSync(join(sessionsDir, `${id}_conversation.jsonl`), '{}\n');
    const a = baseRecord({ sessionId: id, status: 'completed', endTime: Date.parse('2026-10-01T10:11:00Z'), endMetricSentAt: Date.parse('2026-10-01T10:11:01Z'), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a', agentSessionFile: aTranscript } });
    writeFileSync(join(sessionsDir, `completed_${id}${aSuffix}.json`), JSON.stringify(a));
    // The session's own files; the transcript ownership marker the router stamps on any Stop is not a record
    const bytes = () => readdirSync(sessionsDir).filter((name) => name.includes(id)).sort().map((name) => `${name}:${readFileSync(join(sessionsDir, name), 'utf-8')}`);
    return { b, aTranscript, bytes };
  }

  it('a late SessionEnd of generation A, already closed and moved aside, over B\'s live record: nothing written, nothing sent, logged', async () => {
    clearLogs();
    const { b, aTranscript, bytes } = closedAUnderLiveB();
    const before = bytes();

    await runHook({ hook_event_name: 'SessionEnd', session_id: 'gen-a', transcript_path: aTranscript, permission_mode: 'default', cwd: home, reason: 'exit' }, b);

    expect(bytes()).toEqual(before);
    expect(requests).toEqual([]);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes(`gen-a is a closed generation of ${b.sessionId}`))).toBe(true);
  });

  it.each([
    ['moved aside under its generation name', '-gen-a'],
    ['renamed plainly by its finalizer', ''],
  ])('a late Stop of generation A, already closed and %s, over B\'s live record: nothing written, nothing sent, logged', async (_where, aSuffix) => {
    clearLogs();
    const { b, aTranscript, bytes } = closedAUnderLiveB(aSuffix);
    const before = bytes();

    await runHook({ hook_event_name: 'Stop', session_id: 'gen-a', transcript_path: aTranscript, permission_mode: 'default', cwd: home }, b);

    expect(bytes()).toEqual(before);
    expect(requests).toEqual([]);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes(`gen-a is a closed generation of ${b.sessionId}`))).toBe(true);
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

  it('a start with no stored credentials leaves an undelivered record in place: no request, no attempt, never renamed unsent', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(session);
    const { getStoredAnalyticsCredentials } = await import('../../../providers/core/codemie-auth-helpers.js');
    vi.mocked(getStoredAnalyticsCredentials).mockResolvedValue(null);
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };
    const attempts: Array<number | string | undefined> = [];
    try {
      for (let start = 0; start < 4; start++) {
        await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;
        attempts.push(existsSync(join(sessionsDir, `${session.sessionId}.json`)) ? readRecord(session.sessionId).deliveryAttempts : 'renamed');
      }
    } finally {
      vi.mocked(getStoredAnalyticsCredentials).mockImplementation(async () => ({ credentials: { cookies: { session: 'abc' } } }) as Awaited<ReturnType<typeof getStoredAnalyticsCredentials>>);
    }

    expect(attempts).toEqual([undefined, undefined, undefined, undefined]);
    expect(requests).toEqual([]);
  });

  it('a start while the analytics auth of this host is marked invalid leaves an undelivered record in place: no request, no attempt; delivered once a re-login clears the mark', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(session);
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };
    // The server rejects the stored cookies once: the analytics auth of this send path is marked invalid
    respond = () => new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;
    expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(true);
    requests = [];
    respond = () => ok();

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(requests).toEqual([]);
    expect(readRecord(session.sessionId).deliveryAttempts).toBeUndefined();

    await clearAnalyticsAuthStatus();
    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(endMetrics()).toHaveLength(1);
    expect(readRecord(session.sessionId, 'completed_').endMetricSentAt).toBeTypeOf('number');
  });

  it('a start whose end metric meets rejected credentials (401) spends no attempt; the record is kept for a re-login', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(session);
    respond = () => new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(endMetrics().length).toBeGreaterThan(0);
    const kept = readRecord(session.sessionId);
    expect(kept.deliveryAttempts).toBeUndefined();
    expect(kept.endMetricSentAt).toBeUndefined();
  });

  it('a start whose end metric meets a permission denial (403) spends an attempt and marks no credentials invalid', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(session);
    respond = () => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(endMetrics().length).toBeGreaterThan(0);
    expect(readRecord(session.sessionId).deliveryAttempts).toBe(1);
    expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(false);
  });

  it('a stranded record whose delta sync meets rejected credentials (401) gets its finalize attempt back; the record is kept', async () => {
    const transcript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:12:00Z']);
    const session = baseRecord({
      ownerPid: 999_999,
      ownerStartedAt: Date.parse('2026-10-01T09:00:00Z'),
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-1', agentSessionFile: transcript },
    });
    writeRecord(session);
    respond = (metric) => (metric.name === 'codemie_cli_session_total' && metric.attributes.status === 'completed'
      ? ok()
      : new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(requests.length).toBeGreaterThan(endMetrics().length);
    const kept = readRecord(session.sessionId);
    expect(kept.status).toBe('completed');
    expect(kept.finalizeAttempts).toBeUndefined();
    expect(readDeltas(session.sessionId).some((delta) => delta.syncStatus !== 'synced')).toBe(true);
  });

  /** A delivered end metric whose only pending request is one conversation payload. */
  function conversationOnlyRecord(): Session {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), endMetricSentAt: Date.parse('2026-10-01T10:30:01Z') });
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
    return session;
  }

  function readAuthMarker(): { baseUrl: string } | undefined {
    const path = join(home, 'analytics-auth-status.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : undefined;
  }

  it('an undelivered record whose only pending request, a conversation, meets rejected credentials (401) spends no attempt and marks the auth of its send path invalid; the record is kept', async () => {
    const session = conversationOnlyRecord();
    respond = () => new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(urls.filter((url) => !url.includes('/v1/conversations/'))).toEqual([]);
    expect(urls.some((url) => url.includes('/v1/conversations/'))).toBe(true);
    expect(readRecord(session.sessionId).deliveryAttempts).toBeUndefined();
    expect(readAuthMarker()?.baseUrl).toBe(API);
  });

  it('a conversation accepted with 200 clears the invalid-auth mark of its send path', async () => {
    const session = conversationOnlyRecord();
    writeFileSync(join(home, 'analytics-auth-status.json'), JSON.stringify({ status: 'invalid', reason: 'HTTP 401', baseUrl: API, detectedAt: Date.now() }));

    await processEvent({ ...syntheticEnd(), reason: 'exit', endTimeFromActivity: undefined }, config(session));

    expect(urls).toEqual([expect.stringContaining('/v1/conversations/')]);
    expect(readAuthMarker()).toBeUndefined();
  });

  it('an undelivered record whose only pending request, a conversation, meets a permission denial (403) spends an attempt and marks no credentials invalid', async () => {
    const session = conversationOnlyRecord();
    respond = () => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(urls.some((url) => url.includes('/v1/conversations/'))).toBe(true);
    expect(readRecord(session.sessionId).deliveryAttempts).toBe(1);
    expect(readAuthMarker()).toBeUndefined();
  });

  it('an undelivered record whose only pending request, a conversation, is answered 200 with an SSO login page spends no attempt and marks the auth of its send path invalid', async () => {
    const session = conversationOnlyRecord();
    respond = () => new Response('<html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(urls.some((url) => url.includes('/v1/conversations/'))).toBe(true);
    expect(readRecord(session.sessionId).deliveryAttempts).toBeUndefined();
    expect(readAuthMarker()?.baseUrl).toBe(API);
  });

  /** A proxy's or WAF's own error page: HTML at a non-2xx status, a counted failure, not the SSO login page. */
  const gatewayErrorPage = (status: number) => (): Response =>
    new Response(`<html><body>${status} error</body></html>`, { status, headers: { 'content-type': 'text/html' } });

  it('an undelivered record whose only pending request, a conversation, is answered 403 with an HTML block page spends an attempt and marks no credentials invalid', async () => {
    const session = conversationOnlyRecord();
    respond = gatewayErrorPage(403);
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(urls.some((url) => url.includes('/v1/conversations/'))).toBe(true);
    expect(readRecord(session.sessionId).deliveryAttempts).toBe(1);
    expect(readAuthMarker()).toBeUndefined();
  });

  it('an undelivered record whose only pending request, a conversation, is answered 413 with an HTML proxy page spends an attempt and marks no credentials invalid', async () => {
    const session = conversationOnlyRecord();
    respond = gatewayErrorPage(413);
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(urls.some((url) => url.includes('/v1/conversations/'))).toBe(true);
    expect(readRecord(session.sessionId).deliveryAttempts).toBe(1);
    expect(readAuthMarker()).toBeUndefined();
  });

  it('a start whose end metric is answered 403 with an HTML block page spends an attempt and marks no credentials invalid', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(session);
    respond = gatewayErrorPage(403);
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(endMetrics().length).toBeGreaterThan(0);
    expect(readRecord(session.sessionId).deliveryAttempts).toBe(1);
    expect(readAuthMarker()).toBeUndefined();
  });

  it('an undelivered record whose only pending request, a conversation, is answered 502 with an HTML gateway page spends an attempt and marks no credentials invalid', async () => {
    const session = conversationOnlyRecord();
    respond = gatewayErrorPage(502);
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(urls.some((url) => url.includes('/v1/conversations/'))).toBe(true);
    expect(readRecord(session.sessionId).deliveryAttempts).toBe(1);
    expect(readAuthMarker()).toBeUndefined();
  });

  it('a start whose end metric is answered 502 with an HTML gateway page spends an attempt and marks no credentials invalid', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(session);
    respond = gatewayErrorPage(502);
    const nextStart = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: API, CODEMIE_TARGET_API_URL: UPSTREAM, CODEMIE_PROFILE_NAME: 'work', CODEMIE_CLI_VERSION: '9.9.9' };

    await reconcileOtherSessions({ env: nextStart, ownSessionId: 'own' }).done;

    expect(endMetrics().length).toBeGreaterThan(0);
    const kept = readRecord(session.sessionId);
    expect(kept.deliveryAttempts).toBe(1);
    expect(kept.endMetricSentAt).toBeUndefined();
    expect(readAuthMarker()).toBeUndefined();
  });

  it('a /clear over a live active generation whose close fails its status write: that generation is closed locally before it moves, a fresh record its own', async () => {
    clearLogs();
    const lastDelta = Date.parse('2026-10-01T10:40:00Z');
    const a = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-status-fail', agentSessionFile: join(home, 'gen-status-fail.jsonl') } });
    writeRecord(a);
    writeDeltas(a.sessionId, [{ timestamp: a.startTime + SECOND }, { timestamp: lastDelta }]);
    respond = () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const seen = await failCloses(a, 1);

    await runHook({ hook_event_name: 'SessionStart', session_id: 'claude-native-next', transcript_path: join(home, 'next.jsonl'), permission_mode: 'default', cwd: home, source: 'clear' }, a);

    expect(seen.statusWrites).toBe(1);
    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${a.sessionId}-gen-status-fail.json`), 'utf-8')) as Session;
    expect(moved).toMatchObject({ status: 'completed', reason: 'interrupted', endTime: lastDelta, droppedAt: expect.any(Number) });
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('closed locally at its last recorded activity, not flushed here'))).toBe(true);
    expect(vi.mocked(logger.warn).mock.calls.filter(([line]) => String(line).includes('marked dropped'))).toHaveLength(1);
    expect(readRecord(a.sessionId)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
  });

  it('a SessionEnd whose status write fails while the server accepts the delivery: the end metric is sent, the record stays live and active with its mark, not renamed', async () => {
    const session = baseRecord();
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    const seen = await failCloses(session, 1);

    await runHook({ ...syntheticEnd(), endTimeFromActivity: undefined, reason: 'exit' }, session);

    expect(seen.statusWrites).toBe(1);
    expect(endMetrics()).toHaveLength(1);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(false);
    expect(readRecord(session.sessionId)).toMatchObject({ status: 'active', endMetricSentAt: expect.any(Number) });
  });

  it('a /clear over a live active generation whose close fails its status write while the server accepts the delivery: closed locally at its last delta, moved aside, a fresh record its own', async () => {
    clearLogs();
    const lastDelta = Date.parse('2026-10-01T10:40:00Z');
    const a = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-status-fail-sent', agentSessionFile: join(home, 'gen-status-fail-sent.jsonl') } });
    writeRecord(a);
    writeDeltas(a.sessionId, [{ timestamp: a.startTime + SECOND }, { timestamp: lastDelta }]);
    const seen = await failCloses(a, 1);

    await runHook({ hook_event_name: 'SessionStart', session_id: 'claude-native-next', transcript_path: join(home, 'next.jsonl'), permission_mode: 'default', cwd: home, source: 'clear' }, a);

    expect(seen.statusWrites).toBe(1);
    expect(endMetrics()).toHaveLength(1);
    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${a.sessionId}-gen-status-fail-sent.json`), 'utf-8')) as Session;
    expect(moved).toMatchObject({ status: 'completed', reason: 'interrupted', endTime: lastDelta, endMetricSentAt: expect.any(Number) });
    expect(existsSync(join(sessionsDir, `completed_${a.sessionId}.json`))).toBe(false);
    expect(readRecord(a.sessionId)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
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

  it('an active generation gets its synthetic end over its own transcript, moves aside, and a fresh record starts at the /clear', async () => {
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

  it('an active generation\'s close and the fresh record are written under one hold of the reconcile lock: A\'s end, its moves and B\'s one fresh save all land while the lock exists', async () => {
    const transcript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:12:00Z']);
    const session = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-held-once', agentSessionFile: transcript } });
    const id = session.sessionId;
    writeRecord(session);
    const lockPath = join(sessionsDir, `${id}.reconcile.lock`);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    // Every rename onto the live record or a completed_ file of the id: the file, the generation a live record holds, whether the lock exists
    const writes: string[] = [];
    vi.mocked(rename).mockImplementation(async (from, to) => {
      const name = basename(String(to));
      if (name === `${id}.json`) {
        const generation = (JSON.parse(await actual.readFile(from, 'utf-8')) as Session).correlation.agentSessionId;
        writes.push(`${name} ${generation} ${existsSync(lockPath) ? 'locked' : 'unlocked'}`);
      } else if (name.startsWith(`completed_${id}`)) {
        writes.push(`${name} ${existsSync(lockPath) ? 'locked' : 'unlocked'}`);
      }
      return actual.rename(from, to);
    });
    const before = Date.now();

    await processEvent(clearStart(), config(session));

    expect(writes.filter((write) => write.endsWith(' unlocked'))).toEqual([]);
    expect(writes).toContain(`${id}.json gen-held-once locked`);
    expect(writes).toContain(`completed_${id}-gen-held-once.json locked`);
    expect(writes.filter((write) => write.includes('claude-native-next'))).toEqual([`${id}.json claude-native-next locked`]);
    expect(readRecord(id)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
    expect(readRecord(id).startTime).toBeGreaterThanOrEqual(before);
  });

  it('two /clear cycles on one id keep three sets, each with only its own lines, each closed generation delivered once', async () => {
    const session = baseRecord();
    const id = session.sessionId;
    const transcriptOf: Record<string, number> = {};
    for (const [i, generation] of ['gen-a', 'gen-b', 'gen-c'].entries()) {
      // A transcript of its own per generation: its path and line ids carry the counter
      transcriptOf[generation] = Number(newId().slice(-12));
      const transcript = writeTranscript([Date.now() + SECOND, Date.now() + 2 * SECOND].map((t) => new Date(t).toISOString()));
      const start = { ...clearStart(), session_id: generation, transcript_path: transcript, source: i === 0 ? 'startup' : 'clear' };
      await processEvent(start, config(session));
      await processEvent({ ...start, hook_event_name: 'Stop' }, config(session));
    }

    const sets = { 'gen-a': `completed_${id}-gen-a`, 'gen-b': `completed_${id}-gen-b`, 'gen-c': id };
    expect(readdirSync(sessionsDir).filter((n) => n.includes(id)).sort()).toEqual(
      Object.values(sets).flatMap((base) => [`${base}.json`, `${base}_conversation.jsonl`, `${base}_metrics.jsonl`]).sort()
    );
    for (const [generation, base] of Object.entries(sets)) {
      const record = JSON.parse(readFileSync(join(sessionsDir, `${base}.json`), 'utf-8')) as Session;
      expect(record.correlation.agentSessionId).toBe(generation);
      expect(record.status).toBe(generation === 'gen-c' ? 'active' : 'completed');
      const deltas = readFileSync(join(sessionsDir, `${base}_metrics.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(deltas.map((d) => d.recordId)).toEqual([`msg-${transcriptOf[generation]}-1`]);
      expect(deltas[0].syncStatus).toBe(generation === 'gen-c' ? 'pending' : 'synced');
    }
    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['gen-a', 'gen-b']);
    expect(urls.filter((url) => url.includes('/v1/conversations/'))).toEqual([
      `${API}/v1/conversations/gen-a/history`,
      `${API}/v1/conversations/gen-b/history`,
    ]);
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

  it('a completed_ generation is closed already: left as it is, the fresh record written beside it', async () => {
    const session = baseRecord({ status: 'completed', endMetricSentAt: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-three' } });
    writeRecord(session, 'completed_');
    const completedBytes = readFileSync(join(sessionsDir, `completed_${session.sessionId}.json`), 'utf-8');

    await processEvent(clearStart(), config(session));

    expect(endMetrics()).toHaveLength(0);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-three.json`))).toBe(false);
    expect(readFileSync(join(sessionsDir, `completed_${session.sessionId}.json`), 'utf-8')).toBe(completedBytes);
    expect(readRecord(session.sessionId)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
  });

  /** The live record of the next generation over a `completed_` set, renamed: the set is moved to its generation name first. */
  async function renameOverCompleted(session: Session): Promise<void> {
    writeRecord(baseRecord({ sessionId: session.sessionId, correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-next' } }));
    await renameSessionFiles(session.sessionId);
  }

  it('a move whose 2nd rename fails puts the 1st file back: the set stays under its names, the error logged', async () => {
    clearLogs();
    const session = baseRecord({ status: 'completed', endMetricSentAt: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-stuck-move' } });
    writeRecord(session, 'completed_');
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    writeFileSync(join(sessionsDir, `completed_${session.sessionId}_conversation.jsonl`), '{}\n');
    // A directory under the conversation target name: renaming a file onto it fails
    mkdirSync(join(sessionsDir, `completed_${session.sessionId}-gen-stuck-move_conversation.jsonl`, 'occupied'), { recursive: true });

    await renameOverCompleted(session);

    for (const suffix of ['.json', '_metrics.jsonl', '_conversation.jsonl']) {
      expect(existsSync(join(sessionsDir, `completed_${session.sessionId}${suffix}`))).toBe(true);
    }
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-stuck-move.json`))).toBe(false);
    expect(readRecord(session.sessionId, 'completed_').correlation.agentSessionId).toBe('gen-stuck-move');
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('Failed to move the previous generation aside'))).toBe(true);
  });

  it('an active generation the full close leaves unclosed is closed locally (its dropped mark from that close), moved aside; a fresh record its own, starting at the /clear', async () => {
    clearLogs();
    const lastDelta = Date.parse('2026-10-01T10:40:00Z');
    const session = baseRecord({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-unclosed', agentSessionFile: join(home, 'gen-unclosed.jsonl') },
    });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }, { timestamp: lastDelta }]);
    respond = () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    // The full close's status write fails
    const seen = await failCloses(session, 1);
    const before = Date.now();

    await processEvent(clearStart(), config(session));

    const fresh = readRecord(session.sessionId);
    expect(fresh.status).toBe('active');
    expect(fresh.startTime).toBeGreaterThanOrEqual(before);
    expect(fresh.correlation).toMatchObject({ agentSessionId: 'claude-native-next', agentSessionFile: join(home, 'next-transcript.jsonl') });
    expect(seen.statusWrites).toBe(1);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes('Session re-entered'))).toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('closed locally at its last recorded activity, not flushed here'))).toBe(true);
    const old = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-unclosed.json`), 'utf-8')) as Session;
    expect(old.status).toBe('completed');
    expect(old.endTime).toBe(lastDelta);
    expect(old.droppedAt).toEqual(expect.any(Number));
    const oldLines = readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-unclosed_metrics.jsonl`), 'utf-8').trim().split('\n');
    expect(oldLines.map((l) => JSON.parse(l).recordId)).toEqual([`rec-${session.sessionId}-0`, `rec-${session.sessionId}-1`]);
    expect(existsSync(join(sessionsDir, `${session.sessionId}_metrics.jsonl`))).toBe(false);
  });

  it('an active generation of another CodeMie host the full close leaves unclosed is closed locally and moved aside, not marked dropped; a fresh record its own', async () => {
    clearLogs();
    const session = baseRecord({
      codemieUrl: 'https://other.example.com',
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-other-unclosed', agentSessionFile: join(home, 'gen-other-unclosed.jsonl') },
    });
    writeRecord(session);
    writeDeltas(session.sessionId, [{ timestamp: session.startTime + SECOND }]);
    await failCloses(session, 1);

    await processEvent(clearStart(), config(session));

    expect(readRecord(session.sessionId).correlation.agentSessionId).toBe('claude-native-next');
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('closed locally at its last recorded activity'))).toBe(true);
    const old = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-other-unclosed.json`), 'utf-8')) as Session;
    expect(old.status).toBe('completed');
    expect(old.droppedAt).toBeUndefined();
  });

  it('an active generation whose local close cannot save stays active in place: no fresh record, the error logged', async () => {
    clearLogs();
    const session = baseRecord({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-unsaved', agentSessionFile: join(home, 'gen-unsaved.jsonl') },
    });
    writeRecord(session);
    respond = () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    // The full close's status write and both local closes fail
    await failCloses(session, 3);

    await processEvent(clearStart(), config(session));

    expect(readRecord(session.sessionId)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'gen-unsaved' } });
    expect(readdirSync(sessionsDir).some((n) => n.startsWith(`completed_${session.sessionId}`))).toBe(false);
    expect(vi.mocked(logger.error).mock.calls.some(([line]) => String(line).includes('could not be closed locally; the fresh record is not written'))).toBe(true);
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

    const closing = renameOverCompleted(session);
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

    await renameOverCompleted(session);

    const lines = readFileSync(movedMetrics, 'utf-8').trim().split('\n').map((line) => JSON.parse(line).recordId);
    expect(lines).toEqual(['moved-before-the-kill', `rec-${session.sessionId}-0`]);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}_metrics.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-resumed.json`))).toBe(true);
  });

  it('a resumed move whose .json rename fails leaves the appended sidecar in place with both parts', async () => {
    clearLogs();
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

    await renameOverCompleted(session);

    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}_metrics.jsonl`))).toBe(false);
    expect(existsSync(movedMetrics)).toBe(true);
    const lines = readFileSync(movedMetrics, 'utf-8').trim().split('\n').map((line) => JSON.parse(line).recordId);
    expect(lines).toEqual(['moved-before-the-kill', `rec-${session.sessionId}-0`]);
    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}.json`))).toBe(true);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('Failed to move the previous generation aside'))).toBe(true);
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

  /**
   * Runs `/clear` while another live process holds the lock, which it lets go of `releaseAfterMs` in
   * (never when undefined), right after its last write under it (`holderWrite`).
   */
  async function clearAgainstHeldLock(session: Session, releaseAfterMs: number | undefined, holderWrite?: () => void): Promise<number> {
    const lockPath = join(sessionsDir, `${session.sessionId}.reconcile.lock`);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    // Real I/O runs between fake-clock steps
    const realSetTimeout = setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const startedAt = Date.now();
      let released = releaseAfterMs === undefined;
      if (releaseAfterMs !== undefined) {
        setTimeout(() => {
          holderWrite?.();
          rmSync(lockPath);
          released = true;
        }, releaseAfterMs);
      }
      let finishedAt: number | undefined;
      const start = processEvent(clearStart(), config(session)).then(() => {
        finishedAt = Date.now();
      });
      // The holder runs to its release even when the start is done before it
      while ((finishedAt === undefined || !released) && Date.now() - startedAt < 30 * SECOND) {
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

  it('a lock held throughout is given up: logged, the generation left in place undelivered, no fresh record', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-stuck' } });
    writeRecord(session);
    const previousBytes = readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8');

    const waitedMs = await clearAgainstHeldLock(session, undefined);

    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes(
      `${session.sessionId}.reconcile.lock is still held; the previous generation (completed) of ${session.sessionId} left in place, the fresh record is not written`
    ))).toBe(true);
    expect(endMetrics()).toHaveLength(0);
    expect(readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8')).toBe(previousBytes);
    expect(readdirSync(sessionsDir).some((n) => n.startsWith(`completed_${session.sessionId}-`))).toBe(false);
    // One 10 s wait covers the close and the fresh record
    expect(waitedMs).toBeGreaterThanOrEqual(10 * SECOND);
    expect(waitedMs).toBeLessThan(15 * SECOND);
  });

  it('an active generation under a lock held throughout is left byte-identical: no re-entry, no fresh record', async () => {
    const session = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-active-stuck', agentSessionFile: join(home, 'gen-active-stuck.jsonl') } });
    writeRecord(session);
    const previousBytes = readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8');

    const waitedMs = await clearAgainstHeldLock(session, undefined);

    expect(readFileSync(join(sessionsDir, `${session.sessionId}.json`), 'utf-8')).toBe(previousBytes);
    expect(readdirSync(sessionsDir).some((n) => n.startsWith(`completed_${session.sessionId}`))).toBe(false);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes('Session re-entered'))).toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes(
      `${session.sessionId}.reconcile.lock is still held; the previous generation (active) of ${session.sessionId} left in place`
    ))).toBe(true);
    expect(waitedMs).toBeGreaterThanOrEqual(10 * SECOND);
    expect(waitedMs).toBeLessThan(15 * SECOND);
  });

  it('a lock released 8 s into the SessionStart\'s 10 s budget: the holder\'s last write goes with the generation moved aside, a fresh record its own', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now() - 60 * SECOND, correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-stuck' } });
    writeRecord(session);
    // The holder stamps the record by id under the lock (as markEndMetric does), then lets go
    const holderMark = 1_700_000_000_000;
    const holderWrite = () => writeRecord({ ...readRecord(session.sessionId), endMetricSentAt: holderMark });
    vi.mocked(logger.warn).mockClear();
    const before = Date.now();

    await clearAgainstHeldLock(session, 8 * SECOND, holderWrite);

    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes('left in place'))).toBe(false);
    expect(endMetrics()).toHaveLength(0);
    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-stuck.json`), 'utf-8')) as Session;
    expect(moved).toMatchObject({ status: 'completed', endMetricSentAt: holderMark, correlation: { agentSessionId: 'gen-stuck' } });
    const fresh = readRecord(session.sessionId);
    expect(fresh.status).toBe('active');
    expect(fresh.endTime).toBeUndefined();
    expect(fresh.endMetricSentAt).toBeUndefined();
    expect(fresh.startTime).toBeGreaterThanOrEqual(before);
    expect(fresh.correlation.agentSessionId).toBe('claude-native-next');

    // The fresh generation's Stop writes onto its own record and its own metrics file; a Claude record
    // over an existing transcript counts only the lines after its start
    const transcript = writeTranscript([fresh.startTime + SECOND, fresh.startTime + 5 * SECOND].map((t) => new Date(t).toISOString()));
    await processEvent({ ...clearStart(), hook_event_name: 'Stop', transcript_path: transcript }, config(session));

    expect(existsSync(join(sessionsDir, `completed_${session.sessionId}-gen-stuck_metrics.jsonl`))).toBe(false);
    expect(readRecord(session.sessionId).status).toBe('active');
    expect(readDeltas(session.sessionId).length).toBeGreaterThan(0);
  });

  it('a lock released 9.6 s into the SessionStart\'s 10 s budget: the undelivered generation still gets its own delivery budget, sent and moved aside, not dropped', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-late' } });
    writeRecord(session);

    await clearAgainstHeldLock(session, 9.6 * SECOND);

    expect(endMetrics()).toHaveLength(1);
    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-late.json`), 'utf-8')) as Session;
    expect(moved.endMetricSentAt).toBeTypeOf('number');
    expect(moved.droppedAt).toBeUndefined();
    expect(readRecord(session.sessionId)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
  });

  it('a reconcile lock that cannot be created (ENOSPC) is logged; the start metric is still sent', async () => {
    const session = baseRecord({ status: 'completed', endTime: Date.now(), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-eacces' } });
    writeRecord(session);
    vi.mocked(logger.warn).mockClear();
    const actualWriteFile = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).writeFile;
    let refused = false;
    vi.mocked(writeFile).mockImplementation((async (path: string, data: string, options: unknown) => {
      if (String(path).endsWith('.reconcile.lock')) {
        refused = true;
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return actualWriteFile(path, data, options as Parameters<typeof actualWriteFile>[2]);
    }) as typeof writeFile);

    try {
      await expect(processEvent(clearStart(), config(session))).resolves.toBeUndefined();
    } finally {
      vi.mocked(writeFile).mockImplementation(actualWriteFile);
    }

    expect(refused).toBe(true);
    expect(vi.mocked(logger.warn).mock.calls.some(([line]) => String(line).includes(`Could not write the session record of ${session.sessionId}: ENOSPC`))).toBe(true);
    expect(requests.map((r) => [r.name, r.attributes.status])).toEqual([['codemie_cli_session_total', 'started']]);
  });

  it('source=resume with a new session_id over an active generation closes it over its own transcript, moves it aside, and a fresh record starts at the /resume', async () => {
    const transcript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:12:00Z']);
    const session = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-resumed-over', agentSessionFile: transcript } });
    writeRecord(session);
    const before = Date.now();

    await processEvent({ ...clearStart(), source: 'resume' }, config(session));

    const movedPath = join(sessionsDir, `completed_${session.sessionId}-gen-resumed-over.json`);
    expect(existsSync(movedPath)).toBe(true);
    const moved = JSON.parse(readFileSync(movedPath, 'utf-8')) as Session;
    expect(moved).toMatchObject({ status: 'completed', endTime: Date.parse('2026-10-01T10:12:00Z'), reason: 'interrupted' });
    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['gen-resumed-over']);
    const fresh = readRecord(session.sessionId);
    expect(fresh).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
    expect(fresh.startTime).toBeGreaterThanOrEqual(before);
  });

  it('source=resume back to generation A, already closed and moved aside, over B\'s live record: B closed over its own transcript and moved aside, a fresh record of A\'s second stretch takes A\'s later Stop and SessionEnd; A\'s first set untouched', async () => {
    const bTranscript = writeTranscript(['2026-10-01T10:20:00Z', '2026-10-01T10:22:00Z']);
    const b = baseRecord({
      startTime: Date.parse('2026-10-01T10:20:00Z'),
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-next', agentSessionFile: bTranscript },
    });
    const id = b.sessionId;
    writeRecord(b);
    const a = baseRecord({ sessionId: id, status: 'completed', endTime: Date.parse('2026-10-01T10:11:00Z'), endMetricSentAt: Date.parse('2026-10-01T10:11:01Z'), correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a' } });
    writeRecord(a, 'completed_');
    writeDeltas(id, [{ timestamp: a.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    for (const suffix of ['.json', '_metrics.jsonl']) {
      renameSync(join(sessionsDir, `completed_${id}${suffix}`), join(sessionsDir, `completed_${id}-gen-a${suffix}`));
    }
    const aSetBytes = () => [`completed_${id}-gen-a.json`, `completed_${id}-gen-a_metrics.jsonl`].map((name) => readFileSync(join(sessionsDir, name), 'utf-8'));
    const aSetBefore = aSetBytes();
    const before = Date.now();

    await processEvent({ ...clearStart(), source: 'resume', session_id: 'gen-a' }, config(b));

    expect(existsSync(join(sessionsDir, `completed_${id}-claude-native-next.json`))).toBe(true);
    const movedB = readRecord(`${id}-claude-native-next`, 'completed_');
    expect(movedB).toMatchObject({ status: 'completed', endTime: Date.parse('2026-10-01T10:22:00Z'), correlation: { agentSessionId: 'claude-native-next' } });
    const fresh = readRecord(id);
    expect(fresh).toMatchObject({ status: 'active', correlation: { agentSessionId: 'gen-a' } });
    expect(fresh.startTime).toBeGreaterThanOrEqual(before);
    expect(aSetBytes()).toEqual(aSetBefore);

    const aTranscript = writeTranscript([fresh.startTime + SECOND, fresh.startTime + 2 * SECOND].map((t) => new Date(t).toISOString()));
    const aLines = [`msg-${idCounter}-1`];
    await processEvent({ hook_event_name: 'Stop', session_id: 'gen-a', transcript_path: aTranscript, permission_mode: 'default', cwd: home }, config(b));

    expect(readRecord(id)).toMatchObject({ startTime: fresh.startTime, correlation: { agentSessionId: 'gen-a' } });
    expect(readDeltas(id).map((d) => d.recordId)).toEqual(aLines);

    await processEvent({ hook_event_name: 'SessionEnd', session_id: 'gen-a', transcript_path: aTranscript, permission_mode: 'default', cwd: home, reason: 'exit' }, config(b));

    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['claude-native-next', 'gen-a']);
    expect(aSetBytes()).toEqual(aSetBefore);
    expect(readdirSync(sessionsDir).filter((name) => name.startsWith(`completed_${id}`) && name.endsWith('.json')).sort()).toEqual([
      `completed_${id}-claude-native-next.json`, `completed_${id}-gen-a.json`, `completed_${id}.json`,
    ]);
    expect(readRecord(id, 'completed_')).toMatchObject({ status: 'completed', startTime: fresh.startTime, correlation: { agentSessionId: 'gen-a' } });
    expect(readDeltas(id, 'completed_').map((d) => d.recordId)).toEqual(aLines);
  });

  it('an active generation under a lock let go right after the SessionStart\'s first try: fully closed under the lock its wait then takes (end metric sent, moved aside, not marked dropped); the fresh record, written under that same hold, starts at the /clear, not at the idle generation\'s last activity', async () => {
    const aTranscript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:13:00Z']);
    const session = baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-late-free', agentSessionFile: aTranscript } });
    writeRecord(session);
    const lockPath = join(sessionsDir, `${session.sessionId}.reconcile.lock`);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    // The holder lets go right after the start's first lock attempt has met it
    let firstTry = true;
    const before = Date.now();
    vi.mocked(writeFile).mockImplementation(async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]) !== lockPath || !firstTry) return actual.writeFile(...args);
      firstTry = false;
      try {
        return await actual.writeFile(...args);
      } finally {
        rmSync(lockPath);
      }
    });

    try {
      await onFakeClock(() => processEvent(clearStart(), config(session)));
    } finally {
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
    }

    expect(endMetrics().map((m) => m.attributes.session_id)).toEqual(['gen-late-free']);
    const moved = JSON.parse(readFileSync(join(sessionsDir, `completed_${session.sessionId}-gen-late-free.json`), 'utf-8')) as Session;
    expect(moved).toMatchObject({ status: 'completed', reason: 'interrupted', endTime: Date.parse('2026-10-01T10:13:00Z') });
    expect(moved.endMetricSentAt).toBeTypeOf('number');
    expect(moved.droppedAt).toBeUndefined();
    const fresh = readRecord(session.sessionId);
    expect(fresh).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
    expect(fresh.startTime).toBeGreaterThanOrEqual(before);
  });

  it.each(['startup', 'resume', 'compact'])('source=%s with the record\'s own session_id over a live record of the same id re-enters it, nothing moved', async (source) => {
    const session = baseRecord();
    writeRecord(session);

    await processEvent({ ...clearStart(), source, session_id: 'claude-native-1' }, config(session));

    expect(readRecord(session.sessionId).startTime).toBe(session.startTime);
    expect(readdirSync(sessionsDir).some((n) => n.startsWith(`completed_${session.sessionId}-`))).toBe(false);
  });
});

describe('a later event of generation B over generation A\'s record establishes B\'s own record', () => {
  /** An event of generation B (native id `claude-native-next`), in process. */
  function eventOfB(name: string, transcript: string, extra: Record<string, unknown> = {}) {
    return { hook_event_name: name, session_id: 'claude-native-next', transcript_path: transcript, permission_mode: 'default', cwd: home, ...extra };
  }

  function generationA(overrides: Partial<Session> = {}): Session {
    return baseRecord({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a' }, ...overrides });
  }

  it.each(['matched', 'pending'] as const)('Stop of B over A\'s live completed record (correlation %s; delivered, not renamed): A moved aside under its generation name, a fresh record of B starting at A\'s end holds B\'s lines', async (correlationStatus) => {
    const a = generationA({
      status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), endMetricSentAt: Date.parse('2026-10-01T10:30:01Z'),
      correlation: { status: correlationStatus, retryCount: 0, agentSessionId: 'gen-a' },
    });
    const id = a.sessionId;
    writeRecord(a);
    writeDeltas(id, [{ timestamp: a.startTime + SECOND, syncStatus: 'synced' }]);
    const transcript = writeTranscript([Date.now() - 2 * SECOND, Date.now() - SECOND].map((t) => new Date(t).toISOString()));
    const bLines = [`msg-${idCounter}-1`];

    await processEvent(eventOfB('Stop', transcript), config(a));

    expect(existsSync(join(sessionsDir, `completed_${id}-gen-a.json`))).toBe(true);
    expect(existsSync(join(sessionsDir, `completed_${id}_metrics.jsonl`))).toBe(false);
    expect(readDeltas(`${id}-gen-a`, 'completed_').map((d) => d.recordId)).toEqual([`rec-${id}-0`]);
    expect(readRecord(id)).toMatchObject({ status: 'active', startTime: Date.parse('2026-10-01T10:30:00Z'), correlation: { agentSessionId: 'claude-native-next', agentSessionFile: transcript } });
    expect(readDeltas(id).map((d) => d.recordId)).toEqual(bLines);
  });

  it('Stop of B over A\'s live active record whose lock is held throughout is deferred at once (the lock tried, never waited for): nothing written, one warn; the next Stop of B once the lock is free closes A and syncs B\'s whole transcript into a fresh record', async () => {
    clearLogs();
    const a = generationA();
    const id = a.sessionId;
    writeRecord(a);
    writeDeltas(id, [{ timestamp: a.startTime + SECOND }]);
    const recordBefore = readFileSync(join(sessionsDir, `${id}.json`), 'utf-8');
    const deltasBefore = readFileSync(join(sessionsDir, `${id}_metrics.jsonl`), 'utf-8');
    const lockPath = join(sessionsDir, `${id}.reconcile.lock`);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    const transcript = writeTranscript([-4, -3, -2, -1].map((s) => new Date(Date.now() + s * SECOND).toISOString()));
    const bLines = [`msg-${idCounter}-1`, `msg-${idCounter}-3`];

    const stopStartedAt = Date.now();
    await processEvent(eventOfB('Stop', transcript), config(a));

    expect(Date.now() - stopStartedAt).toBeLessThan(2 * SECOND);
    expect(readFileSync(join(sessionsDir, `${id}.json`), 'utf-8')).toBe(recordBefore);
    expect(readFileSync(join(sessionsDir, `${id}_metrics.jsonl`), 'utf-8')).toBe(deltasBefore);
    expect(vi.mocked(logger.warn).mock.calls.filter(([line]) => String(line).includes('the event is deferred') && String(line).includes(lockPath))).toHaveLength(1);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes('Session re-entered'))).toBe(false);

    rmSync(lockPath);
    await processEvent(eventOfB('Stop', transcript), config(a));

    expect(existsSync(join(sessionsDir, `completed_${id}-gen-a.json`))).toBe(true);
    expect(readRecord(id)).toMatchObject({ status: 'active', correlation: { agentSessionId: 'claude-native-next' } });
    expect(readDeltas(id).map((d) => d.recordId)).toEqual(bLines);
  });

  it('Stop of B over A\'s live idle active record (no delta, no activity mark): A closed at its last transcript record, B\'s fresh record starts there', async () => {
    const aTranscript = writeTranscript(['2026-10-01T10:10:00Z', '2026-10-01T10:13:00Z']);
    const a = generationA({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'gen-a', agentSessionFile: aTranscript } });
    const id = a.sessionId;
    writeRecord(a);
    const transcript = writeTranscript([Date.now() - 2 * SECOND, Date.now() - SECOND].map((t) => new Date(t).toISOString()));

    await processEvent(eventOfB('Stop', transcript), config(a));

    expect(JSON.parse(readFileSync(join(sessionsDir, `completed_${id}-gen-a.json`), 'utf-8'))).toMatchObject({ endTime: Date.parse('2026-10-01T10:13:00Z') });
    expect(readRecord(id)).toMatchObject({ status: 'active', startTime: Date.parse('2026-10-01T10:13:00Z'), correlation: { agentSessionId: 'claude-native-next' } });
  });

  it.each(['live', 'completed_'] as const)('UserPromptSubmit of B over A\'s %s record writes no activityStartedAt anywhere; the auth gate still runs', async (where) => {
    const a = generationA(where === 'live' ? {} : { status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z') });
    writeRecord(a, where === 'live' ? '' : 'completed_');
    const prompt = eventOfB('UserPromptSubmit', join(home, 'b-transcript.jsonl'));
    const withKey = config(a, { apiKey: 'test-key' });
    const { markAnalyticsAuthInvalid } = await import('@/utils/analytics-auth-status.js');
    await markAnalyticsAuthInvalid('rejected in test', API);

    await expect(processEvent(prompt, withKey)).rejects.toThrow('rejected the stored credentials');
    await clearAnalyticsAuthStatus();
    await processEvent(prompt, withKey);

    const records = readdirSync(sessionsDir).filter((n) => n.endsWith('.json'));
    expect(records.length).toBeGreaterThan(0);
    expect(records.filter((n) => JSON.parse(readFileSync(join(sessionsDir, n), 'utf-8')).activityStartedAt !== undefined)).toEqual([]);
  });

  it('SubagentStop of B over A\'s completed_ record only: deferred while the lock is held, nothing written; once it is free a fresh record of B, A\'s completed_ set unchanged', async () => {
    const a = generationA({ status: 'completed', endTime: Date.parse('2026-10-01T10:30:00Z'), endMetricSentAt: Date.parse('2026-10-01T10:30:01Z') });
    const id = a.sessionId;
    writeRecord(a, 'completed_');
    writeDeltas(id, [{ timestamp: a.startTime + SECOND, syncStatus: 'synced' }], 'completed_');
    const aRecordBytes = readFileSync(join(sessionsDir, `completed_${id}.json`), 'utf-8');
    const aMetricsBytes = readFileSync(join(sessionsDir, `completed_${id}_metrics.jsonl`), 'utf-8');
    const transcript = writeTranscript([Date.now() - 2 * SECOND, Date.now() - SECOND].map((t) => new Date(t).toISOString()));
    const subagentStop = eventOfB('SubagentStop', transcript, { agent_id: 'sub-1', agent_transcript_path: '', stop_hook_active: false });
    const lockPath = join(sessionsDir, `${id}.reconcile.lock`);
    const { processStartedAt } = await import('../../../utils/processes.js');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    const filesBefore = readdirSync(sessionsDir).sort();

    await processEvent(subagentStop, config(a));

    expect(readdirSync(sessionsDir).sort()).toEqual(filesBefore);
    rmSync(lockPath);
    await processEvent(subagentStop, config(a));

    expect(existsSync(join(sessionsDir, `${id}.json`))).toBe(true);
    expect(readRecord(id).startTime).toBe(a.endTime);
    expect(readRecord(id).correlation.agentSessionId).toBe('claude-native-next');
    expect(readFileSync(join(sessionsDir, `completed_${id}.json`), 'utf-8')).toBe(aRecordBytes);
    expect(readFileSync(join(sessionsDir, `completed_${id}_metrics.jsonl`), 'utf-8')).toBe(aMetricsBytes);
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
