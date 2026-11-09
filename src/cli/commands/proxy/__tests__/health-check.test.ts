import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkProxyHealth, parseAnalyticsReply } from '../health-check.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HEALTH = (url: unknown): boolean => String(url).endsWith('/health');
const MODELS = (url: unknown): boolean => String(url).includes('/v1/llm_models');
const mkHeaders = (ct: string) => ({ get: (h: string) => h === 'content-type' ? ct : null });

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
      if (MODELS(url)) return { ok: true, status: 200, headers: mkHeaders('application/json'), json: async () => [] };
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
    expect(result.reason).toBe(
      'SSO session expired — run `codemie profile login` and restart the proxy.'
    );
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

  it('deep: unauthorized when /v1/llm_models returns 200 with HTML content-type (Keycloak redirect)', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (HEALTH(url)) return { ok: true, status: 200 };
      if (MODELS(url)) return { ok: true, status: 200, headers: mkHeaders('text/html; charset=utf-8') };
      throw new Error(`unexpected url ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

    expect(result.healthy).toBe(false);
    expect(result.level).toBe('deep');
    expect(result.code).toBe('unauthorized');
    expect(result.reason).toContain('SSO session expired');
  });

  it('deep: healthy when /v1/llm_models returns 200 with application/json (regression)', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (HEALTH(url)) return { ok: true, status: 200 };
      if (MODELS(url)) return { ok: true, status: 200, headers: mkHeaders('application/json'), json: async () => [] };
      throw new Error(`unexpected url ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

    expect(result).toEqual({ healthy: true, level: 'deep', code: 'ok' });
  });

  describe('analytics reply', () => {
    const replyWith = (json: () => Promise<unknown>): typeof globalThis.fetch =>
      vi.fn().mockResolvedValue({ ok: true, status: 200, json }) as unknown as typeof globalThis.fetch;

    it('exposes analytics when the reply pid matches expectedPid', async () => {
      globalThis.fetch = replyWith(async () => ({ status: 'ok', pid: 42, analytics: { credentials: 'stale' } }));

      const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', expectedPid: 42 });

      expect(result).toEqual({ healthy: true, level: 'shallow', code: 'ok', analytics: { credentials: 'stale' } });
    });

    it('leaves analytics unset when the reply pid differs from expectedPid', async () => {
      globalThis.fetch = replyWith(async () => ({ pid: 7, analytics: { credentials: 'stale' } }));

      const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', expectedPid: 42 });

      expect(result).toEqual({ healthy: true, level: 'shallow', code: 'ok' });
    });

    it('does not read the body or set analytics when expectedPid is not passed', async () => {
      const json = vi.fn(async () => ({ pid: 42, analytics: { credentials: 'stale' } }));
      globalThis.fetch = replyWith(json);

      const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k' });

      expect(result).toEqual({ healthy: true, level: 'shallow', code: 'ok' });
      expect(json).not.toHaveBeenCalled();
    });

    it('keeps healthy/code unchanged when the body is not JSON', async () => {
      globalThis.fetch = replyWith(async () => { throw new SyntaxError('Unexpected token <'); });

      const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', expectedPid: 42 });

      expect(result).toEqual({ healthy: true, level: 'shallow', code: 'ok' });
    });

    it('exposes analytics on a deep check too', async () => {
      globalThis.fetch = vi.fn(async (url: unknown) => {
        if (HEALTH(url)) return { ok: true, status: 200, json: async () => ({ pid: 42, analytics: { credentials: 'ok' } }) };
        return { ok: true, status: 200, headers: mkHeaders('application/json') };
      }) as unknown as typeof globalThis.fetch;

      const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true, expectedPid: 42 });

      expect(result).toEqual({ healthy: true, level: 'deep', code: 'ok', analytics: { credentials: 'ok' } });
    });
  });
});

describe('parseAnalyticsReply', () => {
  it.each([
    ['null', null],
    ['a number', 5],
    ['a string', 'x'],
    ['an array', []],
    ['missing analytics', { pid: 42 }],
    ['null analytics', { pid: 42, analytics: null }],
    ['unknown credentials', { pid: 42, analytics: { credentials: 'x' } }],
    ['non-string credentials', { pid: 42, analytics: { credentials: true } }],
    ['mismatched pid', { pid: 1, analytics: { credentials: 'ok' } }],
    ['missing pid', { analytics: { credentials: 'ok' } }],
  ])('returns undefined for %s', (_label, body) => {
    expect(parseAnalyticsReply(body, 42)).toBeUndefined();
  });

  it.each(['ok', 'stale'] as const)('accepts credentials %s for a matching pid', (credentials) => {
    expect(parseAnalyticsReply({ pid: 42, analytics: { credentials, extra: 1 } }, 42)).toEqual({ credentials });
  });
});
