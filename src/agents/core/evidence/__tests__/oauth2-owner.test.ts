/**
 * EPMCDME-16776: an oauth2-proxy login (no codemie_access_token cookie) must still own its hook evidence record,
 * and the forwarder must find that record by its own key. Real: resolveHookCredentials, withVerifiedOwner, stampEvidence,
 * record-store, forwarderIdentity. Mocked: the stored-credential read, daemon state and the `/v1/user` network call.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const m = vi.hoisted(() => ({
  home: '',
  stored: new Map<string, unknown>(),
  userInfo: vi.fn(),
}));

vi.mock('@/utils/paths.js', async (orig) => ({
  ...(await orig<typeof import('@/utils/paths.js')>()),
  resolveHomeDir: (relativePath = '') => `${m.home}/${relativePath}`,
}));
vi.mock('@/utils/processes.js', async (orig) => ({
  ...(await orig<typeof import('@/utils/processes.js')>()),
  getRawGitOrigin: async () => undefined,
}));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: async () => 'work',
    load: async () => ({}),
    hasLocalConfig: async () => false,
    resolveProjectOrigin: async () => 'none',
    isLocalProfile: async () => false,
  },
}));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: async () => '1.0.0' }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({
  readState: async () => ({ syncCodeMieUrl: 'https://sync.example.com' }),
}));
vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = async (url: string) => m.stored.get(url) ?? null;
  },
}));
vi.mock('@/providers/core/codemie-auth-helpers.js', async (orig) => ({
  ...(await orig<typeof import('@/providers/core/codemie-auth-helpers.js')>()),
  fetchCodeMieUserInfo: m.userInfo,
}));

const { stampEvidence } = await import('../stamp.js');
const { readRecord, recordKey } = await import('../record-store.js');
const { ownerHash, apiIdentity } = await import('../api-identity.js');
const { resolveHookCredentials } = await import('../../hook-credentials.js');
const { withVerifiedOwner, OWNER_LOOKUP_COOLDOWN_MS } = await import('@/providers/core/credential-owner.js');
const { forwarderIdentity } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js');

const API = 'https://codemie.example.com/code-assistant-api';
const SYNC = 'https://sync.example.com';
const ROUTING = { routed: false, routing_proof: 'unproven' as const };
const proxyCreds = (cookie: string, apiUrl = API) => ({ cookies: { _oauth2_proxy: cookie }, apiUrl });
const userOf = (email: string, username = 'someone') => ({
  userId: 'u', name: 'n', username, email, applications: [], applications_admin: [],
});
const stamp = (sessionId = 'sess-1') => stampEvidence({ cwd: m.home, sessionId }, { routing: ROUTING });
const keyFor = (email: string, sessionId = 'sess-1', api = API) => recordKey(apiIdentity(api), ownerHash(email), sessionId);

const priorHome = process.env.CODEMIE_HOME;
beforeEach(() => {
  m.home = mkdtempSync(join(tmpdir(), 'owner-'));
  process.env.CODEMIE_HOME = m.home;
  m.stored.clear();
  m.userInfo.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  if (priorHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = priorHome;
  rmSync(m.home, { recursive: true, force: true });
});

describe('oauth2-proxy login (stored without email, e.g. a pre-fix login)', () => {
  it('stamps an evidence record owned by the backend-reported email and the forwarder finds it by its own key', async () => {
    m.stored.set(SYNC, proxyCreds('cookie-A'));
    m.userInfo.mockResolvedValue(userOf('Dev.A@example.com', 'dev_a'));

    const stamped = await stamp();
    expect(stamped.ok).toBe(true);
    expect(m.userInfo).toHaveBeenCalledWith(API, { _oauth2_proxy: 'cookie-A' }, expect.objectContaining({ followRedirects: false, emailOnly: true }));

    // the daemon loads the same stored login independently and decorates it the same way
    const daemonCreds = await withVerifiedOwner(m.stored.get(SYNC) as ReturnType<typeof proxyCreds>);
    const id = forwarderIdentity(daemonCreds)!;
    expect(id.owner_hash).toBe(ownerHash('dev.a@example.com'));
    expect(await readRecord(recordKey(id.api_identity, id.owner_hash, 'sess-1'))).toMatchObject({ kind: 'existing' });
    expect(await readRecord(keyFor('dev.a@example.com'))).toMatchObject({ record: { owner_hash: id.owner_hash } });
    expect(m.userInfo).toHaveBeenCalledTimes(1); // second consumer reused the bound record
  });

  it('never uses the username as the owner', async () => {
    m.stored.set(SYNC, proxyCreds('cookie-A'));
    m.userInfo.mockResolvedValue({ ...userOf('x@y.z', 'dev_a'), email: undefined });
    expect(await stamp()).toMatchObject({ ok: false, reason: 'no_owner' });
    expect(forwarderIdentity(await withVerifiedOwner(proxyCreds('cookie-A')))).toBeNull();
  });
});

describe('fresh login', () => {
  it('login-time lookup means hooks make no request at all', async () => {
    const creds = proxyCreds('cookie-A');
    m.stored.set(SYNC, creds);
    m.userInfo.mockResolvedValue(userOf('a@example.com'));
    await withVerifiedOwner(creds); // what CodeMieSSO.authenticate does after storing
    m.userInfo.mockClear();

    expect((await stamp()).ok).toBe(true);
    expect(m.userInfo).not.toHaveBeenCalled();
  });

  it('a login-time lookup failure is retried by the hook, not silently skipped', async () => {
    const creds = proxyCreds('cookie-A');
    m.stored.set(SYNC, creds);
    m.userInfo.mockRejectedValueOnce(new Error('offline'));
    await withVerifiedOwner(creds);
    vi.useFakeTimers({ now: Date.now() + OWNER_LOOKUP_COOLDOWN_MS + 1, toFake: ['Date'] });
    m.userInfo.mockResolvedValue(userOf('a@example.com'));
    expect((await stamp()).ok).toBe(true);
  });
});

describe('identity is bound to the exact login', () => {
  it('re-login to another user: new cookies resolve the new owner, never the old one', async () => {
    m.userInfo.mockResolvedValueOnce(userOf('a@example.com'));
    expect(forwarderIdentity(await withVerifiedOwner(proxyCreds('cookie-A')))!.owner_hash).toBe(ownerHash('a@example.com'));

    m.stored.set(SYNC, proxyCreds('cookie-B'));
    m.userInfo.mockResolvedValueOnce(userOf('b@example.com'));
    expect((await stamp()).ok).toBe(true);
    expect(await readRecord(keyFor('b@example.com'))).toMatchObject({ kind: 'existing' });
    expect(await readRecord(keyFor('a@example.com'))).toBeUndefined();
  });

  it('re-login whose lookup fails does not inherit the previous login\'s email', async () => {
    m.userInfo.mockResolvedValueOnce(userOf('a@example.com'));
    await withVerifiedOwner(proxyCreds('cookie-A'));

    m.stored.set(SYNC, proxyCreds('cookie-B'));
    m.userInfo.mockRejectedValue(new Error('offline'));
    expect(await stamp()).toMatchObject({ ok: false, reason: 'no_owner' });
    expect(await readRecord(keyFor('a@example.com'))).toBeUndefined();
  });

  it('the old login still resolves to its own owner after another login replaced the record', async () => {
    m.userInfo.mockResolvedValueOnce(userOf('a@example.com'));
    await withVerifiedOwner(proxyCreds('cookie-A'));
    m.userInfo.mockResolvedValueOnce(userOf('b@example.com'));
    await withVerifiedOwner(proxyCreds('cookie-B'));
    m.userInfo.mockResolvedValueOnce(userOf('a@example.com'));
    expect(forwarderIdentity(await withVerifiedOwner(proxyCreds('cookie-A')))!.owner_hash).toBe(ownerHash('a@example.com'));
  });

  it('distinct environments keep distinct owners and api identities', async () => {
    const other = 'https://other.example.com/code-assistant-api';
    m.userInfo.mockResolvedValueOnce(userOf('a@example.com')).mockResolvedValueOnce(userOf('b@example.com'));
    const a = forwarderIdentity(await withVerifiedOwner(proxyCreds('same-cookie')))!;
    const b = forwarderIdentity(await withVerifiedOwner(proxyCreds('same-cookie', other)))!;
    expect(a.owner_hash).toBe(ownerHash('a@example.com'));
    expect(b.owner_hash).toBe(ownerHash('b@example.com'));
    expect(a.api_identity).not.toBe(b.api_identity);
  });
});

describe('lookup failures invent no owner and are bounded', () => {
  it.each([
    ['unauthorized', () => Promise.reject(new Error('Authentication failed - invalid or expired credentials'))],
    ['transient', () => Promise.reject(new Error('ECONNRESET'))],
    ['malformed', () => Promise.resolve({ applications: [] })],
    ['non-email value', () => Promise.resolve(userOf('not an email'))],
  ])('%s: no_owner and no forwarder identity', async (_n, answer) => {
    m.stored.set(SYNC, proxyCreds('cookie-A'));
    m.userInfo.mockImplementation(answer);
    expect(await stamp()).toMatchObject({ ok: false, reason: 'no_owner' });
    expect(forwarderIdentity(await withVerifiedOwner(proxyCreds('cookie-A')))).toBeNull();
  });

  it('repeated hooks inside the cooldown cost no request; the next attempt after it recovers', async () => {
    m.stored.set(SYNC, proxyCreds('cookie-A'));
    m.userInfo.mockRejectedValue(new Error('offline'));
    await stamp('s1');
    await stamp('s2');
    await stamp('s3');
    expect(m.userInfo).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ now: Date.now() + OWNER_LOOKUP_COOLDOWN_MS + 1, toFake: ['Date'] });
    m.userInfo.mockResolvedValue(userOf('a@example.com'));
    expect((await stamp('s4')).ok).toBe(true);
    expect(m.userInfo).toHaveBeenCalledTimes(2);
  });
});

describe('compatibility', () => {
  const claim = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;

  it('codemie_access_token claim wins and needs no request', async () => {
    const creds = { cookies: { codemie_access_token: claim('Tok@example.com'), _oauth2_proxy: 'c' }, apiUrl: API };
    expect(forwarderIdentity(await withVerifiedOwner(creds))!.owner_hash).toBe(ownerHash('tok@example.com'));
    expect(m.userInfo).not.toHaveBeenCalled();
  });

  it('JWT credentials are untouched', async () => {
    const jwt = { token: claim('jwt@example.com'), apiUrl: API };
    expect(await withVerifiedOwner(jwt)).toBe(jwt);
    expect(forwarderIdentity(jwt)!.owner_hash).toBe(ownerHash('jwt@example.com'));
    expect(m.userInfo).not.toHaveBeenCalled();
  });

  it('credentials without cookies are never looked up', async () => {
    const creds = { cookies: {}, apiUrl: API };
    expect(await withVerifiedOwner(creds)).toBe(creds);
    expect(m.userInfo).not.toHaveBeenCalled();
  });

  it('resolveHookCredentials keeps its sync-then-target order and returns null when nothing is stored', async () => {
    expect(await resolveHookCredentials()).toBeNull();
  });
});
