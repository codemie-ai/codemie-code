/**
 * Tests for `forwardOtlpEventsToSpool`: sends one hook invocation's events as a single
 * batch to the local proxy daemon, and reports success as a plain boolean (true only for
 * a 2xx response) so the caller's commit decision can depend on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readStateMock = vi.fn();
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { forwardOtlpEventsToSpool } = await import('../utils.js');

const DAEMON_STATE = { url: 'http://127.0.0.1:9999', gatewayKey: 'gw-key' };

describe('forwardOtlpEventsToSpool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    readStateMock.mockReset();
    readStateMock.mockResolvedValue(DAEMON_STATE);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true without touching the network for an empty event list', async () => {
    const result = await forwardOtlpEventsToSpool([], 'claude-code-otlp');
    expect(result).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CR001: an evidence loss report is posted with no events; without it an empty list still sends nothing', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    const ok = await forwardOtlpEventsToSpool([], 'claude-code-otlp', { evidenceLoss: { sessionId: 's1', reason: 'unavailable', events: 2 } });
    expect(ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ hookEvents: [], evidence_loss: { session_id: 's1', reason: 'unavailable', events: 2 } });
  });

  it('POSTs one batch body with every event and the gateway key, and returns true on 2xx', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    const events = [{ type: 'agent.usage.request' }, { type: 'agent.session.summary' }];

    const result = await forwardOtlpEventsToSpool(events, 'claude-code-otlp');

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/v1/analytics/hooks');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer gw-key');
    expect(JSON.parse(init.body as string)).toEqual({ agentName: 'claude-code-otlp', hookEvents: events });
  });

  it('CR008: the serialized body carries evidence_v: 1 exactly when the caller stamped, and no such key otherwise', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    const events = [{ type: 'agent.session.start' }];
    const bodyOf = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string) as Record<string, unknown>;

    await forwardOtlpEventsToSpool(events, 'claude-code-otlp', { evidenceV: 1 });
    expect(bodyOf()).toEqual({ agentName: 'claude-code-otlp', hookEvents: events, evidence_v: 1 });

    await forwardOtlpEventsToSpool(events, 'claude-code-otlp', {});
    expect(Object.keys(bodyOf())).not.toContain('evidence_v');
    await forwardOtlpEventsToSpool(events, 'claude-code-otlp');
    expect(Object.keys(bodyOf())).not.toContain('evidence_v');
  });

  it('returns false for a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    const result = await forwardOtlpEventsToSpool([{ type: 'x' }], 'claude-code-otlp');
    expect(result).toBe(false);
  });

  it('returns false when the daemon is unavailable, without calling fetch', async () => {
    readStateMock.mockResolvedValue(null);
    const result = await forwardOtlpEventsToSpool([{ type: 'x' }], 'claude-code-otlp');
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false and never throws when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(forwardOtlpEventsToSpool([{ type: 'x' }], 'claude-code-otlp')).resolves.toBe(false);
  });

  it('EPMCDME-17854: flags a batch as undelivered only when no daemon state or a refused connection proves nothing was sent (a reset, 5xx or timeout may follow a spool)', async () => {
    const flag = () => ({ value: false });
    const noState = flag();
    readStateMock.mockResolvedValueOnce(null);
    await forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: noState });
    const refused = flag();
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }));
    await forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: refused });
    const reset = flag();
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read'), { code: 'ECONNRESET' }) }));
    await forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: reset });
    const rejected = flag();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: rejected });
    const aborted = flag();
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: aborted });

    expect([noState.value, refused.value, reset.value, rejected.value, aborted.value]).toEqual([true, true, false, false, false]);
  });

  it('EPMCDME-17854: a 401 (gateway key, or a daemon awaiting its login) is answered before anything is spooled, so the daemon did not take the batch', async () => {
    const rejected = { value: false };
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: rejected })).resolves.toBe(false);
    expect(rejected.value).toBe(true);
  });

  it('EPMCDME-17854: refusals of every address of a multi-address host count as refused; a mixed outcome does not', async () => {
    const refusedAt = (code: string) => Object.assign(new Error('connect'), { code });
    const aggregate = (errors: Error[], code?: string) => Object.assign(new AggregateError(errors, 'all failed'), code ? { code } : {});
    const run = async (cause: Error): Promise<boolean> => {
      const flag = { value: false };
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause }));
      await forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: flag });
      return flag.value;
    };
    expect(await run(aggregate([refusedAt('ECONNREFUSED'), refusedAt('ECONNREFUSED')], 'ECONNREFUSED'))).toBe(true); // Node 24 shape
    expect(await run(aggregate([refusedAt('ECONNREFUSED'), refusedAt('ECONNREFUSED')]))).toBe(true); // code only on the members
    expect(await run(aggregate([refusedAt('ECONNREFUSED'), refusedAt('ETIMEDOUT')]))).toBe(false);
  });

  it('EPMCDME-17854: the error real fetch raises for a closed IPv4 loopback port is recognised as refused', async () => {
    // Only the literal IPv4 address: how `localhost` resolves (IPv6 first, several addresses) depends on the host, and that
    // multi-address shape is covered deterministically by the AggregateError cases above.
    const { createServer } = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = server.address() as { port: number };
        server.close(() => resolve(free)); // closed again: nothing listens
      });
    });
    vi.unstubAllGlobals(); // the real fetch
    readStateMock.mockResolvedValueOnce({ url: `http://127.0.0.1:${port}`, gatewayKey: 'gw-key' });
    const flag = { value: false };
    await expect(forwardOtlpEventsToSpool([{ type: 'x' }], 'a', { undelivered: flag })).resolves.toBe(false);
    expect(flag.value).toBe(true);
  });

  it('aborts and returns false after the fixed 3s timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const pending = forwardOtlpEventsToSpool([{ type: 'x' }], 'claude-code-otlp');
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBe(false);
    vi.useRealTimers();
  });
});
