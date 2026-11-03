import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const snapshotPendingHookRecordsMock = vi.fn();
const snapshotPendingBytesMock = vi.fn();
const snapshotPendingNdjsonRecordsMock = vi.fn();
const advanceCursorMock = vi.fn();
const markSessionEndedMock = vi.fn();
const isSendAllowedMock = vi.fn();
const readStateMock = vi.fn();
const fetchMock = vi.fn();
const readStatusMock = vi.fn();
const noteStreamHoldMock = vi.fn();
const deliveryGateMock = vi.fn(async () => 'go');
const noteDeliveryFailureMock = vi.fn(async () => 'noted');
const forwarderIdentityMock = vi.fn();
const readRecordMock = vi.fn();
const getPolicyStateMock = vi.fn();
const refreshPolicyMock = vi.fn();
const proveRangeMock = vi.fn();

vi.mock('../spool-io.js', () => ({
  snapshotPendingHookRecords: snapshotPendingHookRecordsMock,
  snapshotPendingBytes: snapshotPendingBytesMock,
  snapshotPendingNdjsonRecords: snapshotPendingNdjsonRecordsMock,
  isSendAllowed: isSendAllowedMock,
  noteStreamHold: noteStreamHoldMock,
  forwarderIdentity: forwarderIdentityMock,
}));
// The failure mapping is real; only the persisted clock behind it is a spy (its own tests: delivery-retention).
vi.mock('../delivery-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../delivery-state.js')>();
  return {
    ...actual,
    deliveryGate: deliveryGateMock,
    recordUnacknowledged: async (sessionId: string, stream: string, outcome: never, range: unknown) => {
      const failure = actual.deliveryFailureOf(outcome);
      if (failure) await noteDeliveryFailureMock(sessionId, stream, failure, range);
    },
  };
});
vi.mock('../session-status.js', () => ({
  advanceCursor: advanceCursorMock,
  markSessionEnded: markSessionEndedMock,
  readStatus: readStatusMock,
}));
vi.mock('../session-lock.js', () => ({ withSessionLock: (_s: string, fn: () => unknown) => fn() }));
vi.mock('@/agents/core/evidence/record-store.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRecord: readRecordMock,
}));
vi.mock('../policy-cache.js', () => ({ getPolicyState: getPolicyStateMock, refreshPolicy: refreshPolicyMock }));
// The forwarder must never touch the real verdict directory; the sticky rules are tested in the tick.
vi.mock('../verdict-store.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readVerdict: vi.fn().mockResolvedValue(null),
  readVerdictState: vi.fn().mockResolvedValue({ state: 'none' }),
  recordVerdict: vi.fn().mockResolvedValue({ schema: 1, class: 'personal', created: 0 }),
  replaceVerdict: vi.fn().mockResolvedValue(false),
}));
vi.mock('../otlp-reader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  proveRange: proveRangeMock,
}));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };

/** A spool line as the daemon stores it: the envelope around the wire event built at hook time. */
function spoolLine(wireEvent: Record<string, unknown>): string {
  return JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(wireEvent) });
}

describe('unwrapHookRecords', () => {
  it('forwards each raw wire event byte for byte, newline-delimited', async () => {
    const { unwrapHookRecords } = await import('../forwarder.js');
    const first = { type: 'agent.prompt.submit', session_id: 's1', timestamp: '2026-01-01T00:00:00.000Z', zeta: 1, alpha: { b: 2 } };
    const second = { type: 'agent.tool.end', session_id: 's1' };

    const payload = unwrapHookRecords([spoolLine(first), spoolLine(second)]);

    expect(payload.ndjson).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    expect(payload.malformed).toBe(0);
  });

  it('does not synthesize or change any field', async () => {
    const { unwrapHookRecords } = await import('../forwarder.js');
    const bare = { session_id: 's1', hook_event_name: 'SessionEnd' };

    const payload = unwrapHookRecords([spoolLine(bare)]);

    expect(JSON.parse(payload.ndjson.trim())).toEqual(bare);
  });

  it('counts and skips malformed lines, keeping the good ones', async () => {
    const { unwrapHookRecords } = await import('../forwarder.js');
    const good = { type: 'agent.tool.end', session_id: 's1' };
    const badEnvelope = 'not json';
    const badRaw = JSON.stringify({ agentName: 'x', hookEvent: 'not json' });
    const noHookEvent = JSON.stringify({ agentName: 'x' });

    const payload = unwrapHookRecords([badEnvelope, spoolLine(good), badRaw, noHookEvent]);

    expect(payload.malformed).toBe(3);
    expect(payload.ndjson).toBe(`${JSON.stringify(good)}\n`);
  });

  it('returns an empty payload when nothing is usable', async () => {
    const { unwrapHookRecords } = await import('../forwarder.js');
    expect(unwrapHookRecords(['nope'])).toEqual({ ndjson: '', containsSessionEnd: false, malformed: 1 });
  });

  it('detects a session end from the wire type, not from hook_event_name', async () => {
    const { unwrapHookRecords } = await import('../forwarder.js');

    expect(unwrapHookRecords([spoolLine({ type: 'agent.session.end', session_id: 's1' })]).containsSessionEnd).toBe(true);
    expect(unwrapHookRecords([spoolLine({ type: 'agent.session.stop', hook_event_name: 'SessionEnd' })]).containsSessionEnd).toBe(false);
    expect(unwrapHookRecords([spoolLine({ hook_event_name: 'SessionEnd' })]).containsSessionEnd).toBe(false);
  });
});

