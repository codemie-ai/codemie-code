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

  it('resolves an undated pinned profile model to its dated deployment', async () => {
    // config.model carries the profile's undated picker name (e.g. from
    // `codemie proxy connect --codex-desktop`); the fallback must resolve it to
    // the dated deployment rather than dropping to the recency default.
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const plugin = new CodexRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(
      makePluginContext({ config: { clientType: 'codex-desktop', model: 'gpt-5.6-sol' } })
    );
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);

    const context = makeProxyContext({ model: 'gpt-4o-does-not-exist', input: 'hi' });
    await interceptor.onRequest!(context);

    expect(bodyOf(context).model).toBe('gpt-5.6-sol-2026-07-09');
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

describe('CodexRequestNormalizerPlugin empty tool descriptions', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  async function makeInterceptor() {
    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const interceptor = await new CodexRequestNormalizerPlugin().createInterceptor(makePluginContext());
    (interceptor as unknown as { setAvailableModelsForTest(m: string[]): void })
      .setAvailableModelsForTest(AVAILABLE);
    return interceptor;
  }

  it('fills an empty description on a nested input tools array with the tool name', async () => {
    const interceptor = await makeInterceptor();
    const context = makeProxyContext({
      model: 'gpt-5.6-luna-2026-07-09',
      input: [
        {
          type: 'mcp_list_tools',
          server_label: 'codegraph',
          tools: [
            { name: 'codegraph_search', description: '', input_schema: { type: 'object' } },
            { name: 'codegraph_node', description: 'real one', input_schema: { type: 'object' } },
          ],
        },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });

    await interceptor.onRequest!(context);
    const tools = (bodyOf(context).input as Array<{ tools?: Array<{ description?: string }> }>)[0].tools!;

    expect(tools[0].description).toBe('codegraph_search');
    expect(tools[1].description).toBe('real one');
  });

  it('fills an empty description on a top-level tools array', async () => {
    const interceptor = await makeInterceptor();
    const context = makeProxyContext({
      model: 'gpt-5.6-luna-2026-07-09',
      input: 'hi',
      tools: [{ type: 'function', name: 'probe', description: '', parameters: { type: 'object' } }],
    });

    await interceptor.onRequest!(context);
    const tools = bodyOf(context).tools as Array<{ description?: string }>;

    expect(tools[0].description).toBe('probe');
  });

  it('drops the key when an empty description has no usable name', async () => {
    const interceptor = await makeInterceptor();
    const context = makeProxyContext({
      model: 'gpt-5.6-luna-2026-07-09',
      input: 'hi',
      tools: [{ type: 'function', description: '', parameters: { type: 'object' } }],
    });

    await interceptor.onRequest!(context);
    const tools = bodyOf(context).tools as Array<Record<string, unknown>>;

    expect('description' in tools[0]).toBe(false);
  });

  it('leaves whitespace-only descriptions repaired too', async () => {
    const interceptor = await makeInterceptor();
    const context = makeProxyContext({
      model: 'gpt-5.6-luna-2026-07-09',
      input: 'hi',
      tools: [{ type: 'function', name: 'probe', description: '   ', parameters: { type: 'object' } }],
    });

    await interceptor.onRequest!(context);
    expect((bodyOf(context).tools as Array<{ description?: string }>)[0].description).toBe('probe');
  });

  it('never touches a description outside a tools array', async () => {
    const interceptor = await makeInterceptor();
    const context = makeProxyContext({
      model: 'gpt-5.6-luna-2026-07-09',
      input: 'hi',
      // A JSON-schema property description is legitimately allowed to be empty
      // and is not what Azure rejects; rewriting it would alter the schema.
      tools: [{
        type: 'function',
        name: 'probe',
        description: 'fine',
        parameters: { type: 'object', properties: { q: { type: 'string', description: '' } } },
      }],
      metadata: { description: '' },
    });

    await interceptor.onRequest!(context);
    const body = bodyOf(context);
    const params = (body.tools as Array<{ parameters: { properties: { q: { description: string } } } }>)[0].parameters;

    expect(params.properties.q.description).toBe('');
    expect((body.metadata as { description: string }).description).toBe('');
  });

  it('leaves a request with no empty descriptions byte-identical', async () => {
    const interceptor = await makeInterceptor();
    const context = makeProxyContext({
      model: 'gpt-5.6-luna-2026-07-09',
      input: 'hi',
      tools: [{ type: 'function', name: 'probe', description: 'ok', parameters: { type: 'object' } }],
    });
    const before = context.requestBody!.toString('utf-8');

    await interceptor.onRequest!(context);

    expect(context.requestBody!.toString('utf-8')).toBe(before);
  });
});

describe('CodexRequestNormalizerPlugin robustness', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('survives a pathologically deep body without blowing the stack', async () => {
    const { repairEmptyToolDescriptions } = await import('../codex-request-normalizer.plugin.js');

    // Body depth is client-controlled: Codex accumulates conversation history
    // plus nested MCP tool schemas.
    let deep: Record<string, unknown> = { tools: [{ name: 'x', description: '' }] };
    for (let i = 0; i < 20000; i++) deep = { nested: deep };

    expect(() => repairEmptyToolDescriptions(deep)).not.toThrow();
  });

  it('does not hang on a cyclic body', async () => {
    const { repairEmptyToolDescriptions } = await import('../codex-request-normalizer.plugin.js');
    const body: Record<string, unknown> = { tools: [{ name: 'x', description: '' }] };
    body.self = body;

    expect(() => repairEmptyToolDescriptions(body)).not.toThrow();
  });

  it('tolerates a tools key whose value is not an array of objects', async () => {
    const { repairEmptyToolDescriptions } = await import('../codex-request-normalizer.plugin.js');

    expect(() => repairEmptyToolDescriptions({ tools: 'not-an-array' })).not.toThrow();
    expect(() => repairEmptyToolDescriptions({ tools: [null, 5, 'x', [1]] })).not.toThrow();
  });

  it('caches a failed model listing so a broken gateway is not refetched per request', async () => {
    const httpModule = await import('../../../sso.http-client.js');
    const fetchSpy = vi.spyOn(httpModule, 'fetchCodeMieLlmModels')
      .mockRejectedValue(new Error('gateway down'));

    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const interceptor = await new CodexRequestNormalizerPlugin().createInterceptor(makePluginContext());

    for (let i = 0; i < 4; i++) {
      await interceptor.onRequest!(makeProxyContext({ model: 'gpt-5.6-luna', input: 'hi' }));
    }

    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('CodexRequestNormalizerPlugin fallback safety', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('never substitutes a non-Codex deployment', async () => {
    // loadModels must not hand the resolver Claude or embedding deployments: a
    // Responses request silently rerouted to one of those would be worse than
    // the gateway's own error.
    const httpModule = await import('../../../sso.http-client.js');
    vi.spyOn(httpModule, 'fetchCodeMieLlmModels').mockResolvedValue([
      { deployment_name: 'claude-sonnet-4-6', enabled: true },
      { deployment_name: 'text-embedding-3-large', enabled: true },
    ] as never);

    const { CodexRequestNormalizerPlugin } = await import('../codex-request-normalizer.plugin.js');
    const interceptor = await new CodexRequestNormalizerPlugin().createInterceptor(makePluginContext());

    const context = makeProxyContext({ model: 'gpt-5.6-luna', input: 'hi' });
    await interceptor.onRequest!(context);

    // No Codex-compatible deployment exists, so the request passes through and
    // the gateway reports the real problem.
    expect(bodyOf(context).model).toBe('gpt-5.6-luna');
  });
});
