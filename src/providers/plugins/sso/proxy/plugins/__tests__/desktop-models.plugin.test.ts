/**
 * DesktopModelsPlugin Tests
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

const { fetchCodeMieLlmModels } = vi.hoisted(() => ({ fetchCodeMieLlmModels: vi.fn() }));
vi.mock('../../../sso.http-client.js', () => ({ fetchCodeMieLlmModels }));

import { DesktopModelsPlugin, isModelsListRequest } from '../desktop-models.plugin.js';

const CLAUDE_TIERS = {
  simple: { model: 'claude-haiku-5-5' },
  medium: { model: 'claude-haiku-5-5' },
  complex: { model: 'claude-sonnet-5' },
  reasoning: { model: 'claude-sonnet-5' },
};

function makePluginContext(
  overrides: { clientType?: string; project?: string; credentials?: object | null } = {}
): PluginContext {
  const credentials = overrides.credentials === undefined
    ? { cookies: { session: 'c' }, apiUrl: 'https://codemie.example.com/code-assistant-api' }
    : overrides.credentials;
  return {
    config: {
      targetApiUrl: 'https://codemie.example.com/code-assistant-api',
      clientType: overrides.clientType ?? 'claude-desktop',
      project: overrides.project,
    },
    logger,
    ...(credentials ? { credentialRefresher: { refresh: vi.fn().mockResolvedValue(credentials) } as any } : {}),
  };
}

function makeProxyContext(method: string, url: string): ProxyContext {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentName: 'claude-desktop',
    method,
    url,
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: { gatewayKeyValidated: true },
  };
}

function makeMockRes() {
  let body = '';
  let statusCode = 200;
  return {
    res: {
      setHeader: vi.fn(),
      end: vi.fn((data: string) => { body = data; }),
      get statusCode() { return statusCode; },
      set statusCode(v: number) { statusCode = v; },
    } as any,
    json: () => JSON.parse(body),
    status: () => statusCode,
  };
}

describe('isModelsListRequest', () => {
  it.each([
    ['GET', '/v1/models', true],
    ['GET', '/v1/models?limit=1000', true],
    ['GET', '/v1/models?limit=1000&after_id=claude-sonnet-5', true],
    ['GET', '/v1/models/', true],
    ['GET', '/v1/models/claude-sonnet-5', false],
    ['POST', '/v1/models', false],
    ['GET', '/v1/llm_models?include_all=true', false],
  ])('%s %s → %s', (method, url, expected) => {
    expect(isModelsListRequest(method, url)).toBe(expected);
  });
});

describe('DesktopModelsPlugin', () => {
  const plugin = new DesktopModelsPlugin();

  beforeEach(() => {
    fetchCodeMieLlmModels.mockReset();
  });

  it('runs right after the gateway key check (priority 8, after 7)', () => {
    expect(plugin.priority).toBe(8);
  });

  it('is disabled for every client but Claude Desktop', async () => {
    await expect(plugin.createInterceptor(makePluginContext({ clientType: 'codemie-daemon' })))
      .rejects.toThrow('Plugin disabled');
  });

  it('leaves every other request to the normal pipeline', async () => {
    const interceptor = await plugin.createInterceptor(makePluginContext());
    const { res } = makeMockRes();
    expect(await interceptor.handleRequest!(makeProxyContext('POST', '/v1/messages'), {} as any, res, {} as any))
      .toBe(false);
    expect(fetchCodeMieLlmModels).not.toHaveBeenCalled();
  });

  it('answers with the project\'s curated Claude models in the Anthropic Models API shape', async () => {
    fetchCodeMieLlmModels.mockResolvedValue([
      { base_name: 'claude-opus-5', label: 'Bedrock Claude Opus 5', enabled: true },
      { base_name: 'claude-opus-5-5', label: 'Bedrock Claude Opus 5.5', enabled: true },
      { base_name: 'gpt-5', label: 'GPT-5', enabled: true },
      { base_name: 'sy-signal-claude-v1', label: 'SY Signal Claude v1', is_router: true, tiers: CLAUDE_TIERS },
    ]);
    const interceptor = await plugin.createInterceptor(makePluginContext({ project: 'cli-only-check' }));
    const { res, json, status } = makeMockRes();

    const handled = await interceptor.handleRequest!(
      makeProxyContext('GET', '/v1/models?limit=1000'), {} as any, res, {} as any
    );

    expect(handled).toBe(true);
    expect(fetchCodeMieLlmModels).toHaveBeenCalledWith(
      'https://codemie.example.com/code-assistant-api', { session: 'c' }, 'cli-only-check'
    );
    expect(status()).toBe(200);
    expect(json()).toEqual({
      data: [
        { type: 'model', id: 'claude-opus-5-5', display_name: 'Bedrock Claude Opus 5.5', created_at: '1970-01-01T00:00:00Z' },
        { type: 'model', id: 'sy-signal-claude-v1', display_name: 'SY Signal Claude v1', created_at: '1970-01-01T00:00:00Z' },
      ],
      has_more: false,
      first_id: 'claude-opus-5-5',
      last_id: 'sy-signal-claude-v1',
    });
  });

  it('reads the catalog with a JWT token when the daemon runs on one', async () => {
    fetchCodeMieLlmModels.mockResolvedValue([]);
    const interceptor = await plugin.createInterceptor(makePluginContext({
      credentials: { token: 'jwt-token', apiUrl: 'https://codemie.example.com/code-assistant-api' },
    }));
    const { res, json } = makeMockRes();

    await interceptor.handleRequest!(makeProxyContext('GET', '/v1/models'), {} as any, res, {} as any);

    expect(fetchCodeMieLlmModels).toHaveBeenCalledWith(
      'https://codemie.example.com/code-assistant-api', 'jwt-token', undefined
    );
    expect(json()).toEqual({ data: [], has_more: false, first_id: null, last_id: null });
  });

  it('answers 502, not 401, when the catalog cannot be read, so Desktop retries', async () => {
    fetchCodeMieLlmModels.mockRejectedValue(new Error('project "gone" was not found'));
    const interceptor = await plugin.createInterceptor(makePluginContext({ project: 'gone' }));
    const { res, json, status } = makeMockRes();

    expect(await interceptor.handleRequest!(makeProxyContext('GET', '/v1/models'), {} as any, res, {} as any))
      .toBe(true);
    expect(status()).toBe(502);
    expect(json().error.message).toContain('project "gone" was not found');
  });

  it('answers 502 when the daemon has no CodeMie credentials', async () => {
    const interceptor = await plugin.createInterceptor(makePluginContext({ credentials: null }));
    const { res, status } = makeMockRes();

    await interceptor.handleRequest!(makeProxyContext('GET', '/v1/models'), {} as any, res, {} as any);

    expect(status()).toBe(502);
    expect(fetchCodeMieLlmModels).not.toHaveBeenCalled();
  });
});
