/**
 * Claude Request Normalizer Plugin Tests
 *
 * Tests proxy-level transformation of thinking params for claude-opus-4-7:
 *   - thinking.type "enabled"  → thinking.type "adaptive" + output_config.effort
 *   - thinking.type "disabled" → field removed entirely
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeRequestNormalizerPlugin } from '../claude-request-normalizer.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

/** Helper: create a minimal PluginContext */
function createPluginContext(clientType?: string, model?: string): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.anthropic.com',
      provider: 'test',
      sessionId: 'test-session',
      clientType,
      model,
    },
    logger,
  };
}

/** Helper: create a ProxyContext with JSON body */
function createProxyContext(body: Record<string, unknown> | null, contentType = 'application/json'): ProxyContext {
  const requestBody = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': contentType,
      ...(requestBody && { 'content-length': String(requestBody.length) }),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

describe('ClaudeRequestNormalizerPlugin', () => {
  let plugin: ClaudeRequestNormalizerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new ClaudeRequestNormalizerPlugin();
  });

  // ---------------------------------------------------------------------------
  describe('Plugin Metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-claude-request-normalizer');
    });

    it('has correct name', () => {
      expect(plugin.name).toBe('Claude Request Normalizer');
    });

    it('has correct version', () => {
      expect(plugin.version).toBe('1.0.0');
    });

    it('has priority 14 (before RequestSanitizer at 15)', () => {
      expect(plugin.priority).toBe(14);
    });
  });

  // ---------------------------------------------------------------------------
  describe('createInterceptor — Agent Scoping', () => {
    it('creates interceptor for codemie-claude', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
      expect(interceptor).toBeDefined();
      expect(interceptor.name).toBe('claude-request-normalizer');
    });

    it('throws for codemie-code agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('codemie-code')))
        .rejects.toThrow('Plugin disabled for agent: codemie-code');
    });

    it('throws for codemie-opencode agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('codemie-opencode')))
        .rejects.toThrow('Plugin disabled for agent: codemie-opencode');
    });

    it('throws for undefined clientType', async () => {
      await expect(plugin.createInterceptor(createPluginContext(undefined)))
        .rejects.toThrow('Plugin disabled');
    });

    it('throws for empty string clientType', async () => {
      await expect(plugin.createInterceptor(createPluginContext('')))
        .rejects.toThrow('Plugin disabled');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Haiku thinking stripping (Chain 1)', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('strips thinking for claude-haiku-4-5', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
      expect(body.model).toBe('claude-haiku-4-5');
    });

    it('strips thinking for claude-haiku-4-5-20251001 (dated variant)', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5-20251001',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('does NOT strip thinking for claude-haiku-4-6 (newer version)', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-6',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
    });

    it('does NOT strip for claude-haiku-4-7 (future version, may support thinking)', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-7',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
    });

    it('does NOT strip for claude-sonnet-4-6', async () => {
      const context = createProxyContext({
        model: 'claude-sonnet-4-6',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
    });

    it('updates content-length after stripping', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      expect(context.headers['content-length']).toBe(String(context.requestBody!.length));
    });
  });

  // ---------------------------------------------------------------------------
  describe('thinking.type "enabled" → adaptive transformation', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('sets thinking.type to adaptive for claude-opus-4-7', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'adaptive' });
    });

    it('removes budget_tokens from thinking object', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking.budget_tokens).toBeUndefined();
    });

    it('sets output_config.effort based on budget_tokens (high for >8192)', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('sets output_config.effort to medium for budget_tokens <= 8192', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 4000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config).toEqual({ effort: 'medium' });
    });

    it('sets output_config.effort to low for budget_tokens <= 2048', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 1024 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config).toEqual({ effort: 'low' });
    });

    it('sets effort to low when budget_tokens is absent', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config.effort).toBe('low');
    });

    it('does not overwrite an existing output_config.effort', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 20000 },
        output_config: { effort: 'medium' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config.effort).toBe('medium'); // caller's value preserved
    });

    it('preserves existing output_config fields other than effort', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 10000 },
        output_config: { some_other_field: 'value' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config.effort).toBe('high');
      expect(body.output_config.some_other_field).toBe('value');
    });

    it('transforms for versioned model id (claude-opus-4-7-20250514)', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7-20250514',
        thinking: { type: 'enabled', budget_tokens: 8000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config.effort).toBeDefined();
    });

    it('sets effort to low for budget_tokens exactly at boundary (2048)', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 2048 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config.effort).toBe('low');
    });

    it('sets effort to medium for budget_tokens just above low boundary (2049)', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 2049 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config.effort).toBe('medium');
    });

    it('sets effort to medium for budget_tokens exactly at boundary (8192)', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 8192 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config.effort).toBe('medium');
    });

    it('sets effort to high for budget_tokens just above medium boundary (8193)', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 8193 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.output_config.effort).toBe('high');
    });

    it('uses configModel fallback when body.model is absent', async () => {
      const interceptorWithConfig = await plugin.createInterceptor(
        createPluginContext('codemie-claude', 'claude-opus-4-7')
      );
      const context = createProxyContext({
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 2000 },
      });

      await interceptorWithConfig.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config.effort).toBeDefined();
    });

    it('preserves all other body fields', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 4096,
        thinking: { type: 'enabled', budget_tokens: 2000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.model).toBe('claude-opus-4-7');
      expect(body.messages).toHaveLength(1);
      expect(body.max_tokens).toBe(4096);
    });
  });

  // ---------------------------------------------------------------------------
  describe('thinking.type "disabled" → field removal', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('removes thinking field entirely for claude-opus-4-7', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'disabled' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('does not touch output_config when removing disabled thinking', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toEqual({ effort: 'low' });
    });

    it('does not remove disabled thinking for non-matching model', async () => {
      const context = createProxyContext({
        model: 'claude-sonnet-4-5',
        thinking: { type: 'disabled' },
      });
      const originalBodyStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBodyStr);
    });
  });

  // ---------------------------------------------------------------------------
  describe('No-op Cases', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('does not modify thinking for non-matching model', async () => {
      const context = createProxyContext({
        model: 'claude-sonnet-4-5',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });
      const originalBodyStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBodyStr);
    });

    it('does not transform for two-digit sub-minor model (claude-opus-4-70)', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-70',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });
      const originalBodyStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBodyStr);
    });

    it('does not modify when thinking.type is already adaptive', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'adaptive' },
      });
      const originalBodyStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBodyStr);
    });

    it('does not modify when no thinking field present', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hello' }],
      });
      const originalBodyStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBodyStr);
    });

    it('passes through when request body is null', async () => {
      const context = createProxyContext(null);

      await interceptor.onRequest!(context);

      expect(context.requestBody).toBeNull();
    });

    it('passes through for non-JSON content-type', async () => {
      const context = createProxyContext(
        { model: 'claude-opus-4-7', thinking: { type: 'enabled', budget_tokens: 1000 } },
        'text/plain',
      );
      const originalBody = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBody);
    });

    it('processes application/json; charset=utf-8 content-type', async () => {
      const context = createProxyContext(
        { model: 'claude-opus-4-7', thinking: { type: 'enabled', budget_tokens: 10000 } },
        'application/json; charset=utf-8',
      );

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'adaptive' });
    });

    it('passes through malformed JSON without error', async () => {
      const context: ProxyContext = {
        requestId: 'test-req',
        sessionId: 'test-session',
        agentName: 'test-agent',
        method: 'POST',
        url: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        requestBody: Buffer.from('not valid json{{{', 'utf-8'),
        requestStartTime: Date.now(),
        metadata: {},
      };

      await expect(interceptor.onRequest!(context)).resolves.toBeUndefined();
      expect(context.requestBody!.toString('utf-8')).toBe('not valid json{{{');
    });

    it('does nothing when model is absent and no configModel', async () => {
      const context = createProxyContext({
        thinking: { type: 'enabled', budget_tokens: 1000 },
      });
      const originalBodyStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBodyStr);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Content-Length Update', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('updates content-length header to match new body size after enabled→adaptive', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });

      await interceptor.onRequest!(context);

      expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
    });

    it('updates content-length header to match new body size after disabled removal', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'disabled' },
      });

      await interceptor.onRequest!(context);

      expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
    });

    it('does not change content-length when no transformation needed', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        messages: [],
      });
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      expect(context.headers['content-length']).toBe(originalLength);
    });
  });
});
