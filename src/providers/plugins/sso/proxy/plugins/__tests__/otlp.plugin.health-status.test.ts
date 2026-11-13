/**
 * Tests for `OtlpInterceptor.healthStatus()`: the daemon `/health` reply reports whether the
 * analytics credentials are usable, derived from the shared stale flag in `auth-state.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PluginContext } from '../types.js';
import { markCredentialsStale, clearCredentialsStale } from '../otlp-spool/auth-state.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { OtlpPlugin } = await import('../otlp.plugin.js');

describe('OtlpInterceptor — healthStatus', () => {
  afterEach(() => {
    clearCredentialsStale();
  });

  it('reports stale credentials after markCredentialsStale() and ok once cleared', () => {
    const interceptor = new OtlpPlugin().createInterceptor({
      credentials: { cookies: {}, apiUrl: 'https://api' },
      config: { targetApiUrl: 'https://api' },
    } as unknown as PluginContext);

    expect(interceptor.healthStatus?.()).toEqual({ credentials: 'ok' });

    markCredentialsStale();
    expect(interceptor.healthStatus?.()).toEqual({ credentials: 'stale' });

    clearCredentialsStale();
    expect(interceptor.healthStatus?.()).toEqual({ credentials: 'ok' });
  });
});
