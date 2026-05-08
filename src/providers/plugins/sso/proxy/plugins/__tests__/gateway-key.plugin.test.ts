/**
 * GatewayKeyPlugin Tests
 * @group unit
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GatewayKeyPlugin } from '../gateway-key.plugin.js';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

function makePluginContext(gatewayKey?: string): PluginContext {
  return {
    config: { targetApiUrl: 'https://upstream.example.com', gatewayKey },
    logger,
  };
}

function makeProxyContext(authHeader?: string): ProxyContext {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentName: 'test',
    method: 'POST',
    url: '/v1/messages',
    headers: authHeader ? { authorization: authHeader } : {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

function makeMockRes() {
  const headers: Record<string, string> = {};
  let body = '';
  let statusCode = 200;
  return {
    res: {
      setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
      end: vi.fn((data: string) => { body = data; }),
      get statusCode() { return statusCode; },
      set statusCode(v: number) { statusCode = v; },
    } as any,
    getBody: () => body,
    getStatusCode: () => statusCode,
  };
}

describe('GatewayKeyPlugin', () => {
  let plugin: GatewayKeyPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new GatewayKeyPlugin();
  });

  describe('metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-gateway-key');
    });
    it('has priority 7 (after EndpointBlocker=5, before SSO/JWT=10)', () => {
      expect(plugin.priority).toBe(7);
    });
  });

  describe('when gatewayKey is not configured (regular proxy mode)', () => {
    it('handleRequest returns false without touching the request', async () => {
      const interceptor = plugin.createInterceptor(makePluginContext(undefined));
      const ctx = makeProxyContext('Bearer some-real-token');
      const { res } = makeMockRes();
      const result = await interceptor.handleRequest!(ctx, {} as any, res, {} as any);
      expect(result).toBe(false);
      expect(ctx.headers['authorization']).toBe('Bearer some-real-token');
    });
  });

  describe('when gatewayKey is configured (daemon/gateway mode)', () => {
    const KEY = 'codemie-proxy';

    it('returns false and strips header when key matches', async () => {
      const interceptor = plugin.createInterceptor(makePluginContext(KEY));
      const ctx = makeProxyContext(`Bearer ${KEY}`);
      const { res } = makeMockRes();
      const result = await interceptor.handleRequest!(ctx, {} as any, res, {} as any);
      expect(result).toBe(false);
      expect(ctx.headers['authorization']).toBeUndefined();
      expect(ctx.metadata.gatewayKeyValidated).toBe(true);
    });

    it('returns true and sends 401 when authorization header is missing', async () => {
      const interceptor = plugin.createInterceptor(makePluginContext(KEY));
      const ctx = makeProxyContext(undefined);
      const { res } = makeMockRes();
      const result = await interceptor.handleRequest!(ctx, {} as any, res, {} as any);
      expect(result).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(res.end).toHaveBeenCalled();
    });

    it('returns true and sends 401 when key is wrong', async () => {
      const interceptor = plugin.createInterceptor(makePluginContext(KEY));
      const ctx = makeProxyContext('Bearer wrong-key');
      const { res } = makeMockRes();
      const result = await interceptor.handleRequest!(ctx, {} as any, res, {} as any);
      expect(result).toBe(true);
      expect(res.statusCode).toBe(401);
    });

    it('is idempotent: skips validation if already validated', async () => {
      const interceptor = plugin.createInterceptor(makePluginContext(KEY));
      const ctx = makeProxyContext(undefined);
      ctx.metadata.gatewayKeyValidated = true;
      const { res } = makeMockRes();
      const result = await interceptor.handleRequest!(ctx, {} as any, res, {} as any);
      expect(result).toBe(false);
      expect(res.end).not.toHaveBeenCalled();
    });
  });
});
