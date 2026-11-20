/**
 * Tests for `OtlpInterceptor`'s credential-refresh recovery: once
 * `markCredentialsStale()` is set (an upstream 401/403), the daemon must pick up a
 * freshly re-authenticated credential set without a restart, both opportunistically
 * on inbound OTLP traffic and on its own forwarding tick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';
import type { PluginContext } from '../types.js';
import type { CredentialRefresher } from '../credential-refresh.js';
import type { SSOAuth } from '@/providers/plugins/sso/auth/types.js';

const areCredentialsStaleMock = vi.fn();
const clearCredentialsStaleMock = vi.fn();
const resolveFreshCredentialsMock = vi.fn();
const listSessionIdsMock = vi.fn();
const processSessionTickMock = vi.fn();

vi.mock('../otlp-spool/auth-state.js', () => ({
  areCredentialsStale: areCredentialsStaleMock,
  clearCredentialsStale: clearCredentialsStaleMock,
  markCredentialsStale: vi.fn(),
  resolveFreshCredentials: resolveFreshCredentialsMock,
}));
vi.mock('../otlp-spool/spool-paths.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSessionIds: listSessionIdsMock,
}));
vi.mock('../otlp-spool/tick-processor.js', () => ({
  processSessionTick: processSessionTickMock,
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { OtlpPlugin } = await import('../otlp.plugin.js');
const { toSSOAuth } = await import('@/providers/plugins/sso/auth/selection.js');

/**
 * A stored cookie login as the resolver builds it. The email is set so `withVerifiedOwner` returns
 * the credential as-is instead of calling `/v1/user`.
 */
function cookieAuth(cookies: Record<string, string>): SSOAuth {
  return toSSOAuth({ type: 'cookie', record: { cookies, apiUrl: 'https://api', email: 'dev@example.com' } }, 'https://api');
}

/** The shared refresher as sso.proxy.ts wires it; the forwarder only reads its snapshot. */
function refresherOf(auth: SSOAuth): CredentialRefresher {
  return { get: () => auth } as unknown as CredentialRefresher;
}

function fakeResponse(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: () => {},
    end(chunk?: string) {
      res.body = chunk ?? '';
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

/** Any route is enough: the refresh attempt fires at the top of `handleRequest`. */
function unroutedContext(): ProxyContext {
  return {
    requestId: 'req-1',
    sessionId: 'proxy-session',
    agentName: 'claude-code-otlp',
    method: 'GET',
    url: '/not-an-otlp-route',
    headers: {},
    requestBody: undefined,
    requestStartTime: Date.now(),
    metadata: {},
  } as ProxyContext;
}

/** The refresh attempt is fire-and-forget; let its microtasks settle before asserting. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('OtlpInterceptor — credential refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionIdsMock.mockResolvedValue([]);
    processSessionTickMock.mockResolvedValue(undefined);
  });

  it('does not attempt a refresh on inbound traffic when credentials are not stale', async () => {
    areCredentialsStaleMock.mockReturnValue(false);
    const plugin = new OtlpPlugin();
    const interceptor = plugin.createInterceptor({
      credentialRefresher: refresherOf(cookieAuth({})),
      config: { targetApiUrl: 'https://api' },
    } as unknown as PluginContext);

    await interceptor.handleRequest(unroutedContext(), {} as IncomingMessage, fakeResponse(), {} as ProxyHTTPClient);
    await flush();

    expect(resolveFreshCredentialsMock).not.toHaveBeenCalled();
  });

  it('refreshes and clears the stale flag on the next inbound request once credentials go stale', async () => {
    areCredentialsStaleMock.mockReturnValue(true);
    const freshCreds = cookieAuth({ codemie_access_token: 'new' });
    resolveFreshCredentialsMock.mockResolvedValue(freshCreds);
    const config = { targetApiUrl: 'https://api', syncCodeMieUrl: 'https://org.example.com' };

    const plugin = new OtlpPlugin();
    const interceptor = plugin.createInterceptor({
      credentialRefresher: refresherOf(cookieAuth({})),
      config,
    } as unknown as PluginContext);

    await interceptor.handleRequest(unroutedContext(), {} as IncomingMessage, fakeResponse(), {} as ProxyHTTPClient);
    await flush();

    expect(resolveFreshCredentialsMock).toHaveBeenCalledWith(config);
    expect(clearCredentialsStaleMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when stale but no config is available (e.g. an empty plugin context)', async () => {
    areCredentialsStaleMock.mockReturnValue(true);
    const plugin = new OtlpPlugin();
    const interceptor = plugin.createInterceptor({} as unknown as PluginContext);

    await interceptor.handleRequest(unroutedContext(), {} as IncomingMessage, fakeResponse(), {} as ProxyHTTPClient);
    await flush();

    expect(resolveFreshCredentialsMock).not.toHaveBeenCalled();
  });

  it('leaves the stale flag set when the credential store still has nothing fresh', async () => {
    areCredentialsStaleMock.mockReturnValue(true);
    resolveFreshCredentialsMock.mockResolvedValue(null);
    const plugin = new OtlpPlugin();
    const interceptor = plugin.createInterceptor({
      config: { targetApiUrl: 'https://api' },
    } as unknown as PluginContext);

    await interceptor.handleRequest(unroutedContext(), {} as IncomingMessage, fakeResponse(), {} as ProxyHTTPClient);
    await flush();

    expect(resolveFreshCredentialsMock).toHaveBeenCalled();
    expect(clearCredentialsStaleMock).not.toHaveBeenCalled();
  });

  it("tick() retries stale credentials and forwards sessions with the refreshed ones", async () => {
    areCredentialsStaleMock.mockReturnValue(true);
    const freshCreds = cookieAuth({ codemie_access_token: 'new' });
    resolveFreshCredentialsMock.mockResolvedValue(freshCreds);
    listSessionIdsMock.mockResolvedValue(['s1']);
    const config = { targetApiUrl: 'https://api' };

    const plugin = new OtlpPlugin();
    const interceptor = plugin.createInterceptor({ config } as unknown as PluginContext);

    // onProxyStop runs one bounded tick() directly, with no live timer needed.
    await interceptor.onProxyStop?.();

    expect(resolveFreshCredentialsMock).toHaveBeenCalledWith(config);
    expect(clearCredentialsStaleMock).toHaveBeenCalledTimes(1);
    expect(processSessionTickMock).toHaveBeenCalledWith('s1', freshCreds);
  });
});

describe('OtlpInterceptor — bounded shutdown flush', () => {
  const credentials = cookieAuth({ session: 'c' });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    areCredentialsStaleMock.mockReturnValue(false);
    processSessionTickMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves no timer pending once a fast flush settles', async () => {
    listSessionIdsMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(['s1']), 10))
    );
    const interceptor = new OtlpPlugin().createInterceptor({ credentialRefresher: refresherOf(credentials) } as unknown as PluginContext);

    const stopped = interceptor.onProxyStop!();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;

    expect(processSessionTickMock).toHaveBeenCalledWith('s1', credentials);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on a flush that never settles at 5000 ms', async () => {
    listSessionIdsMock.mockImplementation(() => new Promise(() => {}));
    const interceptor = new OtlpPlugin().createInterceptor({ credentialRefresher: refresherOf(credentials) } as unknown as PluginContext);

    let resolved = false;
    void interceptor.onProxyStop!().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });
});
