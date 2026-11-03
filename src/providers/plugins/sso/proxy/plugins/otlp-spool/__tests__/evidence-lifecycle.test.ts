import { evidenceDir } from '@/agents/core/evidence/record-store.js';
/**
 * Evidence lifetime (AC18, AC16, AC1 headers): real stampEvidence, record-store, spool-io, tick and
 * forwarder over a temp CODEMIE_HOME; only the network (fetch), the daemon state, credentials and
 * config/git lookups are faked.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86_400_000;
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  creds: undefined as unknown,
  cfg: {
    project: 'proj-orig' as string | undefined,
    org: 'Corp' as string | undefined,
    routing: { routed: false, routing_proof: 'proven' } as { routed: boolean; routing_proof: 'proven' | 'unproven' },
  },
  be: {
    policy: { status: 200, body: { organizations: ['corp'], version: 'v1' } as unknown },
    hooks: { status: 200, body: {} as unknown },
  },
}));

vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({
  readState: vi.fn().mockResolvedValue({ targetUrl: 'https://analytics.example.com' }),
}));
vi.mock('@/agents/core/hook-credentials.js', () => ({ resolveHookCredentials: async () => h.creds }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: async () => 'p',
    load: async () => ({ name: 'p', codeMieProject: h.cfg.project }),
    hasLocalConfig: async () => false,
    resolveProjectOrigin: async () => 'profile',
    isLocalProfile: async () => false,
  },
}));
vi.mock('@/agents/core/session-project-pin.js', () => ({
  readPinnedProjectName: async () => undefined,
  pinProjectName: async (_s: string, p: string) => p,
}));
vi.mock('@/utils/processes.js', async (orig) => ({
  ...(await orig<typeof import('@/utils/processes.js')>()),
  getRawGitOrigin: async () => 'https://git.example.com/org/repo.git',
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const jwt = (email: string): string => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const ENV = [
  'CODEMIE_HOME', 'OTLP_SEND_MAX_ATTEMPTS', 'OTLP_ABANDONED_SESSION_GRACE_MINUTES',
  'CODEMIE_EVIDENCE_RECORD_MAX_FILES', 'CODEMIE_EVIDENCE_RECORD_IDLE_DAYS',
  'CODEMIE_PROJECT', 'CLAUDE_PROJECT_DIR', 'CODEMIE_SESSION_ID', // ambient shell values must not leak in
];
const saved: Record<string, string | undefined> = {};
let home: string;

/** Fresh module state = a daemon/hook restart. */
async function load() {
  vi.resetModules();
  return {
    rec: await import('@/agents/core/evidence/record-store.js'),
    id: await import('@/agents/core/evidence/api-identity.js'),
    stamp: await import('@/agents/core/evidence/stamp.js'),
    io: await import('../spool-io.js'),
    tick: await import('../tick-processor.js'),
    st: await import('../session-status.js'),
    sweep: await import('../sweep.js'),
    vs: await import('../verdict-store.js'),
    pc: await import('../policy-cache.js'),
  };
}
type M = Awaited<ReturnType<typeof load>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const credentials = () => h.creds as import('../../../../../../core/types.js').SSOCredentials;
const stamp = (m: M, sid: string) =>
  m.stamp.stampEvidence({ cwd: '/repo', sessionId: sid }, { organization: h.cfg.org, routing: h.cfg.routing });
const keyOf = (m: M, sid: string) => {
  const id = m.io.forwarderIdentity(credentials())!;
  return m.rec.recordKey(id.api_identity, id.owner_hash, sid);
};
const recFile = (m: M, sid: string) => join(evidenceDir(), `${keyOf(m, sid)}.json`);
const recCount = () => readdirSync(evidenceDir()).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length;
const setLastUsed = (file: string, ms: number) => {
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), last_used: ms }));
};
const hook = (m: M, sid: string, project?: string) =>
  m.io.appendSpool(
    sid,
    'hooks',
    JSON.stringify({
      agentName: 'claude-code-otlp',
      hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: sid, ...(project ? { codemie_project_name: project } : {}) }),
      evidence_v: 1,
    }) + '\n',
    project ? [project] : []
  );
