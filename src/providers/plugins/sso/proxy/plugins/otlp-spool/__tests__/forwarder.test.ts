import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const snapshotPendingHookRecordsMock = vi.fn();
const snapshotPendingBytesMock = vi.fn();
const snapshotPendingNdjsonRecordsMock = vi.fn();
const advanceCursorMock = vi.fn();
const markSessionEndedMock = vi.fn();
const isSendAllowedMock = vi.fn();
const readStateMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../spool-io.js', () => ({
  snapshotPendingHookRecords: snapshotPendingHookRecordsMock,
  snapshotPendingBytes: snapshotPendingBytesMock,
  snapshotPendingNdjsonRecords: snapshotPendingNdjsonRecordsMock,
  isSendAllowed: isSendAllowedMock,
}));
vi.mock('../session-status.js', () => ({
  advanceCursor: advanceCursorMock,
  markSessionEnded: markSessionEndedMock,
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
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/v1/analytics/cli-analytics/event-hooks');
    expect(init.body).toBe(`${JSON.stringify({ type: 'agent.session.end', session_id: 's1' })}\n`);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 110);
    expect(markSessionEndedMock).toHaveBeenCalledWith('s1');
  });

  it('retries once on 401 and succeeds', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValueOnce({ ok: true, status: 200 });
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
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
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
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
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
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
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
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
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

    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 10);
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
      expect(advanceCursorMock).toHaveBeenLastCalledWith('s1', 'logsJson', byteEnd(r1, r2, r3));
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
