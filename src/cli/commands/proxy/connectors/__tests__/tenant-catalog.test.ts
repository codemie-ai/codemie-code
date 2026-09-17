import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTenantModelCatalog } from '../tenant-catalog.js';
import { ConfigurationError } from '@/utils/errors.js';

describe('fetchTenantModelCatalog', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const mkHeaders = (ct: string) => ({ get: (h: string) => h === 'content-type' ? ct : null });

  it('returns every deployment id unfiltered', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('application/json'),
      json: async () => [
        { base_name: 'openai.gpt-5.6-luna' },
        { base_name: 'github-copilot-gpt-5-mini' },
        { base_name: 'claude-4-6-sonnet' },
        { base_name: 'github-copilot-claude-sonnet-4-5' },
        { base_name: 'qwen.qwen3-coder-30b-a3b-v1' },
      ],
    }) as unknown as typeof globalThis.fetch;

    const ids = await fetchTenantModelCatalog('http://127.0.0.1:4001', 'gw-key');
    expect(ids).toEqual([
      'openai.gpt-5.6-luna',
      'github-copilot-gpt-5-mini',
      'claude-4-6-sonnet',
      'github-copilot-claude-sonnet-4-5',
      'qwen.qwen3-coder-30b-a3b-v1',
    ]);
  });

  it('throws ConfigurationError on a non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: mkHeaders('application/json'),
      json: async () => ({}),
    }) as unknown as typeof globalThis.fetch;

    await expect(fetchTenantModelCatalog('http://127.0.0.1:4001', 'gw-key'))
      .rejects.toThrow(ConfigurationError);
  });

  it('throws on a non-JSON content-type', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('text/html; charset=utf-8'),
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    }) as unknown as typeof globalThis.fetch;

    await expect(fetchTenantModelCatalog('http://127.0.0.1:4001', 'gw-key'))
      .rejects.toThrow(ConfigurationError);
  });

  it('throws on a network rejection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof globalThis.fetch;

    await expect(fetchTenantModelCatalog('http://127.0.0.1:4001', 'gw-key'))
      .rejects.toThrow(ConfigurationError);
  });
});
