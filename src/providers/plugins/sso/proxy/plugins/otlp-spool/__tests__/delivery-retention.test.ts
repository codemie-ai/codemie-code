/**
 * Finite retention of unacknowledged deliveries (EPMCDME-16440 AC9): one first-failure clock per pending
 * range, persisted in the session status, spaced by bounded backoff, ending in a recorded loss of exactly
 * that range. Real spool files, lock and forwarder; fetch, the daemon state, auth state and the logger are
 * faked, and only `Date` is faked so file I/O keeps real timers.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
const readStateMock = vi.hoisted(() => vi.fn());

vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  const ext: Record<string, string> = {
    hooks: '.hooks.ndjson', logs: '.otel_logs.bin', metrics: '.otel_metrics.bin', traces: '.otel_traces.bin',
    logsJson: '.otel_logs.ndjson', metricsJson: '.otel_metrics.ndjson', tracesJson: '.otel_traces.ndjson',
  };
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    streamFile: (sessionId: string, stream: string): string => pathJoin(state.root, sessionId + ext[stream]),
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});
vi.mock('../auth-state.js', () => ({ areCredentialsStale: (): boolean => false, markCredentialsStale: vi.fn() }));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SESSION = 'sess-1';
const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };
const T0 = Date.UTC(2026, 10, 3, 9);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const hookLine = (n: number): string =>
  JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A', n }) }) + '\n';

describe('delivery retention', () => {
  const fetchMock = vi.fn();
  const unavailable = (): Response => new Response(JSON.stringify({ detail: 'default_project_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const ok = (url: string): Response =>
    new Response(String(url).includes('event-hooks') ? '{}' : '', { status: 200, headers: { 'content-type': String(url).includes('event-hooks') ? 'application/json' : 'application/x-protobuf' } });

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-retention-'));
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OTLP_HELD_RETENTION_MINUTES;
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    fetchMock.mockReset();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(state.root, { recursive: true, force: true });
  });

  async function modules() {
    const io = await import('../spool-io.js');
    const status = await import('../session-status.js');
    const delivery = await import('../delivery-state.js');
    const { forwardSession } = await import('../forwarder.js');
    return { ...io, ...status, ...delivery, forwardSession };
  }
  const at = (ms: number): void => vi.setSystemTime(T0 + ms);
  const hooksCalls = (): number => fetchMock.mock.calls.filter(([url]) => String(url).includes('event-hooks')).length;

  it('503 with a named reason records a destination_unavailable range once, and waits (no tight loop)', async () => {
    const { appendSpool, forwardSession, readStatus } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementation(async () => unavailable());

    await forwardSession(SESSION, true, credentials as never);
    await forwardSession(SESSION, true, credentials as never); // same instant: backoff, no request
    at(MIN);
    await forwardSession(SESSION, true, credentials as never); // still inside the backoff of the first failure
    expect(hooksCalls()).toBe(1);

    const rec = (await readStatus(SESSION))?.delivery?.hooks;
    expect(rec).toMatchObject({ reason: 'destination_unavailable', detail: 'default_project_unavailable', since: T0, cursor: 0, end: Buffer.byteLength(hookLine(1)), attempts: 1 });
    expect(rec!.nextAt).toBeGreaterThan(T0 + MIN);
  });

  it('backoff is bounded: attempts double but never exceed 30 minutes', async () => {
    const { deliveryBackoffMs } = await import('../spool-config.js');
    expect(deliveryBackoffMs(1)).toBe(2 * MIN);
    expect(deliveryBackoffMs(3)).toBe(8 * MIN);
    expect(deliveryBackoffMs(50)).toBe(30 * MIN);
  });

  it('a changing reason keeps the first-failure age; a proof hold clearing does not reset it', async () => {
    const { appendSpool, forwardSession, readStatus, noteStreamHold } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementationOnce(async () => unavailable());
    await forwardSession(SESSION, true, credentials as never);

    at(10 * MIN);
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
    await forwardSession(SESSION, true, credentials as never);
    await noteStreamHold(SESSION, 'hooks', 'otlp_unparseable');
    await noteStreamHold(SESSION, 'hooks', null); // proof now verifies

    const rec = (await readStatus(SESSION))?.delivery?.hooks;
    expect(rec).toMatchObject({ reason: 'delivery_failed', detail: 'http_500', since: T0, attempts: 2 });
  });

  it('at the retention bound only the failing range is dropped; a later arrival gets its own clock and is then delivered', async () => {
    const { appendSpool, forwardSession, readStatus } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementation(async () => unavailable());
    await forwardSession(SESSION, true, credentials as never);
    const first = Buffer.byteLength(hookLine(1));

    at(DAY - MIN);
    await appendSpool(SESSION, 'hooks', hookLine(2), ['A']); // arrives under the old deadline
    at(DAY + MIN);
    await forwardSession(SESSION, true, credentials as never);

    const after = await readStatus(SESSION);
    expect(after?.lastLoss).toMatchObject({ reason: 'destination_unavailable', detail: 'default_project_unavailable', bytes: first, at: T0 + DAY + MIN });
    expect(after?.cursors.hooks).toBe(first); // the second line was NOT dropped
    expect(after?.delivery?.hooks).toMatchObject({ since: T0 + DAY + MIN, cursor: first, attempts: 1 }); // new data, new clock

    fetchMock.mockImplementation(async (url: string) => ok(url));
    at(DAY + 10 * MIN);
    await forwardSession(SESSION, true, credentials as never);
    const done = await readStatus(SESSION);
    expect(done?.cursors.hooks).toBe(first + Buffer.byteLength(hookLine(2)));
    expect(done?.delivery).toBeUndefined();
  });

  it('expiry is not a session-wide timer: after it, fresh data keeps being retried, not dropped, until its own bound', async () => {
    const { appendSpool, forwardSession, readStatus } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementation(async () => unavailable());
    await forwardSession(SESSION, true, credentials as never);
    at(DAY + MIN);
    await forwardSession(SESSION, true, credentials as never); // expires line 1, nothing else pending
    await appendSpool(SESSION, 'hooks', hookLine(2), ['A']);
    at(DAY + 5 * MIN);
    await forwardSession(SESSION, true, credentials as never);
    at(DAY + 2 * 60 * MIN);
    await forwardSession(SESSION, true, credentials as never);

    const status = await readStatus(SESSION);
    expect(status?.cursors.hooks).toBe(Buffer.byteLength(hookLine(1)));
    expect(status?.delivery?.hooks?.since).toBe(T0 + DAY + 5 * MIN);
  });

  it('an unrelated healthy stream is acknowledged and untouched while hooks expire', async () => {
    const { appendSpool, forwardSession, readStatus } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('event-hooks') ? unavailable() : ok(url)));
    await forwardSession(SESSION, false, credentials as never);
    await appendSpool(SESSION, 'logs', Buffer.from('LL'));
    at(DAY + MIN);
    await forwardSession(SESSION, false, credentials as never);

    const status = await readStatus(SESSION);
    expect(status?.cursors.logs).toBe(2);
    expect(status?.cursors.hooks).toBe(Buffer.byteLength(hookLine(1)));
    expect(status?.lastLoss).toMatchObject({ reason: 'destination_unavailable', bytes: Buffer.byteLength(hookLine(1)) });
  });

  it('the first-failure time survives a daemon restart', async () => {
    let m = await modules();
    await m.appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementation(async () => unavailable());
    await m.forwardSession(SESSION, true, credentials as never);

    vi.resetModules(); // restart: nothing but the status file remains
    m = await modules();
    expect((await m.readStatus(SESSION))?.delivery?.hooks?.since).toBe(T0);
    at(DAY + MIN);
    expect(await m.deliveryGate(SESSION, 'hooks')).toBe('go');
    expect((await m.readStatus(SESSION))?.lastLoss?.reason).toBe('destination_unavailable');
  });

  describe('partial acknowledgement of a failed range', () => {
    const fail = (m: Awaited<ReturnType<typeof modules>>, cursor: number, end: number) =>
      m.noteDeliveryFailure(SESSION, 'logs', { reason: 'delivery_failed', detail: 'request_error' }, { cursor, end });

    it('trims the stored range but keeps since/end: the old remainder keeps its deadline, also across restart', async () => {
      let m = await modules();
      await m.appendSpool(SESSION, 'logs', Buffer.from('AAAA'));
      await fail(m, 0, 4);
      at(5 * MIN);
      await m.advanceCursor(SESSION, 'logs', 2); // [0,2) really acknowledged
      expect((await m.readStatus(SESSION))?.delivery?.logs).toMatchObject({ since: T0, cursor: 2, end: 4 });

      vi.resetModules();
      m = await modules();
      at(DAY + MIN);
      expect(await m.deliveryGate(SESSION, 'logs')).toBe('go');
      const status = await m.readStatus(SESSION);
      expect(status?.cursors.logs).toBe(4);
      expect(status?.lastLoss).toMatchObject({ reason: 'delivery_failed', bytes: 2 }); // only the old remainder
    });

    it('a smaller retry window does not shrink the range or restart its age', async () => {
      const m = await modules();
      await m.appendSpool(SESSION, 'logs', Buffer.from('AAAA'));
      await fail(m, 0, 4);
      await m.advanceCursor(SESSION, 'logs', 2);
      at(10 * MIN);
      await fail(m, 2, 3); // the retry is only 1 byte
      expect((await m.readStatus(SESSION))?.delivery?.logs).toMatchObject({ since: T0, cursor: 2, end: 4, attempts: 2 });
    });

    it('bytes beyond the old end get a fresh deadline when the old remainder expires', async () => {
      const m = await modules();
      await m.appendSpool(SESSION, 'logs', Buffer.from('AAAA'));
      await fail(m, 0, 4);
      await m.advanceCursor(SESSION, 'logs', 2);
      at(DAY - MIN);
      await m.appendSpool(SESSION, 'logs', Buffer.from('BB'));
      at(DAY + MIN);
      await m.deliveryGate(SESSION, 'logs');
      expect((await m.readStatus(SESSION))?.cursors.logs).toBe(4); // BB survives
      await m.noteDeliveryFailure(SESSION, 'logs', { reason: 'delivery_failed' }, { cursor: 4, end: 6 });
      expect((await m.readStatus(SESSION))?.delivery?.logs).toMatchObject({ since: T0 + DAY + MIN, cursor: 4, end: 6 });
    });

    it('reaching or passing end clears the record; a later failure is a new range', async () => {
      const m = await modules();
      await m.appendSpool(SESSION, 'logs', Buffer.from('AAAAAA'));
      await fail(m, 0, 4);
      await m.advanceCursor(SESSION, 'logs', 4);
      expect((await m.readStatus(SESSION))?.delivery).toBeUndefined();
      at(5 * MIN);
      await fail(m, 4, 6);
      expect((await m.readStatus(SESSION))?.delivery?.logs).toMatchObject({ since: T0 + 5 * MIN, cursor: 4, end: 6 });
    });
  });

  it('only the failed range expires, not the backlog queued behind it', async () => {
    const { appendSpool, noteDeliveryFailure, deliveryGate, readStatus } = await modules();
    await appendSpool(SESSION, 'logs', Buffer.from('AABBCC'));
    await noteDeliveryFailure(SESSION, 'logs', { reason: 'delivery_failed' }, { cursor: 0, end: 2 });
    at(DAY + MIN);
    expect(await deliveryGate(SESSION, 'logs')).toBe('go');
    const status = await readStatus(SESSION);
    expect(status?.cursors.logs).toBe(2);
    expect(status?.lastLoss).toMatchObject({ reason: 'delivery_failed', bytes: 2 });
  });

  it('a failure for a range that was acknowledged meanwhile is ignored', async () => {
    const { appendSpool, advanceCursor, noteDeliveryFailure, readStatus } = await modules();
    await appendSpool(SESSION, 'logs', Buffer.from('AAAA'));
    await advanceCursor(SESSION, 'logs', 4);
    expect(await noteDeliveryFailure(SESSION, 'logs', { reason: 'delivery_failed' }, { cursor: 0, end: 4 })).toBe('stale');
    expect((await readStatus(SESSION))?.delivery).toBeUndefined();
  });

  it.each([
    ['400', () => new Response('{"detail":"missing evidence"}', { status: 400 }), 'delivery_rejected', 'http_400'],
    ['413', () => new Response('', { status: 413 }), 'delivery_rejected', 'http_413'],
    ['422', () => new Response('', { status: 422 }), 'delivery_rejected', 'http_422'],
    ['malformed hooks 200', () => new Response('not json', { status: 200 }), 'response_unverified', 'response_malformed'],
    ['5xx', () => new Response('', { status: 502 }), 'delivery_failed', 'http_502'],
  ])('%s stays unacknowledged until the bound, then is lost with its reason and bytes', async (_n, respond, reason, detail) => {
    const { appendSpool, forwardSession, readStatus } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementation(async () => respond());
    await forwardSession(SESSION, true, credentials as never);
    expect((await readStatus(SESSION))?.cursors.hooks).toBe(0);
    expect((await readStatus(SESSION))?.delivery?.hooks).toMatchObject({ reason, detail });

    at(DAY - MIN);
    await forwardSession(SESSION, true, credentials as never);
    expect((await readStatus(SESSION))?.cursors.hooks).toBe(0); // not yet

    at(DAY + MIN);
    await forwardSession(SESSION, true, credentials as never);
    const status = await readStatus(SESSION);
    expect(status?.lastLoss).toMatchObject({ reason, detail, bytes: Buffer.byteLength(hookLine(1)) });
    expect(status?.cursors.hooks).toBe(Buffer.byteLength(hookLine(1)));
  });

  it('a network failure is recorded the same way', async () => {
    const { appendSpool, forwardSession, readStatus } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await forwardSession(SESSION, true, credentials as never);
    expect((await readStatus(SESSION))?.delivery?.hooks).toMatchObject({ reason: 'delivery_failed', detail: 'request_error' });
  });

  it('the existing retention setting bounds it', async () => {
    process.env.OTLP_HELD_RETENTION_MINUTES = '30';
    const { appendSpool, forwardSession, readStatus } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    fetchMock.mockImplementation(async () => unavailable());
    await forwardSession(SESSION, true, credentials as never);
    at(31 * MIN);
    await forwardSession(SESSION, true, credentials as never);
    expect((await readStatus(SESSION))?.lastLoss?.reason).toBe('destination_unavailable');
    delete process.env.OTLP_HELD_RETENTION_MINUTES;
  });

  it('an acknowledged send clears nothing it should not: the old status shape (no delivery) still loads', async () => {
    const { appendSpool, readStatus, deliveryGate } = await modules();
    await appendSpool(SESSION, 'hooks', hookLine(1), ['A']);
    expect((await readStatus(SESSION))?.delivery).toBeUndefined();
    expect(await deliveryGate(SESSION, 'hooks')).toBe('go');
  });
});
