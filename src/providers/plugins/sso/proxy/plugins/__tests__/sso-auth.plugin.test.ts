import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({
  getStoredPlatformCredentials: vi.fn(),
}));
vi.mock('@/utils/analytics-auth-status.js', () => ({
  getAnalyticsAuthStatus: vi.fn().mockResolvedValue(null),
}));

import { SSOAuthPlugin } from '../sso-auth.plugin.js';
import { getStoredPlatformCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { CredentialRefresher } from '../credential-refresh.js';

const TARGET_API_URL = 'https://api.example.com';

function createPluginContext(credentials?: PluginContext['credentials']): PluginContext {
  return {
    config: {
      targetApiUrl: TARGET_API_URL,
      provider: 'ai-run-sso',
      sessionId: 'test-session',
    },
    logger,
    credentials,
    // sso.proxy.ts builds this once and shares it across consumers in production.
    credentialRefresher: credentials && 'cookies' in credentials
      ? new CredentialRefresher(credentials, {
          provider: 'ai-run-sso',
          baseUrl: TARGET_API_URL,
          codeMieUrl: undefined,
        })
      : undefined,
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

describe('SSOAuthPlugin', () => {
  let plugin: SSOAuthPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new SSOAuthPlugin();
  });

  it('returns a no-op interceptor for JWT credentials (no cookies key)', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ token: 'jwt-token', apiUrl: TARGET_API_URL })
    );
    expect(interceptor.onRequest).toBeUndefined();
  });

  it('injects the startup-snapshot cookies on the first request when no fresher credentials are found', async () => {
    vi.mocked(getStoredPlatformCredentials).mockResolvedValue(null);
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'startup-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 })
    );
    const context = createProxyContext();

    await interceptor.onRequest!(context);

    expect(context.headers['cookie']).toBe('session=startup-value');
  });

  it('re-reads credentials from the store once the refresh throttle window elapses, picking up a fresh re-login without a daemon restart', async () => {
    // Regression test for the retry-loop bug (EPMCDME-15316): a successful
    // browser re-login writes fresh cookies to disk, but the interceptor was
    // injecting the stale startup-time snapshot forever, so every subsequent
    // request kept getting redirected and kept re-triggering the login flow.
    // The re-read is throttled (CREDENTIAL_REFRESH_INTERVAL_MS in sso-auth.plugin.ts)
    // rather than gated on the credential's own `expiresAt` — a server-side revoke
    // does not change the local JWT's exp, so an expiresAt-based skip would never
    // pick up this re-login's fresh cookies. Advance real time past the throttle
    // window between requests to exercise that re-read, matching how a real
    // browser re-login (which takes far longer than the throttle window) plays out.
    vi.useFakeTimers();
    vi.mocked(getStoredPlatformCredentials)
      .mockResolvedValueOnce(null) // first request: no fresher credentials yet
      .mockResolvedValueOnce({     // second request: the browser login just completed
        credentials: { cookies: { session: 'fresh-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 },
        url: TARGET_API_URL,
      });
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'stale-startup-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 })
    );

    const first = createProxyContext();
    await interceptor.onRequest!(first);
    expect(first.headers['cookie']).toBe('session=stale-startup-value');

    vi.advanceTimersByTime(6000); // past CREDENTIAL_REFRESH_INTERVAL_MS (5000ms)

    const second = createProxyContext();
    await interceptor.onRequest!(second);
    expect(second.headers['cookie']).toBe('session=fresh-value');

    expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    expect(getStoredPlatformCredentials).toHaveBeenCalledWith({
      provider: 'ai-run-sso',
      baseUrl: TARGET_API_URL,
      codeMieUrl: undefined,
    });
    vi.useRealTimers();
  });

  it('does not re-read credentials from the store on a second request within the throttle window', async () => {
    vi.mocked(getStoredPlatformCredentials).mockResolvedValue(null);
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'startup-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 })
    );

    await interceptor.onRequest!(createProxyContext());
    await interceptor.onRequest!(createProxyContext());

    expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(1);
  });

  it('keeps using the last known-good credentials when a refresh attempt throws', async () => {
    vi.mocked(getStoredPlatformCredentials).mockRejectedValue(new Error('disk read failed'));
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'startup-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 })
    );
    const context = createProxyContext();

    await interceptor.onRequest!(context);

    expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(1);
    expect(context.headers['cookie']).toBe('session=startup-value');
  });

  it('stays a no-op for JWT main auth + a separately-authenticated SSO sync endpoint (PR #661 review)', async () => {
    // Regression: the shared refresher used to be seeded from whichever of
    // credentials/syncCredentials had cookies, so a JWT-authenticated main profile with an
    // SSO-authenticated sync endpoint got the sync cookies injected into LLM requests here.
    // `credentialRefresher` now only ever wraps `credentials` (the main auth method).
    const jwtCredentials = { token: 'jwt-token', apiUrl: TARGET_API_URL } as never;
    const syncCredentials = { cookies: { session: 'sync-cookie' } } as never;
    const context: PluginContext = {
      config: { targetApiUrl: TARGET_API_URL, provider: 'ai-run-sso', sessionId: 'test-session' },
      logger,
      credentials: jwtCredentials,
      syncCredentials,
      credentialRefresher: new CredentialRefresher(jwtCredentials, {
        provider: 'ai-run-sso',
        baseUrl: TARGET_API_URL,
        codeMieUrl: undefined,
      }),
    };

    const interceptor: ProxyInterceptor = await plugin.createInterceptor(context);

    expect(interceptor.onRequest).toBeUndefined();
  });

  it('throws when neither a fresh nor a last-known-good credential has any usable cookies', async () => {
    vi.mocked(getStoredPlatformCredentials).mockResolvedValue(null);
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: {}, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 })
    );
    const context = createProxyContext();

    await expect(interceptor.onRequest!(context)).rejects.toThrow(/Stored SSO session has no valid cookies or authorization value/);
  });

  it('succeeds on empty cookies when an authorization fallback is set (reverse proxy strips cookies)', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: {}, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000, authorization: 'Bearer backend-issued' })
    );
    const context = createProxyContext();

    await interceptor.onRequest!(context);

    expect(context.headers['cookie']).toBeUndefined();
    expect(context.headers['authorization']).toBe('Bearer backend-issued');
  });

  it('sends both cookie and authorization headers when both are present', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'abc' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000, authorization: 'Bearer backend-issued' })
    );
    const context = createProxyContext();

    await interceptor.onRequest!(context);

    expect(context.headers['cookie']).toBe('session=abc');
    expect(context.headers['authorization']).toBe('Bearer backend-issued');
  });
});
