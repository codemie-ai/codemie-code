/**
 * Haiku Thinking Disabler Plugin Tests
 *
 * Tests proxy-level stripping of thinking field for unsupported models
 * (claude-haiku-4-5) for codemie-claude agent.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeThinkingDisablerPlugin } from '../haiku-thinking-disabler.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

/** Helper: create a minimal PluginContext with the given clientType */
function createPluginContext(clientType?: string, model?: string): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.anthropic.com',
      provider: 'claude',
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

describe('ClaudeThinkingDisablerPlugin', () => {
  let plugin: ClaudeThinkingDisablerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new ClaudeThinkingDisablerPlugin();
  });

  describe('Plugin Metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-haiku-thinking-disabler');
    });

    it('has correct name', () => {
      expect(plugin.name).toBe('Haiku Thinking Disabler');
    });

    it('has correct version', () => {
      expect(plugin.version).toBe('1.0.0');
    });

    it('has priority 14 (before RequestSanitizer at 15)', () => {
      expect(plugin.priority).toBe(14);
    });
  });

  describe('createInterceptor — Agent Scoping', () => {
    it('creates interceptor for codemie-claude', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
      expect(interceptor).toBeDefined();
      expect(interceptor.name).toBe('haiku-thinking-disabler');
    });

    it('throws for codemie-code agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('codemie-code')))
        .rejects.toThrow('Plugin disabled for agent: codemie-code');
    });

    it('throws for gemini agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('gemini')))
        .rejects.toThrow('Plugin disabled for agent: gemini');
    });

    it('throws for undefined clientType', async () => {
      await expect(plugin.createInterceptor(createPluginContext(undefined)))
        .rejects.toThrow('Plugin disabled');
    });
  });

  describe('Model Detection', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('strips thinking for claude-haiku-4-5 model', async () => {
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

    it('does NOT strip thinking for claude-sonnet-4-6', async () => {
      const context = createProxyContext({
        model: 'claude-sonnet-4-6',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
    });

    it('does NOT strip thinking for claude-opus-4-7', async () => {
      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
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
  });

  describe('Config Model Fallback', () => {
    it('uses config model when body has no model field', async () => {
      const interceptor = await plugin.createInterceptor(
        createPluginContext('codemie-claude', 'claude-haiku-4-5')
      );

      const context = createProxyContext({
        messages: [{ role: 'user', content: 'test' }],
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('does nothing when config model is undefined and body has no model', async () => {
      const interceptor = await plugin.createInterceptor(
        createPluginContext('codemie-claude', undefined)
      );

      const context = createProxyContext({
        messages: [{ role: 'user', content: 'test' }],
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
    });

    it('prefers body model over config model', async () => {
      const interceptor = await plugin.createInterceptor(
        createPluginContext('codemie-claude', 'claude-haiku-4-5')
      );

      const context = createProxyContext({
        model: 'claude-opus-4-7',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
    });
  });

  describe('Thinking Field Stripping', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('strips thinking object with type: enabled', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('strips thinking with enabled: true', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        thinking: { enabled: true, budget_tokens: 5000 },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('strips thinking with type: disabled (still removes field)', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        thinking: { type: 'disabled' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('preserves other params when stripping thinking', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        temperature: 0.7,
        thinking: { type: 'enabled', budget_tokens: 5000 },
        messages: [{ role: 'user', content: 'test' }],
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
      expect(body.model).toBe('claude-haiku-4-5');
      expect(body.max_tokens).toBe(1024);
      expect(body.temperature).toBe(0.7);
      expect(body.messages).toEqual([{ role: 'user', content: 'test' }]);
    });

    it('does nothing when thinking field is not present', async () => {
      const original = {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      };
      const context = createProxyContext(original);
      const originalBodyStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBodyStr);
    });
  });

  describe('Content-Length Update', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('updates content-length after stripping thinking', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        thinking: { type: 'enabled', budget_tokens: 5000 },
      });
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      const newLength = context.headers['content-length'];
      expect(Number(newLength)).toBeLessThan(Number(originalLength));
      expect(Number(newLength)).toBe(context.requestBody!.length);
    });

    it('does not change content-length when no stripping needed', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5',
        messages: [],
      });
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      expect(context.headers['content-length']).toBe(originalLength);
    });
  });

  describe('Edge Cases', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));
    });

    it('passes through when request body is null', async () => {
      const context = createProxyContext(null);

      await interceptor.onRequest!(context);

      expect(context.requestBody).toBeNull();
    });

    it('passes through for non-JSON content-type', async () => {
      const context = createProxyContext(
        { model: 'claude-haiku-4-5', thinking: { type: 'enabled' } },
        'text/plain',
      );
      const originalBody = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBody);
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

      // Should not throw
      await expect(interceptor.onRequest!(context)).resolves.toBeUndefined();
      expect(context.requestBody!.toString('utf-8')).toBe('not valid json{{{');
    });

    it('processes application/json; charset=utf-8 content-type', async () => {
      const context = createProxyContext(
        { model: 'claude-haiku-4-5', thinking: { type: 'enabled' } },
        'application/json; charset=utf-8',
      );

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('handles empty JSON object without error', async () => {
      const context = createProxyContext({});

      await expect(interceptor.onRequest!(context)).resolves.toBeUndefined();
    });

    it('handles empty model string', async () => {
      const context = createProxyContext({
        model: '',
        thinking: { type: 'enabled' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled' });
    });

    it('handles model with unexpected format', async () => {
      const context = createProxyContext({
        model: 'some-random-model',
        thinking: { type: 'enabled' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toEqual({ type: 'enabled' });
    });
  });
});
