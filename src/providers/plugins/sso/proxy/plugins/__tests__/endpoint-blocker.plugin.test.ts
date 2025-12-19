/**
 * Endpoint Blocker Plugin Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EndpointBlockerPlugin } from '../endpoint-blocker.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

describe('EndpointBlockerPlugin', () => {
  let plugin: EndpointBlockerPlugin;
  let interceptor: ProxyInterceptor;
  let pluginContext: PluginContext;

  beforeEach(async () => {
    plugin = new EndpointBlockerPlugin();

    pluginContext = {
      config: {
        targetApiUrl: 'https://api.example.com',
        provider: 'test',
        sessionId: 'test-session'
      },
      logger
    };

    interceptor = await plugin.createInterceptor(pluginContext);
  });

  describe('Plugin Metadata', () => {
    it('should have correct plugin metadata', () => {
      expect(plugin.id).toBe('@codemie/proxy-endpoint-blocker');
      expect(plugin.name).toBe('Endpoint Blocker');
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.priority).toBe(5); // Should run early
    });
  });

  describe('Endpoint Blocking', () => {
    it('should block /api/event_logging/batch endpoint', async () => {
      const context: ProxyContext = {
        requestId: 'test-req-1',
        sessionId: 'test-session',
        agentName: 'test-agent',
        method: 'POST',
        url: '/api/event_logging/batch',
        headers: {},
        requestBody: null,
        requestStartTime: Date.now(),
        metadata: {}
      };

      await interceptor.onRequest?.(context);

      expect(context.metadata.blocked).toBe(true);
      expect(context.metadata.blockedReason).toContain('Matched pattern');
    });

    it('should block //api/event_logging/batch endpoint (double slash)', async () => {
      const context: ProxyContext = {
        requestId: 'test-req-2',
        sessionId: 'test-session',
        agentName: 'test-agent',
        method: 'POST',
        url: '//api/event_logging/batch',
        headers: {},
        requestBody: null,
        requestStartTime: Date.now(),
        metadata: {}
      };

      await interceptor.onRequest?.(context);

      expect(context.metadata.blocked).toBe(true);
      expect(context.metadata.blockedReason).toContain('Matched pattern');
    });

    it('should not block normal endpoints', async () => {
      const context: ProxyContext = {
        requestId: 'test-req-3',
        sessionId: 'test-session',
        agentName: 'test-agent',
        method: 'POST',
        url: '/v1/messages',
        headers: {},
        requestBody: null,
        requestStartTime: Date.now(),
        metadata: {}
      };

      await interceptor.onRequest?.(context);

      expect(context.metadata.blocked).toBeUndefined();
      expect(context.metadata.blockedReason).toBeUndefined();
    });

    it('should handle case-insensitive matching', async () => {
      const context: ProxyContext = {
        requestId: 'test-req-4',
        sessionId: 'test-session',
        agentName: 'test-agent',
        method: 'POST',
        url: '/API/EVENT_LOGGING/BATCH',
        headers: {},
        requestBody: null,
        requestStartTime: Date.now(),
        metadata: {}
      };

      await interceptor.onRequest?.(context);

      expect(context.metadata.blocked).toBe(true);
    });

    it('should not block partial matches', async () => {
      const context: ProxyContext = {
        requestId: 'test-req-5',
        sessionId: 'test-session',
        agentName: 'test-agent',
        method: 'POST',
        url: '/api/event_logging/batch/extra',
        headers: {},
        requestBody: null,
        requestStartTime: Date.now(),
        metadata: {}
      };

      await interceptor.onRequest?.(context);

      // The pattern uses ^...$ so it should only match exact paths
      expect(context.metadata.blocked).toBeUndefined();
    });
  });

  describe('Lifecycle Hooks', () => {
    it('should initialize on proxy start', async () => {
      // Should not throw
      await expect(interceptor.onProxyStart?.()).resolves.toBeUndefined();
    });

    it('should cleanup on proxy stop', async () => {
      // Should not throw
      await expect(interceptor.onProxyStop?.()).resolves.toBeUndefined();
    });
  });
});
