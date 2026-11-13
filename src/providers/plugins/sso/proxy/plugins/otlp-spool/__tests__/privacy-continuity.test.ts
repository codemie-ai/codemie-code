/**
 * Privacy continuity through the real spool: (1) a recorded session without a frozen generation is suspended on every send path
 * (tick, direct legacy-mode forwarder); (2) a synthetic 422 contract hold is a hold in the real retention; (3) a stop whose
 * marker cannot be written keeps publication blocked across later sends, ticks and a restart, and nothing is dropped before it
 * is recorded. Real: spool files, status, record store, stop marker, delivery-state, forwarder, tick. Faked: fetch, daemon state,
 * policy cache, preferences, Date, the logger and a controllable write failure at the stop-marker seam.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
const io = vi.hoisted(() => ({ failStop: false, failStatus: false, generation: 0 }));
const policyRef = vi.hoisted(() => ({
  contracts: ['1'] as string[] | undefined,
  /** What a forced refresh returns when it differs (null = no advertised contract). */
  refreshed: undefined as string[] | null | undefined,
  capability: 'evidence' as 'evidence' | 'legacy',
}));
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
vi.mock('@/agents/core/evidence/stop-marker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/core/evidence/stop-marker.js')>();
  return {
    ...actual,
    writeStop: (...args: Parameters<typeof actual.writeStop>) => (io.failStop ? Promise.reject(new Error('EIO: marker write failed')) : actual.writeStop(...args)),
  };
});
vi.mock('../session-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-status.js')>();
  return {
    ...actual,
    writeStatus: (...args: Parameters<typeof actual.writeStatus>) => (io.failStatus ? Promise.reject(new Error('EIO: status write failed')) : actual.writeStatus(...args)),
  };
});
vi.mock('../policy-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../policy-cache.js')>();
  const current = (contracts: string[] | null | undefined = policyRef.contracts) => policyRef.capability === 'legacy'
    ? { policy: null, capability: 'legacy' as const, usable: false, refreshDue: false }
    : {
      policy: { organizations: ['Acme'], version: 'v1' }, capability: 'evidence' as const, usable: true, refreshDue: false,
      ...(contracts ? { publicationContracts: contracts } : {}),
    };
  return {
    ...actual,
    getPolicyState: vi.fn(async () => current()),
    refreshPolicy: vi.fn(async () => current(policyRef.refreshed === undefined ? policyRef.contracts : policyRef.refreshed)),
  };
});
vi.mock('@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js', () => ({
  readClaudeAnalyticsPreferences: vi.fn(async () => ({ kind: 'ok', value: { collectionGeneration: io.generation } })),
}));
vi.mock('../auth-state.js', () => ({ areCredentialsStale: (): boolean => false, markCredentialsStale: vi.fn() }));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SESSION = 'sess-pc';
const API = 'https://api.example.com/code-assistant-api';
const credentials = { cookies: { _oauth2_proxy: 'cookie-A' }, apiUrl: API, email: 'a@example.com' };
const T0 = Date.UTC(2026, 10, 3, 9);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LINE = JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'Proj A' }), evidence_v: 1 }) + '\n';
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('privacy continuity and stop durability', () => {
  const fetchMock = vi.fn();
  let home = '';
  const priorHome = process.env.CODEMIE_HOME;

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-pc-'));
    home = await mkdtemp(join(tmpdir(), 'otlp-pc-home-'));
    process.env.CODEMIE_HOME = home;
    vi.resetModules();
    fetchMock.mockReset();
    io.failStop = false;
    io.failStatus = false;
    io.generation = 0;
    policyRef.contracts = ['1'];
    policyRef.refreshed = undefined;
    policyRef.capability = 'evidence';
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: API, syncApiUrl: API });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (priorHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = priorHome;
    await rm(state.root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  /** A fresh module graph is a restarted daemon: only files on disk survive. */
  async function daemon() {
    vi.resetModules();
    const rs = await import('@/agents/core/evidence/record-store.js');
    const sm = await import('@/agents/core/evidence/stop-marker.js');
    const spool = await import('../spool-io.js');
    const status = await import('../session-status.js');
    const { forwardSession } = await import('../forwarder.js');
    const { processSessionTick } = await import('../tick-processor.js');
    const id = spool.forwarderIdentity(credentials as never)!;
    const key = rs.recordKey(id.api_identity, id.owner_hash, SESSION);
    return { rs, sm, spool, status, forwardSession, processSessionTick, key, id };
  }
  type Daemon = Awaited<ReturnType<typeof daemon>>;

  async function seed(d: Daemon, record: Record<string, unknown>, sendMode: 'evidence' | 'legacy' = 'evidence'): Promise<void> {
    await d.rs.createOrRead(d.key, {
      session_id: SESSION, launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven', organization: 'Acme',
      project: 'Proj A', project_source: 'none', api_identity: d.id.api_identity, owner_hash: d.id.owner_hash,
      ...record,
    } as never);
    await d.spool.appendSpool(SESSION, 'hooks', LINE, ['Proj A']);
    const status = (await d.status.readStatus(SESSION))!;
    await d.status.writeStatus(SESSION, { ...status, sendMode, evidenceMarked: true });
  }
  const newContract = { funding_route: 'subscription', collection_generation: 0, negotiate_publication: true };
  const send = (d: Daemon, hooksOnly = true) => d.forwardSession(SESSION, hooksOnly, credentials as never);
  const markerReason = async (d: Daemon): Promise<string | undefined> => {
    const { readFile } = await import('node:fs/promises');
    try { return (JSON.parse(await readFile(join(d.rs.evidenceDir(), d.rs.stopFileName(d.key)), 'utf8')) as { reason: string }).reason; } catch { return undefined; }
  };

  it.each(['legacy', 'missing', 'corrupt'])('a contract record never downgrades when its sendMode is %s', async (mode) => {
    const d = await daemon();
    await seed(d, newContract, 'legacy');
    if (mode === 'missing') {
      const status = (await d.status.readStatus(SESSION))!;
      delete status.sendMode;
      await d.status.writeStatus(SESSION, status);
    } else if (mode === 'corrupt') {
      await writeFile(join(state.root, `${SESSION}.status`), '{');
    }
    fetchMock.mockImplementation(async () => json(200, {}));
    await send(d);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unreadable recorded scope never becomes an unstamped legacy request', async () => {
    const d = await daemon();
    await seed(d, { collection_generation: 0 }, 'legacy');
    await writeFile(join(d.rs.evidenceDir(), `${d.key}.json`), '{');
    await send(d);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('a recorded session without a frozen generation is suspended on every path', () => {
    const legacyRecord = {};

    it('direct forwarder, sendMode legacy: nothing is sent and the marker names the reason', async () => {
      const d = await daemon();
      await seed(d, legacyRecord, 'legacy');
      fetchMock.mockImplementation(async () => json(200, {}));
      await send(d);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await markerReason(d)).toBe('scope_unproven');
    });

    it('the tick on an old backend does not send it either', async () => {
      policyRef.capability = 'legacy';
      const d = await daemon();
      await seed(d, legacyRecord, 'legacy');
      fetchMock.mockImplementation(async () => json(200, {}));
      await d.processSessionTick(SESSION, credentials as never);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await markerReason(d)).toBe('scope_unproven');
    });

    it('the same legacy-mode path still sends a record with a frozen generation and no funding claim, and never upgrades its protocol', async () => {
      const d = await daemon();
      await seed(d, { collection_generation: 0 }, 'legacy');
      fetchMock.mockImplementation(async () => json(200, {}));
      await send(d);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers).not.toHaveProperty('X-CodeMie-Publication-Contract');
      expect(await markerReason(d)).toBeUndefined();
    });

    it('a toggled collection generation stops the legacy-mode record too', async () => {
      const d = await daemon();
      await seed(d, { collection_generation: 3 }, 'legacy'); // preferences read generation 0
      await send(d);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await markerReason(d)).toBe('generation_changed');
    });
  });

  describe('a synthetic 422 contract hold is a hold in the real retention', () => {
    it('unsupported contract -> refresh without advertisement -> hold -> expiry stops with hold_expired', async () => {
      const d = await daemon();
      await seed(d, newContract);
      // The session was selected as contract mode while advertised; the refresh after the 422 no longer advertises it.
      policyRef.refreshed = null;
      fetchMock.mockImplementation(async () => json(422, { reason: 'publication_contract_unsupported', disposition: 'final' }));
      await send(d);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const held = (await d.status.readStatus(SESSION))!;
      expect(held.delivery?.hooks).toMatchObject({ reason: 'destination_hold', detail: 'publication_contract_unavailable' });
      expect(held.cursors.hooks).toBe(0);
      expect(held.sendCheckpoint).toBeUndefined(); // the synthetic hold is an ordinary processed outcome
      expect(await markerReason(d)).toBe('hold_contract_unavailable'); // first-hold notice, not a stop
      expect(await d.sm.isStopped(d.key)).toBe(false);

      vi.setSystemTime(T0 + DAY + MIN);
      await send(d); // the gate reaches the original bound
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await d.sm.isStopped(d.key)).toBe(true);
      expect(await markerReason(d)).toBe('hold_expired');
      const dropped = (await d.status.readStatus(SESSION))!;
      expect(dropped.lastLoss).toMatchObject({ reason: 'destination_hold', detail: 'publication_contract_unavailable' });
      expect(dropped.cursors.hooks).toBe(held.delivery!.hooks!.end);
    });

    it('an ordinary 422 is still a rejection, not a hold', async () => {
      const { deliveryFailureOf } = await import('../delivery-state.js');
      expect(deliveryFailureOf({ kind: 'failed', reason: 'http_422' })).toEqual({ reason: 'delivery_rejected', detail: 'http_422' });
    });
  });

  describe('legacy wire mode re-checks the recorded scope before EACH request', () => {
    const seedWithLogs = async (d: Daemon): Promise<void> => {
      await seed(d, { collection_generation: 0 }, 'legacy');
      await d.spool.appendSpool(SESSION, 'logs', Buffer.from('otlp-bytes'));
    };
    it('control: an unchanged generation sends the hooks request and the later OTLP request', async () => {
      const d = await daemon();
      await seedWithLogs(d);
      fetchMock.mockImplementation(async () => json(200, {}));
      await send(d, false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) expect(call[1].headers).not.toHaveProperty('X-CodeMie-Publication-Contract');
    });
    it('a generation change after the first request stops the session: no later request is made', async () => {
      const d = await daemon();
      await seedWithLogs(d);
      fetchMock.mockImplementation(async () => { io.generation = 1; return json(200, {}); }); // disabled and re-enabled between requests
      await send(d, false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await markerReason(d)).toBe('generation_changed');
    });
  });

  describe('write-ahead send checkpoint (new contract)', () => {
    const echoed = { 'X-CodeMie-Publication-Contract': '1', 'X-CodeMie-Destination': 'personal' };
    it('is released after an ordinary retry, a verified success and an auth retry; none becomes a stop', async () => {
      const d = await daemon();
      await seed(d, newContract);
      fetchMock.mockImplementationOnce(async () => json(503, { detail: 'default_project_unavailable' }));
      await send(d);
      expect((await d.status.readStatus(SESSION))!.sendCheckpoint).toBeUndefined();
      expect(await d.sm.isStopped(d.key)).toBe(false);
      vi.setSystemTime(T0 + 2 * MIN); // past the retry backoff
      fetchMock.mockImplementationOnce(async () => new Response('', { status: 401 })).mockImplementationOnce(async () => json(200, {}, echoed));
      await send(d);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const after = (await d.status.readStatus(SESSION))!;
      expect(after.sendCheckpoint).toBeUndefined();
      expect(after.cursors.hooks).toBeGreaterThan(0);
      expect(await d.sm.isStopped(d.key)).toBe(false);
    });

    it('a checkpoint that cannot be written means no request at all', async () => {
      const d = await daemon();
      await seed(d, newContract);
      io.failStatus = true;
      fetchMock.mockImplementation(async () => json(200, {}, echoed));
      await send(d);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('marker AND post-response status writes both fail: the pre-send checkpoint blocks after a module reload until the marker exists', async () => {
      const d = await daemon();
      await seed(d, newContract);
      fetchMock.mockImplementation(async () => { io.failStop = true; io.failStatus = true; return json(200, {}); }); // unverified answer, storage dies after the POST
      await send(d);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      io.failStatus = false; // inspection only
      const disk = (await d.status.readStatus(SESSION))!;
      expect(disk.sendCheckpoint).toBe(true); // written before the POST, survived
      expect(disk.stopIntent).toBeUndefined(); // the post-response write is what failed
      expect(await d.sm.isStopped(d.key)).toBe(false);

      io.failStop = true; io.failStatus = true;
      const restarted = await daemon(); // the in-memory intent is gone
      await send(restarted);
      await restarted.processSessionTick(SESSION, credentials as never).catch(() => undefined); // status storage is down: the tick may throw, it must not send
      expect(fetchMock).toHaveBeenCalledTimes(1);

      io.failStop = false; io.failStatus = false; // storage recovers
      const recovered = await daemon();
      await send(recovered);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await recovered.sm.isStopped(recovered.key)).toBe(true);
      expect(await markerReason(recovered)).toBe('response_unverified');
      expect((await recovered.status.readStatus(SESSION))!.sendCheckpoint).toBeUndefined();
    });
  });

  describe('a stop whose marker cannot be written', () => {
    it.each([
      ['an unverifiable accepted answer', () => json(200, {}), 'response_unverified'],
      ['a final refusal', () => json(422, { reason: 'consent_invalid', disposition: 'final' }), 'consent_invalid'],
    ])('%s: no later send, tick or restarted daemon publishes; the marker is written once possible', async (_name, answer, reason) => {
      const d = await daemon();
      await seed(d, newContract);
      io.failStop = true;
      fetchMock.mockImplementation(async () => answer());
      await send(d);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await d.sm.isStopped(d.key)).toBe(false); // no marker could be written
      expect((await d.status.readStatus(SESSION))?.stopIntent).toBe(reason); // but the intent is durable in the spool state

      await send(d); // later forwarder pass
      await d.processSessionTick(SESSION, credentials as never); // later tick
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const restarted = await daemon(); // restart, marker still unwritable
      await send(restarted);
      await restarted.processSessionTick(SESSION, credentials as never);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      io.failStop = false; // storage recovers
      const recovered = await daemon();
      await send(recovered);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await recovered.sm.isStopped(recovered.key)).toBe(true);
      expect(await markerReason(recovered)).toBe(reason);
      expect((await recovered.status.readStatus(SESSION))?.stopIntent).toBeUndefined();
    });

    it('with neither marker nor status writable the intent is volatile and says so, but still blocks this process', async () => {
      const d = await daemon();
      const { stopOrRecordIntent, stopIntentPending } = await import('../stop-intent.js');
      io.failStop = true;
      expect(await stopOrRecordIntent(d.key, 'response_unverified', 'no-status-session')).toBe('volatile');
      expect(await stopIntentPending(d.key, 'no-status-session')).toBe(true);
    });

    it('retention: an expired hold whose stop cannot be recorded keeps its range and sends nothing; recovery then drops it with the stop', async () => {
      const d = await daemon();
      await seed(d, newContract);
      fetchMock.mockImplementation(async () => json(503, { reason: 'project_unavailable', disposition: 'hold' }));
      await send(d);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const size = (await d.status.readStatus(SESSION))!.delivery!.hooks!.end;

      io.failStop = true;
      vi.setSystemTime(T0 + DAY + MIN);
      await send(d); // gate: expiry reached, stop not recordable
      const kept = (await d.status.readStatus(SESSION))!;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(kept.cursors.hooks).toBe(0);
      expect(kept.lastLoss).toBeUndefined();
      expect(kept.delivery?.hooks?.end).toBe(size);

      const restarted = await daemon();
      await send(restarted);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await restarted.status.readStatus(SESSION))!.cursors.hooks).toBe(0);

      io.failStop = false;
      const recovered = await daemon();
      await send(recovered);
      expect(await recovered.sm.isStopped(recovered.key)).toBe(true);
      const after = (await recovered.status.readStatus(SESSION))!;
      expect(after.cursors.hooks).toBe(size);
      expect(after.lastLoss).toMatchObject({ reason: 'destination_hold' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('tick: an expired contract-unavailable hold keeps its hold and backlog until hold_expired is recorded', async () => {
      policyRef.contracts = undefined; // the backend does not advertise the contract
      const d = await daemon();
      await seed(d, { ...newContract, routing_proof: 'unproven' }); // not safe on the old protocol, so it must wait for the contract
      await d.processSessionTick(SESSION, credentials as never); // first hold
      expect((await d.status.readStatus(SESSION))!.holds?.session?.reason).toBe('publication_contract_unavailable');

      io.failStop = true;
      vi.setSystemTime(T0 + DAY + MIN);
      await d.processSessionTick(SESSION, credentials as never);
      const kept = (await d.status.readStatus(SESSION))!;
      expect(kept.holds?.session?.reason).toBe('publication_contract_unavailable');
      expect(kept.lastLoss).toBeUndefined();
      expect(kept.cursors.hooks).toBe(0);

      io.failStop = false;
      const recovered = await daemon();
      await recovered.processSessionTick(SESSION, credentials as never);
      const after = (await recovered.status.readStatus(SESSION))!;
      expect(await recovered.sm.isStopped(recovered.key)).toBe(true);
      expect(after.lastLoss).toMatchObject({ reason: 'publication_contract_unavailable' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
