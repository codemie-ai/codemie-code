/**
 * EPMCDME-16776 R3 / AC9: bytes handed over from the owner-pending queue keep their ORIGINAL age as an exact byte range in
 * the real spool delivery/hold lifecycle: only that range expires at its deadline; younger, unrelated and other-stream bytes
 * keep their own windows. Real: pending store, replay, spool files, session status, forwarder/tick-processor, delivery-state;
 * a daemon restart is simulated by resetting modules. Faked: fetch, daemon state, auth state, logger and `Date` only.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
const readStateMock = vi.hoisted(() => vi.fn());
const stale = vi.hoisted(() => ({ value: false }));

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
vi.mock('../auth-state.js', () => ({ areCredentialsStale: (): boolean => stale.value, markCredentialsStale: vi.fn() }));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SESSION = 'sess-r3';
const API = 'https://api.example.com/code-assistant-api';
const credentials = { cookies: { _oauth2_proxy: 'cookie-A' }, apiUrl: API, email: 'a@example.com' };
const T0 = Date.UTC(2026, 10, 3, 9);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const hookEvent = (n: number) => ({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A', event_id: `e${n}`, n });
const rawLine = (n: number): string => JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(hookEvent(n)), evidence_v: 1 }) + '\n';

describe('owner-pending handover keeps the original age as an exact range', () => {
  const fetchMock = vi.fn();
  const unavailable = (): Response => new Response(JSON.stringify({ detail: 'default_project_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const ok200 = (): Response => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  let home = '';
  const priorHome = process.env.CODEMIE_HOME;

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-r3-'));
    home = await mkdtemp(join(tmpdir(), 'otlp-r3-home-'));
    process.env.CODEMIE_HOME = home;
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OTLP_HELD_RETENTION_MINUTES;
    stale.value = false;
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: API, syncApiUrl: API });
    fetchMock.mockReset();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (priorHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = priorHome;
    await rm(state.root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  /** Fresh module graph = a restarted daemon: only files on disk survive. */
  async function daemon() {
    vi.resetModules();
    const store = await import('@/agents/core/evidence/owner-pending.js');
    const { credentialFingerprint } = await import('@/providers/core/credential-owner.js');
    const { apiIdentity } = await import('@/agents/core/evidence/api-identity.js');
    const replay = await import('../owner-pending-replay.js');
    const io = await import('../spool-io.js');
    const status = await import('../session-status.js');
    const { forwardSession } = await import('../forwarder.js');
    const { processSessionTick } = await import('../tick-processor.js');
    return { ...store, ...replay, ...io, ...status, forwardSession, processSessionTick, credentialFingerprint, apiIdentity };
  }
  type Daemon = Awaited<ReturnType<typeof daemon>>;
  const at = (ms: number): void => vi.setSystemTime(T0 + ms);
  const hooksSize = async (): Promise<number> => (await stat(join(state.root, SESSION + '.hooks.ndjson'))).size;
  const queued = async (): Promise<number> => {
    let n = 0;
    const base = join(home, 'analytics', 'state', 'owner-pending');
    for (const dir of await readdir(base).catch(() => [] as string[])) {
      n += (await readdir(join(base, dir)).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).length;
    }
    return n;
  };

  async function holdAtT0(d: Daemon): Promise<void> {
    const fields = {
      session_id: SESSION, launch_mode: 'native' as const, routed_via_codemie: false, routing_proof: 'unproven' as const,
      project: 'A', project_source: 'none' as const, api_identity: d.apiIdentity(API),
    };
    const stored = await d.enqueuePendingOwner({
      fp: d.credentialFingerprint(credentials), agentName: 'claude-code-otlp', api_identity: d.apiIdentity(API),
      session_id: SESSION, fields, events: [hookEvent(1)],
    }, T0);
    expect(stored).toBe(true);
  }
  const freshOtherStreams = async (d: Daemon): Promise<void> => {
    await d.appendSpool(SESSION, 'logs', Buffer.from('fresh-log-bytes'));
    await d.appendSpool(SESSION, 'metrics', Buffer.from('fresh-metric-bytes'));
  };

  it('queue at t0, recover before the deadline, 503, restart: ONLY the handed-over range expires; the newer tail keeps its own window', async () => {
    let d = await daemon();
    await holdAtT0(d);
    at(DAY - MIN);
    await d.processPendingOwner(credentials as never, T0 + DAY - MIN);
    const handedOver = (await d.readStatus(SESSION))!.carriedAge!.hooks![0].end;
    await d.appendSpool(SESSION, 'hooks', rawLine(2), ['A']);
    fetchMock.mockImplementation(async () => unavailable());
    await d.forwardSession(SESSION, true, credentials as never);
    expect((await d.readStatus(SESSION))!.delivery!.hooks).toMatchObject({ reason: 'destination_unavailable', since: T0 + DAY - MIN, cursor: 0 });

    d = await daemon(); // restart; past the ORIGINAL deadline
    at(DAY + MIN);
    await d.forwardSession(SESSION, true, credentials as never);
    const after = (await d.readStatus(SESSION))!;
    expect(after.lastLoss).toMatchObject({ reason: 'destination_unavailable', bytes: handedOver });
    expect(after.cursors.hooks).toBe(handedOver);
    expect(after.carriedAge).toBeUndefined();
    expect(after.delivery?.hooks).toMatchObject({ since: T0 + DAY - MIN, cursor: handedOver }); // tail: own clock, neither reset nor inherited
  });

  it('mixed prefix: a fresh normal hook ahead of a queued older event defers the replay; the prefix never expires early and the entry keeps its own deadline', async () => {
    let d = await daemon();
    await holdAtT0(d);
    at(DAY - 2 * MIN);
    await d.appendSpool(SESSION, 'hooks', rawLine(7), ['A']); // first successful hook after recovery lands before the daemon replay
    const sizeBefore = await hooksSize();
    await d.processPendingOwner(credentials as never, T0 + DAY - 2 * MIN);
    expect(await hooksSize()).toBe(sizeBefore); // replay deferred: nothing behind the normal prefix
    expect(await queued()).toBe(1);
    expect((await d.readStatus(SESSION))!.carriedAge).toBeUndefined();

    fetchMock.mockImplementation(async () => unavailable());
    await d.forwardSession(SESSION, true, credentials as never); // the prefix fails
    d = await daemon();
    at(DAY + MIN); // the ORIGINAL deadline has passed
    await d.processPendingOwner(credentials as never, T0 + DAY + MIN);
    const after = (await d.readStatus(SESSION))!;
    expect(after.cursors.hooks).toBe(0); // the normal prefix was not expired by the older entry's age
    expect(after.lastLoss).toBeUndefined();
    expect(await queued()).toBe(0); // the aged entry itself expired (owner_unresolved_expired), nothing was appended
    expect(await hooksSize()).toBe(sizeBefore);
  });

  it('mixed prefix, drained: once the prefix is acknowledged the older event is handed over and keeps its original age', async () => {
    const d = await daemon();
    await holdAtT0(d);
    at(DAY - 2 * MIN);
    await d.appendSpool(SESSION, 'hooks', rawLine(7), ['A']);
    await d.processPendingOwner(credentials as never, T0 + DAY - 2 * MIN);
    const status = (await d.readStatus(SESSION))!;
    status.cursors.hooks = await hooksSize(); // prefix acknowledged
    await d.writeStatus(SESSION, status);
    await d.processPendingOwner(credentials as never, T0 + DAY - 2 * MIN);
    expect(await queued()).toBe(0);
    expect((await d.readStatus(SESSION))!.carriedAge!.hooks).toEqual([expect.objectContaining({ since: T0 })]);
  });

  it.each(['session hold', 'endpoint mismatch'])('%s: at the carried deadline only the carried hook bytes are dropped; fresh hooks/logs/metrics keep their own windows', async (kind) => {
    const d = await daemon();
    await d.appendSpool(SESSION, 'hooks', rawLine(1), ['A'], T0); // carried; evidence record missing / endpoint wrong
    const carriedEnd = (await d.readStatus(SESSION))!.carriedAge!.hooks![0].end;
    at(DAY - MIN);
    await d.appendSpool(SESSION, 'hooks', rawLine(2), ['A']); // fresh hook behind the carried one
    await freshOtherStreams(d);
    if (kind === 'endpoint mismatch') readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://other.example.com/x', syncApiUrl: 'https://other.example.com/x' });
    fetchMock.mockImplementation(async () => ok200());
    await d.processSessionTick(SESSION, credentials as never); // the hold on the fresh data starts here
    const heldSince = (await d.readStatus(SESSION))!.holds?.session?.since;
    expect(heldSince).toBe(T0 + DAY - MIN);

    at(DAY + MIN);
    await d.processSessionTick(SESSION, credentials as never);
    const status = (await d.readStatus(SESSION))!;
    expect(status.lastLoss).toMatchObject({ bytes: carriedEnd });
    expect(status.cursors.hooks).toBe(carriedEnd); // the fresh hook is still pending
    expect(status.cursors.logs ?? 0).toBe(0);
    expect(status.cursors.metrics ?? 0).toBe(0);
    expect(status.holds?.session?.since).toBe(heldSince); // unrelated data keeps its own hold clock
    expect(status.carriedAge).toBeUndefined();
  });

  it('stale credentials: the carried range still expires at its own deadline through the tick; younger bytes stay and nothing is sent', async () => {
    const d = await daemon();
    await d.appendSpool(SESSION, 'hooks', rawLine(1), ['A'], T0); // carried, original age T0
    const carriedEnd = (await d.readStatus(SESSION))!.carriedAge!.hooks![0].end;
    at(DAY - MIN);
    await d.appendSpool(SESSION, 'hooks', rawLine(2), ['A']); // younger hook behind it
    await freshOtherStreams(d);

    stale.value = true;
    at(DAY + MIN);
    await d.processSessionTick(SESSION, credentials as never);

    const status = (await d.readStatus(SESSION))!;
    expect(status.cursors.hooks).toBe(carriedEnd); // exactly the expired segment; the younger hook is still pending
    expect(carriedEnd).toBeLessThan(await hooksSize());
    expect(status.lastLoss).toMatchObject({ reason: 'no_evidence_timeout', bytes: carriedEnd });
    expect(status.carriedAge).toBeUndefined();
    expect(status.cursors.logs ?? 0).toBe(0);
    expect(status.cursors.metrics ?? 0).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stale credentials, before the deadline: nothing expires', async () => {
    const d = await daemon();
    await d.appendSpool(SESSION, 'hooks', rawLine(1), ['A'], T0);
    stale.value = true;
    at(DAY - MIN);
    await d.processSessionTick(SESSION, credentials as never);
    const status = (await d.readStatus(SESSION))!;
    expect(status.cursors.hooks).toBe(0);
    expect(status.lastLoss).toBeUndefined();
    expect(status.carriedAge!.hooks).toHaveLength(1);
  });

  it('cap: 65 small adjacent handovers are never merged; the 65th stays queued until the head is acknowledged', async () => {
    const d = await daemon();
    let accepted = 0;
    for (let n = 0; n < 65; n++) {
      at(n * 1000);
      if (await d.appendSpool(SESSION, 'hooks', rawLine(n), ['A'], T0 + n * 1000)) accepted++;
    }
    const st = (await d.readStatus(SESSION))!;
    expect(accepted).toBe(64);
    expect(st.carriedAge!.hooks).toHaveLength(64);
    expect(new Set(st.carriedAge!.hooks!.map((x) => x.since)).size).toBe(64); // distinct clocks, none merged
    st.cursors.hooks = await hooksSize(); // everything pending acknowledged
    await d.writeStatus(SESSION, st);
    expect(await d.appendSpool(SESSION, 'hooks', rawLine(64), ['A'], T0 + 64_000)).toBe(true);
    const last = (await d.readStatus(SESSION))!.carriedAge!.hooks!;
    expect(last).toEqual([expect.objectContaining({ since: T0 + 64_000 })]);
  });

  it('recovery after a crash window: the surviving queue entry replays again with the same event_id and its original age', async () => {
    let d = await daemon();
    await holdAtT0(d);
    at(DAY - MIN);
    await d.processPendingOwner(credentials as never, T0 + DAY - MIN);
    const lines = (await readFile(join(state.root, SESSION + '.hooks.ndjson'), 'utf8')).trim().split('\n');
    expect(JSON.parse(JSON.parse(lines[0]).hookEvent).event_id).toBe('e1');
    expect((await d.readStatus(SESSION))!.carriedAge!.hooks![0]).toMatchObject({ start: 0, since: T0 });

    // the crash: bytes + age are on disk, but the queue file was not renamed -> it is still queued
    d = await daemon();
    await holdAtT0(d);
    await d.processPendingOwner(credentials as never, T0 + DAY - MIN + 1000);
    const twice = (await readFile(join(state.root, SESSION + '.hooks.ndjson'), 'utf8')).trim().split('\n');
    expect(twice.map((l) => JSON.parse(JSON.parse(l).hookEvent).event_id)).toEqual(['e1', 'e1']); // duplicate copy, identical event_id (backend dedupes by identity)
    expect((await d.readStatus(SESSION))!.carriedAge!.hooks!.map((x) => x.since)).toEqual([T0, T0]); // age present for both copies
    expect(await queued()).toBe(0);
  });

  it('a plain append gets no carried age', async () => {
    const d = await daemon();
    await d.appendSpool(SESSION, 'hooks', rawLine(9), ['A']);
    expect((await d.readStatus(SESSION))!.carriedAge).toBeUndefined();
  });
});
