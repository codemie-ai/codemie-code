/**
 * EPMCDME-16776 R2 / AC9: hook events of a login whose owner cannot be resolved yet are held durably (bound to that exact
 * login) and replayed by the daemon tick once the owner resolves, with NO new hook. Real: OtlpAgentAdapter hook flow,
 * resolveHookCredentials, withVerifiedOwner, stampEvidence, owner-pending store, OtlpInterceptor tick, spool append,
 * record-store, forwarderIdentity. Mocked: stored-credential read, daemon state, `/v1/user`, processSessionTick (no HTTP).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const m = vi.hoisted(() => ({
  stored: undefined as unknown,
  userInfo: vi.fn(),
  tick: vi.fn(),
}));

vi.mock('@/utils/processes.js', async (orig) => ({
  ...(await orig<typeof import('@/utils/processes.js')>()),
  detectGitBranch: async () => 'main',
  detectGitRemoteRepo: async () => 'org/repo',
  getRawGitOrigin: async () => 'https://git.example.com/org/repo.git',
}));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: async () => 'work',
    load: async () => ({ codeMieProject: 'proj-at-hook-time' }),
    hasLocalConfig: async () => false,
    resolveProjectOrigin: async () => 'none',
    isLocalProfile: async () => false,
  },
}));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: async () => '1.0.0' }));
vi.mock('../../session-project-pin.js', () => ({
  readPinnedProjectName: async () => undefined,
  pinProjectName: async (_s: string, p: string) => p,
}));
vi.mock('../../identity-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../identity-resolver.js')>()),
  // the git/OS/config tiers: must never reach a replayed event
  resolveIdentity: async () => ({ developerName: 'git-person@elsewhere.example', identitySource: 'git' }),
}));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({
  readState: async () => ({ syncCodeMieUrl: 'https://sync.example.com' }),
}));
vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = async () => m.stored ?? null;
  },
}));
vi.mock('@/providers/core/codemie-auth-helpers.js', async (orig) => ({
  ...(await orig<object>()),
  fetchCodeMieUserInfo: m.userInfo,
}));
vi.mock('@/providers/plugins/sso/proxy/plugins/otlp-spool/auth-state.js', () => ({
  areCredentialsStale: () => false,
  clearCredentialsStale: vi.fn(),
  markCredentialsStale: vi.fn(),
  resolveFreshCredentials: async () => m.stored,
}));
vi.mock('@/providers/plugins/sso/proxy/plugins/otlp-spool/tick-processor.js', () => ({ processSessionTick: m.tick }));

const { OtlpAgentAdapter } = await import('../../OtlpAgentAdapter.js');
const { OtlpPlugin } = await import('@/providers/plugins/sso/proxy/plugins/otlp.plugin.js');
const { OWNER_LOOKUP_COOLDOWN_MS } = await import('@/providers/core/credential-owner.js');
const { pendingOwnerDir } = await import('../owner-pending.js');
const { heldRetentionMs } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-config.js');
const { streamFile } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-paths.js');
const { forwarderIdentity } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js');
const { readStatus } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');
const { readRecord, recordKey } = await import('../record-store.js');
const { apiIdentity, ownerHash } = await import('../api-identity.js');

const API = 'https://codemie.example.com/code-assistant-api';
const SESSION = 'sess-r2';
const login = (cookie: string) => ({ cookies: { _oauth2_proxy: cookie }, apiUrl: API });
const user = (email: string) => ({ userId: 'u', name: 'n', username: 'x', email, applications: [], applications_admin: [] });

class HookAdapter extends OtlpAgentAdapter<{ cwd: string; payload: Record<string, unknown>[] }> {
  readonly name = 'claude-code-otlp';
  finalized: boolean[] = [];
  protected parseHookInput(raw: string) { return JSON.parse(raw); }
  protected extractHookContext(i: { cwd: string }) {
    return { cwd: i.cwd, sessionId: SESSION, evidenceInputs: { routing: { routed: false, routing_proof: 'unproven' as const } } };
  }
  protected async isTracked() { return true; }
  protected async evaluate(i: { payload: Record<string, unknown>[] }) {
    return { decision: 'forward' as const, payload: i.payload, finalize: async (ok: boolean) => { this.finalized.push(ok); } };
  }
  protected async resolveAgentFields() { return {}; }
  protected resolveEventType() { return 'fake.event'; }
  protected buildEventId(_e: Record<string, unknown>, p: Record<string, unknown>) { return `id-${String(p['n'])}`; }
}

let home = '';
const priorHome = process.env.CODEMIE_HOME;
const sent = vi.fn();
const deps = { ensureOtlpProxy: async () => undefined, forwardOtlpEventsToSpool: async (...a: unknown[]) => { sent(...a); return true; } };
const hook = (a: HookAdapter, n = 1) =>
  a.processOtlpEvent(JSON.stringify({ cwd: home, payload: [{ session_id: SESSION, n, timestamp: '2026-11-03T10:00:00.000Z' }] }), deps as never);
const pendingFiles = () => (existsSync(pendingOwnerDir()) ? readdirSync(pendingOwnerDir()).flatMap((d) => readdirSync(join(pendingOwnerDir(), d)).map((f) => join(pendingOwnerDir(), d, f))) : []);
const daemon = () => new OtlpPlugin().createInterceptor({ credentials: m.stored, config: { targetApiUrl: API } } as never) as unknown as { tick: () => Promise<void> };
const spooled = () => (existsSync(streamFile(SESSION, 'hooks')) ? readFileSync(streamFile(SESSION, 'hooks'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'r2-'));
  process.env.CODEMIE_HOME = home;
  vi.useFakeTimers({ toFake: ['Date'], now: 1_800_000_000_000 });
  m.userInfo.mockReset();
  m.tick.mockReset().mockResolvedValue(undefined);
  sent.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  if (priorHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = priorHome;
  delete process.env.CODEMIE_PROJECT;
  rmSync(home, { recursive: true, force: true });
});

describe('hook -> lookup failure -> durable hold -> recovery without a new hook', () => {
  it('holds the event, then the daemon tick delivers it under the verified owner', async () => {
    process.env.CODEMIE_PROJECT = 'proj-at-hook-time';
    m.stored = login('cookie-A');
    m.userInfo.mockRejectedValueOnce(new Error('ECONNRESET'));
    const adapter = new HookAdapter();
    await hook(adapter);

    // held: nothing went to the daemon, source acknowledged (finalize(true)), no secret on disk
    expect(sent).not.toHaveBeenCalled();
    expect(adapter.finalized).toEqual([true]);
    expect(pendingFiles()).toHaveLength(1);
    expect(readFileSync(pendingFiles()[0], 'utf8')).not.toContain('cookie-A');
    expect(spooled()).toHaveLength(0);

    // a tick while the backend is still down changes nothing and sends nothing
    const d = daemon();
    m.userInfo.mockRejectedValue(new Error('still down'));
    later(OWNER_LOOKUP_COOLDOWN_MS + 1);
    await d.tick();
    expect(spooled()).toHaveLength(0);
    expect(pendingFiles()).toHaveLength(1);

    // backend recovers; NO new hook; the environment has changed since the hook ran
    process.env.CODEMIE_PROJECT = 'changed-later';
    m.userInfo.mockResolvedValue(user('Dev.A@example.com'));
    later(OWNER_LOOKUP_COOLDOWN_MS + 1);
    await d.tick();

    const lines = spooled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agentName: 'claude-code-otlp', evidence_v: 1 });
    const event = JSON.parse(lines[0].hookEvent);
    expect(event).toMatchObject({
      event_id: 'id-1', timestamp: '2026-11-03T10:00:00.000Z', // original id/timestamp
      codemie_project_name: 'proj-at-hook-time', // hook-time facts, not re-read
      user_email: 'dev.a@example.com'.replace('dev.a', 'Dev.A'), developer_name: 'Dev.A@example.com', identity_source: 'jwt',
    });
    expect(JSON.stringify(event)).not.toContain('git-person@elsewhere.example');
    expect(pendingFiles()).toHaveLength(0);

    // the next tick walks the replayed session; the forwarder's own key finds the record the replay created
    await d.tick();
    expect(m.tick).toHaveBeenCalledWith(SESSION, expect.anything());
    const creds = m.tick.mock.calls.filter(([sid]) => sid === SESSION).at(-1)![1];
    const id = forwarderIdentity(creds)!;
    expect(id.owner_hash).toBe(ownerHash('dev.a@example.com'));
    expect(await readRecord(recordKey(id.api_identity, id.owner_hash, SESSION))).toMatchObject({
      kind: 'existing', record: { project: 'proj-at-hook-time', owner_hash: id.owner_hash },
    });

    // idempotent: further ticks add nothing
    await d.tick();
    expect(spooled()).toHaveLength(1);
  });

  it('a leftover .done (crash after append) is never replayed again', async () => {
    m.stored = login('cookie-A');
    m.userInfo.mockRejectedValueOnce(new Error('down'));
    await hook(new HookAdapter());
    const [file] = pendingFiles();
    writeFileSync(file.replace(/\.json$/, '.done'), readFileSync(file));
    rmSync(file);

    m.userInfo.mockResolvedValue(user('a@example.com'));
    later(OWNER_LOOKUP_COOLDOWN_MS + 1);
    await daemon().tick();
    expect(spooled()).toHaveLength(0);
    expect(pendingFiles()).toHaveLength(0);
  });
});

describe('isolation', () => {
  it('account switch: B resolving never replays A\'s held events', async () => {
    m.stored = login('cookie-A');
    m.userInfo.mockRejectedValueOnce(new Error('down'));
    await hook(new HookAdapter());

    m.stored = login('cookie-B');
    m.userInfo.mockResolvedValue(user('b@example.com'));
    later(OWNER_LOOKUP_COOLDOWN_MS + 1);
    await daemon().tick();

    expect(spooled()).toHaveLength(0);
    expect(await readRecord(recordKey(apiIdentity(API), ownerHash('b@example.com'), SESSION))).toBeUndefined();
    expect(pendingFiles()).toHaveLength(1); // still waiting for A's exact login

    // A's exact login resolves later: only then does it replay, under A
    m.stored = login('cookie-A');
    m.userInfo.mockResolvedValue(user('a@example.com'));
    later(OWNER_LOOKUP_COOLDOWN_MS + 1);
    await daemon().tick();
    expect(spooled()).toHaveLength(1);
    expect(await readRecord(recordKey(apiIdentity(API), ownerHash('a@example.com'), SESSION))).toBeDefined();
    expect(await readRecord(recordKey(apiIdentity(API), ownerHash('b@example.com'), SESSION))).toBeUndefined();
  });

  it('another environment\'s login cannot replay it', async () => {
    m.stored = login('cookie-A');
    m.userInfo.mockRejectedValueOnce(new Error('down'));
    await hook(new HookAdapter());

    m.stored = { cookies: { _oauth2_proxy: 'cookie-A' }, apiUrl: 'https://other.example.com/code-assistant-api' };
    m.userInfo.mockResolvedValue(user('a@example.com'));
    later(OWNER_LOOKUP_COOLDOWN_MS + 1);
    await daemon().tick();
    expect(spooled()).toHaveLength(0);
    expect(pendingFiles()).toHaveLength(1);
  });
});

describe('finite retention across restarts', () => {
  it('expires only the aged entry with a visible loss; a later arrival gets its own window', async () => {
    m.stored = login('cookie-A');
    m.userInfo.mockRejectedValue(new Error('down'));
    await hook(new HookAdapter(), 1);

    later(heldRetentionMs() - 60_000);
    await hook(new HookAdapter(), 2); // second entry, younger
    expect(pendingFiles()).toHaveLength(2);

    later(120_000); // first is now past the window; a fresh daemon instance (restart) sweeps
    await daemon().tick();
    expect(pendingFiles()).toHaveLength(1);
    expect(JSON.parse(readFileSync(pendingFiles()[0], 'utf8')).events[0].event_id).toBe('id-2');
    expect((await readStatus(SESSION))?.stampLoss).toMatchObject({ reason: 'owner_unresolved_expired', events: 1 });
    expect(spooled()).toHaveLength(0);
  });
});

describe('unchanged paths', () => {
  it('a resolvable owner still goes the normal way and holds nothing', async () => {
    m.stored = login('cookie-A');
    m.userInfo.mockResolvedValue(user('a@example.com'));
    await hook(new HookAdapter());
    expect(sent).toHaveBeenCalledTimes(1);
    expect(pendingFiles()).toHaveLength(0);
  });

  it('no credentials at all: no hold, previous loss report', async () => {
    m.stored = null;
    await hook(new HookAdapter());
    expect(pendingFiles()).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled(); // fail-closed as before: nothing delivered, nothing held without a login
  });
});
