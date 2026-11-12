/**
 * EPMCDME-17142: native Claude publishes a Personal session, or an Unknown one with confirmed subscription funding, only
 * under explicit connect-folder consent. Real stampEvidence, consent store, record store, tick and forwarder over a temp
 * CODEMIE_HOME; only the network (fetch), the daemon state, credentials and config/git lookups are faked. The assertion is
 * on the analytics POSTs the real forwarder makes (policy GETs are allowed), never on a UI.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  creds: undefined as unknown,
  cfg: { project: 'proj-orig' as string | undefined },
  be: {
    policy: { status: 200, body: { organizations: ['corp'], version: 'v1', publication_contracts: ['1'] } as unknown },
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
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const jwt = (email: string): string => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const ENV = ['CODEMIE_HOME', 'OTLP_SEND_MAX_ATTEMPTS', 'CODEMIE_PROJECT', 'CLAUDE_PROJECT_DIR', 'CODEMIE_SESSION_ID'];
const saved: Record<string, string | undefined> = {};
let home: string;
let work: string;

async function load() {
  vi.resetModules();
  return {
    rec: await import('@/agents/core/evidence/record-store.js'),
    stamp: await import('@/agents/core/evidence/stamp.js'),
    consent: await import('@/agents/core/evidence/consent-store.js'),
    stop: await import('@/agents/core/evidence/stop-marker.js'),
    io: await import('../spool-io.js'),
    tick: await import('../tick-processor.js'),
    st: await import('../session-status.js'),
  };
}
type M = Awaited<ReturnType<typeof load>>;

const credentials = () => h.creds as import('../../../../../../core/types.js').SSOCredentials;
const identity = (m: M) => m.io.forwarderIdentity(credentials())!;
const keyOf = (m: M, sid: string) => m.rec.recordKey(identity(m).api_identity, identity(m).owner_hash, sid);

type Funding = 'subscription' | 'unknown' | undefined;
const stamp = (m: M, sid: string, org: string | undefined, funding: Funding) =>
  m.stamp.stampEvidence(
    { cwd: work, sessionId: sid },
    {
      organization: org,
      routing: { routed: false, routing_proof: 'proven' },
      ...(funding ? { funding_route: funding } : {}),
      collection_generation: 0,
    }
  );
const connect = (m: M, project = 'proj-orig') =>
  m.consent.connectFolder({ owner_hash: identity(m).owner_hash, api_identity: identity(m).api_identity, project }, work);
const disconnect = (m: M) => m.consent.disconnectFolder({ owner_hash: identity(m).owner_hash, api_identity: identity(m).api_identity }, work);

const hook = (m: M, sid: string) =>
  m.io.appendSpool(
    sid,
    'hooks',
    JSON.stringify({
      agentName: 'claude-code-otlp',
      hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: sid, codemie_project_name: 'proj-orig' }),
      evidence_v: 1,
    }) + '\n',
    ['proj-orig']
  );
const otlpBytes = async (m: M, sid: string) => {
  for (const stream of ['logs', 'metrics', 'traces'] as const) await m.io.appendSpool(sid, stream, 'abcde', ['proj-orig']);
};
const drain = (m: M, sid: string) => m.tick.processSessionTick(sid, credentials());
const posts = () =>
  h.fetch.mock.calls
    .filter(([, init]) => (init as RequestInit).method === 'POST')
    .map(([url, init]) => ({ url: String(url), headers: (init as RequestInit).headers as Record<string, string> }));
const hooksSize = (sid: string) => readFileSync(join(home, 'proxy', 'otlp-spool', `${sid}.hooks.ndjson`)).length;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'work-consent-pub-'));
  work = join(home, 'work');
  mkdirSync(work);
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ['CODEMIE_PROJECT', 'CLAUDE_PROJECT_DIR', 'CODEMIE_SESSION_ID']) delete process.env[k];
  process.env.CODEMIE_HOME = home;
  process.env.OTLP_SEND_MAX_ATTEMPTS = '0';
  h.creds = { cookies: { codemie_access_token: jwt('dev@example.com') }, apiUrl: 'https://analytics.example.com', timestamp: 0 };
  h.cfg.project = 'proj-orig';
  h.be.policy = { status: 200, body: { organizations: ['corp'], version: 'v1', publication_contracts: ['1'] } };
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init: RequestInit) =>
    init.method === 'GET' && String(url).endsWith('/classification-policy')
      ? json(h.be.policy.status, h.be.policy.body)
      : json(200, {}, { 'X-CodeMie-Publication-Contract': '1', 'X-CodeMie-Destination': 'project', 'X-CodeMie-Bound-Project': 'proj-orig' })
  );
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
});

describe('Personal and Unknown+subscription sessions need explicit work consent to publish', () => {
  it.each([
    ['Personal (organization not in the policy)', 'Gmail Personal'],
    ['Unknown with confirmed subscription funding (no organization)', undefined],
  ])('%s, no consent: every stream stays local, nothing is acknowledged', async (_n, org) => {
    const m = await load();
    await stamp(m, 's1', org, 'subscription');
    await hook(m, 's1');
    await otlpBytes(m, 's1');
    await drain(m, 's1');

    expect(posts()).toEqual([]);
    const status = (await m.st.readStatus('s1'))!;
    expect(status.holds?.session?.reason).toBe('work_consent_required');
    expect(status.cursors).toMatchObject({ hooks: 0, logs: 0, metrics: 0, traces: 0 });
  });

  it.each([
    ['Personal', 'Gmail Personal'],
    ['Unknown + subscription', undefined],
  ])('positive control, %s with the folder connected before the session: it reaches the consented project', async (_n, org) => {
    const m = await load();
    await connect(m);
    expect(await stamp(m, 's1', org, 'subscription')).toMatchObject({ ok: true, record: { consent_ref: expect.any(String) } });
    await hook(m, 's1');
    await drain(m, 's1');

    expect(posts().length).toBeGreaterThan(0);
    expect(posts()[0].headers).toMatchObject({ 'X-CodeMie-Work-Consent': 'explicit-folder', 'X-CodeMie-Project': 'proj-orig' });
    expect((await m.st.readStatus('s1'))!.cursors.hooks).toBe(hooksSize('s1'));
  });

  it('a corporate session, and an Unknown one without a subscription claim, are unchanged (no consent needed)', async () => {
    const m = await load();
    await stamp(m, 'corp', 'Corp', 'subscription');
    await stamp(m, 'unk', undefined, 'unknown');
    await stamp(m, 'old', undefined, undefined); // evidence without a funding claim never confirms a subscription
    for (const sid of ['corp', 'unk', 'old']) {
      await hook(m, sid);
      await drain(m, sid);
    }
    expect(posts().length).toBe(3);
  });

  it('old queued boundary: a record without a funding claim that is Personal stays local, and a later connect-folder never grants it', async () => {
    const m = await load();
    await stamp(m, 's1', 'Gmail Personal', undefined);
    await hook(m, 's1'); // queued under the old record shape
    await drain(m, 's1');
    expect(posts()).toEqual([]);

    await connect(m); // connect after the fact: consent is never granted retroactively
    await hook(m, 's1');
    await drain(m, 's1');
    expect(posts()).toEqual([]);
    expect((await m.st.readStatus('s1'))!.cursors.hooks).toBe(0);
  });

  it('a session started before the folder was connected stays unconsented, new sessions are consented', async () => {
    const m = await load();
    await stamp(m, 'before', 'Gmail Personal', 'subscription');
    await connect(m);
    await stamp(m, 'after', 'Gmail Personal', 'subscription');
    for (const sid of ['before', 'after']) {
      await hook(m, sid);
      await drain(m, sid);
    }
    expect(posts().length).toBeGreaterThan(0);
    expect(posts().every((p) => p.headers['X-CodeMie-Session-Id'] === 'after')).toBe(true);
    expect((await m.st.readStatus('before'))!.holds?.session?.reason).toBe('work_consent_required');
  });

  it('revocation stops further publication, queued data included', async () => {
    const m = await load();
    await connect(m);
    await stamp(m, 's1', 'Gmail Personal', 'subscription');
    await hook(m, 's1');
    await drain(m, 's1');
    const sent = posts().length;
    expect(sent).toBeGreaterThan(0);

    await hook(m, 's1'); // queued behind the revocation
    await disconnect(m);
    await drain(m, 's1');
    expect(posts().length).toBe(sent);
    expect(await m.stop.isStopped(keyOf(m, 's1'))).toBe(true);
    expect((await m.st.readStatus('s1'))!.cursors.hooks).toBeLessThan(hooksSize('s1'));
  });

  it('a consent for another project (or folder) does not apply to the resolved destination', async () => {
    const m = await load();
    await connect(m, 'some-other-project');
    const stamped = await stamp(m, 's1', 'Gmail Personal', 'subscription');
    expect(stamped.ok && stamped.record.consent_ref).toBeFalsy();
    await hook(m, 's1');
    await drain(m, 's1');
    expect(posts()).toEqual([]);
  });

  it('unresolved policy: an organization that may still be Personal is not uploaded while the policy is unavailable', async () => {
    const m = await load();
    h.be.policy = { status: 500, body: {} };
    await stamp(m, 's1', 'Gmail Personal', 'subscription');
    await hook(m, 's1');
    await drain(m, 's1');
    expect(posts()).toEqual([]);
    expect((await m.st.readStatus('s1'))!.holds?.session?.reason).toBe('classification_unresolved');
  });

  it('a policy that lists the organization makes it corporate and publishes without consent', async () => {
    const m = await load();
    h.be.policy = { status: 200, body: { organizations: ['gmail personal'], version: 'v1', publication_contracts: ['1'] } };
    await stamp(m, 's1', 'Gmail Personal', 'subscription');
    await hook(m, 's1');
    await drain(m, 's1');
    expect(posts().length).toBeGreaterThan(0);
    expect(posts()[0].headers['X-CodeMie-Subscription-Type']).toBe('corporate');
    expect(posts()[0].headers).not.toHaveProperty('X-CodeMie-Work-Consent');
  });
});
