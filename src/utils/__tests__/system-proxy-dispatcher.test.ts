/**
 * Global fetch integration for the shared system proxy dispatcher.
 * @group unit
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HTTPClient } from '../../providers/core/base/http-client.js';
import { resetSystemProxyCache } from '../system-proxy.js';
import {
  installSystemProxyDispatcher,
  resetSystemProxyDispatcher,
} from '../system-proxy-dispatcher.js';

interface TestServer {
  port: number;
  close(): Promise<void>;
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  host = '127.0.0.1'
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('Server address unavailable');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function listenProxy(onRoute: () => void): Promise<TestServer> {
  const proxy = http.createServer((request, response) => {
    onRoute();
    const target = new URL(request.url ?? '');
    const upstream = http.request(target, {
      method: request.method,
      headers: request.headers,
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    request.pipe(upstream);
  });
  proxy.on('connect', (request, clientSocket, head) => {
    onRoute();
    const target = new URL(`http://${request.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      proxy.off('error', reject);
      resolve();
    });
  });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new TypeError('Proxy address unavailable');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      proxy.close(error => error ? reject(error) : resolve());
    }),
  };
}

describe('system proxy global fetch dispatcher', () => {
  const original = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
    CODEMIE_NO_SYSTEM_PROXY: process.env.CODEMIE_NO_SYSTEM_PROXY,
  };

  afterEach(async () => {
    await resetSystemProxyDispatcher();
    resetSystemProxyCache();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('routes global fetch through the explicit proxy', async () => {
    let proxyRoutes = 0;
    const target = await listen((_request, response) => response.end('proxied'), '0.0.0.0');
    const proxy = await listenProxy(() => { proxyRoutes += 1; });

    try {
      process.env.CODEMIE_NO_SYSTEM_PROXY = '1';
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
      process.env.http_proxy = process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
      resetSystemProxyCache();
      installSystemProxyDispatcher();

      const response = await fetch(`http://127.0.0.2:${target.port}/through-proxy`);
      expect(await response.text()).toBe('proxied');
      expect(proxyRoutes).toBeGreaterThan(0);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it('routes global fetch directly when NO_PROXY matches', async () => {
    let proxyRoutes = 0;
    const target = await listen((_request, response) => response.end('direct'), '0.0.0.0');
    const proxy = await listenProxy(() => { proxyRoutes += 1; });

    try {
      process.env.CODEMIE_NO_SYSTEM_PROXY = '1';
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
      process.env.http_proxy = process.env.HTTP_PROXY;
      process.env.NO_PROXY = '127.0.0.2';
      process.env.no_proxy = process.env.NO_PROXY;
      resetSystemProxyCache();
      installSystemProxyDispatcher();

      const response = await fetch(`http://127.0.0.2:${target.port}/direct`);
      expect(await response.text()).toBe('direct');
      expect(proxyRoutes).toBe(0);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it('routes the Node HTTP client through proxy and bypass paths per request', async () => {
    let proxyRoutes = 0;
    const target = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    }, '0.0.0.0');
    const proxy = await listenProxy(() => { proxyRoutes += 1; });

    try {
      process.env.CODEMIE_NO_SYSTEM_PROXY = '1';
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
      process.env.http_proxy = process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
      resetSystemProxyCache();

      const client = new HTTPClient({ maxRetries: 1 });
      await expect(client.get<{ ok: boolean }>(`http://127.0.0.2:${target.port}/proxied`))
        .resolves.toMatchObject({ data: { ok: true } });
      expect(proxyRoutes).toBeGreaterThan(0);

      const routesAfterProxy = proxyRoutes;
      process.env.NO_PROXY = '127.0.0.2';
      process.env.no_proxy = process.env.NO_PROXY;
      await expect(client.get<{ ok: boolean }>(`http://127.0.0.2:${target.port}/direct`))
        .resolves.toMatchObject({ data: { ok: true } });
      expect(proxyRoutes).toBe(routesAfterProxy);
    } finally {
      await proxy.close();
      await target.close();
    }
  });
});
