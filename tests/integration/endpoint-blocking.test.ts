/**
 * Integration Test: Endpoint Blocking
 *
 * Verifies that when endpoint-blocker marks a request as blocked:
 * 1. Subsequent onRequest hooks are skipped
 * 2. No upstream request is made
 * 3. Returns 200 OK immediately
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeMieProxy } from '../../src/providers/plugins/sso/proxy/sso.proxy.js';
import { ProxyConfig } from '../../src/providers/plugins/sso/proxy/proxy-types.js';
import http from 'http';
import { setupTestIsolation } from '../helpers/test-isolation.js';

describe('Endpoint Blocking Integration', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let proxy: CodeMieProxy;
  let proxyUrl: string;
  let upstreamCallCount = 0;
  let mockUpstreamServer: http.Server;

  beforeEach(async () => {
    // Reset counter
    upstreamCallCount = 0;

    // Start mock upstream server to verify it's NOT called for blocked endpoints
    mockUpstreamServer = http.createServer((req, res) => {
      upstreamCallCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Upstream received request' }));
    });

    await new Promise<void>((resolve) => {
      mockUpstreamServer.listen(0, 'localhost', () => {
        resolve();
      });
    });

    const address = mockUpstreamServer.address();
    const upstreamPort = typeof address === 'object' && address ? address.port : 0;

    // Start proxy
    const config: ProxyConfig = {
      targetApiUrl: `http://localhost:${upstreamPort}`,
      provider: 'test',
      sessionId: 'test-session'
    };

    proxy = new CodeMieProxy(config);
    const { url } = await proxy.start();
    proxyUrl = url;
  });

  afterEach(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => {
      mockUpstreamServer.close(() => resolve());
    });
  });

  it('should block /api/event_logging/batch without forwarding to upstream', async () => {
    // Make request to blocked endpoint
    const response = await fetch(`${proxyUrl}/api/event_logging/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ test: 'data' })
    });

    // Verify response
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({ success: true });

    // CRITICAL: Verify upstream was NOT called
    expect(upstreamCallCount).toBe(0);
  });

  it('should forward normal endpoints to upstream', async () => {
    // Make request to normal endpoint
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ test: 'data' })
    });

    // Verify response
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ message: 'Upstream received request' });

    // Verify upstream WAS called
    expect(upstreamCallCount).toBe(1);
  });

  it('should block case-insensitive variations', async () => {
    // Make request with uppercase path
    const response = await fetch(`${proxyUrl}/API/EVENT_LOGGING/BATCH`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ test: 'data' })
    });

    // Verify blocked
    expect(response.status).toBe(200);
    expect(upstreamCallCount).toBe(0);
  });
});
