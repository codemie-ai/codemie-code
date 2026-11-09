/**
 * GET /health on a real CodeMieProxy carries `analytics.credentials` from the OTLP interceptor.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext, ProxyInterceptor, ProxyPlugin } from '../plugins/types.js';
import { getPluginRegistry, resetPluginRegistry } from '../plugins/registry.js';
import { clearCredentialsStale, markCredentialsStale } from '../plugins/otlp-spool/auth-state.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { CodeMieProxy } = await import('../sso.proxy.js');
const { OtlpPlugin } = await import('../plugins/otlp.plugin.js');

/** The real OTLP interceptor, minus the spool tick/sweep timers so the test never touches disk. */
function otlpWithoutSpoolWork(): ProxyPlugin {
  const real = new OtlpPlugin();
  return {
    id: real.id,
    name: real.name,
    version: real.version,
    priority: real.priority,
    createInterceptor: (context: PluginContext): ProxyInterceptor => {
      const interceptor = real.createInterceptor(context);
      interceptor.onProxyStart = async () => undefined;
      interceptor.onProxyStop = async () => undefined;
      return interceptor;
    },
  };
}

describe('CodeMieProxy GET /health — analytics', () => {
  beforeEach(() => {
    resetPluginRegistry();
  });

  afterEach(() => {
    clearCredentialsStale();
    resetPluginRegistry();
  });

  it('reports analytics.credentials from the OTLP interceptor, ok and stale', async () => {
    getPluginRegistry().register(otlpWithoutSpoolWork());
    const proxy = new CodeMieProxy({ targetApiUrl: 'http://127.0.0.1:9', host: '127.0.0.1', port: 0, provider: 'test-provider' });
    const { url } = await proxy.start();

    try {
      markCredentialsStale();
      const stale = await (await fetch(`${url}/health`)).json() as { analytics?: unknown; pid?: number };
      expect(stale.analytics).toEqual({ credentials: 'stale' });
      expect(stale.pid).toBe(process.pid);

      clearCredentialsStale();
      const ok = await (await fetch(`${url}/health`)).json() as { analytics?: unknown };
      expect(ok.analytics).toEqual({ credentials: 'ok' });
    } finally {
      await proxy.stop();
    }
  });
});
