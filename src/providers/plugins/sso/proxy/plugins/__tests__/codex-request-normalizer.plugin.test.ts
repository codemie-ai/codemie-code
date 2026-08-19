/**
 * CodexRequestNormalizerPlugin Tests
 * @group unit
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

const AVAILABLE = [
  'gpt-5-2025-08-07',
  'gpt-5-2-2025-12-11',
  'gpt-5.6-luna-2026-07-09',
  'gpt-5.6-sol-2026-07-09',
];

function makePluginContext(overrides: Record<string, unknown> = {}): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://upstream.example.com',
      clientType: 'codex-desktop',
      model: 'gpt-5.6-sol-2026-07-09',
      ...(overrides.config as Record<string, unknown> ?? {}),
    },
    logger,
    credentials: { jwtToken: 'token' } as never,
    ...overrides,
  } as PluginContext;
}

function makeProxyContext(body: unknown, url = '/v1/responses'): ProxyContext {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentName: 'codex-desktop',
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    requestBody: raw,
    requestStartTime: Date.now(),
    metadata: {},
  } as ProxyContext;
}

function bodyOf(context: ProxyContext): Record<string, unknown> {
  return JSON.parse(context.requestBody!.toString('utf-8'));
}

describe('CodexRequestNormalizerPlugin', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('refuses to load for a non-Codex client', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();

    await expect(
      plugin.createInterceptor(makePluginContext({ config: { clientType: 'vscode-byok' } }))
    ).rejects.toThrow(/disabled/i);
  });

  it('rewrites an undated model to its dated deployment', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext());
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const context = makeProxyContext({ model: 'gpt-5.6-luna', input: 'hi' });
    await interceptor.onRequest!(context);

    expect(bodyOf(context).model).toBe('gpt-5.6-luna-2026-07-09');
    expect(context.headers['content-length']).toBe(String(context.requestBody!.length));
  });

  it('substitutes the pinned model when the request names something CodeMie lacks', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext());
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const context = makeProxyContext({ model: 'gpt-5.2-turbo-fake', input: 'hi' });
    await interceptor.onRequest!(context);

    expect(bodyOf(context).model).toBe('gpt-5.6-sol-2026-07-09');
  });

  it('leaves an already-valid deployment name untouched', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext());
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const context = makeProxyContext({ model: 'gpt-5.6-sol-2026-07-09', input: 'hi' });
    const before = context.requestBody!.toString('utf-8');
    await interceptor.onRequest!(context);

    expect(context.requestBody!.toString('utf-8')).toBe(before);
  });

  it('passes through a request with no model field', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext());
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const context = makeProxyContext({ input: 'hi' });
    const before = context.requestBody!.toString('utf-8');
    await interceptor.onRequest!(context);

    expect(context.requestBody!.toString('utf-8')).toBe(before);
  });

  it('passes through non-JSON and empty bodies without throwing', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext());
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const nonJson = makeProxyContext(undefined);
    nonJson.requestBody = Buffer.from('not json at all', 'utf-8');
    await expect(interceptor.onRequest!(nonJson)).resolves.toBeUndefined();

    const empty = makeProxyContext(undefined);
    await expect(interceptor.onRequest!(empty)).resolves.toBeUndefined();
  });

  it('passes the request through unchanged when the model list could not be loaded', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext());
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest([]);

    const context = makeProxyContext({ model: 'gpt-5.6-luna', input: 'hi' });
    await interceptor.onRequest!(context);

    expect(bodyOf(context).model).toBe('gpt-5.6-luna');
  });
});

describe('CodexRequestNormalizerPlugin fallback without a pinned model', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('substitutes the newest deployment when the daemon has no pinned model', async () => {
    // The daemon is spawned before the connector resolves a model, so
    // config.model is routinely absent — the fallback must not depend on it.
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(
      makePluginContext({ config: { clientType: 'codex-desktop' } })
    );
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const context = makeProxyContext({ model: 'gpt-4o-does-not-exist', input: 'hi' });
    await interceptor.onRequest!(context);

    expect(bodyOf(context).model).toBe('gpt-5.6-luna-2026-07-09');
  });

  it('prefers an explicitly pinned model over the newest when one is configured', async () => {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(
      makePluginContext({ config: { clientType: 'codex-desktop', model: 'gpt-5-2025-08-07' } })
    );
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const context = makeProxyContext({ model: 'gpt-4o-does-not-exist', input: 'hi' });
    await interceptor.onRequest!(context);

    expect(bodyOf(context).model).toBe('gpt-5-2025-08-07');
  });
});
