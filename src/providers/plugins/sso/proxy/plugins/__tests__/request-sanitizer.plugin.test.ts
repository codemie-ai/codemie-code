/**
 * Request Sanitizer Plugin Tests
 *
 * Tests proxy-level stripping of unsupported reasoning params
 * for codemie-code and codemie-opencode agents.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestSanitizerPlugin } from '../request-sanitizer.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

/** Helper: create a minimal PluginContext with the given clientType */
function createPluginContext(clientType?: string): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.example.com',
      provider: 'test',
      sessionId: 'test-session',
      clientType,
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
    url: '/v1/chat/completions',
    headers: {
      'content-type': contentType,
      ...(requestBody && { 'content-length': String(requestBody.length) }),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

describe('RequestSanitizerPlugin', () => {
  let plugin: RequestSanitizerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new RequestSanitizerPlugin();
  });

  describe('Plugin Metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-request-sanitizer');
    });

    it('has correct name', () => {
      expect(plugin.name).toBe('Request Sanitizer');
    });

    it('has correct version', () => {
      expect(plugin.version).toBe('1.0.0');
    });

    it('has priority 15 (after auth, before header injection)', () => {
      expect(plugin.priority).toBe(15);
    });
  });

  describe('createInterceptor — Agent Scoping', () => {
    it('creates interceptor for codemie-code', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
      expect(interceptor).toBeDefined();
      expect(interceptor.name).toBe('request-sanitizer');
    });

    it('creates interceptor for codemie-opencode', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-opencode'));
      expect(interceptor).toBeDefined();
      expect(interceptor.name).toBe('request-sanitizer');
    });

    it('throws for claude agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('claude')))
        .rejects.toThrow('Plugin disabled for agent: claude');
    });

    it('throws for gemini agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('gemini')))
        .rejects.toThrow('Plugin disabled for agent: gemini');
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

  describe('Parameter Stripping', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
    });

    it('strips reasoningSummary from JSON body', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        reasoningSummary: 'auto',
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.reasoningSummary).toBeUndefined();
      expect(body.model).toBe('gpt-5');
      expect(body.messages).toHaveLength(1);
    });

    it('strips reasoning_summary from JSON body', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        reasoning_summary: 'auto',
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.reasoning_summary).toBeUndefined();
      expect(body.model).toBe('gpt-5');
    });

    it('strips reasoning object from JSON body', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        reasoning: { effort: 'high', summary: 'auto' },
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.reasoning).toBeUndefined();
      expect(body.model).toBe('gpt-5');
    });

    it('strips all three unsupported params at once', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        reasoningSummary: 'auto',
        reasoning_summary: 'auto',
        reasoning: { effort: 'high' },
        temperature: 0.7,
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.reasoningSummary).toBeUndefined();
      expect(body.reasoning_summary).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(body.model).toBe('gpt-5');
      expect(body.temperature).toBe(0.7);
    });

    it('preserves reasoningEffort (NOT stripped)', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.reasoningEffort).toBe('high');
      expect(body.reasoningSummary).toBeUndefined();
    });

    it('preserves other params (model, messages, temperature)', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'test' }],
        temperature: 0.5,
        max_tokens: 1000,
        reasoningSummary: 'auto',
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.model).toBe('gpt-5');
      expect(body.messages).toEqual([{ role: 'user', content: 'test' }]);
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(1000);
    });

    it('does nothing when no unsupported params present', async () => {
      const original = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.7,
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
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
    });

    it('updates content-length after stripping', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        reasoningSummary: 'auto',
      });
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      const newLength = context.headers['content-length'];
      expect(Number(newLength)).toBeLessThan(Number(originalLength));
      expect(Number(newLength)).toBe(context.requestBody!.length);
    });

    it('does not change content-length when no stripping needed', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
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
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
    });

    it('passes through when request body is null', async () => {
      const context = createProxyContext(null);

      await interceptor.onRequest!(context);

      expect(context.requestBody).toBeNull();
    });

    it('passes through for non-JSON content-type', async () => {
      const context = createProxyContext(
        { reasoningSummary: 'auto' },
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
        url: '/v1/chat/completions',
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
        { model: 'gpt-5', reasoningSummary: 'auto' },
        'application/json; charset=utf-8',
      );

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.reasoningSummary).toBeUndefined();
      expect(body.model).toBe('gpt-5');
    });

    it('handles empty JSON object without error', async () => {
      const context = createProxyContext({});

      await expect(interceptor.onRequest!(context)).resolves.toBeUndefined();
    });
  });
});
