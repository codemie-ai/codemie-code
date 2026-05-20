/**
 * E2E Tests: SSO Session Expiry Handling
 *
 * True end-to-end: real CodeMieProxy + real mock upstream HTTP server.
 * Zero vi.mock() — the full proxy stack runs as-is.
 *
 * Scenarios:
 *   E1 — upstream 401 → proxy returns HTTP 401 + Anthropic authentication_error JSON
 *   E2 — upstream 403 → proxy returns HTTP 401 + Anthropic authentication_error JSON
 *   E3 — upstream 200 → proxy passes response through intact (regression guard)
 *
 * @group e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeMieProxy } from '../../../src/providers/plugins/sso/proxy/sso.proxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startMockUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(0, 'localhost', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
}

async function startProxyAgainst(upstreamUrl: string): Promise<{ proxy: CodeMieProxy; url: string }> {
  const proxy = new CodeMieProxy({
    targetApiUrl: upstreamUrl,
    authMethod: 'jwt',
    jwtToken: 'e2e-test-token',
    sessionId: 'e2e-session',
  });
  const { url } = await proxy.start();
  return { proxy, url };
}

// ---------------------------------------------------------------------------
// E1 — upstream returns 401
// ---------------------------------------------------------------------------

describe('E1: upstream 401 → clean authentication_error response', () => {
  let upstream: Server;
  let proxy: CodeMieProxy;
  let proxyUrl: string;

  beforeAll(async () => {
    const mock = await startMockUpstream((_req, res) => {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Token expired' }));
    });
    upstream = mock.server;
    ({ proxy, url: proxyUrl } = await startProxyAgainst(mock.url));
  });

  afterAll(async () => {
    await proxy.stop();
    await stopServer(upstream);
  });

  it('returns HTTP 401', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('sets Content-Type to application/json', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('body has type === "error"', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe('error');
  });

  it('body.error.type === "authentication_error"', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('authentication_error');
  });

  it('body.error.message references "codemie profile login"', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.message).toContain('codemie profile login');
  });
});

// ---------------------------------------------------------------------------
// E2 — upstream returns 403
// ---------------------------------------------------------------------------

describe('E2: upstream 403 → clean authentication_error response', () => {
  let upstream: Server;
  let proxy: CodeMieProxy;
  let proxyUrl: string;

  beforeAll(async () => {
    const mock = await startMockUpstream((_req, res) => {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden' }));
    });
    upstream = mock.server;
    ({ proxy, url: proxyUrl } = await startProxyAgainst(mock.url));
  });

  afterAll(async () => {
    await proxy.stop();
    await stopServer(upstream);
  });

  it('returns HTTP 401', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('body.error.type === "authentication_error"', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe('authentication_error');
  });
});

// ---------------------------------------------------------------------------
// E3 — upstream returns 200 — passthrough regression guard
// ---------------------------------------------------------------------------

describe('E3: upstream 200 → proxy passes response through intact', () => {
  let upstream: Server;
  let proxy: CodeMieProxy;
  let proxyUrl: string;

  const UPSTREAM_BODY = { id: 'msg_01', type: 'message', content: [] };

  beforeAll(async () => {
    const mock = await startMockUpstream((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(UPSTREAM_BODY));
    });
    upstream = mock.server;
    ({ proxy, url: proxyUrl } = await startProxyAgainst(mock.url));
  });

  afterAll(async () => {
    await proxy.stop();
    await stopServer(upstream);
  });

  it('passes through HTTP 200', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('passes through the upstream JSON body intact', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST' });
    const body = await res.json();
    expect(body).toMatchObject(UPSTREAM_BODY);
  });
});
