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

describe('groupHookRecords', () => {
  it('groups by lowercased top-level name in first-appearance order, keeping file order and bytes', async () => {
    const { groupHookRecords } = await import('../forwarder.js');
    const events = [
      { type: 't', n: 1, codemie_project_name: 'b' },
      { type: 't', n: 2, codemie_project_name: 'A' },
      { type: 't', n: 3, codemie_project_name: 'B' },
      { type: 't', n: 4 },
      { type: 't', n: 5, codemie_project_name: 'a' },
    ];

    const result = groupHookRecords(events.map(spoolLine), 'A', false);

    expect(result.groups).toEqual([
      { project: 'b', ndjson: `${JSON.stringify(events[0])}\n${JSON.stringify(events[2])}\n` },
      {
        project: 'A',
        ndjson: `${JSON.stringify(events[1])}\n${JSON.stringify(events[3])}\n${JSON.stringify(events[4])}\n`,
      },
    ]);
    expect(result.unsendable).toBe(0);
  });

  it('uses the bound spelling for the bound group even when an event spells it differently first', async () => {
    const { groupHookRecords } = await import('../forwarder.js');

    const result = groupHookRecords([spoolLine({ codemie_project_name: 'proj a' })], 'Proj A', false);

    expect(result.groups.map((g) => g.project)).toEqual(['Proj A']);
  });

  it('puts blank, non-string and raw-only names into the bound group', async () => {
    const { groupHookRecords } = await import('../forwarder.js');
    const events = [
      { type: 't', codemie_project_name: '  ' },
      { type: 't', codemie_project_name: 7 },
      { type: 't', raw: { codemie_project_name: 'B' } },
    ];

    const result = groupHookRecords(events.map(spoolLine), 'A', false);

    expect(result.groups).toEqual([{ project: 'A', ndjson: `${events.map((e) => JSON.stringify(e)).join('\n')}\n` }]);
  });

  it('yields one group headed by the bound project for a filtered batch', async () => {
    const { groupHookRecords } = await import('../forwarder.js');
    const events = [{ codemie_project_name: 'a' }, { codemie_project_name: 'B' }];

    const result = groupHookRecords(events.map(spoolLine), 'A', true);

    expect(result.groups).toEqual([{ project: 'A', ndjson: `${events.map((e) => JSON.stringify(e)).join('\n')}\n` }]);
  });

  it('drops a group whose name cannot be sent as a header and counts it', async () => {
    const { groupHookRecords } = await import('../forwarder.js');
    const events = [{ codemie_project_name: 'Café' }, { codemie_project_name: 'A' }];

    const result = groupHookRecords(events.map(spoolLine), 'A', false);

    expect(result.groups.map((g) => g.project)).toEqual(['A']);
    expect(result.unsendable).toBe(1);
  });

  it('aggregates session end and malformed counts over every group', async () => {
    const { groupHookRecords } = await import('../forwarder.js');

    const result = groupHookRecords(
      ['nope', spoolLine({ type: 'agent.session.end', codemie_project_name: 'B' })],
      'A',
      false
    );

    expect(result.containsSessionEnd).toBe(true);
    expect(result.malformed).toBe(1);
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

  it('warns on a backend drop reason without changing the send result', async () => {
    const { logger } = await import('@/utils/logger.js');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ reason: 'project_context_conflict', dropped: 3 }),
    });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[otlp-forwarder] backend dropped analytics events',
      expect.anything()
    );
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 110);
  });

  it('does not warn for an unlisted reason', async () => {
    const { logger } = await import('@/utils/logger.js');
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ reason: 'something_else' }) });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still finds the reason in a body longer than the read cap', async () => {
    const { logger } = await import('@/utils/logger.js');
    const body = JSON.stringify({ reason: 'project_context_conflict', dropped: 2, pad: 'x'.repeat(10_000) });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => body });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per session and reason within the throttle window', async () => {
    const { logger } = await import('@/utils/logger.js');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ reason: 'project_context_conflict', dropped: 3 }),
    });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await forwardSession('s1', true, credentials);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a stalled response body before advancing the cursor', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => new Promise<string>(() => {}) });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 110);
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

