/**
 * EPMCDME-16776 R3 / AC9: bytes handed over from the owner-pending queue keep their ORIGINAL first-failure age in the
 * real spool delivery and hold lifecycle (single finite window, not reset by the handover or by a changed reason).
 * Real: pending store, replay, spool files, session status, forwarder/tick-processor, delivery-state; a daemon restart is
 * simulated by resetting modules. Faked: fetch, daemon state, auth state, logger and `Date` only.
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

const SESSION = 'sess-r3';
const API = 'https://api.example.com/code-assistant-api';
const credentials = { cookies: { _oauth2_proxy: 'cookie-A' }, apiUrl: API, email: 'a@example.com' };
const T0 = Date.UTC(2026, 10, 3, 9);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const hookEvent = (n: number) => ({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A', event_id: `e${n}`, n });
const rawLine = (n: number): string => JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(hookEvent(n)), evidence_v: 1 }) + '\n';

describe('owner-pending handover keeps the original age', () => {
  const fetchMock = vi.fn();
  const unavailable = (): Response => new Response(JSON.stringify({ detail: 'default_project_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
  let home = '';
  const priorHome = process.env.CODEMIE_HOME;

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-r3-'));
    home = await mkdtemp(join(tmpdir(), 'otlp-r3-home-'));
    process.env.CODEMIE_HOME = home;
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OTLP_HELD_RETENTION_MINUTES;
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
  const at = (ms: number): void => vi.setSystemTime(T0 + ms);

  async function holdAtT0(d: Awaited<ReturnType<typeof daemon>>): Promise<void> {
    const fields = {
      session_id: SESSION, launch_mode: 'native' as const, routed_via_codemie: false, routing_proof: 'unproven' as const,
      project: 'A', project_source: 'none' as const, api_identity: d.apiIdentity(API),
    };
    const ok = await d.enqueuePendingOwner({
      fp: d.credentialFingerprint(credentials), agentName: 'claude-code-otlp', api_identity: d.apiIdentity(API),
      session_id: SESSION, fields, events: [hookEvent(1)],
    }, T0);
    expect(ok).toBe(true);
  }

  it('queue at t0, recover just before the deadline, destination unavailable, restart: the ORIGINAL range expires, newer data keeps its own window', async () => {
    let d = await daemon();
    await holdAtT0(d);

    at(DAY - MIN); // owner lookup recovers one minute before the deadline
    await d.processPendingOwner(credentials as never, T0 + DAY - MIN);
    const replayed = (await d.readStatus(SESSION))!;
    expect(replayed.carriedAge?.hooks).toEqual([expect.objectContaining({ start: 0, since: T0 })]);
    const handedOver = replayed.carriedAge!.hooks![0].end;

    await d.appendSpool(SESSION, 'hooks', rawLine(2), ['A']); // newer data after the handover: its own window
    fetchMock.mockImplementation(async () => unavailable());
    await d.forwardSession(SESSION, true, credentials as never);
    const rec = (await d.readStatus(SESSION))!.delivery!.hooks!;
    expect(rec).toMatchObject({ reason: 'destination_unavailable', since: T0, cursor: 0, end: handedOver }); // age carried, scope = handed-over bytes
    const callsBefore = fetchMock.mock.calls.length;

    // daemon restart; time passes the ORIGINAL deadline
    d = await daemon();
    at(DAY + MIN);
    await d.forwardSession(SESSION, true, credentials as never);
    const after = (await d.readStatus(SESSION))!;
    expect(after.lastLoss).toMatchObject({ reason: 'destination_unavailable', bytes: handedOver });
    expect(after.cursors.hooks).toBe(handedOver); // only the handed-over range was dropped
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore); // the newer range was still attempted
    expect(after.delivery?.hooks).toMatchObject({ since: T0 + DAY + MIN, cursor: handedOver }); // own, fresh window
  });

  it('a failure reason that changes does not restart the carried clock', async () => {
    const d = await daemon();
    await holdAtT0(d);
    at(DAY - 2 * MIN);
    await d.processPendingOwner(credentials as never, T0 + DAY - 2 * MIN);

    fetchMock.mockImplementation(async () => unavailable());
    await d.forwardSession(SESSION, true, credentials as never);
    at(DAY - MIN);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    await d.forwardSession(SESSION, true, credentials as never);
    expect((await d.readStatus(SESSION))!.delivery?.hooks?.since).toBe(T0);
  });

  it('unrelated bytes (no handover) are untouched: a plain append gets no carried age', async () => {
    const d = await daemon();
    await d.appendSpool(SESSION, 'hooks', rawLine(9), ['A']);
    expect((await d.readStatus(SESSION))!.carriedAge).toBeUndefined();
  });

  it('a session hold (no evidence record) is measured from the carried age: lost, named, at the original deadline', async () => {
    const d = await daemon();
    // handed-over bytes whose evidence record is not there (e.g. evicted): the hold must not start a fresh window
    await d.appendSpool(SESSION, 'hooks', rawLine(1), ['A'], T0);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

    at(DAY + MIN);
    await d.processSessionTick(SESSION, credentials as never);
    const status = (await d.readStatus(SESSION))!;
    expect(status.lastLoss).toMatchObject({ reason: 'stamp_invalid' }); // named: the evidence record is gone
    expect(status.lastLoss!.bytes).toBeGreaterThan(0);
    expect(status.holds?.session).toBeUndefined();
  });

  it('control: the same hold without a carried age starts a fresh window (held, nothing lost)', async () => {
    const d = await daemon();
    await d.appendSpool(SESSION, 'hooks', rawLine(1), ['A']);
    at(DAY + MIN);
    await d.processSessionTick(SESSION, credentials as never);
    const status = (await d.readStatus(SESSION))!;
    expect(status.lastLoss).toBeUndefined();
    expect(status.holds?.session).toMatchObject({ since: T0 + DAY + MIN });
  });
});
