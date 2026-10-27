import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const snapshotPendingHookRecordsMock = vi.fn();
const snapshotPendingBytesMock = vi.fn();
const advanceCursorMock = vi.fn();
const markSessionEndedMock = vi.fn();
const isSendAllowedMock = vi.fn();
const readStateMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../spool-io.js', () => ({
  snapshotPendingHookRecords: snapshotPendingHookRecordsMock,
  snapshotPendingBytes: snapshotPendingBytesMock,
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
});
