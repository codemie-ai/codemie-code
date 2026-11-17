/**
 * A real CodeMieProxy in gateway mode answers the endpoints clients probe before
 * they send the gateway key — managed-settings and OAuth discovery — locally,
 * and still rejects everything else without the key.
 *
 * Regression: GatewayKeyPlugin (handleRequest, priority 7) used to 401 these
 * before EndpointBlocker (then an onRequest hook) ever saw them, so Claude
 * Desktop's "Sign in with your organization" failed with
 * "gateway SSO discovery failed: 401".
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { getPluginRegistry, resetPluginRegistry } from '../plugins/registry.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { CodeMieProxy } = await import('../sso.proxy.js');
const { EndpointBlockerPlugin } = await import('../plugins/endpoint-blocker.plugin.js');
const { GatewayKeyPlugin } = await import('../plugins/gateway-key.plugin.js');

const GATEWAY_KEY = 'test-gateway-key';

interface UpstreamHit {
  url: string;
  authorization: string | undefined;
}

async function startUpstream(hits: UpstreamHit[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', authorization: req.headers.authorization });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ upstream: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('CodeMieProxy gateway mode — endpoints answered before the gateway key check', () => {
  let upstream: { server: Server; url: string };
  let hits: UpstreamHit[];
  let proxy: InstanceType<typeof CodeMieProxy>;
  let proxyUrl: string;

  beforeEach(async () => {
    resetPluginRegistry();
    getPluginRegistry().register(new EndpointBlockerPlugin());
    getPluginRegistry().register(new GatewayKeyPlugin());

    hits = [];
    upstream = await startUpstream(hits);
    proxy = new CodeMieProxy({
      targetApiUrl: upstream.url,
      host: '127.0.0.1',
      port: 0,
      provider: 'test-provider',
      gatewayKey: GATEWAY_KEY,
    });
    ({ url: proxyUrl } = await proxy.start());
  });

  afterEach(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    resetPluginRegistry();
  });

  it.each([
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-protected-resource',
  ])('answers GET %s without the key with 404, never forwarding it', async (path) => {
    const response = await fetch(`${proxyUrl}${path}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
    expect(hits).toEqual([]);
  });

  it('answers GET /managed-settings without the key with 200 {}', async () => {
    const response = await fetch(`${proxyUrl}/managed-settings`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(hits).toEqual([]);
  });

  it('still rejects model traffic without the key', async () => {
    const response = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { type: 'authentication_error' } });
    expect(hits).toEqual([]);
  });

  it('forwards model traffic with the key, stripping the gateway key header', async () => {
    const response = await fetch(`${proxyUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
    });

    expect(response.status).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('/v1/models');
    expect(hits[0].authorization).toBeUndefined();
  });
});
