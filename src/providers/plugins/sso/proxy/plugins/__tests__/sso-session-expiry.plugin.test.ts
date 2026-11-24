import { IncomingMessage } from 'http';
import { gzipSync } from 'node:zlib';
import { Readable } from 'stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginContext, ProxyInterceptor, UpstreamResponseTools } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

vi.mock('@/providers/plugins/sso/sso.detached-login.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/sso.detached-login.js')>()),
  startDetachedSsoLogin: vi.fn(),
  getLastSignInAt: vi.fn(),
}));
vi.mock('@/utils/analytics-auth-status.js', () => ({ markAnalyticsAuthInvalid: vi.fn() }));

import { SSOSessionExpiryPlugin } from '../sso-session-expiry.plugin.js';
import { startDetachedSsoLogin, describeLogin, getLastSignInAt } from '@/providers/plugins/sso/sso.detached-login.js';
import { markAnalyticsAuthInvalid } from '@/utils/analytics-auth-status.js';
import { buildCookieHeader } from '@/providers/plugins/sso/session/cookie-auth.js';

const TARGET_API_URL = 'https://api.example.com';

function createPluginContext(
  credentials?: PluginContext['credentials'],
  credentialRefresher?: { refreshNow: () => Promise<unknown> }
): PluginContext {
  return {
    config: {
      targetApiUrl: TARGET_API_URL,
      provider: 'test',
      sessionId: 'test-session',
    },
    logger,
    credentials,
    credentialRefresher: credentialRefresher as PluginContext['credentialRefresher'],
  };
}

function createProxyContext(cookie?: string, requestBody: Buffer | null = null): ProxyContext {
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'claude',
    method: 'POST',
    url: '/v1/messages',
    headers: cookie === undefined ? {} : { cookie },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

/** The backend's own session rejection (ExtendedHTTPException, "Authentication failed"). */
const SESSION_REJECTION_BODY = Buffer.from(
  JSON.stringify({ error: { message: 'Authentication failed', details: 'No valid authentication credentials were provided with this request.', help: null } }),
  'utf-8'
);
/** A LiteLLM 401 relayed by the LLM proxy while the SSO session is valid. */
const LITELLM_401_BODY = Buffer.from(
  JSON.stringify({ error: { message: 'Authentication Error, Invalid proxy server token passed', type: 'auth_error', code: '401' } }),
  'utf-8'
);

function response(statusCode: number, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]) as IncomingMessage;
  stream.statusCode = statusCode;
  stream.statusMessage = statusCode === 401 ? 'Unauthorized' : 'Redirect';
  stream.headers = headers;
  return stream;
}

