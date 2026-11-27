/**
 * AC4 at the owner-pending replay caller: a native Copilot sessionEnd held during an identity outage, for a run the
 * daemon already ended from its `session.shutdown`, is consumed on replay without a second end. A held end of a run
 * that was NOT ended stays a normal append. Real: pending store, replay, spool files, session status, recovery.
 * Synthetic: the transcript lines and the identity outage itself.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    streamFile: (sessionId: string, stream: string): string => pathJoin(state.root, `${sessionId}.${stream === 'hooks' ? 'hooks' : stream}.ndjson`),
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
const API = 'https://api.example.com/code-assistant-api';
const credentials = { cookies: { _oauth2_proxy: 'cookie-A' }, apiUrl: API, email: 'a@example.com' };
const T0 = Date.parse('2026-11-03T09:00:00.000Z');
const NOW = T0 + 10 * 60_000;
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const base = { session_id: SID, platform: 'copilot-cli', entrypoint: 'native', codemie_project_name: 'A' };
const startEvent = { ...base, type: 'agent.session.start', timestamp: at(0), event_id: 'start' };
const heldEnd = { ...base, type: 'agent.session.end', timestamp: at(4_900), event_id: 'native-end' };
const line = (type: string, ms: number, data: Record<string, unknown>): string => JSON.stringify({ type, timestamp: at(ms), data });

describe('owner-pending replay of a held native Copilot sessionEnd', () => {
  let home = '';
  const saved = { home: process.env.CODEMIE_HOME, userHome: process.env.HOME, profile: process.env.USERPROFILE, copilot: process.env.COPILOT_HOME };

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-ac4-'));
    home = await mkdtemp(join(tmpdir(), 'otlp-ac4-home-'));
    process.env.CODEMIE_HOME = join(home, 'codemie');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.COPILOT_HOME;
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const [key, value] of [['CODEMIE_HOME', saved.home], ['HOME', saved.userHome], ['USERPROFILE', saved.profile], ['COPILOT_HOME', saved.copilot]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(state.root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function setup(withShutdown: boolean) {
    const store = await import('@/agents/core/evidence/owner-pending.js');
    const { credentialFingerprint } = await import('@/providers/core/credential-owner.js');
    const { apiIdentity } = await import('@/agents/core/evidence/api-identity.js');
    const replay = await import('../owner-pending-replay.js');
    const io = await import('../spool-io.js');
    const enrich = await import('../copilot-usage-enrichment.js');
    // The session already has its start in the spool; the end is held for the identity outage.
    await io.appendSpool(SID, 'hooks', JSON.stringify({ agentName: 'copilot-cli-otlp', hookEvent: JSON.stringify(startEvent), evidence_v: 1 }) + '\n', ['A']);
    const fields = {
      session_id: SID, launch_mode: 'native' as const, routed_via_codemie: false, routing_proof: 'unproven' as const,
      project: 'A', project_source: 'none' as const, api_identity: apiIdentity(API), collection_generation: 0,
    };
    expect(await store.enqueuePendingOwner({
      fp: credentialFingerprint(credentials), agentName: 'copilot-cli-otlp', api_identity: apiIdentity(API),
      session_id: SID, fields, cwd: '/work', project_at_cwd: 'A', events: [heldEnd],
    }, NOW - 5 * 60_000)).toBe(true);
    const dir = join(home, '.copilot', 'session-state', SID);
    await mkdir(dir, { recursive: true });
    const lines = [line('session.start', 0, { startTime: at(0) }), ...(withShutdown ? [line('session.shutdown', 5_000, {})] : [])];
    await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
    await utimes(join(dir, 'events.jsonl'), new Date(NOW - 60_000), new Date(NOW - 60_000));
    return { replay, enrich };
  }
  const spooledEnds = async (): Promise<unknown[]> =>
    (await readFile(join(state.root, `${SID}.hooks.ndjson`), 'utf-8')).split('\n').filter(Boolean)
      .map((l) => JSON.parse(JSON.parse(l).hookEvent) as Record<string, unknown>)
      .filter((e) => e['type'] === 'agent.session.end').map((e) => e['timestamp']);
  const queued = async (): Promise<number> => {
    let n = 0;
    const dir = join(home, 'codemie', 'analytics', 'state', 'owner-pending');
    for (const d of await readdir(dir).catch(() => [] as string[])) n += (await readdir(join(dir, d))).filter((f) => f.endsWith('.json')).length;
    return n;
  };

  it('the run was ended by recovery first: the held end is consumed, not appended, not retried', async () => {
    const { replay, enrich } = await setup(true);
    await enrich.recoverMissingSessionEnds([SID], () => NOW);
    expect(await spooledEnds()).toEqual([at(5_000)]);

    await replay.processPendingOwner(credentials as never, NOW, enrich.copilotHookLifecycle);

    expect(await spooledEnds()).toEqual([at(5_000)]);
    expect(await queued()).toBe(0);
  });

  it('control: with no recovered end a refused replay (the pending start is ahead of it) is unchanged: nothing appended, still queued to retry', async () => {
    const { replay, enrich } = await setup(false);

    await replay.processPendingOwner(credentials as never, NOW, enrich.copilotHookLifecycle);

    expect(await spooledEnds()).toEqual([]);
    expect(await queued()).toBe(1);
  });
});
