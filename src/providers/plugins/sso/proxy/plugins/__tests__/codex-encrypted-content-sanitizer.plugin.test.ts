/**
 * Codex Encrypted Content Sanitizer Plugin Tests
 *
 * The gateway runs LiteLLM `encrypted_content_affinity`, so reasoning state is
 * forwarded untouched by default. Stripping is a self-healing fallback that
 * engages only after upstream rejects a replay (expired affinity pin, or a bare
 * reasoning id under `store: false`).
 *
 * Covers agent scoping, default pass-through, latch detection, and the strip
 * behavior once latched, for codemie-codex, codemie-code, codemie-opencode,
 * codemie-pi, and vscode-byok agents.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CodexEncryptedContentSanitizerPlugin } from '../codex-encrypted-content-sanitizer.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

const AFFINITY_REJECTION = JSON.stringify({
  error: { code: 'invalid_encrypted_content', message: 'could not be verified' },
});
const BARE_ITEM_REJECTION = JSON.stringify({
  error: { message: "Item with id 'rs_abc' not found. Items are not persisted when `store` is set to false." },
});

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

function createProxyContext(body: unknown, url = '/v1/responses'): ProxyContext {
  const requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'content-length': String(requestBody.length),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

/** Drive the interceptor through an upstream rejection so the fallback engages. */
async function latchFallback(interceptor: ProxyInterceptor, body = AFFINITY_REJECTION): Promise<void> {
  await interceptor.onResponseChunk!(createProxyContext({}), Buffer.from(body, 'utf-8'));
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
    it.each([
      'codemie-codex',
      'codemie-code',
      'codemie-opencode',
      'codemie-pi',
      'vscode-byok',
    ])('creates interceptor for %s', async clientType => {
      const interceptor = await plugin.createInterceptor(createPluginContext(clientType));
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

  describe('Default pass-through (affinity healthy)', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-pi'));
    });

    it('forwards encrypted reasoning items untouched', async () => {
      const body = {
        model: 'gpt-5.6-terra-2026-07-09',
        include: ['reasoning.encrypted_content'],
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'abc123==' },
        ],
      };
      const context = createProxyContext(body);
      const originalStr = context.requestBody!.toString('utf-8');
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalStr);
      expect(context.headers['content-length']).toBe(originalLength);
    });

    it('leaves the include array intact so upstream keeps returning encrypted content', async () => {
      const body = {
        model: 'gpt-5.6-terra-2026-07-09',
        include: ['reasoning.encrypted_content', 'usage'],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.include).toEqual(['reasoning.encrypted_content', 'usage']);
    });
  });

  describe('Latch detection via onResponseChunk', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-pi'));
    });

    it('returns the chunk unmodified (read-only scan)', async () => {
      const chunk = Buffer.from(AFFINITY_REJECTION, 'utf-8');

      const result = await interceptor.onResponseChunk!(createProxyContext({}), chunk);

      expect(result).toBe(chunk);
    });

    it.each([
      ['invalid_encrypted_content', AFFINITY_REJECTION],
      ['bare reasoning id under store:false', BARE_ITEM_REJECTION],
    ])('engages the fallback on %s', async (_label, rejection) => {
      const body = { input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'abc==' }] };
      const before = createProxyContext(body);
      await interceptor.onRequest!(before);
      expect(JSON.parse(before.requestBody!.toString('utf-8')).input).toHaveLength(1);

      await latchFallback(interceptor, rejection);

      const after = createProxyContext(body);
      await interceptor.onRequest!(after);
      expect(JSON.parse(after.requestBody!.toString('utf-8')).input).toHaveLength(0);
    });

    it('matches a marker split across two chunks', async () => {
      const context = createProxyContext({});
      await interceptor.onResponseChunk!(context, Buffer.from('{"code":"invalid_encry', 'utf-8'));
      await interceptor.onResponseChunk!(context, Buffer.from('pted_content"}', 'utf-8'));

      const request = createProxyContext({ input: [{ type: 'reasoning', id: 'rs_1' }] });
      await interceptor.onRequest!(request);

      expect(JSON.parse(request.requestBody!.toString('utf-8')).input).toHaveLength(0);
    });

    it('ignores non-Responses traffic', async () => {
      await interceptor.onResponseChunk!(
        createProxyContext({}, '/v1/chat/completions'),
        Buffer.from(AFFINITY_REJECTION, 'utf-8')
      );

      const request = createProxyContext({
        input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'abc==' }],
      });
      await interceptor.onRequest!(request);

      expect(JSON.parse(request.requestBody!.toString('utf-8')).input).toHaveLength(1);
    });

    it('does not latch on a clean stream', async () => {
      const context = createProxyContext({});
      await interceptor.onResponseChunk!(context, Buffer.from('data: {"type":"response.created"}', 'utf-8'));
      await interceptor.onResponseChunk!(context, Buffer.from('data: {"type":"response.completed"}', 'utf-8'));

      const request = createProxyContext({
        input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'abc==' }],
      });
      await interceptor.onRequest!(request);

      expect(JSON.parse(request.requestBody!.toString('utf-8')).input).toHaveLength(1);
    });
  });

  describe('Reasoning state removal once latched — codemie-code', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
      await latchFallback(interceptor);
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

    it('removes bare reasoning items that carry no encrypted content', async () => {
      const body = {
        model: 'gpt-5.6-terra-2026-07-09',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'reasoning', id: 'rs_06547a8c', summary: [] },
        ],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
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

    it('passes through body with no reasoning state unchanged', async () => {
      const body = { model: 'gpt-5.5-2026-04-24', input: [{ type: 'message', content: 'hi' }] };
      const context = createProxyContext(body);
      const originalStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalStr);
    });
  });

  describe('Reasoning state removal once latched — codemie-codex (regression)', () => {
    it('still removes encrypted items for codemie-codex', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-codex'));
      await latchFallback(interceptor);
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

  describe('Reasoning state removal once latched — vscode-byok', () => {
    it('removes encrypted state while preserving reasoning effort and visible tool history', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('vscode-byok'));
      await latchFallback(interceptor);
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