const drain = (m: M, sid: string) => m.tick.processSessionTick(sid, credentials());
const posts = () =>
  h.fetch.mock.calls
    .filter(([, init]) => (init as RequestInit).method === 'POST')
    .map(([url, init]) => ({ url: String(url), headers: (init as RequestInit).headers as Record<string, string> }));
const hooksSize = (sid: string) => readFileSync(join(home, 'proxy', 'otlp-spool', `${sid}.hooks.ndjson`)).length;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evidence-lifecycle-'));
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ['CODEMIE_PROJECT', 'CLAUDE_PROJECT_DIR', 'CODEMIE_SESSION_ID']) delete process.env[k];
  process.env.CODEMIE_HOME = home;
  process.env.OTLP_SEND_MAX_ATTEMPTS = '0'; // hooks-only sessions are forwarded on the first tick
  h.creds = { cookies: { codemie_access_token: jwt('dev@example.com') }, apiUrl: 'https://analytics.example.com', timestamp: 0 };
  h.cfg.project = 'proj-orig';
  h.cfg.org = 'Corp';
  h.cfg.routing = { routed: false, routing_proof: 'proven' };
  h.be.policy = { status: 200, body: { organizations: ['corp'], version: 'v1' } };
  h.be.hooks = { status: 200, body: {} };
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init: RequestInit) =>
    init.method === 'GET' && String(url).endsWith('/classification-policy')
      ? json(h.be.policy.status, h.be.policy.body)
      : json(h.be.hooks.status, h.be.hooks.body)
  );
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
});

describe('AC18 resume with the same session id', () => {
  it('drain -> spool sweep -> restart -> resume with changed project/org/routing reuses the record and sends the original values', async () => {
    let m = await load();
    const first = await stamp(m, 's1');
    expect(first).toMatchObject({ ok: true, record: { project: 'proj-orig', organization: 'Corp', routed_via_codemie: false } });
    await hook(m, 's1', 'proj-orig');
    await drain(m, 's1');
    expect(posts()).toHaveLength(1);

    // Spool swept (drained + grace over); the record is not spool state and stays.
    process.env.OTLP_ABANDONED_SESSION_GRACE_MINUTES = '0.0001';
    await sleep(30);
    await m.sweep.sweepSpool();
    expect(existsSync(join(home, 'proxy', 'otlp-spool', 's1.status'))).toBe(false);
    expect(recCount()).toBe(1);

    // Daemon/hook restart, then the same session resumes with everything changed.
    m = await load();
    h.cfg.project = 'proj-new';
    h.cfg.org = 'Other Org';
    h.cfg.routing = { routed: true, routing_proof: 'proven' };
    const resumed = await stamp(m, 's1');
    expect(resumed).toMatchObject({ ok: true, record: { project: 'proj-orig', organization: 'Corp', routed_via_codemie: false } });
    await hook(m, 's1', 'proj-orig'); // identity fields take the project from the record
    await drain(m, 's1');
    const sent = posts();
    expect(sent).toHaveLength(2);
    expect(sent[1].headers).toMatchObject({
      'X-CodeMie-Project': 'proj-orig',
      'X-CodeMie-Organization': 'Corp',
      'X-CodeMie-Routed-Via-CodeMie': 'false',
      'X-CodeMie-Session-Id': 's1',
    });

    // A genuinely new session id is stamped fresh with the current values.
    const fresh = await stamp(m, 's2');
    expect(fresh).toMatchObject({ ok: true, record: { project: 'proj-new', organization: 'Other Org', routed_via_codemie: true } });
    expect(recCount()).toBe(2);
  });

  it('a corrupt record or a key mismatch is stamp_invalid: never re-stamped, held, nothing sent', async () => {
    const m = await load();
    await stamp(m, 's1');
    await hook(m, 's1', 'proj-orig');
    writeFileSync(recFile(m, 's1'), '{not json');
    expect(await stamp(m, 's1')).toEqual({ ok: false, reason: 'stamp_invalid' });
    expect(readFileSync(recFile(m, 's1'), 'utf-8')).toBe('{not json');
    await drain(m, 's1');
    expect(posts()).toHaveLength(0);
    expect((await m.st.readStatus('s1'))?.holds?.session?.reason).toBe('stamp_invalid');

    // Key mismatch: the valid record of s3 copied under s4's key.
    await stamp(m, 's3');
    writeFileSync(recFile(m, 's4'), readFileSync(recFile(m, 's3'), 'utf-8'));
    expect(await stamp(m, 's4')).toEqual({ ok: false, reason: 'stamp_invalid' });
    expect(readFileSync(recFile(m, 's4'), 'utf-8')).toBe(readFileSync(recFile(m, 's3'), 'utf-8'));
  });
});

