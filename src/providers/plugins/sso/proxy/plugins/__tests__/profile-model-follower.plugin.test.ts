/**
 * Profile Model Follower Plugin Tests
 *
 * Verifies the mid-session model switch for Gemini CLI, GitHub Copilot CLI, Kimi Code and
 * OpenWiki: the plugin re-reads the active profile and rewrites a request that still names
 * the launch model to the profile's current active model.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileModelFollowerPlugin } from '../profile-model-follower.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

const { getProfileForModelSwitch } = vi.hoisted(() => ({ getProfileForModelSwitch: vi.fn() }));
vi.mock('../../../../../../utils/config.js', () => ({
  ConfigLoader: { getProfileForModelSwitch },
  resolveAgentModelSet: (profile: { agentModels?: Record<string, unknown> }, agent: string) =>
    profile.agentModels?.[agent],
}));

function createContext(clientType: string, model: string): PluginContext {
  return {
    config: { targetApiUrl: 'https://api.example.com', profile: 'my-test', clientType, model },
    logger,
    profileConfig: { agentModels: { placeholder: {} } } as never,
  };
}

function createProxyContext(url: string, body: Record<string, unknown> | null): ProxyContext {
  const requestBody = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
  return {
    requestId: 'req',
    sessionId: 'session',
    agentName: 'test-agent',
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(requestBody && { 'content-length': String(requestBody.length) }),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

async function createInterceptor(clientType: string, model: string): Promise<ProxyInterceptor> {
  return new ProfileModelFollowerPlugin().createInterceptor(createContext(clientType, model));
}

function mockActiveModel(agent: string, models: string[], activeModel: string): void {
  getProfileForModelSwitch.mockResolvedValue({ agentModels: { [agent]: { models, activeModel } } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProfileModelFollowerPlugin.createInterceptor', () => {
  it('is disabled for a client type it does not follow', async () => {
    await expect(
      new ProfileModelFollowerPlugin().createInterceptor(createContext('codemie-claude', 'claude-sonnet-5'))
    ).rejects.toThrow('Plugin disabled for agent');
  });

  it('is disabled when the profile has no agentModels (legacy profile)', async () => {
    const context = createContext('codemie-kimi', 'kimi-k2');
    context.profileConfig = {} as never;
    await expect(new ProfileModelFollowerPlugin().createInterceptor(context)).rejects.toThrow('Plugin disabled for agent');
  });
});

describe('ProfileModelFollowerPlugin body rewrite (Kimi, OpenWiki)', () => {
  it('leaves a request alone before any switch', async () => {
    mockActiveModel('kimi', ['kimi-k2'], 'kimi-k2');
    const interceptor = await createInterceptor('codemie-kimi', 'kimi-k2');

    const context = createProxyContext('/v1/chat/completions', { model: 'kimi-k2' });
    await interceptor.onRequest!(context);

    expect(JSON.parse(context.requestBody!.toString()).model).toBe('kimi-k2');
  });

  it('rewrites the model to the profile active model once switched', async () => {
    mockActiveModel('kimi', ['kimi-k2', 'kimi-k2.5'], 'kimi-k2.5');
    const interceptor = await createInterceptor('codemie-kimi', 'kimi-k2');

    const context = createProxyContext('/v1/chat/completions', { model: 'kimi-k2' });
    await interceptor.onRequest!(context);

    expect(JSON.parse(context.requestBody!.toString()).model).toBe('kimi-k2.5');
  });

  it('leaves a request naming a different model alone (the agent picked it itself)', async () => {
    mockActiveModel('openwiki', ['gpt-5-mini', 'gpt-4.1-mini'], 'gpt-4.1-mini');
    const interceptor = await createInterceptor('codemie-openwiki', 'gpt-5-mini');

    const context = createProxyContext('/v1/chat/completions', { model: 'some-other-model' });
    await interceptor.onRequest!(context);

    expect(JSON.parse(context.requestBody!.toString()).model).toBe('some-other-model');
  });

  it('keeps rewriting to the active model on every later request once switched', async () => {
    mockActiveModel('openwiki', ['a', 'b'], 'b');
    const interceptor = await createInterceptor('codemie-openwiki', 'a');

    await interceptor.onRequest!(createProxyContext('/x', { model: 'a' }));

    // A later turn that still names the launch model (e.g. a retried request) keeps
    // following, not just the one request right after the switch.
    const context = createProxyContext('/x', { model: 'a' });
    await interceptor.onRequest!(context);

    expect(JSON.parse(context.requestBody!.toString()).model).toBe('b');
  });

  it('keeps rewriting even after switching back to the launch model, once latched', async () => {
    vi.useFakeTimers();
    try {
      mockActiveModel('openwiki', ['a', 'b'], 'b');
      const interceptor = await createInterceptor('codemie-openwiki', 'a');
      await interceptor.onRequest!(createProxyContext('/x', { model: 'a' })); // latches "switched"

      mockActiveModel('openwiki', ['a', 'b'], 'a'); // switched back to the launch model
      await vi.advanceTimersByTimeAsync(1001); // past the profile re-read TTL

      const context = createProxyContext('/x', { model: 'a' });
      await interceptor.onRequest!(context);

      // Even though the active model is now the launch model again, the rewrite still
      // runs (a no-op here since both sides equal 'a') rather than being skipped as
      // "never switched" — proven by requiring a profile re-read to happen at all.
      expect(getProfileForModelSwitch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(context.requestBody!.toString()).model).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ProfileModelFollowerPlugin URL rewrite (Gemini)', () => {
  it('rewrites the streamGenerateContent path to the active model', async () => {
    mockActiveModel('gemini', ['gemini-a', 'gemini-b'], 'gemini-b');
    const interceptor = await createInterceptor('codemie-gemini', 'gemini-a');

    // Gemini CLI remaps the launch model name before sending, so the path carries a
    // different concrete id than launchModel; the rewrite matches by method, not name.
    const context = createProxyContext('/v1beta/models/gemini-a-remapped:streamGenerateContent?alt=sse', null);
    await interceptor.onRequest!(context);

    expect(context.url).toBe('/v1beta/models/gemini-b:streamGenerateContent?alt=sse');
  });

  it('leaves a non-streamGenerateContent (utility) call alone', async () => {
    mockActiveModel('gemini', ['gemini-a', 'gemini-b'], 'gemini-b');
    const interceptor = await createInterceptor('codemie-gemini', 'gemini-a');

    const context = createProxyContext('/v1beta/models/gemini-a:generateContent', null);
    await interceptor.onRequest!(context);

    expect(context.url).toBe('/v1beta/models/gemini-a:generateContent');
  });
});

describe('ProfileModelFollowerPlugin Copilot CLI cross-family guard', () => {
  it('does not switch across the Claude/GPT family boundary', async () => {
    mockActiveModel('copilot-cli', ['gpt-5', 'claude-sonnet-5'], 'claude-sonnet-5');
    const interceptor = await createInterceptor('codemie-copilot', 'gpt-5');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    const context = createProxyContext('/responses', { model: 'gpt-5' });
    await interceptor.onRequest!(context);

    expect(JSON.parse(context.requestBody!.toString()).model).toBe('gpt-5');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot change between Claude and GPT models'));
  });

  it('switches within the same family (Claude to Claude)', async () => {
    mockActiveModel('copilot-cli', ['claude-4-5-sonnet', 'claude-sonnet-5-5'], 'claude-sonnet-5-5');
    const interceptor = await createInterceptor('codemie-copilot', 'claude-4-5-sonnet');

    const context = createProxyContext('/responses', { model: 'claude-4-5-sonnet' });
    await interceptor.onRequest!(context);

    expect(JSON.parse(context.requestBody!.toString()).model).toBe('claude-sonnet-5-5');
  });
});

describe('ProfileModelFollowerPlugin profile re-read', () => {
  it('re-reads the profile at most once within the TTL window', async () => {
    mockActiveModel('kimi', ['kimi-k2', 'kimi-k2.5'], 'kimi-k2.5');
    const interceptor = await createInterceptor('codemie-kimi', 'kimi-k2');

    await interceptor.onRequest!(createProxyContext('/x', { model: 'kimi-k2' }));
    await interceptor.onRequest!(createProxyContext('/x', { model: 'kimi-k2.5' }));

    expect(getProfileForModelSwitch).toHaveBeenCalledTimes(1);
  });

  it('keeps the current model when the profile cannot be re-read', async () => {
    getProfileForModelSwitch.mockRejectedValue(new Error('config read failed'));
    const interceptor = await createInterceptor('codemie-kimi', 'kimi-k2');

    const context = createProxyContext('/x', { model: 'kimi-k2' });
    await interceptor.onRequest!(context);

    expect(JSON.parse(context.requestBody!.toString()).model).toBe('kimi-k2');
  });
});
