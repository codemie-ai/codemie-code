/**
 * Regression for the "VS Code says no connection after the SSO login expired" incident:
 * the watcher restarted the proxy, start() threw because the login was gone, and the pinned port
 * was left with nothing listening (client: ECONNREFUSED). Real sockets, fake proxy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { ProxyHost, isSsoAuthFailure, type HostedProxy } from '../proxy-host.js';
import { AuthRequiredServer } from '../auth-required-server.js';
import { AuthenticationError } from '@/providers/plugins/sso/proxy/proxy-errors.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({
  startDetachedSsoLogin: vi.fn().mockResolvedValue('started'),
  describeLogin: () => 'Complete the sign-in, then re-send your prompt.',
}));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Stands in for CodeMieProxy: serves 200 on `port`, or throws like start() without stored credentials. */
function fakeProxy(port: number, hasLogin: () => boolean): HostedProxy {
  let server: Server | undefined;
  return {
    async start() {
      if (!hasLogin()) throw new AuthenticationError('SSO credentials not found');
      server = createHttpServer((_req, res) => { res.writeHead(200); res.end('ok'); });
      await new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
      return { port, url: `http://127.0.0.1:${port}` };
    },
    async stop() {
      const s = server;
      server = undefined;
      if (s) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
    },
  };
}

describe('proxy restart after the SSO login expired', () => {
  let host: ProxyHost | undefined;
  afterEach(async () => { await host?.stop(); host = undefined; });

  it('answers 401 on the pinned port instead of refusing the connection, then recovers after sign-in', async () => {
    const port = await freePort();
    let loggedIn = true;
    host = new ProxyHost({
      createProxy: () => fakeProxy(port, () => loggedIn),
      createAuthServer: () => new AuthRequiredServer({ host: '127.0.0.1', port, loginUrl: 'https://example.test/api' }),
      isAuthFailure: isSsoAuthFailure,
    });

    await host.start();
    expect((await fetch(`http://127.0.0.1:${port}/v1/messages`)).status).toBe(200);

    loggedIn = false; // overnight: the stored login expired and was deleted
    expect((await host.restart()).mode).toBe('auth-required');

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' });
    const body = await res.json() as { error: { type: string; message: string } };
    expect(res.status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('CodeMie SSO session expired.');

    loggedIn = true; // user signed in
    expect((await host.restart()).mode).toBe('full');
    expect((await fetch(`http://127.0.0.1:${port}/v1/messages`)).status).toBe(200);
  });
});
