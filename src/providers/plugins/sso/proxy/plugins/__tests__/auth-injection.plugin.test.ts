import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '@/utils/logger.js';

vi.mock('@/providers/plugins/sso/auth/resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/auth/resolver.js')>()),
  resolveSSOAuth: vi.fn(),
}));
vi.mock('@/utils/analytics-auth-status.js', () => ({
  getAnalyticsAuthStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({
  getLastSignInAt: vi.fn().mockResolvedValue(null),
}));

import { AuthInjectionPlugin } from '../auth-injection.plugin.js';
import { CredentialRefresher } from '../credential-refresh.js';
import { AuthenticationError } from '../../proxy-errors.js';
import { resolveSSOAuth } from '@/providers/plugins/sso/auth/resolver.js';
import { toSSOAuth } from '@/providers/plugins/sso/auth/selection.js';
import type { SSOAuth, SSOAuthSource } from '@/providers/plugins/sso/auth/types.js';

const TARGET_API_URL = 'https://api.example.com';

function cookieAuth(cookies: Record<string, string>): SSOAuth {
  return toSSOAuth({ type: 'cookie', record: { cookies, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 } }, TARGET_API_URL);
}

function jwtAuth(token: string, expiresAt?: number, source: SSOAuthSource = 'store'): SSOAuth {
  return toSSOAuth(
    { type: 'jwt', record: { token, apiUrl: TARGET_API_URL, ...(expiresAt !== undefined && { expiresAt }) } },
    TARGET_API_URL,
    source,
  );
}

function refresherFor(credentials: SSOAuth): CredentialRefresher {
  // sso.proxy.ts builds this once and shares it across consumers in production.
  return new CredentialRefresher(credentials, { provider: 'ai-run-sso', baseUrl: TARGET_API_URL, codeMieUrl: undefined });
}

function createPluginContext(credentials?: SSOAuth, extra: Partial<PluginContext> = {}): PluginContext {
  return {
    config: { targetApiUrl: TARGET_API_URL, provider: 'ai-run-sso', sessionId: 'test-session' },
    logger,
    credentials,
    credentialRefresher: credentials ? refresherFor(credentials) : undefined,
    ...extra,
  };
}

function createProxyContext(): ProxyContext {
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'claude',
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

describe('AuthInjectionPlugin', () => {
  let plugin: AuthInjectionPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSSOAuth).mockResolvedValue(null);
    plugin = new AuthInjectionPlugin();
  });

  it('registers under the proxy-auth id at priority 10', () => {
    expect(plugin.id).toBe('@codemie/proxy-auth');
    expect(plugin.priority).toBe(10);
  });

  describe('createInterceptor guards', () => {
    it('returns a no-op interceptor when no credential refresher is wired', async () => {
      const interceptor = await plugin.createInterceptor(
        createPluginContext(undefined, { credentials: jwtAuth('jwt') })
      );
      expect(interceptor.onRequest).toBeUndefined();
    });
  });

  describe('cookie credentials', () => {
    it('injects the startup-snapshot cookies as the `cookie` header and records sentAuth', async () => {
      const startup = cookieAuth({ session: 'startup-value' });
      const interceptor: ProxyInterceptor = await plugin.createInterceptor(createPluginContext(startup));
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(context.headers['cookie']).toBe('session=startup-value');
      expect(context.headers['authorization']).toBeUndefined();
      expect(context.sentAuth).toBe(startup);
    });

    it('re-reads credentials from the store once the refresh throttle window elapses, picking up a fresh re-login without a daemon restart', async () => {
      // Regression test for the retry-loop bug (EPMCDME-15316): a successful browser re-login
      // writes fresh cookies to disk, but the interceptor injected the stale startup-time snapshot
      // forever. The re-read is throttled (CREDENTIAL_REFRESH_INTERVAL_MS) rather than gated on
      // the credential's own `expiresAt`, since a server-side revoke does not change it.
      vi.useFakeTimers();
      try {
        const fresh = cookieAuth({ session: 'fresh-value' });
        vi.mocked(resolveSSOAuth)
          .mockResolvedValueOnce(null) // first request: no fresher credentials yet
          .mockResolvedValueOnce(fresh); // second request: the browser login just completed
        const interceptor: ProxyInterceptor = await plugin.createInterceptor(
          createPluginContext(cookieAuth({ session: 'stale-startup-value' }))
        );

        const first = createProxyContext();
        await interceptor.onRequest!(first);
        expect(first.headers['cookie']).toBe('session=stale-startup-value');

        vi.advanceTimersByTime(6000); // past CREDENTIAL_REFRESH_INTERVAL_MS (5000ms)

        const second = createProxyContext();
        await interceptor.onRequest!(second);
        expect(second.headers['cookie']).toBe('session=fresh-value');
        expect(second.sentAuth).toBe(fresh);

        expect(resolveSSOAuth).toHaveBeenCalledTimes(2);
        expect(resolveSSOAuth).toHaveBeenCalledWith({
          provider: 'ai-run-sso',
          baseUrl: TARGET_API_URL,
          codeMieUrl: undefined,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-read credentials from the store on a second request within the throttle window', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext(cookieAuth({ session: 'startup-value' })));

      await interceptor.onRequest!(createProxyContext());
      await interceptor.onRequest!(createProxyContext());

      expect(resolveSSOAuth).toHaveBeenCalledTimes(1);
    });

    it('keeps using the last known-good credentials when a refresh attempt throws', async () => {
      vi.mocked(resolveSSOAuth).mockRejectedValue(new Error('disk read failed'));
      const interceptor = await plugin.createInterceptor(createPluginContext(cookieAuth({ session: 'startup-value' })));
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(resolveSSOAuth).toHaveBeenCalledTimes(1);
      expect(context.headers['cookie']).toBe('session=startup-value');
    });

    it('warns with the names of dropped cookie entries only, and leaves them out of the header it sends', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const interceptor = await plugin.createInterceptor(
        createPluginContext(
          cookieAuth({ session: 'kept-value', ' ': 'blank-name-secret', 'bad\nname': 'newline-name-secret', broken: 'line\nbreak-secret' })
        )
      );
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(context.headers['cookie']).toBe('session=kept-value');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message, details] = warnSpy.mock.calls[0];
      expect(message).toContain('Ignoring invalid cookie entries');
      expect(details).toEqual({ invalidCookieCount: 3, invalidCookieNames: ['<empty>', 'bad\nname', 'broken'] });
      expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/secret/);
      warnSpy.mockRestore();
    });

    it('does not warn when every cookie entry is usable', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const interceptor = await plugin.createInterceptor(createPluginContext(cookieAuth({ a: '1', b: '2' })));
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(context.headers['cookie']).toBe('a=1; b=2');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('throws when neither a fresh nor a last-known-good credential has any usable cookies', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext(cookieAuth({})));
      const context = createProxyContext();

      await expect(interceptor.onRequest!(context)).rejects.toThrow(/Stored SSO session cookies are invalid/);
      expect(context.sentAuth).toBeUndefined();
    });
  });

  describe('jwt credentials', () => {
    it('injects the bearer token as the `authorization` header and records sentAuth', async () => {
      const startup = jwtAuth('jwt-startup');
      const interceptor = await plugin.createInterceptor(createPluginContext(startup));
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(context.headers['authorization']).toBe('Bearer jwt-startup');
      expect(context.headers['cookie']).toBeUndefined();
      expect(context.sentAuth).toBe(startup);
    });

    it('picks up a rotated token without a proxy restart', async () => {
      vi.useFakeTimers();
      try {
        const interceptor = await plugin.createInterceptor(createPluginContext(jwtAuth('jwt-startup')));
        await interceptor.onRequest!(createProxyContext());

        vi.mocked(resolveSSOAuth).mockResolvedValue(jwtAuth('jwt-relogin'));
        vi.advanceTimersByTime(6000); // past CREDENTIAL_REFRESH_INTERVAL_MS (5000ms)

        const context = createProxyContext();
        await interceptor.onRequest!(context);
        expect(context.headers['authorization']).toBe('Bearer jwt-relogin');
      } finally {
        vi.useRealTimers();
      }
    });

    it('switches to the bearer header when a re-login changed cookies to a JWT', async () => {
      vi.useFakeTimers();
      try {
        const interceptor = await plugin.createInterceptor(createPluginContext(cookieAuth({ session: 'old' })));
        await interceptor.onRequest!(createProxyContext());

        vi.mocked(resolveSSOAuth).mockResolvedValue(jwtAuth('jwt-relogin'));
        vi.advanceTimersByTime(6000);

        const context = createProxyContext();
        await interceptor.onRequest!(context);
        expect(context.headers['authorization']).toBe('Bearer jwt-relogin');
        expect(context.headers['cookie']).toBeUndefined();
        expect(context.sentAuth?.type).toBe('jwt');
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws AuthenticationError for an expired explicit token and sets no header', async () => {
      const interceptor = await plugin.createInterceptor(
        createPluginContext(jwtAuth('jwt-expired', Date.now() - 1_000, 'explicit'))
      );
      const context = createProxyContext();

      await expect(interceptor.onRequest!(context)).rejects.toBeInstanceOf(AuthenticationError);
      expect(context.headers['authorization']).toBeUndefined();
      expect(context.sentAuth).toBeUndefined();
    });

    it('sends an expired stored SSO token upstream, so the server rejection drives the re-login', async () => {
      const expired = jwtAuth('jwt-expired', Date.now() - 1_000);
      const interceptor = await plugin.createInterceptor(createPluginContext(expired));
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(context.headers['authorization']).toBe('Bearer jwt-expired');
      expect(context.sentAuth).toBe(expired);
    });

    it('accepts a token whose expiry is still ahead', async () => {
      const interceptor = await plugin.createInterceptor(
        createPluginContext(jwtAuth('jwt-valid', Date.now() + 60_000, 'explicit'))
      );
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(context.headers['authorization']).toBe('Bearer jwt-valid');
    });

    it('injects the main JWT, never the separately-authenticated SSO sync cookies (PR #661 review)', async () => {
      // Regression: the shared refresher used to be seeded from whichever of
      // credentials/syncCredentials had cookies, so a JWT-authenticated main profile with an
      // SSO-authenticated sync endpoint got the sync cookies injected into LLM requests.
      // `credentialRefresher` only ever wraps `credentials` (the main auth method).
      const main = jwtAuth('jwt-token');
      const interceptor = await plugin.createInterceptor(
        createPluginContext(main, { syncCredentials: cookieAuth({ session: 'sync-cookie' }) })
      );
      const context = createProxyContext();

      await interceptor.onRequest!(context);

      expect(context.headers['authorization']).toBe('Bearer jwt-token');
      expect(context.headers['cookie']).toBeUndefined();
    });
  });
});