describe('AC18 retention', () => {
  it('keeps records idle < 90 days, evicts > 90 days only when not pending, and evicts oldest-first over the cap', async () => {
    const m = await load();
    for (const s of ['young', 'old', 'oldPending']) await stamp(m, s);
    setLastUsed(recFile(m, 'young'), Date.now() - 89 * DAY);
    setLastUsed(recFile(m, 'old'), Date.now() - 91 * DAY);
    setLastUsed(recFile(m, 'oldPending'), Date.now() - 91 * DAY);
    await hook(m, 'oldPending', 'proj-orig'); // undelivered spool relies on it

    await m.sweep.sweepSpool();
    expect(existsSync(recFile(m, 'young'))).toBe(true);
    expect(existsSync(recFile(m, 'old'))).toBe(false);
    expect(existsSync(recFile(m, 'oldPending'))).toBe(true);

    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '4';
    for (const [i, s] of ['c1', 'c2'].entries()) {
      await stamp(m, s);
      setLastUsed(recFile(m, s), Date.now() - (2 - i) * DAY);
    }
    await m.sweep.sweepSpool(); // room for one more: 4 live > cap 4 - 1, oldest non-pending goes first
    expect(existsSync(recFile(m, 'oldPending'))).toBe(true);
    expect(existsSync(recFile(m, 'young'))).toBe(false);
    expect(existsSync(recFile(m, 'c1'))).toBe(true);
  });

  it('a cap that would erase pending state holds NEW sessions as evidence_capacity and leaves pending state intact', async () => {
    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '2';
    const m = await load();
    for (const s of ['p1', 'p2']) { await stamp(m, s); await hook(m, s, 'proj-orig'); }
    const before = hooksSize('p1');

    expect(await stamp(m, 'p3')).toEqual({ ok: false, reason: 'evidence_capacity' });
    await m.sweep.sweepSpool();
    expect(recCount()).toBe(2);
    expect(hooksSize('p1')).toBe(before);
    expect(await stamp(m, 'p3')).toEqual({ ok: false, reason: 'evidence_capacity' });

    await drain(m, 'p1'); // p1 delivered: no longer pending, so the sweep may make room
    await m.sweep.sweepSpool();
    expect(existsSync(recFile(m, 'p1'))).toBe(false);
    expect(existsSync(recFile(m, 'p2'))).toBe(true);
    expect(await stamp(m, 'p3')).toMatchObject({ ok: true });
  });
});

