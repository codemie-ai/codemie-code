/**
 * mcp-auth-proxy config validation tests
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AUTH_PROXY_PORT,
  loadAuthProxyConfig,
  validateAuthProxyConfig,
} from '../config.js';
import { ConfigurationError } from '../../../utils/errors.js';

const validServers = { radar: { upstreamUrl: 'https://mcp.example.com/mcp/radar' } };

describe('validateAuthProxyConfig', () => {
  it('accepts a minimal config and applies the default port', () => {
    const config = validateAuthProxyConfig({ servers: validServers });
    expect(config.port).toBe(DEFAULT_AUTH_PROXY_PORT);
    expect(config.servers.radar.upstreamUrl).toBe('https://mcp.example.com/mcp/radar');
  });

  it('accepts a full route config and strips trailing slashes from upstreamUrl', () => {
    const config = validateAuthProxyConfig({
      port: 42801,
      servers: {
        radar: {
          upstreamUrl: 'https://mcp.example.com/mcp/radar/',
          clientName: 'EPAM Approved MCP Client',
          scopes: ['openid', 'mcp:access'],
        },
      },
    });
    expect(config.port).toBe(42801);
    expect(config.servers.radar.upstreamUrl).toBe('https://mcp.example.com/mcp/radar');
    expect(config.servers.radar.clientName).toBe('EPAM Approved MCP Client');
    expect(config.servers.radar.scopes).toEqual(['openid', 'mcp:access']);
  });

  it.each([null, [], 'x', 42])('rejects non-object root: %j', (root) => {
    expect(() => validateAuthProxyConfig(root)).toThrow(ConfigurationError);
  });

  it.each([0, -1, 1.5, 70000, '42800'])('rejects invalid port %j naming "port"', (port) => {
    expect(() => validateAuthProxyConfig({ port, servers: validServers })).toThrow(/"port"/);
  });

  it('rejects missing or empty servers naming "servers"', () => {
    expect(() => validateAuthProxyConfig({})).toThrow(/"servers"/);
    expect(() => validateAuthProxyConfig({ servers: {} })).toThrow(/at least one route/);
  });

  it.each(['Radar', '-radar', 'ra_dar', 'ra.dar'])('rejects invalid route id %j with key path', (id) => {
    expect(() =>
      validateAuthProxyConfig({ servers: { [id]: { upstreamUrl: 'https://x.example' } } })
    ).toThrow(/servers\./);
  });

  it.each(['as', 'healthz'])('rejects reserved route id %j', (id) => {
    expect(() =>
      validateAuthProxyConfig({ servers: { [id]: { upstreamUrl: 'https://x.example' } } })
    ).toThrow(/reserved/);
  });

  it('rejects missing, malformed, and non-https upstreamUrl with key path', () => {
    expect(() => validateAuthProxyConfig({ servers: { radar: {} } })).toThrow(
      /servers\.radar\.upstreamUrl/
    );
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl: 'not a url' } } })
    ).toThrow(/servers\.radar\.upstreamUrl/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl: 'http://mcp.example.com' } } })
    ).toThrow(/servers\.radar\.upstreamUrl.*https/);
  });

  it('rejects empty clientName and invalid scopes with key paths', () => {
    const upstreamUrl = 'https://x.example';
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, clientName: '' } } })
    ).toThrow(/servers\.radar\.clientName/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, scopes: [] } } })
    ).toThrow(/servers\.radar\.scopes/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, scopes: [''] } } })
    ).toThrow(/servers\.radar\.scopes/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, scopes: 'openid' } } })
    ).toThrow(/servers\.radar\.scopes/);
  });
});

describe('loadAuthProxyConfig', () => {
  it('throws ConfigurationError for a missing config file', async () => {
    const missing = join(tmpdir(), `mcp-auth-proxy-missing-${process.pid}.json`);
    await expect(loadAuthProxyConfig(missing)).rejects.toThrow(ConfigurationError);
    await expect(loadAuthProxyConfig(missing)).rejects.toThrow(/not found/);
  });
});
