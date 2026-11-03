import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

// Real analytics-auth-status marker and sso-login.lock files, isolated in a temp CODEMIE_HOME.
vi.mock('@/utils/paths.js', () => ({
  getCodemiePath: (...parts: string[]) => join(tempDir, ...parts),
  getDirname: () => '/fake/dist/providers/plugins/sso',
}));
vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({
  getStoredPlatformCredentials: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getStoredPlatformCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { markAnalyticsAuthInvalid, clearAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { releaseLoginLockOnSuccess } from '@/providers/plugins/sso/sso.detached-login.js';
import { STORE_READ_DEADLINE_MS, PROXY_STORE_READ_DEADLINE_MS } from '@/providers/plugins/sso/session/cookie-auth.js';
import { CredentialRefresher, CREDENTIAL_REFRESH_INTERVAL_MS } from '../credential-refresh.js';

const URL_ = 'https://codemie.example.com';

interface Creds {
  cookies: Record<string, string>;
  apiUrl: string;
  expiresAt: number;
}

function creds(token: string): Creds {
  return { cookies: { codemie_access_token: token }, apiUrl: URL_, expiresAt: Date.now() + 3_600_000 };
}

async function stampLock(succeededAt: number): Promise<void> {
  await writeFile(join(tempDir, 'sso-login.lock'), JSON.stringify({ pid: process.pid, startedAt: succeededAt - 1_000, succeededAt }));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type StoreResult = { credentials: Creds; url: string } | null;

function storeReturns(value: StoreResult): void {
  vi.mocked(getStoredPlatformCredentials).mockImplementation(async () => value as never);
}

function storeYields(next: Promise<StoreResult>): void {
  vi.mocked(getStoredPlatformCredentials).mockImplementationOnce(() => next as never);
}

// refresh() reads the marker and lock files before it reaches the store, so the wait is by wall
// clock: a tick count runs out first on a loaded machine. Some tests fake setTimeout, so the
// real one is captured before any test installs fake timers.
const realSetTimeout = globalThis.setTimeout;

async function untilStoreCalls(count: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (vi.mocked(getStoredPlatformCredentials).mock.calls.length < count && performance.now() < deadline) {
    await new Promise((r) => realSetTimeout(r, 1));
  }
  expect(vi.mocked(getStoredPlatformCredentials)).toHaveBeenCalledTimes(count);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function token(c: Creds | null): string | undefined {
  return c?.cookies.codemie_access_token;
}

function newRefresher(initial: Creds): CredentialRefresher<Creds & never> {
  return new CredentialRefresher(initial as never, { provider: 'ai-run-sso', baseUrl: URL_ });
}

describe('CredentialRefresher', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cred-refresh-'));
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('serves the re-login cookies to the next request even when the whole sign-in happened between two refreshes inside the throttle window (EPMCDME-16568 double browser)', async () => {
    const t0 = Date.now();
    const stale = { cookies: { codemie_access_token: 'stale' }, apiUrl: URL_, expiresAt: t0 + 3_600_000 };
    const fresh = { cookies: { codemie_access_token: 'fresh' }, apiUrl: URL_, expiresAt: t0 + 3_600_000 };
    let stored = stale;
    vi.mocked(getStoredPlatformCredentials).mockImplementation(async () => ({ credentials: stored, url: URL_ }));
    const refresher = new CredentialRefresher(stale, { provider: 'ai-run-sso', baseUrl: URL_ });

    // Request A injects the stored (server-side revoked) cookies.
    expect((await refresher.refresh()).cookies.codemie_access_token).toBe('stale');

    // Upstream answers request A with the oauth2-proxy redirect: SSOSessionExpiryPlugin marks
    // auth invalid and spawns the detached sign-in child, which owns the lock.
    await markAnalyticsAuthInvalid('oauth2-proxy session-expiry redirect', URL_);
    await writeFile(join(tempDir, 'sso-login.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    // IdP session still active, so the sign-in completes ~2s later (sso.auth.ts + sso-login.ts).
    vi.setSystemTime(t0 + 2_000);
    stored = fresh;
    await clearAnalyticsAuthStatus();
    await releaseLoginLockOnSuccess();

    // Request B (the auto-resumed prompt) arrives before the throttle window has elapsed.
    vi.setSystemTime(t0 + 2_700);
    expect(2_700).toBeLessThan(CREDENTIAL_REFRESH_INTERVAL_MS);
    expect((await refresher.refresh()).cookies.codemie_access_token).toBe('fresh');
  });
  describe('lock-stamp bypass', () => {
    it('does not bypass the throttle when the stamp is unchanged', async () => {
      const t0 = Date.now();
      await stampLock(t0 - 60_000);
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));

      expect(token(await refresher.refresh())).toBe('a');
      storeReturns({ credentials: creds('b'), url: URL_ });
      vi.setSystemTime(t0 + 1_000);
      expect(token(await refresher.refresh())).toBe('a');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(1);
    });

    it('does not read on every call after the clock steps back', async () => {
      const t0 = Date.now();
      await stampLock(t0 - 60_000);
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));

      await refresher.refresh();
      vi.setSystemTime(t0 - 120_000);
      await refresher.refresh();
      await refresher.refresh();
      await refresher.refresh();
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an empty', (): void => storeReturns(null)],
      ['a failed', (): void => {
        vi.mocked(getStoredPlatformCredentials).mockRejectedValue(new Error('keychain locked'));
      }],
    ])('%s read after a stamp change causes no second read inside the window', async (_label, arrange) => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      arrange();
      vi.setSystemTime(t0 + 1_000);
      expect(token(await refresher.refresh())).toBe('a');
      vi.setSystemTime(t0 + 1_500);
      expect(token(await refresher.refresh())).toBe('a');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    });

    it('two concurrent refresh() calls after a stamp change both get the new credentials from one store read', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('old'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      vi.setSystemTime(t0 + 1_000);
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);
      const first = refresher.refresh();
      const second = refresher.refresh();
      await untilStoreCalls(2);
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });
      await flush();
      expect(secondSettled).toBe(false);

      slow.resolve({ credentials: creds('new'), url: URL_ });
      expect(token(await first)).toBe('new');
      expect(token(await second)).toBe('new');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    });

    it('a call during a plain throttle read returns the snapshot at once', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      vi.setSystemTime(t0 + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);
      const throttleRead = refresher.refresh();
      await untilStoreCalls(2);

      expect(token(await refresher.refresh())).toBe('a');
      slow.resolve({ credentials: creds('b'), url: URL_ });
      expect(token(await throttleRead)).toBe('b');
    });

    it('a failed bypass read resolves its followers with the unchanged snapshot and frees the slot', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      vi.setSystemTime(t0 + 1_000);
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);
      const leader = refresher.refresh();
      await untilStoreCalls(2);
      const follower = refresher.refresh();
      let followerSettled = false;
      void follower.then(() => {
        followerSettled = true;
      });
      await flush();
      expect(followerSettled).toBe(false);
      slow.resolve(null);
      expect(token(await leader)).toBe('a');
      expect(token(await follower)).toBe('a');

      // Slot is free: once the window has passed, a later read starts on its own.
      await stampLock(t0 + 2_000);
      vi.setSystemTime(t0 + 1_000 + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
      storeReturns({ credentials: creds('c'), url: URL_ });
      expect(token(await refresher.refresh())).toBe('c');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['an empty', (): void => storeReturns(null)],
      ['a failed', (): void => {
        vi.mocked(getStoredPlatformCredentials).mockRejectedValue(new Error('keychain locked'));
      }],
    ])('%s read after a stamp change keeps the old snapshot and leaves the stamp unspent until the window has passed', async (_label, arrange) => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      arrange();
      vi.setSystemTime(t0 + 1_000);
      expect(token(await refresher.refresh())).toBe('a');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);

      storeReturns({ credentials: creds('new'), url: URL_ });
      vi.setSystemTime(t0 + 1_000 + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
      expect(token(await refresher.refresh())).toBe('new');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(3);
    });

    it('a second call inside the window of a failed stamp-change read does not start another read', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      storeReturns(null);
      vi.setSystemTime(t0 + 1_000);
      await refresher.refresh();
      storeReturns({ credentials: creds('new'), url: URL_ });
      vi.setSystemTime(t0 + 1_000 + CREDENTIAL_REFRESH_INTERVAL_MS - 1);
      expect(token(await refresher.refresh())).toBe('a');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    });

    it('a successful read consumes the stamp, so an unchanged stamp does not bypass the throttle again', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      storeReturns({ credentials: creds('b'), url: URL_ });
      vi.setSystemTime(t0 + 1_000);
      expect(token(await refresher.refresh())).toBe('b');

      storeReturns({ credentials: creds('c'), url: URL_ });
      vi.setSystemTime(t0 + 1_500);
      expect(token(await refresher.refresh())).toBe('b');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    });
  });

  describe('sign-ins that finished before the daemon started', () => {
    async function settlesWhileStorePending(call: Promise<unknown>): Promise<boolean> {
      let settled = false;
      void call.then(() => {
        settled = true;
      });
      await flush();
      return settled;
    }

    it('a stamp older than the refresher is not treated as a new sign-in: a concurrent caller is not held for the read', async () => {
      const t0 = Date.now();
      await stampLock(t0 - 60_000);
      const refresher = newRefresher(creds('init'));
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);

      vi.setSystemTime(t0 + 1_000);
      const leader = refresher.refresh();
      await untilStoreCalls(1);

      expect(await settlesWhileStorePending(refresher.refresh())).toBe(true);
      slow.resolve({ credentials: creds('a'), url: URL_ });
      expect(token(await leader)).toBe('a');
    });

    it('an older stamp stays remembered after a failed read: the next read is a plain throttled one, not a bypass', async () => {
      const t0 = Date.now();
      await stampLock(t0 - 60_000);
      const refresher = newRefresher(creds('init'));
      storeReturns(null);
      await refresher.refresh();

      vi.setSystemTime(t0 + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);
      const leader = refresher.refresh();
      await untilStoreCalls(2);

      expect(await settlesWhileStorePending(refresher.refresh())).toBe(true);
      slow.resolve({ credentials: creds('a'), url: URL_ });
      expect(token(await leader)).toBe('a');
    });

    it('a stamp newer than the refresher takes the bypass path', async () => {
      const t0 = Date.now();
      const refresher = newRefresher(creds('init'));

      await stampLock(t0 + 500);
      vi.setSystemTime(t0 + 1_000);
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);
      const leader = refresher.refresh();
      await untilStoreCalls(1);
      const follower = refresher.refresh();
      let followerSettled = false;
      void follower.then(() => {
        followerSettled = true;
      });
      await flush();
      expect(followerSettled).toBe(false);

      slow.resolve({ credentials: creds('new'), url: URL_ });
      expect(token(await leader)).toBe('new');
      expect(token(await follower)).toBe('new');
    });

    it('a stamp that changes after an older one was remembered takes the bypass path', async () => {
      const t0 = Date.now();
      await stampLock(t0 - 60_000);
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      storeReturns({ credentials: creds('fresh'), url: URL_ });
      vi.setSystemTime(t0 + 1_000);
      expect(token(await refresher.refresh())).toBe('fresh');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    });
  });

  describe('marker edge', () => {
    it('a failed read does not spend the marker edge: it is held for the window, then served as a bypass again', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await markAnalyticsAuthInvalid('HTTP 401', URL_);
      vi.setSystemTime(t0 + 1_000);
      await refresher.refresh();
      await clearAnalyticsAuthStatus();

      // The re-login cleared the marker, but the store read it triggers fails.
      storeReturns(null);
      vi.setSystemTime(t0 + 2_000);
      expect(token(await refresher.refresh())).toBe('a');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);

      // Inside the window of that failed read nothing else is read.
      storeReturns({ credentials: creds('new'), url: URL_ });
      vi.setSystemTime(t0 + 2_000 + CREDENTIAL_REFRESH_INTERVAL_MS - 1);
      expect(token(await refresher.refresh())).toBe('a');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);

      // Past the window the edge fires again as a bypass: a concurrent caller waits for the read.
      vi.setSystemTime(t0 + 2_000 + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);
      const leader = refresher.refresh();
      await untilStoreCalls(3);
      const follower = refresher.refresh();
      let followerSettled = false;
      void follower.then(() => {
        followerSettled = true;
      });
      await flush();
      expect(followerSettled).toBe(false);
      slow.resolve({ credentials: creds('new'), url: URL_ });
      expect(token(await leader)).toBe('new');
      expect(token(await follower)).toBe('new');
    });

    it('a successful read spends the marker edge', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await markAnalyticsAuthInvalid('HTTP 401', URL_);
      vi.setSystemTime(t0 + 1_000);
      await refresher.refresh();
      await clearAnalyticsAuthStatus();
      storeReturns({ credentials: creds('b'), url: URL_ });
      vi.setSystemTime(t0 + 2_000);
      expect(token(await refresher.refresh())).toBe('b');

      storeReturns({ credentials: creds('c'), url: URL_ });
      vi.setSystemTime(t0 + 2_500);
      expect(token(await refresher.refresh())).toBe('b');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshNow()', () => {
    it('starts its own read while a throttle read is in flight and gets the post-sign-in store', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      vi.setSystemTime(t0 + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);
      const throttleRead = refresher.refresh();
      await untilStoreCalls(2);

      // Sign-in finishes while the throttle read (begun before it) is still pending.
      storeReturns({ credentials: creds('fresh'), url: URL_ });
      const now = await refresher.refreshNow();
      expect(token(now)).toBe('fresh');
      expect(token(refresher.get())).toBe('fresh');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(3);

      // The older throttle read finishes late with the pre-sign-in store: no overwrite.
      slow.resolve({ credentials: creds('a'), url: URL_ });
      await throttleRead;
      expect(token(refresher.get())).toBe('fresh');
    });

    it('concurrent refreshNow() calls share one read', async () => {
      storeReturns({ credentials: creds('fresh'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      const [a, b] = await Promise.all([refresher.refreshNow(), refresher.refreshNow()]);
      expect(token(a)).toBe('fresh');
      expect(token(b)).toBe('fresh');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(1);
    });

    it('returns null and keeps the snapshot on an empty or failed read', async () => {
      const refresher = newRefresher(creds('init'));
      storeReturns(null);
      expect(await refresher.refreshNow()).toBeNull();
      vi.mocked(getStoredPlatformCredentials).mockRejectedValue(new Error('boom'));
      expect(await refresher.refreshNow()).toBeNull();
      expect(token(refresher.get())).toBe('init');
    });

    it('records the stamp so the next refresh() does not re-read', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      vi.setSystemTime(t0 + 1_000);
      storeReturns({ credentials: creds('fresh'), url: URL_ });
      expect(token(await refresher.refreshNow())).toBe('fresh');
      vi.setSystemTime(t0 + 1_500);
      expect(token(await refresher.refresh())).toBe('fresh');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    });

    it('does not consume the stamp on a failed read, so refresh() reads again once the window has passed', async () => {
      const t0 = Date.now();
      storeReturns({ credentials: creds('a'), url: URL_ });
      const refresher = newRefresher(creds('init'));
      await refresher.refresh();

      await stampLock(t0 + 500);
      storeReturns(null);
      vi.setSystemTime(t0 + 1_000);
      expect(await refresher.refreshNow()).toBeNull();
      expect(token(refresher.get())).toBe('a');

      storeReturns({ credentials: creds('new'), url: URL_ });
      vi.setSystemTime(t0 + 1_000 + CREDENTIAL_REFRESH_INTERVAL_MS + 1);
      expect(token(await refresher.refresh())).toBe('new');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(3);
    });

    it('waits longer than a one-shot process does for a slow store: a read slower than the short deadline still lands', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      expect(PROXY_STORE_READ_DEADLINE_MS).toBeGreaterThan(STORE_READ_DEADLINE_MS);
      const refresher = newRefresher(creds('init'));
      const slow = deferred<StoreResult>();
      storeYields(slow.promise);

      let settled = false;
      const read = refresher.refreshNow().then((value) => {
        settled = true;
        return value;
      });
      await untilStoreCalls(1);
      await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS + 1_000);
      expect(settled).toBe(false);

      slow.resolve({ credentials: creds('late-but-in-time'), url: URL_ });
      expect(token(await read)).toBe('late-but-in-time');
    });

    it('returns null after the proxy deadline on a never-answering store; the next call starts a fresh read at once', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const refresher = newRefresher(creds('init'));
      const hung = deferred<StoreResult>();
      storeYields(hung.promise);

      const first = refresher.refreshNow();
      await untilStoreCalls(1);
      await vi.advanceTimersByTimeAsync(PROXY_STORE_READ_DEADLINE_MS);
      expect(await first).toBeNull();
      expect(token(refresher.get())).toBe('init');

      // The abandoned read is still unsettled; the next call reads fresh anyway.
      storeReturns({ credentials: creds('fresh'), url: URL_ });
      expect(token(await refresher.refreshNow())).toBe('fresh');
      expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);

      // The abandoned read's late result is ignored.
      hung.resolve({ credentials: creds('late'), url: URL_ });
      await new Promise((r) => setImmediate(r));
      expect(token(refresher.get())).toBe('fresh');
    });
  });
});
