/**
 * mcp-auth-proxy server tests — real HTTP against a local fake upstream (MCP RS + AS).
 * @group unit
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpAuthProxy } from '../server.js';
import type { AuthProxyConfig, JsonObject } from '../types.js';

interface FakeUpstream {
  server: http.Server;
  origin: string;
  state: { lastRegisterBody?: JsonObject; lastTokenBody?: string; lastMcpAuth?: string };
}

function createFakeUpstream(): Promise<FakeUpstream> {
  const state: FakeUpstream['state'] = {};
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? '/', origin);
    const sendJson = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = async (): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      return Buffer.concat(chunks).toString('utf-8');
    };

    void (async (): Promise<void> => {
      if (url.pathname === '/mcp/radar' && req.method === 'POST') {
        state.lastMcpAuth = req.headers.authorization;
        if (req.headers.authorization) {
          sendJson(200, { jsonrpc: '2.0', id: 1, result: 'ok' });
        } else {
          res.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/radar", scope="upstream-scope"`,
          });
          res.end();
        }
        return;
      }
      if (url.pathname === '/mcp/radar/sse' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => {
          res.write('data: two\n\n');
          res.end();
        }, 20);
        return;
      }
      if (url.pathname === '/mcp/naked') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (
        url.pathname === '/.well-known/oauth-protected-resource/mcp/radar' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp/naked'
      ) {
        const resource = url.pathname.endsWith('naked') ? `${origin}/mcp/naked` : `${origin}/mcp/radar`;
        sendJson(200, {
          resource,
          authorization_servers: [`${origin}/idp`],
          scopes_supported: ['upstream-scope'],
        });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server/idp') {
        sendJson(200, {
          issuer: `${origin}/idp`,
          authorization_endpoint: `${origin}/idp/authorize`,
          token_endpoint: `${origin}/idp/token`,
          registration_endpoint: `${origin}/idp/register`,
          code_challenge_methods_supported: ['S256'],
          client_id_metadata_document_supported: true,
        });
        return;
      }
      if (url.pathname === '/idp/register' && req.method === 'POST') {
        state.lastRegisterBody = JSON.parse(await readBody()) as JsonObject;
        sendJson(201, { client_id: `dyn-${Date.now()}`, client_name: state.lastRegisterBody.client_name });
        return;
      }
      if (url.pathname === '/idp/token' && req.method === 'POST') {
        state.lastTokenBody = await readBody();
        sendJson(200, { access_token: 'tok-123', token_type: 'Bearer' });
        return;
      }
      sendJson(404, { error: 'not_found' });
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        state,
      });
    });
  });
}

describe('McpAuthProxy', () => {
  let upstream: FakeUpstream;
  let proxy: McpAuthProxy;
  let proxyOrigin: string;

  beforeAll(async () => {
    upstream = await createFakeUpstream();
    const config: AuthProxyConfig = {
      port: 0,
      servers: {
        radar: {
          upstreamUrl: `${upstream.origin}/mcp/radar`,
          clientName: 'EPAM Approved MCP Client',
          scopes: ['openid', 'mcp:access'],
        },
        naked: { upstreamUrl: `${upstream.origin}/mcp/naked` },
        down: { upstreamUrl: 'http://127.0.0.1:1/mcp/down' },
      },
    };
    proxy = new McpAuthProxy(config);
    const { url } = await proxy.start();
    proxyOrigin = url;
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it('streams MCP POSTs through untouched, passing Authorization along', async () => {
    const res = await fetch(`${proxyOrigin}/radar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-abc' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok' });
    expect(upstream.state.lastMcpAuth).toBe('Bearer tok-abc');
  });

  it('rewrites the 401 challenge to point at the proxy PRM with configured scope', async () => {
    const res = await fetch(`${proxyOrigin}/radar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(`resource_metadata="${proxyOrigin}/.well-known/oauth-protected-resource/radar"`);
    expect(challenge).toContain('scope="openid mcp:access"');
    expect(challenge).not.toContain('upstream-scope');
  });

  it('injects a challenge when the upstream 401 carries none', async () => {
    const res = await fetch(`${proxyOrigin}/naked`, { method: 'GET' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(`resource_metadata="${proxyOrigin}/.well-known/oauth-protected-resource/naked"`);
    expect(challenge).not.toContain('scope=');
  });

  it('streams SSE responses through with the event-stream content type', async () => {
    const res = await fetch(`${proxyOrigin}/radar/sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    expect(body).toContain('data: one');
    expect(body).toContain('data: two');
  });

  it('serves the rewritten PRM for a route', async () => {
    const res = await fetch(`${proxyOrigin}/.well-known/oauth-protected-resource/radar`);
    expect(res.status).toBe(200);
    const prm = (await res.json()) as JsonObject;
    expect(prm.resource).toBe(`${proxyOrigin}/radar`);
    expect(prm.authorization_servers).toEqual([`${proxyOrigin}/as/radar`]);
    expect(prm.scopes_supported).toEqual(['openid', 'mcp:access']);
  });

  it('serves identical rewritten AS metadata on all three well-known variants', async () => {
    const variants = [
      `${proxyOrigin}/.well-known/oauth-authorization-server/as/radar`,
      `${proxyOrigin}/.well-known/openid-configuration/as/radar`,
      `${proxyOrigin}/as/radar/.well-known/openid-configuration`,
    ];
    const bodies: JsonObject[] = [];
    for (const variant of variants) {
      const res = await fetch(variant);
      expect(res.status).toBe(200);
      bodies.push((await res.json()) as JsonObject);
    }
    for (const body of bodies) {
      expect(body.issuer).toBe(`${proxyOrigin}/as/radar`);
      expect(body.authorization_endpoint).toBe(`${proxyOrigin}/as/radar/authorize`);
      expect(body.token_endpoint).toBe(`${proxyOrigin}/as/radar/token`);
      expect(body.registration_endpoint).toBe(`${proxyOrigin}/as/radar/register`);
      expect(body.code_challenge_methods_supported).toEqual(['S256']);
      expect(body).not.toHaveProperty('client_id_metadata_document_supported');
      expect(body).not.toHaveProperty('revocation_endpoint');
    }
  });

  it('rewrites DCR bodies (client_name + injected scope) and relays the dynamic client_id', async () => {
    const res = await fetch(`${proxyOrigin}/as/radar/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:33418/callback'],
      }),
    });
    expect(res.status).toBe(201);
    const registered = (await res.json()) as JsonObject;
    expect(String(registered.client_id)).toMatch(/^dyn-/);
    expect(upstream.state.lastRegisterBody?.client_name).toBe('EPAM Approved MCP Client');
    expect(upstream.state.lastRegisterBody?.scope).toBe('openid mcp:access');
    expect(upstream.state.lastRegisterBody?.redirect_uris).toEqual(['http://localhost:33418/callback']);
  });

  it('302-redirects authorize with rewritten scope + resource, preserving PKCE params', async () => {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'dyn-1',
      redirect_uri: 'http://localhost:33418/callback',
      state: 's1',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
      scope: 'claudeai',
      resource: `${proxyOrigin}/radar`,
    });
    const res = await fetch(`${proxyOrigin}/as/radar/authorize?${query.toString()}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${upstream.origin}/idp/authorize`);
    expect(location.searchParams.get('scope')).toBe('openid mcp:access');
    expect(location.searchParams.get('resource')).toBe(`${upstream.origin}/mcp/radar`);
    expect(location.searchParams.get('code_challenge')).toBe('cc');
    expect(location.searchParams.get('state')).toBe('s1');
  });

  it('rewrites token bodies (resource) and relays the token response verbatim', async () => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      code_verifier: 'verifier-1',
      client_id: 'dyn-1',
      redirect_uri: 'http://localhost:33418/callback',
      resource: `${proxyOrigin}/radar`,
    });
    const res = await fetch(`${proxyOrigin}/as/radar/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as JsonObject).access_token).toBe('tok-123');
    const sent = new URLSearchParams(upstream.state.lastTokenBody ?? '');
    expect(sent.get('resource')).toBe(`${upstream.origin}/mcp/radar`);
    expect(sent.get('code')).toBe('auth-code-1');
    expect(sent.get('code_verifier')).toBe('verifier-1');
  });

  it('keeps routes isolated: a dead upstream 502s while others keep working', async () => {
    const downRes = await fetch(`${proxyOrigin}/down`, { method: 'POST', body: '{}' });
    expect(downRes.status).toBe(502);
    expect(await downRes.json()).toEqual({ error: 'upstream_unreachable', route: 'down' });

    const okRes = await fetch(`${proxyOrigin}/radar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-abc' },
      body: '{}',
    });
    expect(okRes.status).toBe(200);
  });

  it('marks a route degraded in /healthz after failed discovery, without touching others', async () => {
    const prmRes = await fetch(`${proxyOrigin}/.well-known/oauth-protected-resource/down`);
    expect(prmRes.status).toBe(502);

    const health = await fetch(`${proxyOrigin}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; routes: Array<{ id: string; status: string }> };
    expect(body.status).toBe('ok');
    expect(body.routes.find((r) => r.id === 'down')?.status).toBe('degraded');
    expect(body.routes.find((r) => r.id === 'radar')?.status).toBe('ok');
  });

  it('rejects oversized register bodies with 413', async () => {
    const res = await fetch(`${proxyOrigin}/as/radar/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'x'.repeat(65 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('404s unknown routes and the root PRM alias when multiple routes exist', async () => {
    const unknown = await fetch(`${proxyOrigin}/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_route' });

    const rootPrm = await fetch(`${proxyOrigin}/.well-known/oauth-protected-resource`);
    expect(rootPrm.status).toBe(404);
  });
});

describe('McpAuthProxy single-route alias', () => {
  it('serves the root PRM alias when exactly one route is configured', async () => {
    const upstream = await createFakeUpstream();
    const config: AuthProxyConfig = {
      port: 0,
      servers: { radar: { upstreamUrl: `${upstream.origin}/mcp/radar` } },
    };
    const solo = new McpAuthProxy(config);
    const { url } = await solo.start();
    try {
      const res = await fetch(`${url}/.well-known/oauth-protected-resource`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as JsonObject).resource).toBe(`${url}/radar`);
    } finally {
      await solo.stop();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });
});
