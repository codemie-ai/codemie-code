/**
 * Claude Non-Thinking Model Sanitizer Plugin Tests
 *
 * Verifies Claude API clients are sanitized when the selected Claude model does
 * not support extended thinking, such as Claude Haiku.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeNonThinkingModelSanitizerPlugin } from '../claude-non-thinking-model-sanitizer.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

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

function createProxyContext(
  body: Record<string, unknown> | null,
  contentType = 'application/json',
  headers: Record<string, string> = {},
): ProxyContext {
  const requestBody = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'claude-desktop',
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': contentType,
      ...headers,
      ...(requestBody && { 'content-length': String(requestBody.length) }),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

describe('ClaudeNonThinkingModelSanitizerPlugin', () => {
  let plugin: ClaudeNonThinkingModelSanitizerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new ClaudeNonThinkingModelSanitizerPlugin();
  });

  describe('Plugin Metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-claude-non-thinking-model-sanitizer');
    });

    it('has priority 17', () => {
      expect(plugin.priority).toBe(17);
    });
  });

  describe('createInterceptor — Agent Scoping', () => {
    it('creates interceptor for claude-desktop', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('claude-desktop'));

      expect(interceptor).toBeDefined();
      expect(interceptor.name).toBe('claude-non-thinking-model-sanitizer');
    });

    it('creates interceptor for codemie-claude', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-claude'));

      expect(interceptor).toBeDefined();
      expect(interceptor.name).toBe('claude-non-thinking-model-sanitizer');
    });

    it('throws for codemie-opencode', async () => {
      await expect(plugin.createInterceptor(createPluginContext('codemie-opencode')))
        .rejects.toThrow('Plugin disabled for agent: codemie-opencode');
    });
  });

  describe('Non-Thinking Claude Model Sanitization', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('claude-desktop'));
    });

    it('removes top-level thinking and thinking history blocks for Claude Haiku', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5-20251001',
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
              { type: 'text', text: 'Visible answer' },
              { type: 'tool_use', id: 'tool-1', name: 'read', input: {} },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'redacted_thinking', data: 'encrypted' },
              { type: 'text', text: 'More visible text' },
            ],
          },
        ],
      });
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
      expect(body.messages[0].content).toEqual([
        { type: 'text', text: 'Visible answer' },
        { type: 'tool_use', id: 'tool-1', name: 'read', input: {} },
      ]);
      expect(body.messages[1].content).toEqual([
        { type: 'text', text: 'More visible text' },
      ]);
      expect(Number(context.headers['content-length'])).toBeLessThan(Number(originalLength));
      expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
    });

    it('replaces thinking-only content arrays with an empty text block', async () => {
      const context = createProxyContext({
        model: 'claude-haiku-4-5-20251001',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'internal reasoning' }],
          },
        ],
      });

      await interceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.messages[0].content).toEqual([{ type: 'text', text: '' }]);
    });

    it('removes only interleaved thinking from anthropic-beta header', async () => {
      const context = createProxyContext(
        {
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'hello' }],
        },
        'application/json',
        { 'anthropic-beta': 'files-api-beta, interleaved-thinking-beta' },
      );

      await interceptor.onRequest!(context);

      expect(context.headers['anthropic-beta']).toBe('files-api-beta');
    });

    it('deletes anthropic-beta header when it only contains interleaved thinking', async () => {
      const context = createProxyContext(
        {
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'hello' }],
        },
        'application/json',
        { 'anthropic-beta': 'interleaved-thinking-beta' },
      );

      await interceptor.onRequest!(context);

      expect(context.headers['anthropic-beta']).toBeUndefined();
    });

    it('does not change Sonnet 4 requests that support extended thinking', async () => {
      const original = {
        model: 'claude-sonnet-4-6',
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
              { type: 'text', text: 'Visible answer' },
            ],
          },
        ],
      };
      const context = createProxyContext(original);
      const originalBody = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBody);
    });
  });

  describe('Edge Cases', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('claude-desktop'));
    });

    it('passes through non-Claude models', async () => {
      const context = createProxyContext({
        model: 'gpt-5',
        thinking: { type: 'enabled' },
      });
      const originalBody = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalBody);
    });

    it('uses configured model when request body omits model', async () => {
      const configuredInterceptor = await plugin.createInterceptor(
        createPluginContext('claude-desktop', 'claude-haiku-4-5-20251001'),
      );
      const context = createProxyContext({
        thinking: { type: 'enabled' },
        messages: [{ role: 'user', content: 'hello' }],
      });

      await configuredInterceptor.onRequest!(context);

      const body = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(body.thinking).toBeUndefined();
    });

    it('passes through malformed JSON without error', async () => {
      const context = createProxyContext(null);
      context.requestBody = Buffer.from('not valid json{{{', 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      await expect(interceptor.onRequest!(context)).resolves.toBeUndefined();
      expect(context.requestBody.toString('utf-8')).toBe('not valid json{{{');
    });
  });
});
