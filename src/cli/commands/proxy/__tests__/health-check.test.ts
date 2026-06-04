import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkProxyHealth } from '../health-check.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HEALTH = (url: unknown): boolean => String(url).endsWith('/health');
const MODELS = (url: unknown): boolean => String(url).includes('/v1/llm_models');

describe('checkProxyHealth', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shallow: returns healthy when /health responds 200', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k' });

    expect(result).toEqual({ healthy: true, level: 'shallow', code: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:4001/health');
  });

  it('shallow: dead-socket when the /health fetch rejects (proxy not listening)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('connect ECONNREFUSED')
    ) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k' });

    expect(result.healthy).toBe(false);
    expect(result.level).toBe('shallow');
    expect(result.code).toBe('dead-socket');
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('shallow: dead-socket when /health returns a non-2xx status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k' });

    expect(result).toMatchObject({ healthy: false, level: 'shallow', code: 'dead-socket' });
    expect(result.reason).toContain('503');
  });

  it('deep: healthy when /health and /v1/llm_models both succeed, with Bearer auth', async () => {
    const fetchSpy = vi.fn(async (url: unknown) => {
      if (HEALTH(url)) return { ok: true, status: 200 };
      if (MODELS(url)) return { ok: true, status: 200, json: async () => [] };
      throw new Error(`unexpected url ${String(url)}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'my-key', deep: true });

    expect(result).toEqual({ healthy: true, level: 'deep', code: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const modelsCall = fetchSpy.mock.calls.find(([u]) => MODELS(u));
    expect(modelsCall).toBeDefined();
    const init = modelsCall![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-key');
  });

  it('deep: unauthorized when /v1/llm_models returns 401', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (HEALTH(url)) return { ok: true, status: 200 };
      return { ok: false, status: 401 };
    }) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

    expect(result.healthy).toBe(false);
    expect(result.level).toBe('deep');
    expect(result.code).toBe('unauthorized');
    expect(result.reason).toContain('SSO session expired');
  });

  it('deep: unauthorized when /v1/llm_models returns 403', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (HEALTH(url)) return { ok: true, status: 200 };
      return { ok: false, status: 403 };
    }) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

    expect(result.code).toBe('unauthorized');
  });

  it('deep: upstream-error when /v1/llm_models returns a 5xx', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (HEALTH(url)) return { ok: true, status: 200 };
      return { ok: false, status: 500 };
    }) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

    expect(result).toMatchObject({ healthy: false, level: 'deep', code: 'upstream-error' });
    expect(result.reason).toContain('500');
  });

  it('deep: upstream-error when the models fetch throws', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (HEALTH(url)) return { ok: true, status: 200 };
      throw new Error('socket hang up');
    }) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

    expect(result).toMatchObject({ healthy: false, level: 'deep', code: 'upstream-error' });
    expect(result.reason).toContain('socket hang up');
  });

  it('does not perform the deep call when deep is not requested', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(MODELS(fetchSpy.mock.calls[0][0])).toBe(false);
  });
});
