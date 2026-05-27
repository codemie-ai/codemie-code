/**
 * SessionExpiryHandlerPlugin Tests
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SessionExpiryHandlerPlugin } from '../session-expiry-handler.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

function createPluginContext(): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.codemie.com',
      provider: 'test',
      sessionId: 'test-session',
    },
    logger,
  };
}

function createProxyContext(upstreamStatusCode?: number): ProxyContext {
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: upstreamStatusCode !== undefined ? { upstreamStatusCode } : {},
  };
}

describe('SessionExpiryHandlerPlugin', () => {
  let plugin: SessionExpiryHandlerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new SessionExpiryHandlerPlugin();
  });

  describe('Plugin Metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-session-expiry-handler');
    });

    it('has correct name', () => {
      expect(plugin.name).toBe('Session Expiry Handler');
    });

    it('has correct version', () => {
      expect(plugin.version).toBe('1.0.0');
    });

    it('has priority 20', () => {
      expect(plugin.priority).toBe(20);
    });
  });

  describe('createInterceptor', () => {
    it('returns an interceptor named session-expiry-handler', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext());
      expect(interceptor.name).toBe('session-expiry-handler');
    });

    it('interceptor implements onResponseHeaders', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext());
      expect(typeof interceptor.onResponseHeaders).toBe('function');
    });
  });

  describe('onResponseHeaders — session expiry detection', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext());
    });

    it('sets sessionExpired=true when upstreamStatusCode is 401', async () => {
      const context = createProxyContext(401);
      await interceptor.onResponseHeaders!(context, {});
      expect(context.metadata.sessionExpired).toBe(true);
    });

    it('sets sessionExpired=true when upstreamStatusCode is 403', async () => {
      const context = createProxyContext(403);
      await interceptor.onResponseHeaders!(context, {});
      expect(context.metadata.sessionExpired).toBe(true);
    });

    it('does NOT set sessionExpired for 200', async () => {
      const context = createProxyContext(200);
      await interceptor.onResponseHeaders!(context, {});
      expect(context.metadata.sessionExpired).toBeUndefined();
    });

    it('does NOT set sessionExpired for 500', async () => {
      const context = createProxyContext(500);
      await interceptor.onResponseHeaders!(context, {});
      expect(context.metadata.sessionExpired).toBeUndefined();
    });

    it('does NOT set sessionExpired when upstreamStatusCode is absent', async () => {
      const context = createProxyContext();
      await interceptor.onResponseHeaders!(context, {});
      expect(context.metadata.sessionExpired).toBeUndefined();
    });

    it('logs a warning when session is expired', async () => {
      const context = createProxyContext(401);
      await interceptor.onResponseHeaders!(context, {});
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not log when status is 200', async () => {
      const context = createProxyContext(200);
      await interceptor.onResponseHeaders!(context, {});
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
