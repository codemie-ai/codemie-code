/**
 * Effort-stripping tests for the Claude request normalizer.
 * Models that do not support the adaptive-thinking/effort API must not receive
 * an `effort` parameter, or the upstream returns HTTP 400
 * ("This model does not support the effort parameter"). Covers EPMCDME-14035 (Bug 2).
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { ClaudeRequestNormalizerPlugin } from '../claude-request-normalizer.plugin.js';
import { logger } from '../../../../../../utils/logger.js';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';

function pluginContext(clientType: string, model?: string): PluginContext {
  return {
    config: { targetApiUrl: 'https://api.anthropic.com', provider: 'test', sessionId: 's', clientType, model },
    logger,
  } as PluginContext;
}

function proxyContext(body: Record<string, unknown>): ProxyContext {
  const requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'r',
    sessionId: 's',
    agentName: 'a',
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': String(requestBody.length) },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  } as ProxyContext;
}

async function run(model: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const plugin = new ClaudeRequestNormalizerPlugin();
  const interceptor = await plugin.createInterceptor(pluginContext('codemie-claude', model));
  const ctx = proxyContext({ model, ...body });
  await interceptor.onRequest(ctx);
  return JSON.parse(ctx.requestBody!.toString('utf-8'));
}

describe('ClaudeRequestNormalizer — unsupported effort stripping', () => {
  it('strips output_config.effort for claude-4-5-sonnet (no thinking present)', async () => {
    const out = await run('claude-4-5-sonnet', { output_config: { effort: 'high' }, messages: [] });
    expect(out.output_config).toBeUndefined();
  });

  it('strips effort for the alternate spelling claude-sonnet-4-5 but keeps sibling keys', async () => {
    const out = await run('claude-sonnet-4-5', { output_config: { effort: 'medium', other: 1 }, messages: [] });
    expect((out.output_config as Record<string, unknown>)?.effort).toBeUndefined();
    expect((out.output_config as Record<string, unknown>)?.other).toBe(1);
  });

  it('strips a top-level effort field for a non-adaptive model', async () => {
    const out = await run('claude-4-5-sonnet', { effort: 'high', messages: [] });
    expect(out.effort).toBeUndefined();
  });

  it('preserves effort for adaptive models (opus-4-7, sonnet-5)', async () => {
    for (const model of ['claude-opus-4-7', 'claude-sonnet-5']) {
      const out = await run(model, { output_config: { effort: 'high' }, messages: [] });
      expect((out.output_config as Record<string, unknown>)?.effort).toBe('high');
    }
  });

  it('leaves a request with no effort untouched', async () => {
    const out = await run('claude-4-5-sonnet', { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.effort).toBeUndefined();
    expect(out.output_config).toBeUndefined();
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('leaves the thinking field of a standard (non-adaptive, non-none) model untouched', async () => {
    // claude-4-5-sonnet resolves to DEFAULT_CAPABILITIES (thinking: "standard"),
    // so an enabled thinking block must pass through unchanged (not transformed to adaptive).
    const out = await run('claude-4-5-sonnet', {
      thinking: { type: 'enabled', budget_tokens: 10000 },
      messages: [],
    });
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
    expect(out.output_config).toBeUndefined();
  });
});