describe('forwardSession (hooks)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    isSendAllowedMock.mockResolvedValue(true);
    snapshotPendingBytesMock.mockResolvedValue(null);
    snapshotPendingNdjsonRecordsMock.mockResolvedValue(null);
    snapshotPendingHookRecordsMock.mockResolvedValue({
      project: 'Proj A',
      records: [spoolLine({ type: 'agent.session.end', session_id: 's1' })],
      cursor: 10,
      byteLength: 100,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the ndjson to the target API, advances the cursor and marks the session ended', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/v1/analytics/cli-analytics/event-hooks');
    expect(init.body).toBe(`${JSON.stringify({ type: 'agent.session.end', session_id: 's1' })}\n`);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 110);
    expect(markSessionEndedMock).toHaveBeenCalledWith('s1');
  });

  it('IR-CLI003: every hooks and OTLP request URL is the canonical validated base plus one path (no //), localhost has no API prefix', async () => {
    const { apiIdentity } = await import('@/agents/core/evidence/api-identity.js');
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) => ({
      project: 'Proj A', cursor: 4, bytes: Buffer.from(`${stream}-bytes`),
    }));
    const API = 'https://api.example.com/code-assistant-api';
    const LOCAL = 'http://localhost:3000';
    const run = async (apiUrl: string, state: Record<string, string>): Promise<string[]> => {
      fetchMock.mockClear();
      forwarderIdentityMock.mockReturnValue({ api_identity: apiIdentity(apiUrl), owner_hash: 'h' });
      readStateMock.mockResolvedValue({ targetUrl: 'https://llm-gateway.example.com', ...state });
      const { forwardSession } = await import('../forwarder.js');
      await forwardSession('s1', false, { ...credentials, apiUrl });
      return fetchMock.mock.calls.map(([url]) => String(url));
    };
    const expected = (base: string): string[] =>
      ['event-hooks', 'logs', 'metrics', 'traces'].map((p) => `${base}/v1/analytics/cli-analytics/${p}`);
    try {
      // Forms apiIdentity accepts: trailing slash, repeated slashes, query/userinfo, and the bare host.
      for (const syncApiUrl of [API + '/', API + '//', 'https://u:p@api.example.com//code-assistant-api/?x=1']) {
        const urls = await run(API, { syncApiUrl });
        expect(urls).toEqual(expected(API));
        expect(urls.every((u) => !u.slice(8).includes('//'))).toBe(true);
      }
      expect(await run(API, { syncCodeMieUrl: 'https://api.example.com/' })).toEqual(expected(API));
      // Localhost: no /code-assistant-api prefix on either side.
      expect(await run(LOCAL, { syncCodeMieUrl: LOCAL + '/' })).toEqual(expected(LOCAL));
      // Genuine mismatches send and fetch nothing.
      expect(await run(LOCAL, { syncCodeMieUrl: 'http://127.0.0.1:3000' })).toEqual([]);
      expect(await run(API, { syncCodeMieUrl: LOCAL })).toEqual([]);
      expect(await run(LOCAL + '/code-assistant-api', { syncCodeMieUrl: LOCAL })).toEqual([]);
    } finally {
      forwarderIdentityMock.mockReset();
    }
  });

  it('retries once on 401 and succeeds', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 110);
  });

  it('leaves the cursor untouched and marks credentials stale after two 403s', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');

    await forwardSession('s1', true, credentials);

    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(markSessionEndedMock).not.toHaveBeenCalled();
    expect(areCredentialsStale()).toBe(true);
  });

  it('a login-blocked backlog is suspended, not resent every tick, and starts no retention clock', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    const attempts = fetchMock.mock.calls.length; // one attempt plus the single auth retry
    expect(attempts).toBe(2);

    for (let tick = 0; tick < 3; tick++) await forwardSession('s1', true, credentials);
    expect(fetchMock.mock.calls.length).toBe(attempts);
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(noteDeliveryFailureMock).not.toHaveBeenCalled();
  });

  it('treats repeated 302 login redirects as expired credentials without following them', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 302 });
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(markSessionEndedMock).not.toHaveBeenCalled();
    expect(areCredentialsStale()).toBe(true);
  });

  it('leaves a 301 redirect pending without marking credentials stale', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 301 });
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(areCredentialsStale()).toBe(false);
  });

  it('leaves the cursor untouched on a non-auth failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('advances the cursor without a request when every line is malformed', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({ project: 'Proj A', records: ['nope'], cursor: 5, byteLength: 4 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 9);
  });

  it('does not mark the session ended for a batch without a session end', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({
      project: 'Proj A',
      records: [spoolLine({ type: 'agent.tool.end', session_id: 's1' })],
      cursor: 0,
      byteLength: 10,
    });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(markSessionEndedMock).not.toHaveBeenCalled();
  });
});

