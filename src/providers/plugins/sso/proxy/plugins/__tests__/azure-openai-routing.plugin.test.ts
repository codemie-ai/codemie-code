import { describe, expect, it } from 'vitest';
import { logger } from '../../../../../../utils/logger.js';
import type { ProxyContext } from '../../proxy-types.js';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import { AzureOpenAIRoutingPlugin } from '../azure-openai-routing.plugin.js';

function createPluginContext(provider = 'azure-openai'): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://resource.example.test/code-assistant-api',
      provider,
      clientType: 'codemie-code',
      model: 'profile-deployment',
    },
    logger,
    profileConfig: {
      provider: 'azure-openai',
      baseUrl: 'https://resource.example.test/code-assistant-api',
      apiKey: 'PLACEHOLDER-KEY-FOR-TESTING-ONLY',
      model: 'profile-deployment',
      azureApiVersion: '2025-04-01-preview',
    },
  };
}

function createRequest(
  url: string,
  model?: string,
  headers: Record<string, string> = {
    authorization: 'Bearer proxy-token',
    'content-type': 'application/json',
  },
): ProxyContext {
  return {
    requestId: 'request-id',
    sessionId: 'session-id',
    agentName: 'codemie-code',
    method: model ? 'POST' : 'GET',
    url,
    headers,
    requestBody: model ? Buffer.from(JSON.stringify({ model }), 'utf-8') : null,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

async function createInterceptor(provider = 'azure-openai'): Promise<ProxyInterceptor> {
  return new AzureOpenAIRoutingPlugin().createInterceptor(createPluginContext(provider));
}

describe('AzureOpenAIRoutingPlugin', () => {
  it('routes chat requests to the selected deployment and preserves endpoint prefix', async () => {
    const interceptor = await createInterceptor();
    const context = createRequest('/v1/chat/completions?stream=true', 'deployment-b');

    await interceptor.onRequest?.(context);

    expect(context.targetUrl).toBe(
      'https://resource.example.test/code-assistant-api/openai/deployments/deployment-b/chat/completions?stream=true&api-version=2025-04-01-preview',
    );
    expect(context.headers['api-key']).toBe('PLACEHOLDER-KEY-FOR-TESTING-ONLY');
    expect(context.headers.authorization).toBeUndefined();
  });

  it('uses the profile deployment when the request does not contain a model', async () => {
    const interceptor = await createInterceptor();
    const context = createRequest('/v1/chat/completions', undefined, {
      'content-type': 'application/json',
    });

    await interceptor.onRequest?.(context);

    expect(context.targetUrl).toBe(
      'https://resource.example.test/code-assistant-api/openai/deployments/profile-deployment/chat/completions?api-version=2025-04-01-preview',
    );
  });

  it('routes model discovery to the classic Azure deployments endpoint', async () => {
    const interceptor = await createInterceptor();
    const context = createRequest('/v1/models?limit=10');

    await interceptor.onRequest?.(context);

    expect(context.targetUrl).toBe(
      'https://resource.example.test/code-assistant-api/openai/deployments?limit=10&api-version=2025-04-01-preview',
    );
  });

  it('does not activate for another provider', async () => {
    const interceptor = await createInterceptor('litellm');
    const context = createRequest('/v1/chat/completions', 'deployment-b');

    await interceptor.onRequest?.(context);

    expect(context.targetUrl).toBeUndefined();
    expect(context.headers.authorization).toBe('Bearer proxy-token');
  });
});
