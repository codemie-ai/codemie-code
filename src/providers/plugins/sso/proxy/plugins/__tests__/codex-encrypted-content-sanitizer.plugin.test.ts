/**
 * Codex Encrypted Content Sanitizer Plugin Tests
 *
 * Tests agent-scoping and functional encrypted-content removal for
 * codemie-codex, codemie-code, codemie-opencode, and vscode-byok agents.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CodexEncryptedContentSanitizerPlugin } from '../codex-encrypted-content-sanitizer.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

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

function createProxyContext(body: unknown): ProxyContext {
  const requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'content-length': String(requestBody.length),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

describe('CodexEncryptedContentSanitizerPlugin', () => {
  let plugin: CodexEncryptedContentSanitizerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new CodexEncryptedContentSanitizerPlugin();
  });

  describe('Plugin Metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-codex-encrypted-content-sanitizer');
    });

    it('has priority 16 (after request-sanitizer)', () => {
      expect(plugin.priority).toBe(16);
    });
  });

  describe('createInterceptor — Agent Scoping', () => {
    it('creates interceptor for codemie-codex', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-codex'));
      expect(interceptor).toBeDefined();
    });

    it('creates interceptor for codemie-code', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
      expect(interceptor).toBeDefined();
    });

    it('creates interceptor for codemie-opencode', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-opencode'));
      expect(interceptor).toBeDefined();
    });

    it('creates interceptor for vscode-byok', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('vscode-byok'));
      expect(interceptor).toBeDefined();
    });

    it('throws for claude agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('claude')))
        .rejects.toThrow('Plugin disabled for agent: claude');
    });

    it('throws for undefined clientType', async () => {
      await expect(plugin.createInterceptor(createPluginContext(undefined)))
        .rejects.toThrow('Plugin disabled');
    });
  });

  describe('Encrypted content removal — codemie-code', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
    });

    it('removes encrypted reasoning items from input array', async () => {
      const body = {
        model: 'gpt-5.5-2026-04-24',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'reasoning', encrypted_content: 'abc123==' },
        ],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.input).toHaveLength(1);
      expect(result.input[0].type).toBe('message');
    });

    it('removes reasoning.encrypted_content from include array', async () => {
      const body = {
        model: 'gpt-5.5-2026-04-24',
        include: ['reasoning.encrypted_content', 'usage'],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.include).not.toContain('reasoning.encrypted_content');
      expect(result.include).toContain('usage');
    });

    it('updates content-length after stripping', async () => {
      const body = {
        model: 'gpt-5.5-2026-04-24',
        input: [{ type: 'reasoning', encrypted_content: 'abc123==' }],
      };
      const context = createProxyContext(body);
      const originalLength = Number(context.headers['content-length']);

      await interceptor.onRequest!(context);

      expect(Number(context.headers['content-length'])).toBeLessThan(originalLength);
      expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
    });

    it('passes through body with no encrypted content unchanged', async () => {
      const body = { model: 'gpt-5.5-2026-04-24', input: [{ type: 'message', content: 'hi' }] };
      const context = createProxyContext(body);
      const originalStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalStr);
    });
  });

  describe('Encrypted content removal — codemie-codex (regression)', () => {
    it('still removes encrypted items for codemie-codex', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-codex'));
      const body = {
        model: 'gpt-5.3-codex',
        input: [{ type: 'reasoning', encrypted_content: 'xyz==' }],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.input).toHaveLength(0);
    });
  });

  describe('Encrypted content removal — vscode-byok', () => {
    it('removes encrypted state while preserving reasoning effort and visible tool history', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('vscode-byok'));
      const visibleItems = [
        { type: 'message', role: 'user', content: 'hello' },
        {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'I will call the tool.' }],
        },
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'get_test_value',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'ready',
        },
      ];
      const body = {
        model: 'gpt-5.6-sol-2026-07-09',
        reasoning: { effort: 'medium' },
        include: ['reasoning.encrypted_content', 'usage'],
        input: [
          visibleItems[0],
          { type: 'reasoning', summary: [], encrypted_content: 'deployment-bound-state' },
          ...visibleItems.slice(1),
        ],
      };
      const context = createProxyContext(body);
      const originalLength = Number(context.headers['content-length']);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.reasoning).toEqual({ effort: 'medium' });
      expect(result.include).toEqual(['usage']);
      expect(result.input).toEqual(visibleItems);
      expect(result.input).not.toContainEqual(
        expect.objectContaining({ type: 'reasoning', encrypted_content: expect.any(String) })
      );
      expect(result.input[1]).toMatchObject({
        role: 'assistant',
        phase: 'commentary',
      });
      expect(result.input[2]).toMatchObject({
        type: 'function_call',
        call_id: 'call-1',
      });
      expect(result.input[3]).toMatchObject({
        type: 'function_call_output',
        call_id: 'call-1',
      });
      expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
      expect(Number(context.headers['content-length'])).toBeLessThan(originalLength);
    });
  });
});
