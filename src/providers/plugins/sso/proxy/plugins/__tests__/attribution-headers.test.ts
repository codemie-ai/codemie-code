import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAttributionHeaders, HeaderInjectionPlugin, type AnalyticsAttribution } from '../header-injection.plugin.js';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { ProviderRegistry } from '@/providers/core/registry.js';

const analytics: AnalyticsAttribution = {
  destination: 'analytics', sessionId: 's1', routedViaCodemie: false,
  subscriptionType: 'personal', routingUnproven: false, organization: 'Яндекс',
  policyVersion: 'p1', repoKey: 'host/org/repo', project: 'project', projectSource: 'profile',
};
const context = (): ProxyContext => ({
  requestId: 'r1', sessionId: 's1', agentName: 'claude', method: 'POST', url: '/v1/messages',
  headers: {}, requestBody: null, requestStartTime: 0, metadata: {},
});

afterEach(() => vi.restoreAllMocks());

describe('central attribution header contract', () => {
  it('keeps the analytics wire representation and excludes model metadata', () => {
    expect(buildAttributionHeaders(analytics)).toEqual({ headers: {
      'X-CodeMie-Session-Id': 's1', 'X-CodeMie-Routed-Via-CodeMie': 'false',
      'X-CodeMie-Subscription-Type': 'personal',
      'X-CodeMie-Organization-Encoded': 'utf8-b64u.v1:0K_QvdC00LXQutGB',
      'X-CodeMie-Policy-Version': 'p1', 'X-CodeMie-Repo-Remote': 'host/org/repo',
      'X-CodeMie-Project': 'project', 'X-CodeMie-Project-Source': 'profile',
    }, omitted: [] });
  });

  it('the model mode cannot emit evidence even when passed an object containing those fields', () => {
    const result = buildAttributionHeaders({ ...analytics, destination: 'model', requestId: 'r1' });
    expect(result.headers).toEqual({
      'X-CodeMie-Request-ID': 'r1', 'X-CodeMie-Session-ID': 's1',
      'X-CodeMie-CLI': 'codemie-cli/0.0.0', 'X-CodeMie-Project': 'project',
    });
  });

  it('reports omitted header names without retaining rejected values', () => {
    const built = buildAttributionHeaders({ ...analytics, organization: 'Acme%20Corp', repoKey: 'host/секрет' });
    expect(built.headers['X-CodeMie-Organization']).toBe('Acme%20Corp');
    expect(built.headers).not.toHaveProperty('X-CodeMie-Organization-Encoded');
    expect(built.omitted).toEqual(['X-CodeMie-Repo-Remote']);
    expect(JSON.stringify(built)).not.toContain('секрет');
  });

  it('unproven routing omits both organization representations', () => {
    const h = buildAttributionHeaders({ ...analytics, routingUnproven: true, subscriptionType: 'unknown' }).headers;
    expect(h).not.toHaveProperty('X-CodeMie-Organization');
    expect(h).not.toHaveProperty('X-CodeMie-Organization-Encoded');
  });

  it('preserves absent/sentinel session handling and raw-project validation in model mode', () => {
    const h = buildAttributionHeaders({ destination: 'model', requestId: 'r', sessionId: 'unknown', project: 'Проект' }).headers;
    expect(h).not.toHaveProperty('X-CodeMie-Session-ID');
    expect(h).not.toHaveProperty('X-CodeMie-Project');
  });

  it('the actual model interceptor preserves provider metadata, static attribution and existing headers', async () => {
    vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ customProperties: { requiresIntegration: true } } as never);
    const interceptor = await new HeaderInjectionPlugin().createInterceptor({ config: {
      provider: 'provider', clientType: 'codemie-codex', version: '1.2', integrationId: 'integration',
      model: 'model', timeout: 30, repository: 'org/репо', branch: 'feature/ветка', project: 'project',
    } } as PluginContext);
    const request = context();
    request.headers['custom-header'] = 'keep';
    await interceptor.onRequest!(request);
    expect(request.headers).toEqual({
      'custom-header': 'keep', 'X-CodeMie-Request-ID': 'r1', 'X-CodeMie-Session-ID': 's1',
      'x-litellm-session-id': 's1', 'X-CodeMie-CLI': 'codemie-cli/1.2',
      'X-CodeMie-Integration': 'integration', 'X-CodeMie-CLI-Model': 'model',
      'X-CodeMie-CLI-Timeout': '30', 'X-CodeMie-Client': 'codemie-codex',
      'X-CodeMie-Repository': 'org/%D1%80%D0%B5%D0%BF%D0%BE',
      'X-CodeMie-Branch': 'feature/%D0%B2%D0%B5%D1%82%D0%BA%D0%B0', 'X-CodeMie-Project': 'project',
    });
  });

  it('preserves Desktop/Cowork resolution and configured-branch precedence', async () => {
    const resolveForRequest = vi.fn().mockResolvedValue({ repository: '', branch: 'detected', isCowork: true });
    const interceptor = await new HeaderInjectionPlugin().createInterceptor({ config: {
      desktopRepositoryResolver: { resolveForRequest }, branch: 'configured', clientType: 'codemie-codex',
    } } as unknown as PluginContext);
    const request = context();
    request.remotePort = 123;
    request.headers['x-claude-code-session-id'] = 'desktop-session';
    await interceptor.onRequest!(request);
    expect(resolveForRequest).toHaveBeenCalledWith('desktop-session', { remotePort: 123, url: '/v1/messages' });
    expect(request.headers).toMatchObject({
      'X-CodeMie-Repository': '', 'X-CodeMie-Branch': 'configured', 'X-CodeMie-Client': 'claude-desktop',
      'x-litellm-session-id': 's1',
    });
  });
});
