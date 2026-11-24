/**
 * CodeMieProxy.stop hands its bounds to every interceptor's onProxyStop.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeMieProxy } from '../sso.proxy.js';
import { getPluginRegistry, resetPluginRegistry } from '../plugins/registry.js';
import type { ProxyInterceptor, ProxyPlugin } from '../plugins/types.js';

function recordingPlugin(id: string, priority: number, seen: Array<{ id: string; bounds: unknown }>): ProxyPlugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    priority,
    createInterceptor: (): ProxyInterceptor => ({
      name: id,
      onProxyStop: async (bounds) => {
        seen.push({ id, bounds });
      },
    }),
  };
}

describe('CodeMieProxy.stop', () => {
  beforeEach(() => {
    resetPluginRegistry();
  });

  afterEach(() => {
    resetPluginRegistry();
  });

  it('forwards its deadline to each interceptor', async () => {
    const seen: Array<{ id: string; bounds: unknown }> = [];
    const registry = getPluginRegistry();
    registry.register(recordingPlugin('test-first', 10, seen));
    registry.register(recordingPlugin('test-second', 20, seen));
    const proxy = new CodeMieProxy({ targetApiUrl: 'http://127.0.0.1:9', host: '127.0.0.1', port: 0, provider: 'test-provider' });
    await proxy.start();

    await proxy.stop({ deadlineMs: 1_790_000_010_000 });

    expect(seen).toEqual([
      { id: 'test-first', bounds: { deadlineMs: 1_790_000_010_000 } },
      { id: 'test-second', bounds: { deadlineMs: 1_790_000_010_000 } },
    ]);
  });
});
