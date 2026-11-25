/**
 * CodeMieProxy auth wiring: the SSO start resolves the stored login through the SSO auth resolver
 * (usable cookies, else a stored JWT when a reverse proxy stripped them), an explicit JWT is never
 * re-read from the store, and a typed ProxyError from an onRequest hook fails the request
 * closed while a plain Error only skips that interceptor.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));
import { CredentialStore } from '@/utils/security.js';
import { CodeMieProxy } from '../sso.proxy.js';
import { getPluginRegistry, resetPluginRegistry } from '../plugins/registry.js';
import type { PluginContext, ProxyInterceptor, ProxyPlugin } from '../plugins/types.js';
import type { ProxyContext } from '../proxy-types.js';
import { AuthenticationError } from '../proxy-errors.js';
import { AuthMethod } from '@/providers/core/types.js';
import '@/providers/plugins/sso/index.js'; // register the SSO provider

const TARGET = 'http://127.0.0.1:9';

function plugin(id: string, priority: number, build: (context: PluginContext) => Omit<ProxyInterceptor, 'name'>): ProxyPlugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    priority,
    createInterceptor: (context: PluginContext): ProxyInterceptor => ({ name: id, ...build(context) }),
  };
}

function proxyContext(): ProxyContext {
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

describe('CodeMieProxy auth wiring', () => {
  let proxy: CodeMieProxy | undefined;
  let tempHome: string;
  let previousHome: string | undefined;
  // The resolver reads both slots per URL (and the global slot when the URL has none).
  const retrieveSSOCredentials = vi.fn();
  const retrieveJWTCredentials = vi.fn();

  beforeEach(async () => {
    previousHome = process.env.CODEMIE_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'codemie-proxy-auth-'));
    process.env.CODEMIE_HOME = tempHome;
    resetPluginRegistry();
    retrieveSSOCredentials.mockReset().mockResolvedValue(null);
    retrieveJWTCredentials.mockReset().mockResolvedValue(null);
    vi.spyOn(CredentialStore, 'getInstance').mockReturnValue({
      retrieveSSOCredentials,
      retrieveJWTCredentials,
    } as unknown as CredentialStore);
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    resetPluginRegistry();
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  describe('SSO start', () => {
    async function startSso(): Promise<PluginContext> {
      let seen: PluginContext | undefined;
      getPluginRegistry().register(plugin('test-capture', 10, (context) => {
        seen = context;
        return {};
      }));
      proxy = new CodeMieProxy({ targetApiUrl: TARGET, host: '127.0.0.1', port: 0, provider: 'ai-run-sso' });
      await proxy.start();
      return seen!;
    }

    /** Seeds one record under TARGET only (no global-slot record). */
    function seed(mock: typeof retrieveSSOCredentials, record: unknown): void {
      mock.mockImplementation(async (url?: string) => (url === TARGET ? record : null));
    }

    it('uses the stored cookies when they are usable, over a stored JWT', async () => {
      seed(retrieveSSOCredentials, { cookies: { session: 'c' }, apiUrl: TARGET });
      seed(retrieveJWTCredentials, { token: 'jwt-other', apiUrl: TARGET });

      const context = await startSso();

      expect(context.credentials).toMatchObject({ type: 'cookie', cookies: { session: 'c' }, headers: { cookie: 'session=c' } });
    });

    it.each([
      ['no SSO record', null],
      ['an SSO record with empty cookies', { cookies: {}, apiUrl: TARGET }],
      ['an SSO record with only unusable cookies', { cookies: { '': 'x', bad: 'a\r\nb' }, apiUrl: TARGET }],
    ])('falls back to the stored JWT for %s', async (_label, stored) => {
      seed(retrieveSSOCredentials, stored);
      seed(retrieveJWTCredentials, { token: 'jwt-fallback', apiUrl: TARGET });

      const context = await startSso();

      expect(retrieveJWTCredentials).toHaveBeenCalledWith(TARGET, { includeExpired: true });
      const expected = { type: 'jwt', token: 'jwt-fallback', apiUrl: TARGET, headers: { authorization: 'Bearer jwt-fallback' }, source: 'store' };
      expect(context.credentials).toMatchObject(expected);
      expect(context.syncCredentialRefresher?.get()).toMatchObject(expected);
    });

    it('fails with AuthenticationError when neither cookies nor a JWT are stored', async () => {
      proxy = new CodeMieProxy({ targetApiUrl: TARGET, host: '127.0.0.1', port: 0, provider: 'ai-run-sso' });

      await expect(proxy.start()).rejects.toBeInstanceOf(AuthenticationError);
      proxy = undefined;
    });
  });

  describe('JWT start', () => {
    it('never replaces an explicitly handed-in token from the credential store', async () => {
      let seen: PluginContext | undefined;
      getPluginRegistry().register(plugin('test-capture', 10, (context) => {
        seen = context;
        return {};
      }));
      retrieveJWTCredentials.mockResolvedValue({ token: 'jwt-stored', apiUrl: TARGET });
      retrieveSSOCredentials.mockResolvedValue({ cookies: { session: 'stored' }, apiUrl: TARGET });
      proxy = new CodeMieProxy({ targetApiUrl: TARGET, host: '127.0.0.1', port: 0, authMethod: AuthMethod.JWT, jwtToken: 'jwt-explicit' });
      await proxy.start();

      expect(await seen!.credentialRefresher!.refresh()).toMatchObject({
        type: 'jwt',
        token: 'jwt-explicit',
        apiUrl: TARGET,
        source: 'explicit',
        headers: { authorization: 'Bearer jwt-explicit' },
      });
      expect(await seen!.credentialRefresher!.refreshNow()).toBeNull();
      expect(retrieveJWTCredentials).not.toHaveBeenCalled();
      expect(retrieveSSOCredentials).not.toHaveBeenCalled();
    });
  });

  describe('onRequest hook errors', () => {
    type RunHook = (hookName: string, fn: (i: ProxyInterceptor) => Promise<void> | void | undefined, context?: ProxyContext) => Promise<void>;

    async function startWith(...plugins: ProxyPlugin[]): Promise<RunHook> {
      for (const p of plugins) getPluginRegistry().register(p);
      proxy = new CodeMieProxy({ targetApiUrl: TARGET, host: '127.0.0.1', port: 0, provider: 'test-provider' });
      await proxy.start();
      return (proxy as unknown as { runHook: RunHook }).runHook.bind(proxy);
    }

    it('rethrows a ProxyError so the request fails closed and later interceptors do not run', async () => {
      const later = vi.fn();
      const runHook = await startWith(
        plugin('test-auth', 10, () => ({
          onRequest: async () => {
            throw new AuthenticationError('JWT token expired. Please re-authenticate.');
          },
        })),
        plugin('test-later', 20, () => ({ onRequest: later }))
      );
      const context = proxyContext();

      await expect(runHook('onRequest', (i) => i.onRequest?.(context), context)).rejects.toBeInstanceOf(AuthenticationError);
      expect(later).not.toHaveBeenCalled();
    });

    it('swallows a plain Error and continues with the remaining interceptors', async () => {
      const later = vi.fn();
      const runHook = await startWith(
        plugin('test-skip', 10, () => ({
          onRequest: async () => {
            throw new Error('Plugin disabled for agent: claude');
          },
        })),
        plugin('test-later', 20, () => ({ onRequest: later }))
      );
      const context = proxyContext();

      await expect(runHook('onRequest', (i) => i.onRequest?.(context), context)).resolves.toBeUndefined();
      expect(later).toHaveBeenCalledTimes(1);
    });

    it('swallows a ProxyError from a hook other than onRequest', async () => {
      const runHook = await startWith(
        plugin('test-auth', 10, () => ({
          onProxyStart: async () => {
            throw new AuthenticationError('boom');
          },
        }))
      );

      await expect(runHook('onProxyStart', (i) => i.onProxyStart?.())).resolves.toBeUndefined();
    });
  });
});
