/**
 * ProxyHTTPClient tests
 * @group unit
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => ''),
}));

import { ProxyHTTPClient } from './proxy-http-client.js';

function getAgent(client: ProxyHTTPClient, url: string): object {
  return (client as unknown as { getAgentForUrl(target: URL): object }).getAgentForUrl(new URL(url));
}

function getRoutingKind(client: ProxyHTTPClient, url: string): 'direct' | 'proxy' {
  const internal = client as unknown as {
    getAgentForUrl(target: URL): object;
    directHttpAgent: object;
    directHttpsAgent: object;
  };
  const agent = internal.getAgentForUrl(new URL(url));
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
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalProxyEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function createClient(noProxy: string): ProxyHTTPClient {
    process.env.HTTP_PROXY = 'http://proxy.example.test:8080';
    process.env.HTTPS_PROXY = 'http://proxy.example.test:8080';
    process.env.NO_PROXY = noProxy;
    process.env.http_proxy = process.env.HTTP_PROXY;
    process.env.https_proxy = process.env.HTTPS_PROXY;
    process.env.no_proxy = process.env.NO_PROXY;
    const client = new ProxyHTTPClient();
    expect((client as unknown as { proxyHttpAgent?: object }).proxyHttpAgent).toBeDefined();
    expect((client as unknown as { proxyHttpsAgent?: object }).proxyHttpsAgent).toBeDefined();
    return client;
  }

  it('bypasses the proxy for an exact host on any port', () => {
    const client = createClient('api.example.com');

    expect(getAgent(client, 'https://api.example.com:8443/v1')).toBe(
      getAgent(client, 'https://api.example.com:9443/v1')
    );

    client.close();
  });

  it('bypasses the proxy for a domain and its subdomains', () => {
    const client = createClient('.example.com');

    expect(getAgent(client, 'https://api.example.com/v1')).toBe(
      getAgent(client, 'https://nested.api.example.com/v1')
    );
    expect(getRoutingKind(client, 'https://external.example.net/v1')).toBe('proxy');

    client.close();
  });

  it('bypasses the proxy for an IPv4 address inside a CIDR range', () => {
    const client = createClient('10.20.0.0/16');

    expect(getAgent(client, 'http://10.20.15.7/v1')).toBe(
      getAgent(client, 'http://10.20.99.8/v1')
    );
    expect(getRoutingKind(client, 'http://10.21.15.7/v1')).toBe('proxy');

    client.close();
  });

  it('bypasses the proxy for every host when wildcard is configured', () => {
    const client = createClient('*');

    expect(getAgent(client, 'http://public.example.test')).toBe(
      getAgent(client, 'http://private.example.test')
    );

    client.close();
  });

  it('bypasses the proxy only for the configured host and port', () => {
    const client = createClient('api.example.com:8080');

    expect(getRoutingKind(client, 'http://api.example.com:8080/v1')).toBe('direct');
    expect(getRoutingKind(client, 'http://api.example.com:8081/v1')).toBe('proxy');
    expect(getAgent(client, 'http://api.example.com:8081/v1')).toBe(
      getAgent(client, 'http://other.example.com:8081/v1')
    );

    client.close();
  });

  it('uses the implicit protocol port for a port-specific rule', () => {
    const client = createClient('api.example.com:443');

    expect(getRoutingKind(client, 'https://api.example.com/v1')).toBe('direct');
    expect(getRoutingKind(client, 'https://api.example.com:8443/v1')).toBe('proxy');
    expect(getAgent(client, 'https://api.example.com:8443/v1')).toBe(
      getAgent(client, 'https://other.example.com:8443/v1')
    );

    client.close();
  });
});
