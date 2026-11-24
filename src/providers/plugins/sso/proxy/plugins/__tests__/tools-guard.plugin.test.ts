/**
 * Tools Guard plugin, interceptor and registration tests
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolsGuardPlugin } from '../tools-guard.plugin.js';
import {
  registerCorePlugins,
  getPluginRegistry,
  resetPluginRegistry,
  ToolsGuardPlugin as IndexToolsGuardPlugin,
} from '../index.js';
import { CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE } from '../../proxy-clients.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '@/utils/logger.js';

function createPluginContext(): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.anthropic.com',
      provider: 'test',
      sessionId: 'test-session',
    },
    logger,
  };
}

function createProxyContext(
  body: unknown,
  opts: { url?: string; contentType?: string | null; raw?: string | null } = {}
): ProxyContext {
  const { url = '/v1/messages', contentType = 'application/json' } = opts;
  const raw = opts.raw !== undefined ? opts.raw : JSON.stringify(body);
  const requestBody = raw === null ? null : Buffer.from(raw, 'utf-8');
  const headers: Record<string, string> = {};
  if (contentType !== null) headers['content-type'] = contentType;
  if (requestBody) headers['content-length'] = String(requestBody.length);
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url,
    headers,
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  } as ProxyContext;
}

// Non-ASCII char so byte length differs from string length.
const historyBody = (): Record<string, unknown> => ({
  messages: [
    { role: 'user', content: 'héllo ✓' },
    { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }] },
  ],
});

describe('ToolsGuardPlugin', () => {
  let interceptor: ProxyInterceptor;

  beforeEach(async () => {
    interceptor = await new ToolsGuardPlugin().createInterceptor(createPluginContext());
  });

  describe('metadata', () => {
    it('exposes id, priority and clients', () => {
      const plugin = new ToolsGuardPlugin();
      expect(plugin.id).toBe('@codemie/proxy-tools-guard');
      expect(plugin.priority).toBe(14);
      expect(plugin.clients).toEqual([
        'codemie-code',
        'codemie-claude',
        'codemie-claude-acp',
        'codemie-opencode',
        'codemie-opencode-acp',
        'codemie-copilot',
        CLAUDE_DESKTOP,
        VSCODE_CLAUDE_CODE,
      ]);
    });
  });

  describe('injection', () => {
    it('injects the placeholder and updates content-length by byte length', async () => {
      const ctx = createProxyContext(historyBody());
      await interceptor.onRequest!(ctx);
      const newBody = ctx.requestBody!.toString('utf-8');
      const parsed = JSON.parse(newBody);
      expect(parsed.tools[0].name).toBe('noop_placeholder_tool');
      expect(ctx.headers['content-length']).toBe(String(Buffer.byteLength(newBody)));
      expect(Buffer.byteLength(newBody)).not.toBe(newBody.length);
    });

    it('leaves the buffer and header unchanged when there is no tool history', async () => {
      const ctx = createProxyContext({ messages: [{ role: 'user', content: 'hi' }] });
      const before = ctx.requestBody;
      const header = ctx.headers['content-length'];
      await interceptor.onRequest!(ctx);
      expect(ctx.requestBody).toBe(before);
      expect(ctx.headers['content-length']).toBe(header);
    });

    it('leaves the buffer and header unchanged when tools is non-empty', async () => {
      const ctx = createProxyContext({ ...historyBody(), tools: [{ name: 'real' }] });
      const before = ctx.requestBody;
      const header = ctx.headers['content-length'];
      await interceptor.onRequest!(ctx);
      expect(ctx.requestBody).toBe(before);
      expect(ctx.headers['content-length']).toBe(header);
    });
  });

  describe('endpoint filtering', () => {
    it.each([
      ['/v1/messages', true],
      ['/v1/messages/', true],
      ['/v1/chat/completions', true],
      ['/chat/completions', true],
      ['/v1/responses', true],
      ['/v1/messages?beta=true', true],
      ['/v1/messages/count_tokens', false],
      ['/v1/models', false],
      ['/v1/messages/batches', false],
      ['/', false],
    ])('path %s acted on: %s', async (url, acted) => {
      const ctx = createProxyContext(historyBody(), { url });
      const before = ctx.requestBody!.toString('utf-8');
      await interceptor.onRequest!(ctx);
      const after = ctx.requestBody!.toString('utf-8');
      if (acted) {
        expect(JSON.parse(after).tools).toHaveLength(1);
      } else {
        expect(after).toBe(before);
      }
    });
  });

  describe('early returns', () => {
    it.each([
      ['null body', { raw: null }],
      ['text/plain', { contentType: 'text/plain' }],
      ['missing content-type', { contentType: null }],
      ['invalid JSON', { raw: '{not json' }],
      ['JSON null', { raw: 'null' }],
      ['JSON number', { raw: '5' }],
      ['JSON string', { raw: '"s"' }],
      // Characterization: arrays pass the object guard and are a no-op (no injection).
      ['array body', { raw: '[{"messages":[{"role":"tool"}]}]' }],
    ])('leaves request unchanged for %s', async (_label, opts) => {
      const ctx = createProxyContext(historyBody(), opts);
      const before = ctx.requestBody ? ctx.requestBody.toString('utf-8') : null;
      const header = ctx.headers['content-length'];
      await interceptor.onRequest!(ctx);
      expect(ctx.requestBody ? ctx.requestBody.toString('utf-8') : null).toBe(before);
      expect(ctx.headers['content-length']).toBe(header);
    });

    it('accepts application/json with a charset parameter', async () => {
      const ctx = createProxyContext(historyBody(), { contentType: 'application/json; charset=utf-8' });
      await interceptor.onRequest!(ctx);
      expect(JSON.parse(ctx.requestBody!.toString('utf-8')).tools).toHaveLength(1);
    });
  });
});

describe('ToolsGuardPlugin registration', () => {
  beforeEach(() => resetPluginRegistry());
  afterEach(() => resetPluginRegistry());

  it('is registered by registerCorePlugins at priority 14', () => {
    registerCorePlugins();
    const plugins = getPluginRegistry()['getEnabledPluginsSorted']();
    const found = plugins.find((p) => p.id === '@codemie/proxy-tools-guard');
    expect(found).toBeDefined();
    expect(found!.priority).toBe(14);
    expect(found).toBeInstanceOf(ToolsGuardPlugin);
  });

  it('index re-exports the same class', () => {
    expect(IndexToolsGuardPlugin).toBe(ToolsGuardPlugin);
  });
});
