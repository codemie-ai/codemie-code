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

  it('warns once per session, project and reason within the throttle window', async () => {
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

  describe('backend drop warnings', () => {
    const dropBody = JSON.stringify({ accepted: 0, dropped: 3, reason: 'project_context_conflict' });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => dropBody });
    });

    it('warns once per project for the same reason, each warning naming its project', async () => {
      const { logger } = await import('@/utils/logger.js');
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('s1', true, credentials);
      await flush();

      expect(logger.warn).toHaveBeenCalledTimes(2);
      const projects = vi.mocked(logger.warn).mock.calls.map(([, fields]) => (fields as { project: string }).project);
      expect(projects.sort()).toEqual(['A', 'B']);
    });

    it('keeps the throttle per project: a repeat within the window warns for neither', async () => {
      const { logger } = await import('@/utils/logger.js');
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('s1', true, credentials);
      await flush();
      await forwardSession('s1', true, credentials);
      await flush();

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('treats project spellings that differ only in case as one throttle key', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(batch([eventA1, eventA2], { project: 'A' }));
      const { logger } = await import('@/utils/logger.js');
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('s1', true, credentials);
      await flush();
      snapshotPendingHookRecordsMock.mockResolvedValue(batch([{ ...eventA1, codemie_project_name: 'a' }], { project: 'a' }));
      await forwardSession('s1', true, credentials);
      await flush();

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
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

  it('keeps sending the other groups after a failed one: cursor unchanged, session not marked ended', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(
      batch([eventA1, { type: 'agent.session.end', session_id: 's1', codemie_project_name: 'B' }, { codemie_project_name: 'C' }])
    );
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValue({ ok: false, status: 500 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(hookCalls().map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'B', 'C']);
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(markSessionEndedMock).not.toHaveBeenCalled();
  });

  it('delivers a healthy group behind a failing one in the same tick', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => ({
      ok: init.headers['X-CodeMie-Project'] !== 'A',
      status: init.headers['X-CodeMie-Project'] === 'A' ? 500 : 200,
    }));
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(hookCalls().map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'B']);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('sends only the open group on the next tick and advances when it succeeds', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValueOnce({ ok: false, status: 500 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    expect(advanceCursorMock).not.toHaveBeenCalled();

    await forwardSession('s1', true, credentials);

    const calls = hookCalls();
    expect(calls).toHaveLength(3);
    expect(calls[2][1].headers['X-CodeMie-Project']).toBe('B');
    expect(calls[2][1].body).toBe(calls[1][1].body);
    expect(advanceCursorMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
  });

  it('sends an accepted group again when its events changed', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValueOnce({ ok: false, status: 500 });
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    snapshotPendingHookRecordsMock.mockResolvedValue(batch([eventA1, eventB, eventA2], { byteLength: 400 }));
    await forwardSession('s1', true, credentials);

    expect(hookCalls().map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'B', 'A', 'B']);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 420);
  });

  it('forgets the accepted groups once the cursor has advanced', async () => {
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);
    await forwardSession('s1', true, credentials);

    expect(hookCalls()).toHaveLength(4);
    expect(advanceCursorMock).toHaveBeenCalledTimes(2);
  });

  describe('a group that keeps failing', () => {
    const failB = (): void => {
      fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) =>
        init.headers['X-CodeMie-Project'] === 'B' ? { ok: false, status: 500 } : { ok: true, status: 200 }
      );
    };
    const withSessionEnd = () =>
      batch([eventA1, { type: 'agent.session.end', session_id: 's1', codemie_project_name: 'B' }]);

    it('holds the range back for the first four failures, then consumes the group and advances', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(withSessionEnd());
      failB();
      const { forwardSession } = await import('../forwarder.js');
      const { logger } = await import('@/utils/logger.js');

      for (let tick = 0; tick < 4; tick++) {
        await forwardSession('s1', true, credentials);
      }
      expect(advanceCursorMock).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();

      await forwardSession('s1', true, credentials);

      expect(advanceCursorMock).toHaveBeenCalledTimes(1);
      expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
      expect(logger.warn).toHaveBeenCalledWith(
        '[otlp-forwarder] hook record group dropped after repeated failures',
        expect.anything()
      );
    });

    it('does not send the accepted group again while it waits', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(withSessionEnd());
      failB();
      const { forwardSession } = await import('../forwarder.js');

      for (let tick = 0; tick < 5; tick++) {
        await forwardSession('s1', true, credentials);
      }

      const sent = hookCalls().map(([, init]) => init.headers['X-CodeMie-Project']);
      expect(sent.filter((project) => project === 'A')).toHaveLength(1);
      expect(sent.filter((project) => project === 'B')).toHaveLength(5);
    });

    it('does not mark the session ended for a session end held by the consumed group', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(withSessionEnd());
      failB();
      const { forwardSession } = await import('../forwarder.js');

      for (let tick = 0; tick < 5; tick++) {
        await forwardSession('s1', true, credentials);
      }

      expect(advanceCursorMock).toHaveBeenCalledTimes(1);
      expect(markSessionEndedMock).not.toHaveBeenCalled();
    });

    it('restarts the count after a success', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(withSessionEnd());
      const { forwardSession } = await import('../forwarder.js');

      failB();
      for (let tick = 0; tick < 4; tick++) {
        await forwardSession('s1', true, credentials);
      }
      fetchMock.mockReset();
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      await forwardSession('s1', true, credentials);

      expect(advanceCursorMock).toHaveBeenCalledTimes(1);
      expect(markSessionEndedMock).toHaveBeenCalledWith('s1');
    });

    it('never puts the project name in the warning', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(withSessionEnd());
      failB();
      const { forwardSession } = await import('../forwarder.js');
      const { logger } = await import('@/utils/logger.js');

      for (let tick = 0; tick < 5; tick++) {
        await forwardSession('s1', true, credentials);
      }

      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('"B"');
    });
  });

  describe('401/403 on a hooks group', () => {
    it('marks credentials stale and stops when the first group is auth-expired', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      const { forwardSession } = await import('../forwarder.js');
      const { areCredentialsStale } = await import('../auth-state.js');

      await forwardSession('s1', true, credentials);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(advanceCursorMock).not.toHaveBeenCalled();
      expect(areCredentialsStale()).toBe(true);
    });

    it('treats it as that group failing, not as expired credentials, after an accepted group', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValue({ ok: false, status: 403 });
      const { forwardSession } = await import('../forwarder.js');
      const { areCredentialsStale } = await import('../auth-state.js');

      await forwardSession('s1', true, credentials);

      expect(areCredentialsStale()).toBe(false);
      expect(advanceCursorMock).not.toHaveBeenCalled();
      expect(hookCalls().map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'B', 'B']);
    });
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

  describe('warning about unsendable groups', () => {
    const unsendable = { type: 'agent.tool.end', session_id: 's1', codemie_project_name: 'Café' };
    const warnCalls = async (): Promise<unknown[][]> => {
      const { logger } = await import('@/utils/logger.js');
      return vi.mocked(logger.warn).mock.calls.filter(([message]) => String(message).includes('cannot be sent'));
    };

    it('warns once per session, with the session id and the group count', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(batch([eventA1, unsendable]));
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('sess-warn-1', true, credentials);
      await forwardSession('sess-warn-1', true, credentials);

      const calls = await warnCalls();
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0])).toContain('"sessionId":"sess-warn-1"');
      expect(JSON.stringify(calls[0])).toContain('"count":1');
    });

    it('warns again for another session', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(batch([unsendable]));
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('sess-warn-2', true, credentials);
      await forwardSession('sess-warn-3', true, credentials);

      expect(await warnCalls()).toHaveLength(2);
    });

    it('never puts the project name in a log argument', async () => {
      const secretLike = 'sk-secret\u0007token Café';
      snapshotPendingHookRecordsMock.mockResolvedValue(
        batch([eventA1, { ...unsendable, codemie_project_name: secretLike }])
      );
      const { forwardSession } = await import('../forwarder.js');
      const { logger } = await import('@/utils/logger.js');

      await forwardSession('sess-warn-4', true, credentials);

      expect(await warnCalls()).toHaveLength(1);
      const logged = JSON.stringify(
        [logger.debug, logger.info, logger.warn, logger.error].map((fn) => vi.mocked(fn).mock.calls)
      );
      expect(logged).not.toContain('secret');
      expect(logged).not.toContain('Caf');
    });

    it('does not warn when no group is dropped', async () => {
      snapshotPendingHookRecordsMock.mockResolvedValue(batch([eventA1]));
      const { forwardSession } = await import('../forwarder.js');

      await forwardSession('sess-warn-5', true, credentials);

      expect(await warnCalls()).toHaveLength(0);
    });
  });

  it('does not mark the session ended for a session end held only by an unsent group', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(
      batch([eventA1, { type: 'agent.session.end', session_id: 's1', codemie_project_name: 'Café' }])
    );
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
    expect(markSessionEndedMock).not.toHaveBeenCalled();
  });

  it('marks the session ended after advancing when every group is unsent and one held the session end', async () => {
    snapshotPendingHookRecordsMock.mockResolvedValue(
      batch([{ type: 'agent.session.end', session_id: 's1', codemie_project_name: 'Café' }])
    );
    const { forwardSession } = await import('../forwarder.js');

    await forwardSession('s1', true, credentials);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', 320);
    expect(markSessionEndedMock).toHaveBeenCalledWith('s1');
    expect(markSessionEndedMock.mock.invocationCallOrder[0]).toBeGreaterThan(advanceCursorMock.mock.invocationCallOrder[0]);
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