describe('forwardSession (project header)', () => {
  const hooksBatch = {
    project: 'Proj A',
    records: [spoolLine({ type: 'agent.tool.end', session_id: 's1' })],
    cursor: 0,
    byteLength: 10,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    isSendAllowedMock.mockResolvedValue(true);
    snapshotPendingHookRecordsMock.mockResolvedValue(hooksBatch);
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) => ({
      project: 'Proj A',
      cursor: 4,
      bytes: Buffer.from(`${stream}-bytes`),
    }));
    snapshotPendingNdjsonRecordsMock.mockResolvedValue(null);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends X-CodeMie-Project on hooks, logs, metrics and traces', async () => {
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const urls = fetchMock.mock.calls.map(([url]) => String(url).split('/').pop());
    expect(urls).toEqual(['event-hooks', 'logs', 'metrics', 'traces']);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers['X-CodeMie-Project']).toBe('Proj A');
      expect(init.headers['Content-Type']).toBeDefined();
    }
    expect(fetchMock.mock.calls[1][1].body.toString()).toBe('logs-bytes');
  });

  it('sends a personal project (email) unchanged', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({ ...hooksBatch, project: 'a@b.com' });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock.mock.calls[0][1].headers['X-CodeMie-Project']).toBe('a@b.com');
  });

  it('AC8: sends no project header when the session has no project', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({ ...hooksBatch, project: '' });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('X-CodeMie-Project');
  });

  it('omits the project header for a non-Latin-1 project name', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({ ...hooksBatch, project: 'клиенты/проект' });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock.mock.calls[0][1].headers['X-CodeMie-Project']).toBeUndefined();
  });

  it('sends nothing when the snapshots are null', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockResolvedValue(null);
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when the project is no longer sendable', async () => {
    isSendAllowedMock.mockResolvedValue(false);
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(isSendAllowedMock).toHaveBeenNthCalledWith(1, 's1', 'hooks', 'Proj A', { cursor: 0, end: 10, filtered: false });
  });

  it('checks every OTLP stream under its own name and byte range, so a hooks-only seal cannot cover it', async () => {
    isSendAllowedMock.mockImplementation(async (_s: string, stream: string) => stream === 'hooks');
    snapshotPendingBytesMock.mockResolvedValue({ project: 'Proj A', cursor: 4, bytes: Buffer.alloc(10) });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(isSendAllowedMock).toHaveBeenCalledWith('s1', 'logs', 'Proj A', { cursor: 4, end: 14, filtered: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the hooks batch only
    expect(String(fetchMock.mock.calls[0][0])).toContain('/event-hooks');
    expect(advanceCursorMock).not.toHaveBeenCalledWith('s1', 'logs', expect.anything());
  });

  it('tells the pre-send check whether the batch was built through the sealed-project filter', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({
      project: 'Proj A',
      records: [spoolLine({ type: 'agent.tool.end', session_id: 's1' })],
      cursor: 0,
      byteLength: 50,
      dropped: 0,
      filtered: true,
    });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(isSendAllowedMock).toHaveBeenCalledWith('s1', 'hooks', 'Proj A', { cursor: 0, end: 50, filtered: true });
  });

  it('advances over a sealed batch with nothing provable to send, without a request', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({
      project: 'Proj A',
      records: [],
      cursor: 0,
      byteLength: 50,
      dropped: 2,
    });
    fetchMock.mockReset();
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 50);
  });

  it('does not re-POST after a 401 once the project stopped being sendable', async () => {
    isSendAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('counts a BE 200 discard as done and does not mark credentials stale', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"accepted":0,"dropped":2,"reason":"project_context_conflict"}',
    });
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');

    await forwardSession('s1', true, credentials);

    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 10, expect.objectContaining({ reason: 'project_context_conflict' }));
    expect(areCredentialsStale()).toBe(false);
  });

  it('keeps the cursor on a 503 and does not mark credentials stale', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');

    await forwardSession('s1', true, credentials);

    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(areCredentialsStale()).toBe(false);
  });

  it.each([400, 413, 422])('keeps retrying a hooks batch the backend answers with %i: skipping would drop the whole batch', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('keeps retrying accumulated binary OTLP bytes the backend answers with 413', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logs' ? { project: 'Proj A', cursor: 0, bytes: Buffer.from('LL') } : null
    );
    fetchMock.mockResolvedValue({ ok: false, status: 413 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });
});

