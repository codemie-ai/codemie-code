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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedRequest } from '../../../session/bounded-request.js';

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

// CredentialRefresher (shared with auth-injection.plugin.ts) re-reads stored credentials from disk/
// keychain through the SSO auth resolver — mock that out so this suite stays pure unit (no real
// I/O, no fake-timer interaction with a real pending promise). Defaults to "no fresher credentials
// found" (null), same as the production fallback; individual tests may override to simulate a
// picked-up re-login.
const { resolveSSOAuth } = vi.hoisted(() => ({ resolveSSOAuth: vi.fn() }));
vi.mock('@/providers/plugins/sso/auth/resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/auth/resolver.js')>()),
  resolveSSOAuth,
}));
vi.mock('@/utils/analytics-auth-status.js', () => ({
  getAnalyticsAuthStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({
  getLastSignInAt: vi.fn().mockResolvedValue(null),
}));

// Imported after vi.mock is declared (hoisted anyway).
import { SSOSessionSyncPlugin } from '../sso.session-sync.plugin.js';
import { CredentialRefresher } from '../credential-refresh.js';
import { toSSOAuth } from '@/providers/plugins/sso/auth/selection.js';
import type { SSOAuth } from '@/providers/plugins/sso/auth/types.js';

const DEFAULT_INTERVAL = 120000;

// Env vars this suite manipulates; snapshot/restore to avoid cross-test leakage.
const MANAGED_ENV = [
  'CODEMIE_SESSION_SYNC_ENABLED',
  'CODEMIE_SESSION_DRY_RUN',
  'CODEMIE_SESSION_SYNC_INTERVAL',
  'CODEMIE_DEV_API_URL',
  'CODEMIE_DEV_API_KEY'
] as const;

/** A stored record shape (cookies or a token), as the store would hold it. */
type RawCredentials = { cookies: Record<string, string>; apiUrl?: string } | { token: string; apiUrl?: string };

/** The SSOAuth the resolver would build from a stored record. */
function auth(raw: RawCredentials): SSOAuth {
  const apiUrl = raw.apiUrl ?? 'https://api.example.com';
  return 'cookies' in raw
    ? toSSOAuth({ type: 'cookie', record: { cookies: raw.cookies, apiUrl } }, apiUrl)
    : toSSOAuth({ type: 'jwt', record: { token: raw.token, apiUrl } }, apiUrl);
}

interface ContextOverrides extends Omit<Partial<PluginContext>, 'credentials' | 'syncCredentials'> {
  credentials?: RawCredentials;
  syncCredentials?: RawCredentials;
}

function buildContext(overrides: ContextOverrides = {}, syncCodeMieUrl?: string): PluginContext {
  const credentials = 'credentials' in overrides
    ? overrides.credentials && auth(overrides.credentials)
    : auth({ cookies: { auth: 'cookie-value' } });
  const syncCredentials = overrides.syncCredentials && auth(overrides.syncCredentials);
  const refresherParams = { provider: 'ai-run-sso', baseUrl: 'https://api.example.com', codeMieUrl: syncCodeMieUrl };
  // Mirrors sso.proxy.ts: syncCredentialRefresher wraps syncCredentials, falling back to
  // credentials, reusing the same refresher instance as credentialRefresher when it falls back
  // to the identical `credentials` snapshot (PR #661 review).
  const credentialRefresher = credentials
    ? new CredentialRefresher(credentials, refresherParams)
    : undefined;
  const syncSource = syncCredentials ?? credentials ?? undefined;
  // Mirrors sso.proxy.ts: a distinct sync source gets params keyed to `syncCodeMieUrl` alone (no
  // `provider`), not the main-profile `refresherParams`, so a refresh re-reads the sync host's
  // own credentials instead of the main profile's (PR #661 review, point 3).
  const syncOnlyRefresherParams = { baseUrl: syncCodeMieUrl as string, codeMieUrl: syncCodeMieUrl };
  const syncCredentialRefresher = !syncSource
    ? undefined
    : syncSource === credentials && credentialRefresher
      ? credentialRefresher
      : new CredentialRefresher(syncSource, syncOnlyRefresherParams);
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
    ...overrides,
    credentials,
    syncCredentials,
    credentialRefresher,
    syncCredentialRefresher,
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
    resolveSSOAuth.mockReset();
    resolveSSOAuth.mockResolvedValue(null);
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
        }
      });
      await expect(plugin.createInterceptor(ctx)).rejects.toBeInstanceOf(ConfigurationError);
      expect(SessionSyncerMock).not.toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
    });

    it('throws ConfigurationError when there are no credentials at all', async () => {
      const ctx = buildContext({
        credentials: undefined,
        syncCredentials: undefined
      });
      await expect(plugin.createInterceptor(ctx)).rejects.toBeInstanceOf(ConfigurationError);
      expect(SessionSyncerMock).not.toHaveBeenCalled();
    });

    it('creates an interceptor for JWT-only credentials (a reverse proxy stripped cookies)', async () => {
      const ctx = buildContext({
        credentials: { token: 'jwt-token', apiUrl: 'https://api.example.com' },
        syncCredentials: undefined
      });
      const interceptor = await plugin.createInterceptor(ctx);
      expect(interceptor.name).toBe('sso-session-sync');
    });

    it('throws ConfigurationError when clientType is missing', async () => {
      const ctx = buildContext({
        config: {
          targetApiUrl: 'https://api.example.com',
          sessionId: 'session-123'
          // clientType omitted
        }
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
        credentials: { token: 'jwt' },
        syncCredentials: { cookies: { auth: 'c' } }
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
        credentials: { cookies: { auth: 'main-profile-cookie' } },
        syncCredentials: { cookies: { auth: 'sync-endpoint-cookie' } }
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
      resolveSSOAuth.mockImplementation(async (params: { provider?: string }) => {
        if (params.provider) {
          // Main-profile refresher: would return the main profile's own fresh cookies.
          return auth({ cookies: { auth: 'main-profile-cookie-refreshed' }, apiUrl: 'https://api.example.com' });
        }
        // Sync-only refresher: the sync endpoint's own fresh cookies.
        return auth({ cookies: { auth: 'sync-endpoint-cookie-refreshed' }, apiUrl: syncCodeMieUrl });
      });

      const ctx = buildContext({
        credentials: { cookies: { auth: 'main-profile-cookie' } },
        syncCredentials: { cookies: { auth: 'sync-endpoint-cookie' } },
      }, syncCodeMieUrl);
      const interceptor = await plugin.createInterceptor(ctx);

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=sync-endpoint-cookie-refreshed' });

      await interceptor.onProxyStop?.();
    });
  });

  describe('cookie header validity', () => {
    it('drops entries with an empty name or control characters from the cookie string sent to sync', async () => {
      vi.useFakeTimers();
      const ctx = buildContext({
        credentials: {
          cookies: { auth: 'good', '': 'empty-name', bad: 'line\r\nbreak', 'ba\nd2': 'v', other: 'ok' }
        }
      });
      const interceptor = await plugin.createInterceptor(ctx);

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=good; other=ok' });

      await interceptor.onProxyStop?.();
    });
  });

  describe('dropped cookie entries', () => {
    function droppedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
      return spy.mock.calls
        .map((call) => call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
        .filter((line) => line.includes('Ignoring invalid cookie entries'));
    }

    it('debug-logs the key names, never the values, when entries were dropped from the sync cookie header', async () => {
      vi.useFakeTimers();
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const ctx = buildContext({
        credentials: {
          cookies: { auth: 'good-secret', '': 'orphan-secret', bad: 'line\r\nbreak-secret', other: 'ok' }
        }
      });
      const interceptor = await plugin.createInterceptor(ctx);

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      const lines = droppedLines(debugSpy);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((line) => line.includes('bad') && line.includes('<empty>'))).toBe(true);
      const all = lines.join('\n');
      expect(all).not.toContain('good-secret');
      expect(all).not.toContain('orphan-secret');
      expect(all).not.toContain('break-secret');
      expect(all).not.toContain('auth');
      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=good-secret; other=ok' });

      await interceptor.onProxyStop?.();
      debugSpy.mockRestore();
    });

    it('logs nothing about dropped entries when every cookie is usable', async () => {
      vi.useFakeTimers();
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      expect(droppedLines(debugSpy)).toHaveLength(0);

      await interceptor.onProxyStop?.();
      debugSpy.mockRestore();
    });
  });

  describe('credential refresh (PR #655 review: picks up a re-login, not just the LLM-request path)', () => {
    it('rebuilds the cookie header from a freshly re-read credential before each sync tick', async () => {
      vi.useFakeTimers();
      // First tick: no fresher credentials found yet — keeps the startup-snapshot cookie.
      resolveSSOAuth.mockResolvedValueOnce(null);
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=cookie-value' });

      // A browser re-login completed between ticks — the throttle window (5s) has long since
      // elapsed by the next 120s tick, so the next sync must pick up the fresh cookie.
      resolveSSOAuth.mockResolvedValueOnce(auth({ cookies: { auth: 'fresh-after-relogin' }, apiUrl: 'https://api.example.com' }));
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[1][1]).toMatchObject({ cookies: 'auth=fresh-after-relogin' });

      await interceptor.onProxyStop?.();
    });
  });

  describe('JWT fallback credentials', () => {
    const API = 'https://api.example.com';

    async function startWith(credentials: RawCredentials): Promise<Awaited<ReturnType<SSOSessionSyncPlugin['createInterceptor']>>> {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext({ credentials }));
      await interceptor.onProxyStart?.();
      return interceptor;
    }

    it('syncs with the JWT and an empty cookie header', async () => {
      const interceptor = await startWith({ token: 'jwt-startup', apiUrl: API });

      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: '', jwtToken: 'jwt-startup' });

      await interceptor.onProxyStop?.();
    });

    it('picks up a rotated JWT before a later sync tick', async () => {
      const interceptor = await startWith({ token: 'jwt-startup', apiUrl: API });
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      resolveSSOAuth.mockResolvedValueOnce(auth({ token: 'jwt-relogin', apiUrl: API }));
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[1][1]).toMatchObject({ cookies: '', jwtToken: 'jwt-relogin' });

      await interceptor.onProxyStop?.();
    });

    it('switches to the JWT when a re-read finds only a JWT (a re-login changed the type)', async () => {
      const interceptor = await startWith({ cookies: { auth: 'cookie-value' }, apiUrl: API });
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: 'auth=cookie-value' });

      resolveSSOAuth.mockResolvedValueOnce(auth({ token: 'jwt-relogin', apiUrl: API }));
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[1][1]).toMatchObject({ cookies: '', jwtToken: 'jwt-relogin' });

      await interceptor.onProxyStop?.();
    });

    it('switches to the cookies when a re-read finds only cookies, dropping the JWT', async () => {
      const interceptor = await startWith({ token: 'jwt-startup', apiUrl: API });
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      resolveSSOAuth.mockResolvedValueOnce(auth({ cookies: { auth: 'fresh' }, apiUrl: API }));
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      const context = syncMock.mock.calls[1][1];
      expect(context).toMatchObject({ cookies: 'auth=fresh' });
      expect(context.jwtToken).toBeUndefined();

      await interceptor.onProxyStop?.();
    });

    it('does not send the JWT in local-dev mode', async () => {
      process.env.CODEMIE_DEV_API_URL = 'http://localhost:8080';
      process.env.CODEMIE_DEV_API_KEY = 'dev-key';
      const interceptor = await startWith({ token: 'jwt-startup', apiUrl: API });

      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      expect(syncMock.mock.calls[0][1]).toMatchObject({ cookies: '', apiKey: 'dev-key' });
      expect(syncMock.mock.calls[0][1].jwtToken).toBeUndefined();

      await interceptor.onProxyStop?.();
    });
  });

  describe('credentialsSuperseded on the sync context', () => {
    async function runOneTick(): Promise<{
      credentialsSuperseded?: (sent: string) => Promise<boolean>;
    }> {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext());
      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      await interceptor.onProxyStop?.();
      return syncMock.mock.calls[0][1];
    }

    it('is exposed outside local-dev mode and reports a stored re-login as superseding the sent cookies', async () => {
      const syncContext = await runOneTick();
      expect(syncContext.credentialsSuperseded).toBeTypeOf('function');

      resolveSSOAuth.mockResolvedValue(auth({ cookies: { auth: 'fresh-after-relogin' }, apiUrl: 'https://api.example.com' }));
      await expect(syncContext.credentialsSuperseded!('auth=cookie-value')).resolves.toBe(true);
    });

    it('reports false when the stored cookies equal the ones that were sent', async () => {
      const syncContext = await runOneTick();

      resolveSSOAuth.mockResolvedValue(auth({ cookies: { auth: 'cookie-value' }, apiUrl: 'https://api.example.com' }));
      await expect(syncContext.credentialsSuperseded!('auth=cookie-value')).resolves.toBe(false);
    });

    it('is unset in local-dev mode', async () => {
      process.env.CODEMIE_DEV_API_URL = 'http://localhost:8080';
      process.env.CODEMIE_DEV_API_KEY = 'dev-key';

      const syncContext = await runOneTick();

      expect(syncContext.credentialsSuperseded).toBeUndefined();
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

    it('gives every timer tick its own abort controller signal', async () => {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext());
      await interceptor.onProxyStart?.();

      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      const signals = syncMock.mock.calls.map(call => (call[1] as { abortSignal?: AbortSignal }).abortSignal);
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      expect(signals[0]).not.toBe(signals[1]);

      await interceptor.onProxyStop?.();
    });

    it('hands each timer tick the stop-at-first-failure flag and its own abort signal', async () => {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext());
      await interceptor.onProxyStart?.();

      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL);

      expect(syncMock).toHaveBeenCalledWith('session-123', expect.objectContaining({
        stopAtFirstFailure: true,
        abortSignal: expect.any(AbortSignal)
      }));

      await interceptor.onProxyStop?.();
    });

    describe('a line the server refused for good during a timer run', () => {
      let home: string;
      let previousHome: string | undefined;
      const livePath = (): string => join(home, 'sessions', 'session-123.json');
      const liveRecord = (overrides: Record<string, unknown> = {}) => ({
        sessionId: 'session-123', agentName: 'claude', provider: 'ai-run-sso', startTime: 1_790_000_000_000, endTime: 1_790_000_100_000,
        workingDirectory: '/tmp/project', status: 'completed', activeDurationMs: 0, deliveryRealAttempts: 0,
        correlation: { status: 'matched', agentSessionId: 'native-1', retryCount: 0 }, ...overrides
      });

      beforeEach(() => {
        previousHome = process.env.CODEMIE_HOME;
        home = mkdtempSync(join(tmpdir(), 'session-sync-plugin-'));
        process.env.CODEMIE_HOME = home;
        mkdirSync(join(home, 'sessions'), { recursive: true });
        process.env.CODEMIE_SESSION_SYNC_INTERVAL = '15';
      });

      afterEach(() => {
        if (previousHome === undefined) delete process.env.CODEMIE_HOME;
        else process.env.CODEMIE_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
      });

      function syncAnswering(...statuses: number[]): void {
        syncMock.mockImplementation(async (_id: string, ctx: { abortSignal: AbortSignal }) => {
          for (const status of statuses) {
            const request = boundedRequest(1000, { abortSignal: ctx.abortSignal });
            request.noteAnswer(status, true, false);
            request.dispose();
          }
          return { success: false, message: 'failed', processorResults: {}, failedProcessors: ['metrics-sync'] };
        });
      }

      /** A timer tick on real timers (the stamp is real file I/O), settled once the sync and its stamp are done. */
      async function tick(interceptor: { onProxyStart?: () => Promise<void>; onProxyStop?: () => Promise<void> }): Promise<void> {
        await interceptor.onProxyStart?.();
        await vi.waitFor(() => expect(syncMock).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The timer is cleared and the tick in flight is let to finish, so nothing outlives the test
        await interceptor.onProxyStop?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      it('stamps the drop on the live record without spending an attempt', async () => {
        writeFileSync(livePath(), JSON.stringify(liveRecord({ deliveryRealAttempts: 2 })));
        syncAnswering(400);
        const interceptor = await plugin.createInterceptor(buildContext());

        await tick(interceptor);

        const saved = JSON.parse(readFileSync(livePath(), 'utf-8')) as Record<string, unknown>;
        expect(saved).toMatchObject({ droppedReason: 'rejected by the server', droppedAt: expect.any(Number), deliveryRealAttempts: 2 });
        expect(saved.deliveryFailingSince).toBeUndefined();
      });

      it('leaves an earlier drop stamp as it is', async () => {
        writeFileSync(livePath(), JSON.stringify(liveRecord({ droppedAt: 1_790_000_050_000, droppedReason: 'retention expired' })));
        syncAnswering(400);
        const interceptor = await plugin.createInterceptor(buildContext());

        await tick(interceptor);

        expect(JSON.parse(readFileSync(livePath(), 'utf-8'))).toMatchObject({ droppedAt: 1_790_000_050_000, droppedReason: 'retention expired' });
      });

      it('stamps nothing for a failure that is not a rejection', async () => {
        writeFileSync(livePath(), JSON.stringify(liveRecord()));
        syncAnswering(503);
        const interceptor = await plugin.createInterceptor(buildContext());

        await tick(interceptor);

        expect(JSON.parse(readFileSync(livePath(), 'utf-8')).droppedAt).toBeUndefined();
      });
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

    it('makes the final sync a full pass: only the timer stops at the first failure', async () => {
      vi.useFakeTimers();
      process.env.CODEMIE_SESSION_SYNC_INTERVAL = '1000';
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStart?.();
      await vi.advanceTimersByTimeAsync(1000);
      await interceptor.onProxyStop?.();

      const flags = syncMock.mock.calls.map(call => (call[1] as { stopAtFirstFailure?: boolean }).stopAtFirstFailure);
      expect(flags).toEqual([true, false]);
    });

    it('performs a final sync even if the proxy was never started', async () => {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStop?.();
      expect(syncMock).toHaveBeenCalledTimes(1);
    });

    it('bounds the final sync by the deadline it is given', async () => {
      vi.useFakeTimers();
      const interceptor = await plugin.createInterceptor(buildContext());

      await interceptor.onProxyStop?.({ deadlineMs: 1_790_000_010_000 });

      expect(syncMock).toHaveBeenCalledWith('session-123', expect.objectContaining({ syncDeadlineMs: 1_790_000_010_000 }));
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