describe('AC18 post-eviction fixture and AC16 sticky Personal', () => {
  const personal = () => {
    h.cfg.org = 'Gmail Personal';
    h.cfg.routing = { routed: false, routing_proof: 'proven' };
  };

  it('re-stamp after eviction is allowed; a Personal request answered session_project_conflict is a recorded discard, never accepted', async () => {
    personal();
    let m = await load();
    await stamp(m, 's1');
    await hook(m, 's1', 'proj-orig');
    await drain(m, 's1');
    expect(posts()[0].headers['X-CodeMie-Subscription-Type']).toBe('personal');
    expect(await m.vs.readVerdict(keyOf(m, 's1'))).toMatchObject({ class: 'personal' });

    setLastUsed(recFile(m, 's1'), Date.now() - 91 * DAY);
    process.env.OTLP_ABANDONED_SESSION_GRACE_MINUTES = '0.0001';
    await sleep(30);
    await m.sweep.sweepSpool();
    expect(existsSync(recFile(m, 's1'))).toBe(false);
    expect(await m.vs.readVerdict(keyOf(m, 's1'))).toBeNull();

    m = await load();
    h.cfg.project = 'proj-new';
    expect(await stamp(m, 's1')).toMatchObject({ ok: true, record: { project: 'proj-new' } });
    h.be.hooks = { status: 200, body: { accepted: 0, dropped: 1, reason: 'session_project_conflict' } };
    await hook(m, 's1', 'proj-new');
    await drain(m, 's1');

    const status = (await m.st.readStatus('s1'))!;
    expect(posts()).toHaveLength(2);
    expect(posts()[1].headers).toMatchObject({ 'X-CodeMie-Project': 'proj-new', 'X-CodeMie-Subscription-Type': 'personal' });
    expect(status.lastDiscard).toMatchObject({ reason: 'session_project_conflict', stream: 'hooks' });
    expect(status.cursors.hooks).toBe(hooksSize('s1')); // that range only, as a discard
    expect(status.lastLoss).toBeUndefined();
  });

  it.each([
    ['404 (old backend)', 404, 'legacy'],
    ['5xx (unknown capability)', 500, 'unknown'],
  ])('sticky Personal is held personal_not_forwardable on %s, never stripped', async (_n, status, capability) => {
    personal();
    const m = await load();
    await stamp(m, 's1');
    await m.vs.recordVerdict(keyOf(m, 's1'), { class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v1' });
    h.be.policy = { status, body: {} };
    await hook(m, 's1', 'proj-orig');
    await drain(m, 's1');

    expect(posts()).toHaveLength(0);
    expect((await m.st.readStatus('s1'))?.holds?.session?.reason).toBe('personal_not_forwardable');
    expect(h.fetch.mock.calls.length).toBeGreaterThan(0);
    expect((await m.pc.getPolicyState({ ...m.io.forwarderIdentity(credentials())! })).capability).toBe(capability);
  });

  it('sticky Personal on an evidence-capable backend with an expired policy is sent as full evidence', async () => {
    personal();
    const m = await load();
    await stamp(m, 's1');
    await m.vs.recordVerdict(keyOf(m, 's1'), { class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v1' });
    await m.pc.refreshPolicy(m.io.forwarderIdentity(credentials())!, {
      baseUrl: 'https://analytics.example.com', headers: { a: 'b' }, now: Date.now() - 2 * DAY,
    });
    h.be.policy = { status: 500, body: {} };
    await hook(m, 's1', 'proj-orig');
    await drain(m, 's1');

    expect(posts()).toHaveLength(1);
    expect(posts()[0].headers).toMatchObject({ 'X-CodeMie-Subscription-Type': 'personal', 'X-CodeMie-Session-Id': 's1' });
  });

  it('no verdict on an old backend keeps the legacy request (no evidence headers)', async () => {
    personal();
    const m = await load();
    await stamp(m, 's1');
    h.be.policy = { status: 404, body: {} };
    await hook(m, 's1', 'proj-orig');
    await drain(m, 's1');

    expect(posts()).toHaveLength(1);
    expect(posts()[0].headers['X-CodeMie-Project']).toBe('proj-orig');
    expect(Object.keys(posts()[0].headers).filter((k) => /Session-Id|Subscription-Type|Routed/.test(k))).toEqual([]);
  });
});

describe('AC1 headers sent per routing proof', () => {
  it.each([
    ['routed + proven', true, 'proven', 'codemie', 'true'],
    ['direct + proven, org not in policy', false, 'proven', 'personal', 'false'],
    ['unproven route never personal', false, 'unproven', 'unknown', 'false'],
  ] as const)('%s', async (_n, routed, routing_proof, cls, routedHeader) => {
    h.cfg.org = 'Gmail Personal';
    h.cfg.routing = { routed, routing_proof };
    const m = await load();
    await stamp(m, 's1');
    await hook(m, 's1', 'proj-orig');
    await drain(m, 's1');
    const [req] = posts();
    expect(req.headers).toMatchObject({
      'X-CodeMie-Subscription-Type': cls,
      'X-CodeMie-Routed-Via-CodeMie': routedHeader,
    });
    if (!routed) expect(req.headers['X-CodeMie-Policy-Version']).toBe('v1'); // routed needs no policy
    expect(JSON.stringify(req.headers)).not.toContain('routing_unproven');
  });
});
