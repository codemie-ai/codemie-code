/**
 * Azure OpenAI proxy sanitizer tests.
 *
 * Covers provider activation and request-body transformations performed by the
 * proxy-level interceptor. The old OpenCode source-string tests were moved here
 * because sanitization now runs in CodeMieProxy before forwarding requests.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AzureOpenAISanitizerPlugin } from '../azure-openai-sanitizer.plugin.js';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

function createPluginContext(provider = 'azure-openai'): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.example.com',
      provider,
      clientType: 'codemie-code',
      sessionId: 'test-session',
    },
    logger,
  };
}

function createProxyContext(
  body: Record<string, unknown> | null,
  contentType = 'application/json',
  url = '/v1/chat/completions',
): ProxyContext {
  const requestBody = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
  return {
    requestId: 'test-request',
    sessionId: 'test-session',
    agentName: 'codemie-code',
    method: 'POST',
    url,
    headers: {
      'content-type': contentType,
      ...(requestBody && { 'content-length': String(requestBody.length) }),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

function readBody(context: ProxyContext): Record<string, any> {
  return JSON.parse(context.requestBody!.toString('utf-8')) as Record<string, any>;
}

describe('AzureOpenAISanitizerPlugin', () => {
  let plugin: AzureOpenAISanitizerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new AzureOpenAISanitizerPlugin();
  });

  describe('plugin metadata and activation', () => {
    it('has Azure-specific metadata and request transformation priority', () => {
      expect(plugin.id).toBe('@codemie/proxy-azure-openai-sanitizer');
      expect(plugin.name).toBe('Azure OpenAI Sanitizer');
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.priority).toBe(15);
    });

    it('creates an active interceptor for Azure OpenAI traffic', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext());

      expect(interceptor.name).toBe('azure-openai-sanitizer');
      expect(interceptor.onRequest).toBeDefined();
    });

    it('creates a no-op interceptor for other providers', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('openai'));

      expect(interceptor.name).toBe('azure-openai-sanitizer');
      expect(interceptor.onRequest).toBeUndefined();
    });
  });

  describe('request sanitization', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext());
    });

    it('removes unsupported top-level and options fields while preserving supported values', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
        reasoningSummary: 'auto',
        reasoning_summary: 'auto',
        reasoning: { effort: 'high' },
        reasoning_effort: 'high',
        include_reasoning: true,
        reasoning_content: 'hidden',
        thinking: { type: 'enabled' },
        cache_control: { type: 'ephemeral' },
        parallel_tool_calls: true,
        store: true,
        metadata: { trace: 'hidden' },
        prediction: { type: 'content' },
        options: {
          thinking: { type: 'enabled' },
          reasoning: { effort: 'high' },
          cache_control: { type: 'ephemeral' },
          timeout: 10,
        },
      });

      await interceptor.onRequest!(context);

      const body = readBody(context);
      for (const field of [
        'reasoningSummary',
        'reasoning_summary',
        'reasoning',
        'reasoning_effort',
        'include_reasoning',
        'reasoning_content',
        'thinking',
        'cache_control',
        'parallel_tool_calls',
        'store',
        'metadata',
        'prediction',
      ]) {
        expect(body[field]).toBeUndefined();
      }
      expect(body.model).toBe('gpt-5');
      expect(body.temperature).toBe(0.5);
      expect(body.options).toEqual({ timeout: 10 });
    });

    it('normalizes message fields and recursively removes unsupported nested fields', async () => {
      const context = createProxyContext({
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: 'hello',
            cache_control: { type: 'ephemeral' },
            reasoning_content: 'hidden',
            thinking: { budget_tokens: 1024 },
            nested: { citations: ['hidden'], value: 'kept' },
          }],
          name: 'user-name',
          cache_control: { type: 'ephemeral' },
          reasoning_content: 'hidden',
          thinking: { type: 'enabled' },
          unsupported: 'removed',
        }],
      });

      await interceptor.onRequest!(context);

      const body = readBody(context);
      expect(body.messages).toEqual([{
        role: 'user',
        content: [{
          type: 'text',
          text: 'hello',
          nested: { value: 'kept' },
        }],
        name: 'user-name',
      }]);
    });

    it('normalizes tool calls and function fields', async () => {
      const context = createProxyContext({
        messages: [{
          role: 'assistant',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{}',
              description: 'removed',
            },
            cache_control: { type: 'ephemeral' },
            extra: 'removed',
          }],
        }],
      });

      await interceptor.onRequest!(context);

      const body = readBody(context);
      expect(body.messages[0].tool_calls).toEqual([{
        id: 'call-1',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{}',
        },
      }]);
    });

    it('does not rewrite a clean request body', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.7,
      });
      const originalBody = context.requestBody!.toString('utf-8');
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBody);
      expect(context.headers['content-length']).toBe(originalLength);
    });
  });

  describe('proxy request edge cases', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext());
    });

    it('updates content-length after rewriting the body', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        reasoningSummary: 'auto',
      });
      const originalLength = Number(context.headers['content-length']);

      await interceptor.onRequest!(context);

      expect(Number(context.headers['content-length'])).toBeLessThan(originalLength);
      expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
    });

    it('passes through null bodies and non-JSON content', async () => {
      const emptyContext = createProxyContext(null);
      await interceptor.onRequest!(emptyContext);
      expect(emptyContext.requestBody).toBeNull();

      const textContext = createProxyContext({ reasoningSummary: 'auto' }, 'text/plain');
      const originalBody = textContext.requestBody!.toString('utf-8');
      await interceptor.onRequest!(textContext);
      expect(textContext.requestBody!.toString('utf-8')).toBe(originalBody);
    });

    it('passes through malformed JSON without throwing', async () => {
      const context: ProxyContext = {
        requestId: 'test-request',
        sessionId: 'test-session',
        agentName: 'codemie-code',
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        requestBody: Buffer.from('not valid json{{{', 'utf-8'),
        requestStartTime: Date.now(),
        metadata: {},
      };

      await expect(interceptor.onRequest!(context)).resolves.toBeUndefined();
      expect(context.requestBody!.toString('utf-8')).toBe('not valid json{{{');
    });
  });
});
