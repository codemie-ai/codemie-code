/**
 * ProxyHTTPClient tests
 * @group unit
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => ''),
}));

import { ProxyHTTPClient } from './proxy-http-client.js';
import { resetSystemProxyCache } from '../../../../utils/system-proxy.js';

function getAgent(client: ProxyHTTPClient, url: string): Promise<object> {
  return (client as unknown as { getAgentForUrl(target: URL): Promise<object> })
    .getAgentForUrl(new URL(url));
}

async function getRoutingKind(client: ProxyHTTPClient, url: string): Promise<'direct' | 'proxy'> {
  const internal = client as unknown as {
    getAgentForUrl(target: URL): Promise<object>;
    directHttpAgent: object;
    directHttpsAgent: object;
  };
  const agent = await internal.getAgentForUrl(new URL(url));
  return agent === internal.directHttpAgent || agent === internal.directHttpsAgent ? 'direct' : 'proxy';
}

describe('ProxyHTTPClient NO_PROXY routing', () => {
  const originalProxyEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
    CODEMIE_NO_SYSTEM_PROXY: process.env.CODEMIE_NO_SYSTEM_PROXY,
    CODEMIE_INSECURE: process.env.CODEMIE_INSECURE,
  };

  afterEach(() => {
    resetSystemProxyCache();
    for (const [key, value] of Object.entries(originalProxyEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function createClient(noProxy: string): ProxyHTTPClient {
    process.env.CODEMIE_NO_SYSTEM_PROXY = '1';
    process.env.HTTP_PROXY = 'http://proxy.example.test:8080';
    process.env.HTTPS_PROXY = 'http://proxy.example.test:8080';
    process.env.NO_PROXY = noProxy;
    process.env.http_proxy = process.env.HTTP_PROXY;
    process.env.https_proxy = process.env.HTTPS_PROXY;
    process.env.no_proxy = process.env.NO_PROXY;
    resetSystemProxyCache();
    return new ProxyHTTPClient();
  }

  it('bypasses the proxy for an exact host on any port', async () => {
    const client = createClient('api.example.com');

    expect(await getRoutingKind(client, 'https://api.example.com:8443/v1')).toBe('direct');
    expect(await getAgent(client, 'https://api.example.com:8443/v1')).toBe(
      await getAgent(client, 'https://api.example.com:9443/v1')
    );

    client.close();
  });

  it('bypasses the proxy for a domain and its subdomains', async () => {
    const client = createClient('.example.com');

    expect(await getAgent(client, 'https://api.example.com/v1')).toBe(
      await getAgent(client, 'https://nested.api.example.com/v1')
    );
    expect(await getRoutingKind(client, 'https://external.example.net/v1')).toBe('proxy');

    client.close();
  });

  it('bypasses the proxy for IPv4 wildcard and CIDR ranges', async () => {
    const client = createClient('10.*,192.168.0.0/16');

    expect(await getRoutingKind(client, 'http://10.20.15.7/v1')).toBe('direct');
    expect(await getRoutingKind(client, 'http://192.168.99.8/v1')).toBe('direct');
    expect(await getRoutingKind(client, 'http://172.16.15.7/v1')).toBe('proxy');

    client.close();
  });

  it('bypasses the proxy for every host when wildcard is configured', async () => {
    const client = createClient('*');

    expect(await getAgent(client, 'http://public.example.test')).toBe(
      await getAgent(client, 'http://private.example.test')
    );

    client.close();
  });

  it('bypasses the proxy only for the configured host and port', async () => {
    const client = createClient('api.example.com:8080');

    expect(await getRoutingKind(client, 'http://api.example.com:8080/v1')).toBe('direct');
    expect(await getRoutingKind(client, 'http://api.example.com:8081/v1')).toBe('proxy');
    expect(await getAgent(client, 'http://api.example.com:8081/v1')).toBe(
      await getAgent(client, 'http://other.example.com:8081/v1')
    );

    client.close();
  });

  it('uses the implicit protocol port for a port-specific rule', async () => {
    const client = createClient('api.example.com:443');

    expect(await getRoutingKind(client, 'https://api.example.com/v1')).toBe('direct');
    expect(await getRoutingKind(client, 'https://api.example.com:8443/v1')).toBe('proxy');
    expect(await getAgent(client, 'https://api.example.com:8443/v1')).toBe(
      await getAgent(client, 'https://other.example.com:8443/v1')
    );

    client.close();
  });

  it('reuses a keep-alive proxy agent for repeated requests', async () => {
    const client = createClient('localhost');

    const first = await getAgent(client, 'https://api.example.com/v1');
    const second = await getAgent(client, 'https://api.example.com/v2');
    expect(first).toBe(second);
    expect((first as { keepAlive?: boolean }).keepAlive).toBe(true);

    client.close();
  });

  it('verifies TLS by default and allows the documented insecure override', () => {
    delete process.env.CODEMIE_INSECURE;
    const secureClient = new ProxyHTTPClient();
    expect((secureClient as unknown as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
    secureClient.close();

    process.env.CODEMIE_INSECURE = '1';
    const insecureClient = new ProxyHTTPClient();
    expect((insecureClient as unknown as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(false);
    insecureClient.close();
  });
});