describe('forwardSession (OTEL JSON streams)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    isSendAllowedMock.mockResolvedValue(true);
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function logsOnlyBatch(records: string[], cursor = 0) {
    const byteLength = records.reduce((sum, r) => sum + Buffer.byteLength(r, 'utf8') + 1, 0);
    return { project: 'Proj A', cursor, records, byteLength };
  }

  it('POSTs each masked-JSON record as its own application/json request, routed to the matching signal endpoint', async () => {
    const record = JSON.stringify({ n: 1 });
    snapshotPendingNdjsonRecordsMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logsJson' ? logsOnlyBatch([record], 100) : null
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    const logsCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/logs'));
    expect(logsCalls).toHaveLength(1);
    expect(logsCalls[0][1].body).toBe(record);
    expect(logsCalls[0][1].headers['Content-Type']).toBe('application/json');
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logsJson', 100 + Buffer.byteLength(record, 'utf8') + 1);
  });

  it('(CR-004) acknowledges a multi-record batch one record at a time, in order', async () => {
    const r1 = JSON.stringify({ n: 1 });
    const r2 = JSON.stringify({ n: 2 });
    snapshotPendingNdjsonRecordsMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logsJson' ? logsOnlyBatch([r1, r2], 100) : null
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    const logsCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/logs'));
    expect(logsCalls.map(([, init]) => init.body)).toEqual([r1, r2]);

    const r1End = 100 + Buffer.byteLength(r1, 'utf8') + 1;
    const r2End = r1End + Buffer.byteLength(r2, 'utf8') + 1;
    expect(advanceCursorMock).toHaveBeenNthCalledWith(1, 's1', 'logsJson', r1End);
    expect(advanceCursorMock).toHaveBeenNthCalledWith(2, 's1', 'logsJson', r2End);
  });

  it('(CR-004) stops at the first failing record and never resends the records already confirmed', async () => {
    const r1 = JSON.stringify({ n: 1 });
    const r2 = JSON.stringify({ n: 2 });
    const r3 = JSON.stringify({ n: 3 });
    snapshotPendingNdjsonRecordsMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logsJson' ? logsOnlyBatch([r1, r2, r3], 0) : null
    );
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) =>
      init.body === r2 ? { ok: false, status: 500 } : { ok: true, status: 200 }
    );
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    const logsCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/logs'));
    // r3 is never attempted: the loop stops as soon as r2 fails.
    expect(logsCalls.map(([, init]) => init.body)).toEqual([r1, r2]);

    const r1End = Buffer.byteLength(r1, 'utf8') + 1;
    expect(advanceCursorMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logsJson', r1End);
  });

  describe('a record the backend permanently rejects', () => {
    const r1 = JSON.stringify({ n: 1 });
    const r2 = JSON.stringify({ n: 2 });
    const r3 = JSON.stringify({ n: 3 });
    const byteEnd = (...records: string[]): number =>
      records.reduce((sum, r) => sum + Buffer.byteLength(r, 'utf8') + 1, 0);

    function respondWith(status: number, rejectedBody: string): void {
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) =>
        init.body === rejectedBody ? { ok: false, status } : { ok: true, status: 200 }
      );
    }

    function logsCalls(): string[] {
      return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/logs')).map(([, init]) => init.body);
    }

    beforeEach(() => {
      snapshotPendingNdjsonRecordsMock.mockImplementation(async (_s: string, stream: string) =>
        stream === 'logsJson' ? logsOnlyBatch([r1, r2, r3], 0) : null
      );
    });

    it.each([400, 413, 422])('is skipped on a %i, so the records behind it still go out', async (status) => {
      respondWith(status, r2);
      const { forwardSession } = await import('../forwarder.js');
      const { logger } = await import('@/utils/logger.js');

      await forwardSession('s1', false, credentials);

      expect(logsCalls()).toEqual([r1, r2, r3]);
      expect(advanceCursorMock.mock.calls.map(([, , cursor]) => cursor)).toEqual([
        byteEnd(r1),
        byteEnd(r1, r2),
        byteEnd(r1, r2, r3),
      ]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('does not log the rejected payload', async () => {
      respondWith(413, r2);
      const { forwardSession } = await import('../forwarder.js');
      const { logger } = await import('@/utils/logger.js');

      await forwardSession('s1', false, credentials);

      expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(r2);
    });

    it('lets the stream finish when every record is rejected', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 413 });
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('s1', false, credentials);

      expect(logsCalls()).toEqual([r1, r2, r3]);
      expect(advanceCursorMock).toHaveBeenLastCalledWith('s1', 'logsJson', byteEnd(r1, r2, r3),
        expect.objectContaining({ reason: 'payload_rejected', stream: 'logsJson', bytes: Buffer.byteLength(r3) + 1 }));
    });

    it.each([404, 405, 408, 409, 429, 500, 502, 503])(
      'is retried, not skipped, on a %i: the cursor stays and the records behind it wait',
      async (status) => {
        respondWith(status, r2);
        const { forwardSession } = await import('../forwarder.js');
        const { logger } = await import('@/utils/logger.js');

        await forwardSession('s1', false, credentials);

        expect(logsCalls()).toEqual([r1, r2]);
        expect(advanceCursorMock).toHaveBeenCalledTimes(1);
        expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logsJson', byteEnd(r1));
        expect(logger.warn).not.toHaveBeenCalled();
      }
    );

    it('is retried when the send is no longer allowed, even though nothing was rejected', async () => {
      isSendAllowedMock.mockResolvedValue(false);
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('s1', false, credentials);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(advanceCursorMock).not.toHaveBeenCalled();
    });
  });

  it('marks credentials stale and stops after an auth-expired JSON-stream response', async () => {
    const record = JSON.stringify({ n: 1 });
    snapshotPendingNdjsonRecordsMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logsJson' ? logsOnlyBatch([record], 0) : null
    );
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');

    await forwardSession('s1', false, credentials);

    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(areCredentialsStale()).toBe(true);
  });

  it('advances the cursor without a request when the only pending bytes are an incomplete trailing record', async () => {
    snapshotPendingNdjsonRecordsMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logsJson' ? { project: 'Proj A', cursor: 5, records: [], byteLength: 20 } : null
    );
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logsJson', 25);
  });
});

