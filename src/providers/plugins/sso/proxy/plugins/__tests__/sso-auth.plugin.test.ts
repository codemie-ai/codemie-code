import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({
  getStoredPlatformCredentials: vi.fn(),
}));

import { SSOAuthPlugin } from '../sso-auth.plugin.js';
import { getStoredPlatformCredentials } from '@/providers/core/codemie-auth-helpers.js';

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

  it('re-reads credentials from the store on each request, picking up a fresh re-login without a daemon restart', async () => {
    // Regression test for the retry-loop bug (EPMCDME-15316): a successful
    // browser re-login writes fresh cookies to disk, but the interceptor was
    // injecting the stale startup-time snapshot forever, so every subsequent
    // request kept getting redirected and kept re-triggering the login flow.
    vi.mocked(getStoredPlatformCredentials)
      .mockResolvedValueOnce(null) // first request: no fresher credentials yet
      .mockResolvedValueOnce({     // second request: the browser login just completed
        credentials: { cookies: { session: 'fresh-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 },
        url: TARGET_API_URL,
      });
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'stale-startup-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() - 1000 })
    );

    const first = createProxyContext();
    await interceptor.onRequest!(first);
    expect(first.headers['cookie']).toBe('session=stale-startup-value');

    const second = createProxyContext();
    await interceptor.onRequest!(second);
    expect(second.headers['cookie']).toBe('session=fresh-value');

    expect(getStoredPlatformCredentials).toHaveBeenCalledTimes(2);
    expect(getStoredPlatformCredentials).toHaveBeenCalledWith({
      provider: 'ai-run-sso',
      baseUrl: TARGET_API_URL,
      codeMieUrl: undefined,
    });
  });

  it('keeps using the last known-good credentials when a refresh attempt throws', async () => {
    vi.mocked(getStoredPlatformCredentials).mockRejectedValue(new Error('disk read failed'));
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'startup-value' }, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 })
    );
    const context = createProxyContext();

    await interceptor.onRequest!(context);

    expect(context.headers['cookie']).toBe('session=startup-value');
  });

  it('throws when neither a fresh nor a last-known-good credential has any usable cookies', async () => {
    vi.mocked(getStoredPlatformCredentials).mockResolvedValue(null);
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: {}, apiUrl: TARGET_API_URL, expiresAt: Date.now() + 60_000 })
    );
    const context = createProxyContext();

    await expect(interceptor.onRequest!(context)).rejects.toThrow(/Stored SSO session cookies are invalid/);
  });
});
