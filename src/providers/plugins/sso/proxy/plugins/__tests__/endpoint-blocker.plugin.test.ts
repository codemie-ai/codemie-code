/**
 * Endpoint Blocker Plugin Tests
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerResponse } from 'http';
import { EndpointBlockerPlugin } from '../endpoint-blocker.plugin.js';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';
import { logger } from '../../../../../../utils/logger.js';

function makeContext(url: string, method = 'GET'): ProxyContext {
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method,
    url,
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

function makeMockRes() {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  let statusCode = 200;
  const res = {
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    end: vi.fn((data?: string) => { body = data; }),
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
  };
  return {
    res: res as unknown as ServerResponse,
    end: res.end,
    getBody: () => body,
    getStatusCode: () => statusCode,
    getHeader: (k: string) => headers[k],
  };
}

describe('EndpointBlockerPlugin', () => {
  let plugin: EndpointBlockerPlugin;
  let interceptor: ProxyInterceptor;

  beforeEach(async () => {
    plugin = new EndpointBlockerPlugin();
    const pluginContext: PluginContext = {
      config: {
        targetApiUrl: 'https://api.example.com',
        provider: 'test',
        sessionId: 'test-session',
      },
      logger,
    };
    interceptor = await plugin.createInterceptor(pluginContext);
  });

  async function handle(url: string, method = 'GET') {
    const context = makeContext(url, method);
    const mock = makeMockRes();
    const handled = await interceptor.handleRequest!(
      context,
      {} as never,
      mock.res,
      {} as ProxyHTTPClient
    );
    return { handled, context, ...mock };
  }

  describe('Plugin Metadata', () => {
    it('should have correct plugin metadata', () => {
      expect(plugin.id).toBe('@codemie/proxy-endpoint-blocker');
      expect(plugin.name).toBe('Endpoint Blocker');
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.priority).toBe(5); // Before the gateway key check (7)
    });

    it('answers in the handleRequest phase, not onRequest', () => {
      expect(interceptor.handleRequest).toBeTypeOf('function');
      expect(interceptor.onRequest).toBeUndefined();
    });
  });

  describe('telemetry endpoints', () => {
    it.each([
      '/api/event_logging/batch',
      '//api/event_logging/batch',
      '/API/EVENT_LOGGING/BATCH',
    ])('answers %s with 200 {"success":true}', async (url) => {
      const r = await handle(url, 'POST');

      expect(r.handled).toBe(true);
      expect(r.getStatusCode()).toBe(200);
      expect(r.getHeader('Content-Type')).toBe('application/json');
      expect(JSON.parse(r.getBody()!)).toEqual({ success: true });
      expect(r.context.metadata.blocked).toBe(true);
      expect(r.context.metadata.blockedReason).toContain('Matched pattern');
    });

    it('does not match partial paths', async () => {
      const r = await handle('/api/event_logging/batch/extra', 'POST');

      expect(r.handled).toBe(false);
      expect(r.end).not.toHaveBeenCalled();
      expect(r.context.metadata.blocked).toBeUndefined();
    });
  });

  describe('managed-settings endpoints', () => {
    it.each([
      '/managed-settings',
      '/managed-settings?platform=darwin',
      '/v1/managed-settings',
      '/api/claude/managed-settings',
      '/api/v1/managed-settings/',
    ])('answers %s with 200 {}', async (url) => {
      const r = await handle(url);

      expect(r.handled).toBe(true);
      expect(r.getStatusCode()).toBe(200);
      expect(r.getBody()).toBe('{}');
    });

    it('does not match a longer path segment', async () => {
      const r = await handle('/managed-settings-extra');
      expect(r.handled).toBe(false);
    });
  });

  describe('OAuth / OIDC discovery on the gateway root', () => {
    it.each([
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server/v1',
      '/.well-known/openid-configuration?x=1',
    ])('answers %s with 404 instead of letting the gateway key check 401 it', async (url) => {
      const r = await handle(url);

      expect(r.handled).toBe(true);
      expect(r.getStatusCode()).toBe(404);
      expect(r.getHeader('Content-Type')).toBe('application/json');
      expect(JSON.parse(r.getBody()!)).toMatchObject({ error: 'not_found' });
    });

    it.each([
      '/.well-known/oauth-authorization-server/mcp_relay/abc/def/realms/x',
      '/.well-known/mcp_relay/abc/def',
    ])('leaves %s to McpAuthPlugin', async (url) => {
      const r = await handle(url);

      expect(r.handled).toBe(false);
      expect(r.end).not.toHaveBeenCalled();
    });

    it('does not match paths that only contain .well-known later on', async () => {
      const r = await handle('/v1/.well-known/oauth-authorization-server');
      expect(r.handled).toBe(false);
    });
  });

  describe('regular traffic', () => {
    it.each(['/v1/messages', '/v1/models', '/'])('passes %s through', async (url) => {
      const r = await handle(url, 'POST');

      expect(r.handled).toBe(false);
      expect(r.end).not.toHaveBeenCalled();
      expect(r.context.metadata.blocked).toBeUndefined();
    });
  });

  describe('Lifecycle Hooks', () => {
    it('should initialize on proxy start', async () => {
      await expect(interceptor.onProxyStart?.()).resolves.toBeUndefined();
    });

    it('should cleanup on proxy stop', async () => {
      await expect(interceptor.onProxyStop?.()).resolves.toBeUndefined();
    });
  });
});
