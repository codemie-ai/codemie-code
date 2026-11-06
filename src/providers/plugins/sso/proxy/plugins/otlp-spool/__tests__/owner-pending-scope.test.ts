/**
 * Owner-pending replay re-checks the scope of an already-recorded session: content held during an identity outage
 * is appended only when it still fits the record's project (a folder move stops the session and drops it).
 * Real: pending store, replay, record store, stop marker, spool; faked: daemon state, auth state and logger.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

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
const projectMock = vi.hoisted(() => vi.fn());
vi.mock('@/agents/core/event-fields/identity-fields.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectAtCwd: projectMock,
}));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SESSION = 'sess-scope';
const API = 'https://api.example.com/code-assistant-api';
const credentials = { cookies: { _oauth2_proxy: 'cookie-A' }, apiUrl: API, email: 'a@example.com' };
const event = (n: number) => ({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'work', event_id: `e${n}`, n });

describe('owner-pending replay scope', () => {
  let home = '';
  const priorHome = process.env.CODEMIE_HOME;

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-scope-'));
    home = await mkdtemp(join(tmpdir(), 'otlp-scope-home-'));
    process.env.CODEMIE_HOME = home;
    vi.resetModules();
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = priorHome;
    await rm(state.root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function mods() {
    const store = await import('@/agents/core/evidence/owner-pending.js');
    const rs = await import('@/agents/core/evidence/record-store.js');
    const sm = await import('@/agents/core/evidence/stop-marker.js');
    const { credentialFingerprint } = await import('@/providers/core/credential-owner.js');
    const { apiIdentity, ownerHash } = await import('@/agents/core/evidence/api-identity.js');
    const { processPendingOwner } = await import('../owner-pending-replay.js');
    const key = rs.recordKey(apiIdentity(API), ownerHash('a@example.com'), SESSION);
    const fields = (over: Record<string, unknown> = {}) => ({
      session_id: SESSION, launch_mode: 'native' as const, routed_via_codemie: false, routing_proof: 'proven' as const,
      project: 'work', project_source: 'none' as const, api_identity: apiIdentity(API),
      funding_route: 'subscription' as const, collection_generation: 0, negotiate_publication: true as const, ...over,
    });
    const hold = (n: number, projectAtCwd: string, over: Record<string, unknown> = {}) => store.enqueuePendingOwner({
      fp: credentialFingerprint(credentials as never), agentName: 'claude-code-otlp', api_identity: apiIdentity(API),
      session_id: SESSION, fields: fields(over), cwd: join(tmpdir(), 'folder'), project_at_cwd: projectAtCwd, events: [event(n)],
    }, Date.now() + n);
    const existing = (over: Record<string, unknown> = {}) =>
      rs.createOrRead(key, { ...fields(over), owner_hash: ownerHash('a@example.com') } as never);
    const hooksBytes = async (): Promise<number> => (await stat(join(state.root, SESSION + '.hooks.ndjson')).catch(() => ({ size: 0 }))).size;
    const queued = async (): Promise<number> => {
      let n = 0;
      const base = join(home, 'analytics', 'state', 'owner-pending');
      for (const dir of await readdir(base).catch(() => [] as string[])) n += (await readdir(join(base, dir))).filter((f) => f.endsWith('.json')).length;
      return n;
    };
    const capture = async (cwd: string, activeProfile: string) => {
      const { ClaudeCodeOtlpPlugin } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.js');
      const plugin = new ClaudeCodeOtlpPlugin() as unknown as { holdForOwner(c: object, p: object[], pending: object): Promise<boolean> };
      return plugin.holdForOwner({ cwd, sessionId: SESSION }, [event(1)], {
        fp: credentialFingerprint(credentials as never), fields: fields({ profile: activeProfile }),
      });
    };
    return { sm, key, hold, capture, existing, hooksBytes, queued, run: () => processPendingOwner(credentials as never) };
  }

  it('content held for another folder is dropped and stops the recorded session; nothing reaches the spool', async () => {
    const m = await mods();
    await m.existing();
    expect(await m.hold(1, 'other')).toBe(true);
    await m.run();
    expect(await m.sm.isStopped(m.key)).toBe(true);
    expect(await m.hooksBytes()).toBe(0);
    expect(await m.queued()).toBe(0);
  });

  it('content held for the recorded project is appended (case-insensitive)', async () => {
    const m = await mods();
    await m.existing();
    await m.hold(1, 'WORK');
    await m.run();
    expect(await m.sm.isStopped(m.key)).toBe(false);
    expect(await m.hooksBytes()).toBeGreaterThan(0);
  });

  it('a fresh session is still created from its held facts, but a later entry from another folder stops it', async () => {
    const m = await mods();
    await m.hold(1, 'work');
    await m.hold(2, 'other');
    await m.run();
    const afterFirstOnly = await m.hooksBytes();
    expect(afterFirstOnly).toBeGreaterThan(0);
    expect(await m.sm.isStopped(m.key)).toBe(true);
    expect(await m.queued()).toBe(0);
  });

  it('a collection-generation change during the outage stops the recorded session', async () => {
    const m = await mods();
    await m.existing();
    await m.hold(1, 'work', { collection_generation: 1 });
    await m.run();
    expect(await m.sm.isStopped(m.key)).toBe(true);
    expect(await m.hooksBytes()).toBe(0);
  });

  it('a session recorded before the new contract stays legacy and is not scope-stopped', async () => {
    const m = await mods();
    await m.existing({ funding_route: undefined, negotiate_publication: undefined, collection_generation: undefined });
    await m.hold(1, 'other', { funding_route: undefined, negotiate_publication: undefined, collection_generation: undefined });
    await m.run();
    expect(await m.sm.isStopped(m.key)).toBe(false);
    expect(await m.hooksBytes()).toBeGreaterThan(0);
  });

  describe('captured through the real hook-time producer', () => {
    // Profile A resolves the work folder to projA (anything else is another project); profile B would say projB for any folder.
    beforeEach(() => {
      projectMock.mockReset().mockImplementation(async (cwd: string, profile?: string) =>
        profile === 'A' ? (cwd.endsWith('work') ? 'projA' : 'other') : 'projB');
    });

    it('an unchanged folder after the ACTIVE profile switched A->B is not a folder move', async () => {
      const m = await mods();
      await m.existing({ profile: 'A', project: 'projA' });
      expect(await m.capture(join(tmpdir(), 'work'), 'B')).toBe(true);
      await m.run();
      expect(await m.sm.isStopped(m.key)).toBe(false);
      expect(await m.hooksBytes()).toBeGreaterThan(0);
    });

    it('a real move during the outage is still rejected, whatever profile is active', async () => {
      const m = await mods();
      await m.existing({ profile: 'A', project: 'projA' });
      expect(await m.capture(join(tmpdir(), 'elsewhere'), 'B')).toBe(true);
      await m.run();
      expect(await m.sm.isStopped(m.key)).toBe(true);
      expect(await m.hooksBytes()).toBe(0);
    });

    it('a fresh session (no record) is captured with the current profile', async () => {
      const m = await mods();
      expect(await m.capture(join(tmpdir(), 'work'), 'B')).toBe(true);
      expect(projectMock).toHaveBeenCalledWith(join(tmpdir(), 'work'), 'B');
    });
  });
});
