import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchVsCodeModelCatalog,
  normalizeVsCodeModelCatalog,
  type VsCodeCatalogModel,
} from '../vscode-model-catalog.js';

function model(
  id: string,
  overrides: Partial<VsCodeCatalogModel> = {}
): VsCodeCatalogModel {
  return {
    base_name: id,
    deployment_name: id,
    label: id,
    enabled: true,
    features: {
      streaming: true,
      tools: true,
      temperature: true,
      parallel_tool_calls: true,
      system_prompt: true,
      max_tokens: true,
    },
    ...overrides,
  };
}

describe('normalizeVsCodeModelCatalog', () => {
  it('filters disabled entries, de-duplicates request IDs, and orders defaults first', () => {
    const catalog = normalizeVsCodeModelCatalog([
      model('z-model'),
      model('disabled', { enabled: false }),
      model('duplicate-a', { request_model: 'shared', label: 'Z duplicate' }),
      model('duplicate-b', { request_model: 'shared', label: 'Default duplicate', default: true }),
      model('a-model', { default: true }),
    ]);

    expect(catalog).toMatchObject({ discoveredCount: 5, enabledCount: 3 });
    expect(catalog.models.map(entry => entry.requestId)).toEqual([
      'a-model',
      'shared',
      'z-model',
    ]);
    expect(catalog.models[1]).toMatchObject({
      deploymentName: 'duplicate-b',
      label: 'Default duplicate',
      default: true,
    });
  });

  it('keeps only validated backend capability metadata', () => {
    const catalog = normalizeVsCodeModelCatalog([
      model('future-model', {
        request_model: 'request-model-id',
        label: 'Future model',
        multimodal: true,
        provider: 'future-provider',
        max_input_tokens: 100000,
        max_output_tokens: 12000,
        protocol: {
          type: 'responses',
          zero_data_retention: false,
          reasoning_efforts: ['low', 'invalid', 'high'],
          reasoning_effort_format: 'responses',
        },
      }),
    ]);

    expect(catalog.models[0]).toMatchObject({
      requestId: 'request-model-id',
      label: 'Future model',
      provider: 'future-provider',
      multimodal: true,
      maxInputTokens: 100000,
      maxOutputTokens: 12000,
      protocol: {
        type: 'responses',
        zero_data_retention: false,
        reasoning_efforts: ['low', 'high'],
        reasoning_effort_format: 'responses',
      },
    });
  });
});

describe('fetchVsCodeModelCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and normalizes the authenticated local-proxy catalog', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      model('gpt-4.1'),
    ]), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await fetchVsCodeModelCatalog('http://127.0.0.1:4001', 'local-key');

    expect(catalog.models.map(entry => entry.requestId)).toEqual(['gpt-4.1']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4001/v1/llm_models?include_all=true',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer local-key',
        },
      })
    );
  });

  it('rejects non-JSON responses without returning an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>', {
      headers: { 'content-type': 'text/html' },
    })));

    await expect(fetchVsCodeModelCatalog(
      'http://127.0.0.1:4001',
      'local-key'
    )).rejects.toThrow('unexpected response');
  });

  it('rejects catalogs without enabled usable models', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
      model('disabled', { enabled: false }),
    ]), { headers: { 'content-type': 'application/json' } })));

    await expect(fetchVsCodeModelCatalog(
      'http://127.0.0.1:4001',
      'local-key'
    )).rejects.toThrow('did not return any enabled models');
  });
});