describe('send outcomes and evidence requests (Task 13)', () => {
  const record = {
    schema: 1, session_id: 's1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven',
    organization: 'Acme', project: 'Proj A', project_source: 'linked_folder', repo_key: 'git.example.com/a/b',
    api_identity: 'https://api', owner_hash: 'h', created: 0, last_used: 0,
  };
  const policyV1 = { organizations: ['Acme'], version: 'v1' };
  const usable = (policy: unknown) => ({ policy, capability: 'evidence', usable: !!policy, refreshDue: !policy });
  const line = (sessionId: string) => spoolLine({ type: 'agent.tool.end', session_id: sessionId, codemie_project_name: 'Proj A' });
  const hooksBatch = (lines: string[]) => ({
    project: 'Proj A', records: lines, cursor: 0, byteLength: lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0), dropped: 0, filtered: false,
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /** ExportLogsServiceResponse{partial_success{rejected=1:varint, error_message=2:string}}, hand-encoded. */
  const protoPartial = (rejected: number, message: string) => {
    const msg = Buffer.from(message);
    const inner = Buffer.concat([Buffer.from([0x08, rejected, 0x12, msg.length]), msg]);
    return new Response(Buffer.concat([Buffer.from([0x0a, inner.length]), inner]), {
      status: 200, headers: { 'content-type': 'application/x-protobuf' },
    });
  };
  const headersOf = (n: number) => fetchMock.mock.calls[n][1].headers as Record<string, string>;
  const evidenceKeys = ['X-CodeMie-Session-Id', 'X-CodeMie-Routed-Via-CodeMie', 'X-CodeMie-Organization',
    'X-CodeMie-Project-Source', 'X-CodeMie-Subscription-Type', 'X-CodeMie-Policy-Version', 'X-CodeMie-Repo-Remote'];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api', profile: 'p' });
    isSendAllowedMock.mockResolvedValue(true);
    readStatusMock.mockResolvedValue({ sendMode: 'evidence' });
    forwarderIdentityMock.mockReturnValue({ api_identity: 'https://api', owner_hash: 'h' });
    readRecordMock.mockResolvedValue({ kind: 'existing', record });
    getPolicyStateMock.mockResolvedValue(usable(policyV1));
    refreshPolicyMock.mockResolvedValue(usable(null));
    noteStreamHoldMock.mockResolvedValue('clear');
    snapshotPendingNdjsonRecordsMock.mockResolvedValue(null);
    snapshotPendingHookRecordsMock.mockResolvedValue(hooksBatch([line('s1')]));
    snapshotPendingBytesMock.mockResolvedValue(null);
    proveRangeMock.mockImplementation((bytes: Buffer) => ({ verified: bytes.length }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([200, 400, 503])('JSON evidence sends retain identity and acknowledge only confirmed responses (%i)', async (status) => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    const recordJson = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
      attributes: [{ key: 'session.id', value: { stringValue: 's1' } }],
    }] }] }] });
    snapshotPendingNdjsonRecordsMock.mockImplementation(async (_id: string, stream: string) => stream === 'logsJson'
      ? { project: 'Proj A', cursor: 4, records: [recordJson], byteLength: Buffer.byteLength(recordJson) + 1 } : null);
    fetchMock.mockImplementation(async () => json({}, status));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(headersOf(0)['X-CodeMie-Session-Id']).toBe('s1');
    expect(headersOf(0)['X-CodeMie-Subscription-Type']).toBe('corporate');
    expect(fetchMock.mock.calls[0][1].body).toBe(recordJson);
    if (status === 200) expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logsJson', 4 + Buffer.byteLength(recordJson) + 1);
    else expect(advanceCursorMock).not.toHaveBeenCalled();
    // An unacknowledged request starts the range's retention clock, keyed by the range start; an ack does not.
    if (status === 200) expect(noteDeliveryFailureMock).not.toHaveBeenCalled();
    else expect(noteDeliveryFailureMock).toHaveBeenCalledWith('s1', 'logsJson', status === 400
      ? { reason: 'delivery_rejected', detail: 'http_400' }
      : { reason: 'delivery_failed', detail: 'http_503' }, { cursor: 4, end: 4 + Buffer.byteLength(recordJson) + 1, filtered: false });
  });

  it('a stream in backoff sends nothing; auth failures and local non-attempts are not delivery failures', async () => {
    deliveryGateMock.mockResolvedValueOnce('wait');
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () => json({}, 401));
    await forwardSession('s1', true, credentials);
    isSendAllowedMock.mockResolvedValue(false);
    await forwardSession('s1', true, credentials);
    expect(noteDeliveryFailureMock).not.toHaveBeenCalled();
  });

  it('a 503 naming its refusal is a destination failure; a malformed 200 is an unverified response', async () => {
    const { forwardSession } = await import('../forwarder.js');
    fetchMock.mockImplementationOnce(async () => json({ detail: 'default_project_unavailable' }, 503));
    await forwardSession('s1', true, credentials);
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 200 }));
    await forwardSession('s1', true, credentials);
    expect(noteDeliveryFailureMock).toHaveBeenNthCalledWith(1, 's1', 'hooks', { reason: 'destination_unavailable', detail: 'default_project_unavailable' }, expect.objectContaining({ cursor: expect.any(Number) }));
    expect(noteDeliveryFailureMock).toHaveBeenNthCalledWith(2, 's1', 'hooks', { reason: 'response_unverified', detail: 'response_malformed' }, expect.objectContaining({ cursor: expect.any(Number) }));
  });

  it('holds a JSON evidence record with a mismatching session before sending', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    const recordJson = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
      attributes: [{ key: 'session.id', value: { stringValue: 'other' } }],
    }] }] }] });
    snapshotPendingNdjsonRecordsMock.mockImplementation(async (_id: string, stream: string) => stream === 'logsJson'
      ? { project: 'Proj A', cursor: 0, records: [recordJson], byteLength: recordJson.length + 1 } : null);
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(noteStreamHoldMock).toHaveBeenCalledWith('s1', 'logsJson', 'session_mismatch');
  });

  it('legacy sends carry no Session-Id or evidence header', async () => {
    readStatusMock.mockResolvedValue({ sendMode: 'legacy' });
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    for (const k of evidenceKeys) expect(headersOf(0)).not.toHaveProperty(k);
    expect(headersOf(0)['X-CodeMie-Project']).toBe('Proj A');
  });

  it('hooks 2xx with an empty/non-JSON body: legacy acknowledges the range, an evidence request keeps it queued', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue({ ...hooksBatch([line('s1')]), cursor: 0 });
    fetchMock.mockImplementation(async () => new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const { forwardSession } = await import('../forwarder.js');

    readStatusMock.mockResolvedValue({ sendMode: 'legacy' });
    await forwardSession('s1', false, credentials);
    expect(headersOf(0)).not.toHaveProperty('X-CodeMie-Session-Id');
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', hooksBatch([line('s1')]).byteLength);

    advanceCursorMock.mockClear();
    readStatusMock.mockResolvedValue({ sendMode: 'evidence' });
    await forwardSession('s1', false, credentials);
    expect(headersOf(1)).toHaveProperty('X-CodeMie-Session-Id', 's1');
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('evidence sends carry the frozen record values and the classification', async () => {
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(headersOf(0)).toMatchObject({
      'X-CodeMie-Session-Id': 's1', 'X-CodeMie-Routed-Via-CodeMie': 'false', 'X-CodeMie-Organization': 'Acme',
      'X-CodeMie-Subscription-Type': 'corporate', 'X-CodeMie-Policy-Version': 'v1',
      'X-CodeMie-Project': 'Proj A', 'X-CodeMie-Project-Source': 'linked_folder', 'X-CodeMie-Repo-Remote': 'git.example.com/a/b',
    });
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', hooksBatch([line('s1')]).byteLength);
  });

  it('no project: no Project headers; no organization: no Organization header, sent as unknown', async () => {
    readRecordMock.mockResolvedValue({
      kind: 'existing', record: { ...record, project: undefined, project_source: 'none', organization: undefined, repo_key: undefined },
    });
    snapshotPendingHookRecordsMock.mockResolvedValue({ ...hooksBatch([spoolLine({ type: 'x', session_id: 's1' })]), project: '' });
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    const h = headersOf(0);
    for (const k of ['X-CodeMie-Project', 'X-CodeMie-Project-Source', 'X-CodeMie-Organization', 'X-CodeMie-Repo-Remote', 'X-CodeMie-Policy-Version']) {
      expect(h).not.toHaveProperty(k);
    }
    expect(h['X-CodeMie-Subscription-Type']).toBe('unknown');
  });

  /** The backend's D7 (cli-analytics-events.md): routed -> codemie; org blank or empty list -> unknown; match -> corporate; else personal. */
  const backendClass = (h: Record<string, string>, list: string[]): string => {
    if (h['X-CodeMie-Routed-Via-CodeMie'] === 'true') return 'codemie';
    const org = (h['X-CodeMie-Organization'] ?? '').trim().toLowerCase();
    if (!org || list.length === 0) return 'unknown';
    return list.some((o) => o.trim().toLowerCase() === org) ? 'corporate' : 'personal';
  };

  it('CR002 wire: an unproven route with a known non-matching organization derives Unknown at the backend too, never Personal', async () => {
    getPolicyStateMock.mockResolvedValue(usable({ organizations: ['Other'], version: 'v1' }));
    readRecordMock.mockResolvedValue({ kind: 'existing', record: { ...record, routing_proof: 'unproven' } });
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    const h = headersOf(0);
    expect(h['X-CodeMie-Subscription-Type']).toBe('unknown');
    expect(h).not.toHaveProperty('X-CodeMie-Organization');
    expect(backendClass(h, ['Other'])).toBe('unknown');
  });

  it('CR002 wire: a proven direct route keeps the organization and client and backend agree on Personal', async () => {
    getPolicyStateMock.mockResolvedValue(usable({ organizations: ['Other'], version: 'v1' }));
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    const h = headersOf(0);
    expect(h['X-CodeMie-Subscription-Type']).toBe('personal');
    expect(backendClass(h, ['Other'])).toBe('personal');
  });

  it.each([
    ['malformed hooks JSON', () => new Response('not-json', { status: 200 })],
    ['a body read that fails after the headers', () => ({
      status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => { throw new Error('aborted'); } }) },
    }) as unknown as Response],
  ])('IR-CLI001: %s keeps the cursor and does not mark the session ended', async (_n, make) => {
    snapshotPendingHookRecordsMock.mockResolvedValue(hooksBatch([spoolLine({ type: 'agent.session.end', session_id: 's1', codemie_project_name: 'Proj A' })]));
    fetchMock.mockImplementation(async () => make());
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(markSessionEndedMock).not.toHaveBeenCalled();
  });

  it('IR-CLI001: a truncated OTLP response keeps the cursor; a genuine empty one advances it', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logs' ? { project: 'Proj A', cursor: 0, bytes: Buffer.from('abc'), more: false } : null);
    fetchMock.mockImplementationOnce(async () =>
      new Response(Buffer.from([0x0a, 0x7f]), { status: 200, headers: { 'content-type': 'application/x-protobuf' } }));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(advanceCursorMock).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200, headers: { 'content-type': 'application/x-protobuf' } }));
    await forwardSession('s1', false, credentials);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logs', 3);
  });

  it('CR003: a backlog over the cap drains in bounded windows with exact cursors', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    const first = Buffer.from('aaaa');
    const second = Buffer.from('bb');
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string, limit?: number) => {
      if (stream !== 'logs') return null;
      expect(limit).toBe(5_242_880); // evidence mode asks for a window, never the whole tail
      const calls = snapshotPendingBytesMock.mock.calls.filter((c) => c[1] === 'logs').length;
      return calls === 1
        ? { project: 'Proj A', cursor: 0, bytes: first, more: true }
        : { project: 'Proj A', cursor: 4, bytes: second, more: false };
    });
    proveRangeMock.mockImplementation((bytes: Buffer, o: { more?: boolean }) => ({ verified: bytes.length, ...(o.more ? { windowCut: true } : {}) }));
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(fetchMock.mock.calls.map((c) => (c[1].body as Buffer).toString())).toEqual(['aaaa', 'bb']);
    expect(advanceCursorMock.mock.calls).toEqual([['s1', 'logs', 4], ['s1', 'logs', 6]]);
    // A window cut inside an entry is not a hold.
    expect(noteStreamHoldMock).toHaveBeenCalledWith('s1', 'logs', null);
  });

  it('evidence mode without a valid record at the forwarder key sends nothing', async () => {
    readRecordMock.mockResolvedValue({ kind: 'stamp_invalid', reason: 'record_invalid' });
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('fetches the policy when none is usable (bounded, not forced)', async () => {
    getPolicyStateMock.mockResolvedValue(usable(null));
    refreshPolicyMock.mockResolvedValue(usable(policyV1));
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(refreshPolicyMock).toHaveBeenCalledWith(
      { api_identity: 'https://api', owner_hash: 'h', profile: 'p' },
      expect.objectContaining({ baseUrl: 'https://api', force: undefined })
    );
    expect(headersOf(0)['X-CodeMie-Policy-Version']).toBe('v1');
  });

  it('AC5: a hooks discard advances exactly its range, records the real reason and acknowledges no OTLP stream', async () => {
    snapshotPendingBytesMock.mockResolvedValue({ project: 'Proj A', cursor: 7, bytes: Buffer.from('logs') });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/event-hooks')
        ? json({ accepted: 0, dropped: 1, reason: 'session_project_conflict' })
        : new Response('', { status: 503 })
    );
    const { forwardSession } = await import('../forwarder.js');
    const { logger } = await import('@/utils/logger.js');
    await forwardSession('s1', false, credentials);
    const n = hooksBatch([line('s1')]).byteLength;
    expect(advanceCursorMock).toHaveBeenCalledTimes(1);
    // AC18: the discard is persisted with the advance (status.lastDiscard), never an accepted send.
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', n, {
      reason: 'session_project_conflict', stream: 'hooks', bytes: n, at: expect.any(Number),
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain('session_project_conflict');
    expect(markSessionEndedMock).not.toHaveBeenCalled();
  });

  it('uses the classification decided by the tick, without re-reading the policy', async () => {
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials, { class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v9' });
    expect(headersOf(0)).toMatchObject({ 'X-CodeMie-Subscription-Type': 'personal', 'X-CodeMie-Policy-Version': 'v9' });
    expect(getPolicyStateMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', hooksBatch([line('s1')]).byteLength);
  });

  it.each([
    ['protobuf', () => protoPartial(3, 'session_project_conflict'), 'session_project_conflict'],
    ['JSON', () => json({ partialSuccess: { rejectedLogRecords: '3', errorMessage: 'evidence_session_conflict' } }), 'evidence_session_conflict'],
  ])('AC5: an OTLP complete rejection (%s) advances its range with the real reason', async (_n, response, reason) => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logs' ? { project: 'Proj A', cursor: 7, bytes: Buffer.from('logs-bytes') } : null
    );
    fetchMock.mockResolvedValue(response());
    const { forwardSession } = await import('../forwarder.js');
    const { logger } = await import('@/utils/logger.js');
    await forwardSession('s1', false, credentials);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logs', 17, expect.objectContaining({ reason, stream: 'logs', bytes: 10 }));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain(reason);
  });

  it('AC5: partial_success with another message is recorded and advanced once', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logs' ? { project: 'Proj A', cursor: 0, bytes: Buffer.from('abc') } : null
    );
    fetchMock.mockImplementation(async () => protoPartial(1, 'records the analytics storage cannot store were dropped'));
    const { forwardSession } = await import('../forwarder.js');
    const { logger } = await import('@/utils/logger.js');
    await forwardSession('s1', false, credentials);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logs', 3, expect.objectContaining({ stream: 'logs', bytes: 3 }));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain('cannot store');
  });

  it.each([503, 500])('AC5: OTLP %i retains the spool', async (status) => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockResolvedValue({ project: 'Proj A', cursor: 0, bytes: Buffer.from('abc') });
    fetchMock.mockImplementation(async () => new Response('busy', { status }));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('AC4: 409 stale_policy refreshes, re-classifies and resends once', async () => {
    refreshPolicyMock.mockResolvedValue(usable({ organizations: ['Other'], version: 'v2' }));
    fetchMock
      .mockResolvedValueOnce(json({ reason: 'stale_policy', policy_version: 'v2' }, 409))
      .mockResolvedValueOnce(json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(refreshPolicyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ force: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(0)['X-CodeMie-Subscription-Type']).toBe('corporate');
    expect(headersOf(1)).toMatchObject({ 'X-CodeMie-Subscription-Type': 'personal', 'X-CodeMie-Policy-Version': 'v2' });
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(advanceCursorMock).toHaveBeenCalledTimes(1);
  });

  it('AC4: a second 409 after the resend keeps the spool (once only)', async () => {
    refreshPolicyMock.mockResolvedValue(usable({ organizations: ['Other'], version: 'v2' }));
    fetchMock.mockImplementation(async () => json({ reason: 'stale_policy', policy_version: 'v3' }, 409));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('AC4: a failed policy refresh on 409 keeps the spool and does not resend', async () => {
    refreshPolicyMock.mockResolvedValue(usable(policyV1)); // still the stale version: refresh failed
    fetchMock.mockImplementation(async () => json({ reason: 'stale_policy', policy_version: 'v2' }, 409));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('auth-expired is preserved in evidence mode', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 401 }));
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');
    await forwardSession('s1', false, credentials);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(areCredentialsStale()).toBe(true);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('AC10: sends only the verified OTLP prefix byte-for-byte, holds the rest and advances by the prefix', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    const bytes = Buffer.from('0123456789');
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logs' ? { project: 'Proj A', cursor: 5, bytes } : null
    );
    proveRangeMock.mockReturnValue({ verified: 4, hold: 'session_mismatch' });
    noteStreamHoldMock.mockResolvedValue('held');
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(0), { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(proveRangeMock).toHaveBeenCalledWith(bytes, { sessionId: 's1', project: 'Proj A', signal: 'logs' });
    expect(Buffer.from(fetchMock.mock.calls[0][1].body).toString()).toBe('0123');
    expect(isSendAllowedMock).toHaveBeenCalledWith('s1', 'logs', 'Proj A', { cursor: 5, end: 9, filtered: false });
    expect(noteStreamHoldMock).toHaveBeenCalledWith('s1', 'logs', 'session_mismatch');
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logs', 9);
  });

  it('a fully verified OTLP range clears the stream hold; nothing verified sends nothing', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) =>
      stream === 'logs' ? { project: 'Proj A', cursor: 0, bytes: Buffer.from('ab') }
        : stream === 'traces' ? { project: 'Proj A', cursor: 0, bytes: Buffer.from('cd') } : null
    );
    proveRangeMock.mockImplementation((_b: Buffer, o: { signal: string }) =>
      o.signal === 'logs' ? { verified: 2 } : { verified: 0, hold: 'otlp_unparseable' }
    );
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(0), { status: 200 }));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', false, credentials);
    expect(noteStreamHoldMock).toHaveBeenCalledWith('s1', 'logs', null);
    expect(noteStreamHoldMock).toHaveBeenCalledWith('s1', 'traces', 'otlp_unparseable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).not.toHaveBeenCalledWith('s1', 'traces', expect.anything());
  });

  it('AC10: hooks send only the verified line prefix and hold the rest', async () => {
    const good = line('s1');
    snapshotPendingHookRecordsMock.mockResolvedValue(hooksBatch([good, line('other')]));
    noteStreamHoldMock.mockResolvedValue('held');
    fetchMock.mockImplementation(async () => json({}));
    const { forwardSession } = await import('../forwarder.js');
    await forwardSession('s1', true, credentials);
    expect(fetchMock.mock.calls[0][1].body).toBe(`${JSON.parse(good).hookEvent}\n`);
    expect(noteStreamHoldMock).toHaveBeenCalledWith('s1', 'hooks', 'session_mismatch');
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', Buffer.byteLength(good) + 1);
  });
});
