import { IncomingMessage } from 'http';
import { Readable } from 'stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginContext, ProxyInterceptor, UpstreamResponseTools } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

vi.mock('@/providers/plugins/sso/sso.detached-login.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/sso.detached-login.js')>()),
  startDetachedSsoLogin: vi.fn(),
}));
vi.mock('@/utils/analytics-auth-status.js', () => ({ markAnalyticsAuthInvalid: vi.fn() }));

import { SSOSessionExpiryPlugin } from '../sso-session-expiry.plugin.js';
import { startDetachedSsoLogin, describeLogin } from '@/providers/plugins/sso/sso.detached-login.js';
import { markAnalyticsAuthInvalid } from '@/utils/analytics-auth-status.js';

const TARGET_API_URL = 'https://api.example.com';

function createPluginContext(credentials?: PluginContext['credentials']): PluginContext {
  return {
    config: {
      targetApiUrl: TARGET_API_URL,
      provider: 'test',
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

function response(statusCode: number, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]) as IncomingMessage;
  stream.statusCode = statusCode;
  stream.statusMessage = statusCode === 401 ? 'Unauthorized' : 'Redirect';
  stream.headers = headers;
  return stream;
}

function createTools(): UpstreamResponseTools & {
  readBody: ReturnType<typeof vi.fn<[IncomingMessage], Promise<Buffer>>>;
  retry: ReturnType<typeof vi.fn<[Buffer], Promise<IncomingMessage>>>;
  fromBuffer: ReturnType<typeof vi.fn<[IncomingMessage, Buffer], IncomingMessage>>;
} {
  return {
    readBody: vi.fn(async () => Buffer.from('', 'utf-8')),
    retry: vi.fn(async () => response(200)),
    fromBuffer: vi.fn((_upstream, body: Buffer) => {
      const synthetic = Readable.from([]) as IncomingMessage;
      synthetic.statusCode = 200;
      synthetic.statusMessage = 'OK';
      synthetic.headers = {};
      (synthetic as unknown as { _syntheticBody: Buffer })._syntheticBody = body;
      return synthetic;
    }),
  };
}

describe('SSOSessionExpiryPlugin', () => {
  let plugin: SSOSessionExpiryPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new SSOSessionExpiryPlugin();
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
  });

  it('returns a no-op interceptor for JWT credentials (no cookies key)', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ token: 'jwt-token', apiUrl: TARGET_API_URL })
    );

    expect(interceptor.onUpstreamResponse).toBeUndefined();
  });

  it('replaces a confirmed-expired oauth2-proxy redirect with a parseable 401 and triggers re-auth', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({
        cookies: { session: 'abc' },
        apiUrl: TARGET_API_URL,
        expiresAt: Date.now() - 1000,
      })
    );
    const context = createProxyContext();
    const tools = createTools();
    const original = response(302, { location: 'https://x/oauth2/start?rd=%2F' });

    const result = await interceptor.onUpstreamResponse!(context, original, tools);

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(
      ((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toString('utf-8')
    );
    expect(body).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: `CodeMie SSO session expired. ${describeLogin('started')}`,
      },
    });
    expect(Object.keys(result.headers).sort()).toEqual(['content-length', 'content-type']);
    expect(result.headers['location']).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['cache-control']).toBeUndefined();

    expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
    const [reason, baseUrl] = vi.mocked(markAnalyticsAuthInvalid).mock.calls[0];
    expect(reason).toContain('/oauth2/start');
    expect(baseUrl).toBe(TARGET_API_URL);

    expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    expect(startDetachedSsoLogin).toHaveBeenCalledWith(TARGET_API_URL);
  });

  it('passes through unchanged when the redirect signature matches but the credential is still fresh', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({
        cookies: { session: 'abc' },
        apiUrl: TARGET_API_URL,
        expiresAt: Date.now() + 60_000,
      })
    );
    const context = createProxyContext();
    const tools = createTools();
    const original = response(302, { location: 'https://x/oauth2/start?rd=%2F' });

    const result = await interceptor.onUpstreamResponse!(context, original, tools);

    expect(result).toBe(original);
    expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('passes through unchanged when the redirect signature matches but expiresAt is undefined', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({
        cookies: { session: 'abc' },
        apiUrl: TARGET_API_URL,
        expiresAt: undefined,
      })
    );
    const context = createProxyContext();
    const tools = createTools();
    const original = response(302, { location: 'https://x/oauth2/start?rd=%2F' });

    const result = await interceptor.onUpstreamResponse!(context, original, tools);

    expect(result).toBe(original);
    expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('passes through a non-redirect infra error (e.g. 503) unchanged without relabeling it as session expiry', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({
        cookies: { session: 'abc' },
        apiUrl: TARGET_API_URL,
        expiresAt: Date.now() - 1000,
      })
    );
    const context = createProxyContext();
    const tools = createTools();
    const original = response(503, {});

    const result = await interceptor.onUpstreamResponse!(context, original, tools);

    expect(result).toBe(original);
    expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('also triggers the 401 for a 303 redirect to /oauth2/start with an expired credential', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({
        cookies: { session: 'abc' },
        apiUrl: TARGET_API_URL,
        expiresAt: Date.now() - 1000,
      })
    );
    const context = createProxyContext();
    const tools = createTools();
    const original = response(303, { location: 'https://x/oauth2/start?rd=%2F' });

    const result = await interceptor.onUpstreamResponse!(context, original, tools);

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(
      ((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toString('utf-8')
    );
    expect(body.error.message).toBe(`CodeMie SSO session expired. ${describeLogin('started')}`);
  });
});
