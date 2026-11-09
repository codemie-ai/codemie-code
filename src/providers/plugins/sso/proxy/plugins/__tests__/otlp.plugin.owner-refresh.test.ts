/**
 * EPMCDME-16776 review R1: a re-login / account switch while the daemon runs, with NO stale marker and NO outgoing
 * rejection, must still move the forwarder to the stored login the hooks stamp with. Real: OtlpInterceptor tick,
 * withVerifiedOwner, forwarderIdentity. Mocked: the stored-credential read, the spool walk and the `/v1/user` call.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext } from '../types.js';

const m = vi.hoisted(() => ({
  stored: undefined as unknown,
  fresh: vi.fn(),
  userInfo: vi.fn(),
  tick: vi.fn(),
}));

vi.mock('../otlp-spool/auth-state.js', () => ({
  areCredentialsStale: () => false, // never set: neither credential-owner nor policy errors mark it
  clearCredentialsStale: vi.fn(),
  markCredentialsStale: vi.fn(),
  resolveFreshCredentials: m.fresh,
}));
vi.mock('../otlp-spool/spool-paths.js', async (orig) => ({
  ...(await orig<object>()),
  listSessionIds: async () => ['sess-1'],
}));
vi.mock('../otlp-spool/tick-processor.js', () => ({ processSessionTick: m.tick }));
vi.mock('@/providers/core/codemie-auth-helpers.js', async (orig) => ({
  ...(await orig<object>()),
  fetchCodeMieUserInfo: m.userInfo,
}));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { OtlpPlugin } = await import('../otlp.plugin.js');
const { CREDENTIAL_REFRESH_INTERVAL_MS } = await import('../credential-refresh.js');
const { withVerifiedOwner } = await import('@/providers/core/credential-owner.js');
const { forwarderIdentity } = await import('../otlp-spool/spool-io.js');
const { ownerHash } = await import('@/agents/core/evidence/api-identity.js');

const API = 'https://codemie.example.com/code-assistant-api';
const login = (cookie: string) => ({ cookies: { _oauth2_proxy: cookie }, apiUrl: API });
const user = (email: string) => ({ userId: 'u', name: 'n', username: 'x', email, applications: [], applications_admin: [] });

let home = '';
const priorHome = process.env.CODEMIE_HOME;
const tickOf = (interceptor: unknown) => (interceptor as { tick: () => Promise<void> }).tick();
const sentOwner = (call: number) => forwarderIdentity(m.tick.mock.calls[call][1])?.owner_hash;
function daemonStartedWith(creds: unknown) {
  return new OtlpPlugin().createInterceptor({ credentials: creds, config: { targetApiUrl: API } } as unknown as PluginContext);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owner-refresh-'));
  process.env.CODEMIE_HOME = home;
  vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
  m.fresh.mockReset().mockImplementation(async () => m.stored);
  m.userInfo.mockReset();
  m.tick.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  if (priorHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

describe('OtlpInterceptor tick follows the stored login without a stale marker', () => {
  it('A -> B: forwards under B, the same identity the hook derives from the stored login', async () => {
    m.userInfo.mockImplementation(async (_api: string, cookies: Record<string, string>) =>
      user(cookies._oauth2_proxy === 'A' ? 'a@example.com' : 'b@example.com'));
    m.stored = login('A');
    const interceptor = daemonStartedWith(login('A'));

    await tickOf(interceptor);
    expect(sentOwner(0)).toBe(ownerHash('a@example.com'));

    m.stored = login('B'); // user signs in as someone else; the daemon is not restarted
    vi.setSystemTime(Date.now() + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
    await tickOf(interceptor);

    const hookSide = forwarderIdentity(await withVerifiedOwner(login('B')));
    expect(sentOwner(1)).toBe(ownerHash('b@example.com'));
    expect(sentOwner(1)).toBe(hookSide!.owner_hash);
  });

  it('old login rejected by /v1/user -> still moves to the fresh stored login', async () => {
    m.userInfo.mockImplementation(async (_api: string, cookies: Record<string, string>) => {
      if (cookies._oauth2_proxy === 'A') throw new Error('Authentication failed - invalid or expired credentials');
      return user('b@example.com');
    });
    m.stored = login('A');
    const interceptor = daemonStartedWith(login('A'));

    await tickOf(interceptor);
    expect(sentOwner(0)).toBeUndefined(); // no owner invented for the rejected login

    m.stored = login('B');
    vi.setSystemTime(Date.now() + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
    await tickOf(interceptor);
    expect(sentOwner(1)).toBe(ownerHash('b@example.com'));
  });

  it('re-reads the store at most once per interval and keeps the snapshot when nothing is stored', async () => {
    m.userInfo.mockResolvedValue(user('a@example.com'));
    m.stored = login('A');
    const interceptor = daemonStartedWith(login('A'));

    await tickOf(interceptor);
    await tickOf(interceptor);
    await tickOf(interceptor);
    expect(m.fresh).toHaveBeenCalledTimes(1);

    m.stored = null; // expired / cleared: keep the last known-good login
    vi.setSystemTime(Date.now() + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
    await tickOf(interceptor);
    expect(m.fresh).toHaveBeenCalledTimes(2);
    expect(sentOwner(3)).toBe(ownerHash('a@example.com'));
  });

  it('once the daemon converged on B, alternating cache records cost no further lookups', async () => {
    m.userInfo.mockResolvedValue(user('b@example.com'));
    m.stored = login('B');
    const interceptor = daemonStartedWith(login('A'));
    await withVerifiedOwner(login('B')); // hook side wrote B's record

    await tickOf(interceptor);
    const afterConverge = m.userInfo.mock.calls.length;
    vi.setSystemTime(Date.now() + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
    await tickOf(interceptor);
    await withVerifiedOwner(login('B'));
    expect(m.userInfo.mock.calls.length).toBe(afterConverge);
  });
});
