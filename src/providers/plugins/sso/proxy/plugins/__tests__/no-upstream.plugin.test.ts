/**
 * The last plugin of a daemon with no upstream answers 404 itself and ends the chain; the default plugin set leaves it
 * and the local intake off.
 * @group unit
 */
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';
import { NoUpstreamPlugin } from '../no-upstream.plugin.js';
import { getPluginRegistry } from '../registry.js';
import { logger } from '../../../../../../utils/logger.js';

describe('NoUpstreamPlugin', () => {
  it.each(['/v1/messages', '/v1/chat/completions', '/anything?x=1'])('%s → 404 and the chain ends, with no outbound request', async (url) => {
    const res = { statusCode: 0, body: '', setHeader: () => undefined, end(chunk?: string) { res.body = chunk ?? ''; } };
    const forward = vi.fn();
    const httpClient = { forward } as unknown as ProxyHTTPClient;
    const ctx = { method: 'POST', url, headers: {}, metadata: {} } as unknown as ProxyContext;

    const handled = await new NoUpstreamPlugin()
      .createInterceptor()
      .handleRequest!(ctx, {} as IncomingMessage, res as unknown as ServerResponse, httpClient);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it('runs after every plugin the registry holds', async () => {
    await import('../index.js');
    const others = getPluginRegistry().getAll().filter((plugin) => !(plugin instanceof NoUpstreamPlugin));

    expect(others.length).toBeGreaterThan(0);
    expect(others.every((plugin) => plugin.priority < new NoUpstreamPlugin().priority)).toBe(true);
  });

  it('the default plugin set enables neither plugin of the local daemon', async () => {
    const { LocalAnalyticsPlugin } = await import('../index.js');
    const registry = getPluginRegistry();

    expect(registry.getConfig(new NoUpstreamPlugin().id)?.enabled).toBe(false);
    expect(registry.getConfig(new LocalAnalyticsPlugin().id)?.enabled).toBe(false);
    expect(registry.getConfig('@codemie/otlp')?.enabled).toBe(true);
  });

  it.each([
    ['a backend daemon', { targetApiUrl: 'https://api.example.com', host: '127.0.0.1', provider: 'ai-run-sso', gatewayKey: 'codemie-proxy' }],
    ['a wrapper\'s proxy', { targetApiUrl: 'https://api.example.com', provider: 'ai-run-sso', clientType: 'claude', sessionId: 'session-1' }],
  ])('the default registry, initialized as %s initializes it, builds an interceptor for neither plugin of the local daemon', async (_caller, config) => {
    await import('../index.js');

    const interceptors = await getPluginRegistry().initialize({ config, logger });
    const names = interceptors.map((interceptor) => interceptor.name);

    expect(names).toContain('otlp-ingest');
    expect(names).not.toContain('local-analytics');
    expect(names).not.toContain('no-upstream');
  });
});