describe('forwardSession (hooks split by project)', () => {
  const eventA1 = { type: 'agent.tool.end', session_id: 's1', codemie_project_name: 'A' };
  const eventB = { type: 'agent.tool.end', session_id: 's1', codemie_project_name: 'B' };
  const unnamed = { type: 'agent.tool.end', session_id: 's1' };
  const eventA2 = { type: 'agent.prompt.submit', session_id: 's1', codemie_project_name: 'a' };
  const batch = (records: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    project: 'A',
    records: records.map(spoolLine),
    cursor: 20,
    byteLength: 300,
    dropped: 0,
    filtered: false,
    ...extra,
  });
  const line = (event: Record<string, unknown>): string => JSON.stringify(event);
  const hookCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/event-hooks'));

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    isSendAllowedMock.mockResolvedValue(true);
    snapshotPendingBytesMock.mockResolvedValue(null);
    snapshotPendingHookRecordsMock.mockResolvedValue(batch([eventA1, eventB, unnamed, eventA2]));
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends one request per project with a matching header and the unmodified lines, then advances once', async () => {
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [[, first], [, second]] = fetchMock.mock.calls;
    expect(first.headers['X-CodeMie-Project']).toBe('A');
    expect(first.body).toBe(`${line(eventA1)}\n${line(unnamed)}\n${line(eventA2)}\n`);
    expect(second.headers['X-CodeMie-Project']).toBe('B');
    expect(second.body).toBe(`${line(eventB)}\n`);
    expect(advanceCursorMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
    expect(advanceCursorMock.mock.invocationCallOrder[0]).toBeGreaterThan(fetchMock.mock.invocationCallOrder[1]);
  });

  it('re-checks every group with its own project and the shared batch range', async () => {
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    const range = { cursor: 20, end: 320, filtered: false };
    expect(isSendAllowedMock).toHaveBeenNthCalledWith(1, 's1', 'hooks', 'A', range);
    expect(isSendAllowedMock).toHaveBeenNthCalledWith(2, 's1', 'hooks', 'B', range);
  });

  it('orders groups by first appearance and keeps case variants in one group', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(
      batch([{ codemie_project_name: 'Beta' }, { codemie_project_name: 'A' }, { codemie_project_name: 'BETA' }])
    );
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock.mock.calls.map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['Beta', 'A']);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      `${line({ codemie_project_name: 'Beta' })}\n${line({ codemie_project_name: 'BETA' })}\n`
    );
  });

  it('stops at a failed group: cursor unchanged and the session not marked ended', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(
      batch([eventA1, { type: 'agent.session.end', session_id: 's1', codemie_project_name: 'B' }, { codemie_project_name: 'C' }])
    );
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValue({ ok: false, status: 500 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(markSessionEndedMock).not.toHaveBeenCalled();
  });

  it('re-sends the accepted group with identical bytes on retry and advances only when all succeed', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValueOnce({ ok: false, status: 500 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    expect(advanceCursorMock).not.toHaveBeenCalled();

    await forwardSession('s1', true, credentials);

    const calls = hookCalls();
    expect(calls).toHaveLength(4);
    expect(calls[2][1].headers['X-CodeMie-Project']).toBe('A');
    expect(calls[2][1].body).toBe(calls[0][1].body);
    expect(calls[3][1].headers['X-CodeMie-Project']).toBe('B');
    expect(calls[3][1].body).toBe(calls[1][1].body);
    expect(advanceCursorMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
  });

  it('marks credentials stale and leaves the cursor when a later group is auth-expired', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValue({ ok: false, status: 401 });
    const { forwardSession } = await import('../forwarder.js');
    const { areCredentialsStale } = await import('../auth-state.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(areCredentialsStale()).toBe(true);
  });

  it('marks the session ended for a session end in a non-bound group, after the cursor advance', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(
      batch([eventA1, { type: 'agent.session.end', session_id: 's1', codemie_project_name: 'B' }])
    );
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(markSessionEndedMock).toHaveBeenCalledWith('s1');
    expect(markSessionEndedMock.mock.invocationCallOrder[0]).toBeGreaterThan(advanceCursorMock.mock.invocationCallOrder[0]);
  });

  it('never posts a group whose name cannot be sent and advances over it', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(batch([eventA1, { codemie_project_name: 'Café' }]));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['X-CodeMie-Project']).toBe('A');
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
  });

  it('advances without a request when every group is unsendable', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(batch([{ codemie_project_name: 'Café' }]));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
  });

  it('sends a sealed batch as one filtered request under the seal project', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(batch([eventA1, eventA2], { filtered: true }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['X-CodeMie-Project']).toBe('A');
    expect(fetchMock.mock.calls[0][1].body).toBe(`${line(eventA1)}\n${line(eventA2)}\n`);
    expect(isSendAllowedMock).toHaveBeenCalledWith('s1', 'hooks', 'A', { cursor: 20, end: 320, filtered: true });
  });

  it('keeps the bound project header and the bytes on every OTLP stream of a split session', async () => {
    snapshotPendingBytesMock.mockImplementation(async (_s: string, stream: string) => ({
      project: 'A',
      cursor: 0,
      bytes: Buffer.from(`${stream}-bytes`),
    }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    const otlp = fetchMock.mock.calls.filter(([url]) => !String(url).endsWith('/event-hooks'));
    expect(hookCalls()).toHaveLength(2);
    expect(otlp.map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'A', 'A']);
    expect(otlp.map(([, init]) => init.body.toString())).toEqual(['logs-bytes', 'metrics-bytes', 'traces-bytes']);
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

  it('omits the project header on an OTLP stream for a non-Latin-1 project name', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(null);
    snapshotPendingBytesMock.mockResolvedValue({ project: 'клиенты/проект', cursor: 0, bytes: Buffer.from('x') });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers['X-CodeMie-Project']).toBeUndefined();
    }
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

  it('warns when an OTLP response reports a project-gate rejection in partial_success', async () => {
    const { logger } = await import('@/utils/logger.js');
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/logs')
        ? { ok: true, status: 200, text: async () => '\x0a\x1c\x08\x03\x12\x18project_context_conflict' }
        : { ok: true, status: 200 }
    );
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', false, credentials);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[otlp-forwarder] backend dropped analytics events',
      expect.objectContaining({})
    );
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'logs', 14);
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
