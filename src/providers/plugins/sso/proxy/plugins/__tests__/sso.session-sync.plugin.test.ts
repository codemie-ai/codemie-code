/**
 * SSO Session Sync Plugin Tests
 *
 * Covers SSOSessionSyncPlugin.createInterceptor guard paths and the
 * SSOSessionSyncInterceptor background timer / final-sync lifecycle.
 *
 * SessionSyncer is fully mocked so no real session discovery or network
 * happens. Timers are faked so we can drive the interval deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../../../../../utils/logger.js';
import { ConfigurationError } from '../../../../../../utils/errors.js';
import type { PluginContext } from '../types.js';

// --- Mock SessionSyncer so sync() is fully controlled (no network / fs) ---
const { syncMock, SessionSyncerMock } = vi.hoisted(() => {
  const syncMock = vi.fn();
  const SessionSyncerMock = vi.fn(function (this: { sync: typeof syncMock }) {
    this.sync = syncMock;
  });
  return { syncMock, SessionSyncerMock };
});

vi.mock('../../../session/SessionSyncer.js', () => ({
  SessionSyncer: SessionSyncerMock
}));

// CredentialRefresher (shared with sso-auth.plugin.ts) re-reads stored credentials from disk/
// keychain — mock it out so this suite stays pure unit (no real I/O, no fake-timer interaction
// with a real pending promise). Defaults to "no fresher credentials found" (null), same as the
// production fallback; individual tests may override to simulate a picked-up re-login.
const { getStoredPlatformCredentials } = vi.hoisted(() => ({ getStoredPlatformCredentials: vi.fn() }));
vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({ getStoredPlatformCredentials }));
vi.mock('@/utils/analytics-auth-status.js', () => ({
  getAnalyticsAuthStatus: vi.fn().mockResolvedValue(null),
}));

// Imported after vi.mock is declared (hoisted anyway).
import { SSOSessionSyncPlugin } from '../sso.session-sync.plugin.js';
import { CredentialRefresher } from '../credential-refresh.js';

const DEFAULT_INTERVAL = 120000;

// Env vars this suite manipulates; snapshot/restore to avoid cross-test leakage.
const MANAGED_ENV = [
  'CODEMIE_SESSION_SYNC_ENABLED',
  'CODEMIE_SESSION_DRY_RUN',
  'CODEMIE_SESSION_SYNC_INTERVAL',
  'CODEMIE_DEV_API_URL',
  'CODEMIE_DEV_API_KEY'
] as const;

function buildContext(overrides: Partial<PluginContext> = {}, syncCodeMieUrl?: string): PluginContext {
  const credentials = 'credentials' in overrides ? overrides.credentials : { cookies: { auth: 'cookie-value' } } as never;
  const syncCredentials = overrides.syncCredentials;
  const refresherParams = { provider: 'ai-run-sso', baseUrl: 'https://api.example.com', codeMieUrl: syncCodeMieUrl };
  // Mirrors sso.proxy.ts: syncCredentialRefresher wraps whichever of syncCredentials/credentials
  // actually has SSO cookies, reusing the same refresher instance as credentialRefresher when
  // it falls back to the identical `credentials` snapshot (PR #661 review).
  const credentialRefresher = credentials
    ? new CredentialRefresher(credentials as never, refresherParams)
    : undefined;
  const syncSource = syncCredentials && 'cookies' in syncCredentials
    ? syncCredentials
    : credentials && 'cookies' in credentials
      ? credentials
      : undefined;
  // Mirrors sso.proxy.ts: a distinct sync source gets params keyed to `syncCodeMieUrl` alone (no
  // `provider`), not the main-profile `refresherParams`, so a refresh re-reads the sync host's
  // own credentials instead of the main profile's (PR #661 review, point 3).
  const syncOnlyRefresherParams = { baseUrl: syncCodeMieUrl as string, codeMieUrl: syncCodeMieUrl };
  const syncCredentialRefresher = !syncSource
    ? undefined
    : syncSource === credentials && credentialRefresher
      ? credentialRefresher
      : new CredentialRefresher(syncSource as never, syncOnlyRefresherParams);
  return {
    config: {
      targetApiUrl: 'https://api.example.com',
      provider: 'ai-run-sso',
      sessionId: 'session-123',
      clientType: 'claude',
      version: '9.9.9',
      // no explicit syncApiUrl / port -> resolves to targetApiUrl
      ...(overrides.config as object)
    },
    logger,
    credentials,
    credentialRefresher,
    syncCredentialRefresher,
    ...overrides
  } as PluginContext;
}

describe('SSOSessionSyncPlugin', () => {
  let plugin: SSOSessionSyncPlugin;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    plugin = new SSOSessionSyncPlugin();

    // Snapshot then clear managed env so each test starts from the defaults.
    envBackup = {};
    for (const key of MANAGED_ENV) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }

    SessionSyncerMock.mockClear();
    syncMock.mockReset();
    syncMock.mockResolvedValue({
      success: true,
      message: 'synced',
      processorResults: {},
      failedProcessors: []
    });
    getStoredPlatformCredentials.mockReset();
    getStoredPlatformCredentials.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of MANAGED_ENV) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  });

  describe('Plugin metadata', () => {
    it('exposes the expected id/name/version and priority 100', () => {
      expect(plugin.id).toBe('@codemie/sso-session-sync');
      expect(plugin.name).toBe('SSO Session Sync (Unified)');
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.priority).toBe(100);
    });
  });

  describe('createInterceptor guards', () => {
    it('creates an interceptor when all conditions are met', async () => {
      const interceptor = await plugin.createInterceptor(buildContext());
      expect(interceptor.name).toBe('sso-session-sync');
      expect(SessionSyncerMock).toHaveBeenCalledTimes(1);
    });

    it('throws ConfigurationError when session id is missing (no timer/sync)', async () => {
      const ctx = buildContext({
        config: {
          targetApiUrl: 'https://api.example.com',
          clientType: 'claude'
          // sessionId omitted
        } as never
      });
      await expect(plugin.createInterceptor(ctx)).rejects.toBeInstanceOf(ConfigurationError);
      expect(SessionSyncerMock).not.toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
    });

    it('throws ConfigurationError when credentials have no cookies (JWT, not SSO)', async () => {
      const ctx = buildContext({
        credentials: { token: 'jwt-token' } as never,
        syncCredentials: undefined
      });
      await expect(plugin.createInterceptor(ctx)).rejects.toBeInstanceOf(ConfigurationError);
      expect(SessionSyncerMock).not.toHaveBeenCalled();
    });

    it('throws ConfigurationError when clientType is missing', async () => {
      const ctx = buildContext({
        config: {
          targetApiUrl: 'https://api.example.com',
          sessionId: 'session-123'
          // clientType omitted
        } as never
      });
      await expect(plugin.createInterceptor(ctx)).rejects.toBeInstanceOf(ConfigurationError);
      expect(SessionSyncerMock).not.toHaveBeenCalled();
    });

    it('throws ConfigurationError when disabled via CODEMIE_SESSION_SYNC_ENABLED=false', async () => {
      process.env.CODEMIE_SESSION_SYNC_ENABLED = 'false';
      await expect(plugin.createInterceptor(buildContext())).rejects.toBeInstanceOf(ConfigurationError);
      expect(SessionSyncerMock).not.toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
    });

    it('honours syncCredentials over credentials for the SSO cookie check', async () => {
      // credentials are JWT-shaped, but syncCredentials carry cookies -> allowed
      const ctx = buildContext({
        credentials: { token: 'jwt' } as never,
        syncCredentials: { cookies: { auth: 'c' } } as never
      });
      const interceptor = await plugin.createInterceptor(ctx);
      expect(interceptor.name).toBe('sso-session-sync');
    });

    it('syncs with the syncCredentials cookies, not the main profile cookies, when both differ (PR #661 review)', async () => {
      // Regression: the shared refresher used to be seeded "credentials first, syncCredentials
      // second", so when the main SSO profile and the sync endpoint point at different
      // environments, sync went out with the main profile's cookies instead of the sync
      // endpoint's own. syncCredentialRefresher now always prefers syncCredentials.
      vi.useFakeTimers();
      const ctx = buildContext({
        credentials: { cookies: { auth: 'main-profile-cookie' } } as never,
        syncCredentials: { cookies: { auth: 'sync-endpoint-cookie' } } as never
      });
      const interceptor = await plugin.createInterceptor(ctx);

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=sync-endpoint-cookie' });

      await interceptor.onProxyStop?.();
    });

    it('keeps the sync endpoint\'s own cookies after a refresh tick, not the main profile\'s (PR #661 review, point 3)', async () => {
      // Regression: syncCredentialRefresher used to re-read with the main refresher's own
      // params (baseUrl: targetApiUrl), so getPlatformUrlCandidates tried the main profile's
      // host first and found it — overwriting the sync cookies with the main profile's on the
      // very next refresh. The lookup is now keyed to `syncCodeMieUrl` alone (no `provider`).
      vi.useFakeTimers();
      const syncCodeMieUrl = 'https://sync.example.com';
      getStoredPlatformCredentials.mockImplementation(async (params: { provider?: string }) => {
        if (params.provider) {
          // Main-profile refresher: would return the main profile's own fresh cookies.
          return {
            credentials: { cookies: { auth: 'main-profile-cookie-refreshed' }, apiUrl: 'https://api.example.com' },
            url: 'https://api.example.com',
          };
        }
        // Sync-only refresher: the sync endpoint's own fresh cookies.
        return {
          credentials: { cookies: { auth: 'sync-endpoint-cookie-refreshed' }, apiUrl: syncCodeMieUrl },
          url: syncCodeMieUrl,
        };
      });

      const ctx = buildContext({
        credentials: { cookies: { auth: 'main-profile-cookie' } } as never,
        syncCredentials: { cookies: { auth: 'sync-endpoint-cookie' } } as never,
      }, syncCodeMieUrl);
      const interceptor = await plugin.createInterceptor(ctx);

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=sync-endpoint-cookie-refreshed' });

      await interceptor.onProxyStop?.();
    });
  });

  describe('credential refresh (PR #655 review: picks up a re-login, not just the LLM-request path)', () => {
    it('rebuilds the cookie header from a freshly re-read credential before each sync tick', async () => {
      vi.useFakeTimers();
      // First tick: no fresher credentials found yet — keeps the startup-snapshot cookie.
      getStoredPlatformCredentials.mockResolvedValueOnce(null);
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=cookie-value' });

      // A browser re-login completed between ticks — the throttle window (5s) has long since
      // elapsed by the next 120s tick, so the next sync must pick up the fresh cookie.
      getStoredPlatformCredentials.mockResolvedValueOnce({
        credentials: { cookies: { auth: 'fresh-after-relogin' }, apiUrl: 'https://api.example.com' },
        url: 'https://api.example.com',
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[1][1]).toMatchObject({ cookies: 'auth=fresh-after-relogin' });

      await interceptor.onProxyStop?.();
    });
  });

  describe('background timer lifecycle', () => {
    it('schedules a repeating sync at the default interval (120s)', async () => {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStart?.();
      expect(syncMock).not.toHaveBeenCalled();

      // Just before the interval: nothing fires.
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL - 1);
      expect(syncMock).not.toHaveBeenCalled();

      // At the interval boundary: one sync.
      await vi.advanceTimersByTimeAsync(1);
      expect(syncMock).toHaveBeenCalledTimes(1);

      // Repeats on the next interval.
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock).toHaveBeenCalledTimes(2);

      await interceptor.onProxyStop?.();
    });

    it('respects a custom CODEMIE_SESSION_SYNC_INTERVAL', async () => {
      vi.useFakeTimers();
      process.env.CODEMIE_SESSION_SYNC_INTERVAL = '5000';
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(4999);
      expect(syncMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(syncMock).toHaveBeenCalledTimes(1);

      await interceptor.onProxyStop?.();
    });

    it('does not overlap an in-flight sync (isSyncing guard)', async () => {
      vi.useFakeTimers();

      // Make sync hang until we release it.
      let release!: () => void;
      const pending = new Promise<void>(resolve => {
        release = resolve;
      });
      syncMock.mockReturnValue(
        pending.then(() => ({
          success: true,
          message: 'synced',
          processorResults: {},
          failedProcessors: []
        }))
      );

      process.env.CODEMIE_SESSION_SYNC_INTERVAL = '1000';
      const interceptor = await plugin.createInterceptor(buildContext());
      await interceptor.onProxyStart?.();

      // Fire two intervals while the first sync is still pending.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      // Only ONE sync started; the second tick was skipped by the guard.
      expect(syncMock).toHaveBeenCalledTimes(1);

      // Release the in-flight sync, then the next tick can run again.
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(syncMock).toHaveBeenCalledTimes(2);

      await interceptor.onProxyStop?.();
    });
  });

  describe('onProxyStop', () => {
    it('clears the timer AND performs exactly one final sync', async () => {
      vi.useFakeTimers();
      process.env.CODEMIE_SESSION_SYNC_INTERVAL = '1000';
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(1000); // one periodic sync
      expect(syncMock).toHaveBeenCalledTimes(1);

      await interceptor.onProxyStop?.(); // final sync
      expect(syncMock).toHaveBeenCalledTimes(2);

      // Timer was cleared: further time advances produce no more syncs.
      await vi.advanceTimersByTimeAsync(5000);
      expect(syncMock).toHaveBeenCalledTimes(2);
    });

    it('performs a final sync even if the proxy was never started', async () => {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStop?.();
      expect(syncMock).toHaveBeenCalledTimes(1);
    });

    it('swallows errors from the final sync (does not reject)', async () => {
      vi.useFakeTimers();
      syncMock.mockRejectedValueOnce(new Error('boom'));
      const interceptor = await plugin.createInterceptor(buildContext());

      await expect(interceptor.onProxyStop?.()).resolves.toBeUndefined();
      expect(syncMock).toHaveBeenCalledTimes(1);
    });
  });
});