function createTools(): UpstreamResponseTools & {
  readBody: ReturnType<typeof vi.fn<[IncomingMessage], Promise<Buffer>>>;
  retry: ReturnType<typeof vi.fn<[Buffer | null | undefined], Promise<IncomingMessage>>>;
  fromBuffer: ReturnType<typeof vi.fn<[IncomingMessage, Buffer], IncomingMessage>>;
} {
  return {
    readBody: vi.fn(async () => SESSION_REJECTION_BODY),
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
    vi.mocked(getLastSignInAt).mockResolvedValue(null);
  });

  it('returns a no-op interceptor for JWT credentials (no cookies key)', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ token: 'jwt-token', apiUrl: TARGET_API_URL })
    );

    expect(interceptor.onUpstreamResponse).toBeUndefined();
  });

  it('replaces an oauth2-proxy session-expiry redirect with a parseable 401 and triggers re-auth', async () => {
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

  it('also replaces the redirect with a 401 when the local credential still looks fresh', async () => {
    // Confirmed by live reproduction (2026-10-16): a server-side session revoke
    // (e.g. signing out of all sessions) does not change the local JWT's own
    // `exp` claim, so this is the PRIMARY real-world trigger for this bug, not
    // an edge case to exclude. Nothing else produces this exact redirect.
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

    expect(result.statusCode).toBe(401);
    expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
    expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
  });

  it('also replaces the redirect with a 401 when expiresAt is undefined', async () => {
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

    expect(result.statusCode).toBe(401);
    expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
    expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
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

  it('falls back to a synthetic 401 (not the raw redirect) when re-auth plumbing rejects, and logs which step failed', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(startDetachedSsoLogin).mockRejectedValueOnce(new Error('spawn failed'));
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

    expect(result).not.toBe(original);
    expect(result.statusCode).toBe(401);
    const body = JSON.parse(
      ((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toString('utf-8')
    );
    expect(body.error.message).toBe(`CodeMie SSO session expired. ${describeLogin('failed')}`);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0];
    expect(message).toContain('startDetachedSsoLogin');

    errorSpy.mockRestore();
  });

  it('does not open the message with the session-expired lead when a sign-in just finished', async () => {
    vi.mocked(startDetachedSsoLogin).mockResolvedValueOnce('signed-in-recently');
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(
      createPluginContext({ cookies: { session: 'abc' }, apiUrl: TARGET_API_URL })
    );

    const result = await interceptor.onUpstreamResponse!(
      createProxyContext(),
      response(302, { location: 'https://x/oauth2/start?rd=%2F' }),
      createTools()
    );

    expect(result.statusCode).toBe(401);
    const { message } = JSON.parse(
      ((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toString('utf-8')
    ).error;
    expect(message).toBe(describeLogin('signed-in-recently'));
    expect(message).not.toContain('expired');
    expect(message).toContain('re-send your prompt');
  });

  describe('superseded credentials', () => {
    const REDIRECT = { location: 'https://x/oauth2/start?rd=%2F' };
    const SSO_CREDENTIALS = { cookies: { session: 'old' }, apiUrl: TARGET_API_URL };

    async function interceptorWith(
      refreshNow: () => Promise<unknown>
    ): Promise<ProxyInterceptor> {
      return plugin.createInterceptor(createPluginContext(SSO_CREDENTIALS, { refreshNow }));
    }

    function bodyOf(result: IncomingMessage): { error: { message: string } } {
      return JSON.parse(
        ((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toString('utf-8')
      );
    }

    const REQUEST_BODY = Buffer.from('{"model":"m","messages":[]}', 'utf-8');

    function supersededContext(): ProxyContext {
      return createProxyContext(buildCookieHeader({ session: 'old' }), REQUEST_BODY);
    }

    it('replays a request with superseded cookies once, with the original body and the fresh cookies, and returns the retried response', async () => {
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'new' } }));
      const tools = createTools();
      const retried = response(200, { 'content-type': 'application/json' });
      let cookieAtRetry: string | undefined;
      const context = supersededContext();
      tools.retry.mockImplementation(async () => {
        cookieAtRetry = context.headers['cookie'];
        return retried;
      });
      const original = response(302, REDIRECT);

      const result = await interceptor.onUpstreamResponse!(context, original, tools);

      expect(result).toBe(retried);
      expect(tools.readBody).toHaveBeenCalledTimes(1);
      expect(tools.readBody).toHaveBeenCalledWith(original);
      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(tools.retry).toHaveBeenCalledWith(REQUEST_BODY);
      expect(cookieAtRetry).toBe(buildCookieHeader({ session: 'new' }));
      expect(tools.fromBuffer).not.toHaveBeenCalled();
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('treats a retried oauth2 redirect as a real revoke: one marker, one sign-in, a session-expired 401, never a second retry', async () => {
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'new' } }));
      const tools = createTools();
      const original = response(302, REDIRECT);
      const retriedRedirect = response(302, REDIRECT);
      tools.retry.mockResolvedValueOnce(retriedRedirect);

      const result = await interceptor.onUpstreamResponse!(supersededContext(), original, tools);

      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(tools.readBody).toHaveBeenCalledTimes(2);
      expect(tools.readBody).toHaveBeenNthCalledWith(1, original);
      expect(tools.readBody).toHaveBeenNthCalledWith(2, retriedRedirect);
      expect(result).not.toBe(retriedRedirect);
      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toBe(
        `CodeMie SSO session expired. ${describeLogin('started')}`
      );
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('answers the "just renewed" 401 without a marker or sign-in when the retry throws', async () => {
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'new' } }));
      const tools = createTools();
      tools.retry.mockRejectedValueOnce(new Error('upstream down'));
      const original = response(302, REDIRECT);

      const result = await interceptor.onUpstreamResponse!(supersededContext(), original, tools);

      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(result).not.toBe(original);
      expect(result.statusCode).toBe(401);
      expect(result.statusMessage).toBe('Unauthorized');
      expect(Object.keys(result.headers).sort()).toEqual(['content-length', 'content-type']);
      const { error } = bodyOf(result) as { error: { type?: string; message: string } };
      expect(error.type).toBe('authentication_error');
      expect(error.message).toContain('just renewed');
      expect(error.message).toContain('re-send');
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('replays a request without a body (GET) once with the fresh cookie, passing the null body to retry unchanged', async () => {
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'new' } }));
      const tools = createTools();
      const retried = response(200);
      const context = createProxyContext(buildCookieHeader({ session: 'old' }));
      let cookieAtRetry: string | undefined;
      tools.retry.mockImplementation(async () => {
        cookieAtRetry = context.headers['cookie'];
        return retried;
      });
      const original = response(302, REDIRECT);

      const result = await interceptor.onUpstreamResponse!(context, original, tools);

      expect(result).toBe(retried);
      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(tools.retry.mock.calls[0][0]).toBeNull();
      expect(cookieAtRetry).toBe(buildCookieHeader({ session: 'new' }));
      expect(tools.readBody).toHaveBeenCalledTimes(1);
      expect(tools.fromBuffer).not.toHaveBeenCalled();
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('treats a retried redirect of a body-less request as a real revoke, without a second retry', async () => {
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'new' } }));
      const tools = createTools();
      tools.retry.mockResolvedValueOnce(response(302, REDIRECT));

      const result = await interceptor.onUpstreamResponse!(
        createProxyContext(buildCookieHeader({ session: 'old' })),
        response(302, REDIRECT),
        tools
      );

      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toBe(`CodeMie SSO session expired. ${describeLogin('started')}`);
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('still replays without a marker or sign-in when draining the redirect body rejects', async () => {
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'new' } }));
      const tools = createTools();
      tools.readBody.mockRejectedValueOnce(new Error('socket hang up'));
      const retried = response(200);
      tools.retry.mockResolvedValueOnce(retried);

      const result = await interceptor.onUpstreamResponse!(supersededContext(), response(302, REDIRECT), tools);

      expect(tools.readBody).toHaveBeenCalledTimes(1);
      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(result).toBe(retried);
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('logs one debug line without cookie content when the request carried superseded credentials', async () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'new-secret' } }));

      await interceptor.onUpstreamResponse!(
        createProxyContext(buildCookieHeader({ session: 'old-secret' })),
        response(302, REDIRECT),
        createTools()
      );

      const lines = debugSpy.mock.calls.map((call) => call.map(String).join(' '));
      expect(lines.filter((line) => line.includes('superseded credentials'))).toHaveLength(1);
      expect(lines.join('\n')).not.toContain('old-secret');
      expect(lines.join('\n')).not.toContain('new-secret');
      debugSpy.mockRestore();
    });

    it('treats a redirect as a real revoke when the sent header equals the freshly built one', async () => {
      const interceptor = await interceptorWith(async () => ({ cookies: { session: 'same' } }));
      const tools = createTools();

      const result = await interceptor.onUpstreamResponse!(
        createProxyContext(buildCookieHeader({ session: 'same' }), REQUEST_BODY),
        response(302, REDIRECT),
        tools
      );

      expect(tools.readBody).toHaveBeenCalledTimes(1);
      expect(tools.retry).not.toHaveBeenCalled();

      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toBe(
        `CodeMie SSO session expired. ${describeLogin('started')}`
      );
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('treats a redirect as a real revoke when the store holds an entry the header builder drops', async () => {
      const stored = { session: 'same', '': 'orphan' };
      const interceptor = await interceptorWith(async () => ({ cookies: stored }));

      const result = await interceptor.onUpstreamResponse!(
        createProxyContext(buildCookieHeader({ session: 'same' })),
        response(302, REDIRECT),
        createTools()
      );

      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toContain('session expired');
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['returns null', async () => null],
      ['throws', async () => { throw new Error('store unreadable'); }],
    ])('falls back to the sign-in path when refreshNow %s', async (_label, refreshNow) => {
      const interceptor = await interceptorWith(refreshNow);

      const result = await interceptor.onUpstreamResponse!(
        createProxyContext(buildCookieHeader({ session: 'old' })),
        response(302, REDIRECT),
        createTools()
      );

      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toBe(
        `CodeMie SSO session expired. ${describeLogin('started')}`
      );
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('keeps the sign-in path when no credentialRefresher is provided', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext(SSO_CREDENTIALS));

      const result = await interceptor.onUpstreamResponse!(
        createProxyContext(buildCookieHeader({ session: 'old' })),
        response(302, REDIRECT),
        createTools()
      );

      expect(result.statusCode).toBe(401);
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('keeps the sign-in path when the request carried no cookie header', async () => {
      const refreshNow = vi.fn(async () => ({ cookies: { session: 'new' } }));
      const interceptor = await interceptorWith(refreshNow);

      const result = await interceptor.onUpstreamResponse!(
        createProxyContext(),
        response(302, REDIRECT),
        createTools()
      );

      expect(result.statusCode).toBe(401);
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('stays a no-op for JWT credentials even with a credentialRefresher', async () => {
      const refreshNow = vi.fn();
      const interceptor = await plugin.createInterceptor(
        createPluginContext({ token: 'jwt-token', apiUrl: TARGET_API_URL }, { refreshNow })
      );

      expect(interceptor.onUpstreamResponse).toBeUndefined();
      expect(refreshNow).not.toHaveBeenCalled();
    });
  });

  describe('session-shaped 401', () => {
    const REDIRECT = { location: 'https://x/oauth2/start?rd=%2F' };
    const UNAUTHORIZED = { 'content-type': 'application/json' };

    function bodyOf(result: IncomingMessage): { error: { message: string } } {
      return JSON.parse(
        ((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toString('utf-8')
      );
    }

    /** An interceptor whose credential store holds `store.cookies`, which a test may change. */
    async function interceptorWithStore(store: { cookies: Record<string, string> }): Promise<ProxyInterceptor> {
      return plugin.createInterceptor(
        createPluginContext(
          { cookies: { session: 'same' }, apiUrl: TARGET_API_URL },
          { refreshNow: async () => ({ cookies: store.cookies }) }
        )
      );
    }

    function contextWith(cookies: Record<string, string>): ProxyContext {
      return createProxyContext(buildCookieHeader(cookies));
    }

    it('writes the marker, starts one sign-in and returns the synthetic 401, as for the redirect', async () => {
      const interceptor = await plugin.createInterceptor(
        createPluginContext({ cookies: { session: 'abc' }, apiUrl: TARGET_API_URL })
      );
      const tools = createTools();
      const original = response(401, UNAUTHORIZED);

      const result = await interceptor.onUpstreamResponse!(createProxyContext(), original, tools);

      expect(result).not.toBe(original);
      expect(result.statusCode).toBe(401);
      expect(Object.keys(result.headers).sort()).toEqual(['content-length', 'content-type']);
      expect(bodyOf(result)).toEqual({
        type: 'error',
        error: { type: 'authentication_error', message: `CodeMie SSO session expired. ${describeLogin('started')}` },
      });
      expect(tools.readBody).toHaveBeenCalledWith(original);
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(vi.mocked(markAnalyticsAuthInvalid).mock.calls[0][1]).toBe(TARGET_API_URL);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledWith(TARGET_API_URL);
    });

    it('replays a 401 request sent with superseded cookies once and returns the retried response', async () => {
      const interceptor = await interceptorWithStore({ cookies: { session: 'new' } });
      const tools = createTools();
      const retried = response(200);
      const context = contextWith({ session: 'old' });
      let cookieAtRetry: string | undefined;
      tools.retry.mockImplementation(async () => {
        cookieAtRetry = context.headers['cookie'];
        return retried;
      });
      const original = response(401, UNAUTHORIZED);

      const result = await interceptor.onUpstreamResponse!(context, original, tools);

      expect(result).toBe(retried);
      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(cookieAtRetry).toBe(buildCookieHeader({ session: 'new' }));
      expect(tools.readBody).toHaveBeenCalledTimes(1);
      expect(tools.readBody).toHaveBeenCalledWith(original);
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('treats a replayed 401 as a real rejection: one marker, one sign-in, never a second retry', async () => {
      const interceptor = await interceptorWithStore({ cookies: { session: 'new' } });
      const tools = createTools();
      tools.retry.mockResolvedValueOnce(response(401, UNAUTHORIZED));

      const result = await interceptor.onUpstreamResponse!(
        contextWith({ session: 'old' }),
        response(401, UNAUTHORIZED),
        tools
      );

      expect(tools.retry).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toBe(`CodeMie SSO session expired. ${describeLogin('started')}`);
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('passes a 401 whose body is not the backend session rejection through with its body, and starts no sign-in', async () => {
      const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
      const tools = createTools();
      tools.readBody.mockResolvedValue(LITELLM_401_BODY);
      const original = response(401, UNAUTHORIZED);

      const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, tools);

      expect(tools.fromBuffer).toHaveBeenCalledWith(original, LITELLM_401_BODY);
      expect((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toBe(LITELLM_401_BODY);
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('recovers from a gzip-encoded session rejection', async () => {
      const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
      const tools = createTools();
      tools.readBody.mockResolvedValue(gzipSync(SESSION_REJECTION_BODY));

      const result = await interceptor.onUpstreamResponse!(
        contextWith({ session: 'same' }),
        response(401, { ...UNAUTHORIZED, 'content-encoding': 'gzip' }),
        tools
      );

      expect(result.statusCode).toBe(401);
      expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    });

    it('passes a gzip-encoded non-session 401 through with its original compressed bytes', async () => {
      const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
      const tools = createTools();
      const compressed = gzipSync(LITELLM_401_BODY);
      tools.readBody.mockResolvedValue(compressed);
      const original = response(401, { ...UNAUTHORIZED, 'content-encoding': 'gzip' });

      const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, tools);

      expect(tools.fromBuffer).toHaveBeenCalledWith(original, compressed);
      expect((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toBe(compressed);
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('passes a replayed 401 that is not a session rejection through and starts no sign-in', async () => {
      const interceptor = await interceptorWithStore({ cookies: { session: 'new' } });
      const tools = createTools();
      const replayed = response(401, UNAUTHORIZED);
      tools.retry.mockResolvedValueOnce(replayed);
      tools.readBody.mockResolvedValueOnce(SESSION_REJECTION_BODY).mockResolvedValueOnce(LITELLM_401_BODY);

      const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'old' }), response(401, UNAUTHORIZED), tools);

      expect(tools.fromBuffer).toHaveBeenCalledWith(replayed, LITELLM_401_BODY);
      expect((result as unknown as { _syntheticBody: Buffer })._syntheticBody).toBe(LITELLM_401_BODY);
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('passes a 403 through untouched and starts no sign-in', async () => {
      const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
      const tools = createTools();
      const original = response(403, UNAUTHORIZED);

      const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, tools);

      expect(result).toBe(original);
      expect(tools.readBody).not.toHaveBeenCalled();
      expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    describe('loop guard', () => {
      it('suppresses a 401 with identical cookies after a completed sign-in: original response, body untouched', async () => {
        const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(401, UNAUTHORIZED), createTools());
        expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
        vi.clearAllMocks();
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 60_000);

        const tools = createTools();
        const original = response(401, UNAUTHORIZED);
        const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, tools);

        expect(result.statusCode).toBe(200); // the stub rebuilds a response; the real one keeps the 401
        expect(tools.fromBuffer).toHaveBeenCalledWith(original, SESSION_REJECTION_BODY);
        expect(tools.retry).not.toHaveBeenCalled();
        expect(markAnalyticsAuthInvalid).not.toHaveBeenCalled();
        expect(startDetachedSsoLogin).not.toHaveBeenCalled();
      });

      it.each([
        ['no sign-in is recorded', null],
        ['the last sign-in finished before the rejection', Date.now() - 60_000],
      ])('still recovers from a 401 with identical cookies when %s', async (_label, signedInAt) => {
        const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(401, UNAUTHORIZED), createTools());
        vi.clearAllMocks();
        vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
        vi.mocked(getLastSignInAt).mockResolvedValue(signedInAt);

        const original = response(401, UNAUTHORIZED);
        const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, createTools());

        expect(result).not.toBe(original);
        expect(result.statusCode).toBe(401);
        expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
        expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
      });

      it('recovers from an identical 401 long after the sign-in: the guard only covers the retry that follows it', async () => {
        const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(401, UNAUTHORIZED), createTools());
        vi.clearAllMocks();
        vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 1_000);

        // suppressed right after the sign-in, passed through without a sign-in
        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(401, UNAUTHORIZED), createTools());
        expect(startDetachedSsoLogin).not.toHaveBeenCalled();

        // 48 hours later, same cookies, no new sign-in: a new rejection, acted on
        vi.useFakeTimers({ now: Date.now() + 48 * 3_600_000, toFake: ['Date'] });
        try {
          const original = response(401, UNAUTHORIZED);
          const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, createTools());
          expect(result).not.toBe(original);
          expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
          expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it.each([
        ['returns nothing', async () => null],
        ['returns an empty cookie jar', async () => ({ cookies: {} })],
        ['cannot be read', async () => { throw new Error('keychain locked'); }],
      ])('never suppresses a 401 when the credential store %s', async (_label, readStore) => {
        let reading: () => Promise<{ cookies: Record<string, string> } | null> = async () => ({ cookies: { session: 'same' } });
        const interceptor = await plugin.createInterceptor(
          createPluginContext(
            { cookies: { session: 'same' }, apiUrl: TARGET_API_URL },
            { refreshNow: () => reading() }
          )
        );
        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(401, UNAUTHORIZED), createTools());
        vi.clearAllMocks();
        vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 1_000);
        reading = readStore;

        const original = response(401, UNAUTHORIZED);
        const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, createTools());

        expect(result).not.toBe(original);
        expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
        expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
      });

      it('does not suppress a 401 once the stored cookies changed, even after a completed sign-in', async () => {
        const store = { cookies: { session: 'same' } };
        const interceptor = await interceptorWithStore(store);
        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(401, UNAUTHORIZED), createTools());
        vi.clearAllMocks();
        vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 60_000);
        store.cookies = { session: 'other' };

        const original = response(401, UNAUTHORIZED);
        const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'other' }), original, createTools());

        expect(result).not.toBe(original);
        expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
        expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
      });

      it('clears when a redirect rejection is seen, so the next identical 401 recovers again', async () => {
        const interceptor = await interceptorWithStore({ cookies: { session: 'same' } });
        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(401, UNAUTHORIZED), createTools());
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 60_000);

        await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), response(302, REDIRECT), createTools());
        expect(startDetachedSsoLogin).toHaveBeenCalledTimes(2);
        vi.clearAllMocks();
        vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 60_000);

        const original = response(401, UNAUTHORIZED);
        const result = await interceptor.onUpstreamResponse!(contextWith({ session: 'same' }), original, createTools());

        expect(result).not.toBe(original);
        expect(markAnalyticsAuthInvalid).toHaveBeenCalledTimes(1);
        expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
      });

      it('never logs cookie values while guarding', async () => {
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const interceptor = await interceptorWithStore({ cookies: { session: 'top-secret' } });
        await interceptor.onUpstreamResponse!(contextWith({ session: 'top-secret' }), response(401, UNAUTHORIZED), createTools());
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 60_000);
        await interceptor.onUpstreamResponse!(contextWith({ session: 'top-secret' }), response(401, UNAUTHORIZED), createTools());

        const lines = debugSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(lines).not.toContain('top-secret');
        debugSpy.mockRestore();
      });
    });
  });
});
