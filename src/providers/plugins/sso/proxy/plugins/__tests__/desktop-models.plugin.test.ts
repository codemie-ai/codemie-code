/**
 * DesktopModelsPlugin Tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

const { fetchCodeMieLlmModels, getProfile } = vi.hoisted(() => ({ fetchCodeMieLlmModels: vi.fn(), getProfile: vi.fn() }));
vi.mock('../../../sso.http-client.js', () => ({ fetchCodeMieLlmModels }));
// The plugin reads the daemon profile's extra models through ConfigLoader.
vi.mock('../../../../../../utils/config.js', () => ({ ConfigLoader: { getProfile } }));

import { DesktopModelsPlugin, isModelsListRequest } from '../desktop-models.plugin.js';
import { desktopExtraModelAlias } from '../../../sso.desktop-models.js';

const CLAUDE_TIERS = {
  simple: { model: 'claude-haiku-5-5' },
  medium: { model: 'claude-haiku-5-5' },
  complex: { model: 'claude-sonnet-5' },
  reasoning: { model: 'claude-sonnet-5' },
};

function makePluginContext(
  overrides: { clientType?: string; project?: string; profile?: string; credentials?: object | null } = {}
): PluginContext {
  const credentials = overrides.credentials === undefined
    ? { cookies: { session: 'c' }, apiUrl: 'https://codemie.example.com/code-assistant-api' }
    : overrides.credentials;
  return {
    config: {
      targetApiUrl: 'https://codemie.example.com/code-assistant-api',
      clientType: overrides.clientType ?? 'claude-desktop',
      project: overrides.project,
      profile: overrides.profile,
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

  it('runs right after the client attribution (priority 9, after 8)', () => {
    expect(plugin.priority).toBe(9);
  });

  it('declares exactly Claude Desktop and the VS Code Claude Code extension', () => {
    expect(plugin.clients).toEqual(['claude-desktop', 'vscode-claude-code']);
  });

  it('leaves every other request to the normal pipeline', async () => {
    const interceptor = await plugin.createInterceptor(makePluginContext());
    const { res } = makeMockRes();
    expect(await interceptor.handleRequest!(makeProxyContext('POST', '/v1/messages'), {} as any, res, {} as any))
      .toBe(false);
    expect(fetchCodeMieLlmModels).not.toHaveBeenCalled();
  });

  it('answers with every Claude model the project allows in the Anthropic Models API shape', async () => {
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
        { type: 'model', id: 'claude-opus-5', display_name: 'Bedrock Claude Opus 5', created_at: '1970-01-01T00:00:00Z' },
      ],
      has_more: false,
      first_id: 'claude-opus-5-5',
      last_id: 'claude-opus-5',
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

describe('DesktopModelsPlugin — extra models of the profile', () => {
  const plugin = new DesktopModelsPlugin();
  const grokAlias = desktopExtraModelAlias('grok-4.6');

  function messagesContext(body: unknown): ProxyContext {
    const ctx = makeProxyContext('POST', '/v1/messages');
    ctx.headers = { 'content-type': 'application/json' };
    ctx.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
    return ctx;
  }

  beforeEach(() => {
    fetchCodeMieLlmModels.mockReset();
    getProfile.mockReset().mockResolvedValue({ claudeExtraModels: ['grok-4.6'] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists a selected non-Claude model under its claude-x- alias with its real name', async () => {
    fetchCodeMieLlmModels.mockResolvedValue([
      { base_name: 'claude-router-standard', label: 'Claude Router Standard v1', is_router: true, tiers: CLAUDE_TIERS },
      { base_name: 'grok-4.6', deployment_name: 'grok-4.6', label: 'Grok 4.6', enabled: true },
      { base_name: 'gemini-3.1-pro', deployment_name: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', enabled: true },
    ]);
    const interceptor = await plugin.createInterceptor(makePluginContext({ project: 'router-demo', profile: 'router-demo' }));
    const { res, json } = makeMockRes();

    await interceptor.handleRequest!(makeProxyContext('GET', '/v1/models'), {} as any, res, {} as any);

    expect(getProfile).toHaveBeenCalledWith('router-demo');
    expect(json().data.map((m: { id: string; display_name?: string }) => [m.id, m.display_name])).toEqual([
      ['claude-router-standard', 'Claude Router Standard v1'],
      [grokAlias, 'Grok 4.6'],
    ]);
  });

  it('lists no extra model when the profile cannot be read', async () => {
    getProfile.mockRejectedValue(new Error('unreadable'));
    fetchCodeMieLlmModels.mockResolvedValue([
      { base_name: 'grok-4.6', deployment_name: 'grok-4.6', label: 'Grok 4.6', enabled: true },
    ]);
    const interceptor = await plugin.createInterceptor(makePluginContext({ profile: 'router-demo' }));
    const { res, json } = makeMockRes();

    await interceptor.handleRequest!(makeProxyContext('GET', '/v1/models'), {} as any, res, {} as any);

    expect(json().data).toEqual([]);
  });

  it('maps the alias in a request back to the real model and fixes content-length', async () => {
    const interceptor = await plugin.createInterceptor(makePluginContext({ profile: 'router-demo' }));
    const ctx = messagesContext({ model: grokAlias, max_tokens: 10, messages: [] });

    await interceptor.onRequest!(ctx);

    const body = JSON.parse(ctx.requestBody!.toString('utf-8'));
    expect(body).toEqual({ model: 'grok-4.6', max_tokens: 10, messages: [] });
    expect(ctx.headers['content-length']).toBe(String(ctx.requestBody!.length));
  });

  it('leaves a Claude model request untouched without reading the profile', async () => {
    const interceptor = await plugin.createInterceptor(makePluginContext({ profile: 'router-demo' }));
    const ctx = messagesContext({ model: 'claude-router-standard', messages: [] });
    const before = ctx.requestBody;

    await interceptor.onRequest!(ctx);

    expect(ctx.requestBody).toBe(before);
    expect(getProfile).not.toHaveBeenCalled();
  });

  it('passes an alias the profile no longer lists through unchanged, with a warning', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const interceptor = await plugin.createInterceptor(makePluginContext({ profile: 'router-demo' }));
    const stale = desktopExtraModelAlias('gemini-3.1-pro');
    const ctx = messagesContext({ model: stale, messages: [] });

    await interceptor.onRequest!(ctx);

    expect(JSON.parse(ctx.requestBody!.toString('utf-8')).model).toBe(stale);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown model alias'));
  });

  it('ignores a body that is not JSON', async () => {
    const interceptor = await plugin.createInterceptor(makePluginContext({ profile: 'router-demo' }));
    const ctx = makeProxyContext('POST', '/v1/messages');
    ctx.headers = { 'content-type': 'application/json' };
    ctx.requestBody = Buffer.from('not json', 'utf-8');

    await interceptor.onRequest!(ctx);

    expect(ctx.requestBody.toString('utf-8')).toBe('not json');
  });
});
