import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoonshotSubscriptionTemplate } from '../moonshot-subscription.template.js';
import { KimiHookConfigInjector } from '../../../../agents/plugins/kimi/kimi.hook-config-injector.js';

const mockKimiHookConfigInjector = vi.mocked(KimiHookConfigInjector);

const { mockGetAgent, mockInject } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockInject: vi.fn(),
}));

vi.mock('../../../../agents/registry.js', () => ({
  AgentRegistry: { getAgent: mockGetAgent },
}));

vi.mock('../../../../agents/plugins/kimi/kimi.hook-config-injector.js', () => ({
  KimiHookConfigInjector: vi.fn(function () {
    return { inject: mockInject };
  }),
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

describe('MoonshotSubscriptionTemplate', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should require no authentication', () => {
    expect(MoonshotSubscriptionTemplate.requiresAuth).toBe(false);
    expect(MoonshotSubscriptionTemplate.authType).toBe('none');
  });

  it('should export CodeMie env vars with empty API key and optional analytics values', () => {
    const codeMieUrl = 'https://codemie.example.com';
    const codeMieProject = 'my-project';

    const env = MoonshotSubscriptionTemplate.exportEnvVars!({
      provider: 'moonshot-subscription',
      codeMieUrl,
      codeMieProject
    });

    expect(env.CODEMIE_API_KEY).toBe('');
    expect(env.CODEMIE_URL).toBe(codeMieUrl);
    expect(env.CODEMIE_SYNC_API_URL).toBe(`${codeMieUrl}/code-assistant-api`);
    expect(env.CODEMIE_PROJECT).toBe(codeMieProject);
  });

  it('should recommend at least one model', () => {
    expect(MoonshotSubscriptionTemplate.recommendedModels.length).toBeGreaterThan(0);
  });

  describe('agentHooks - beforeRun (*)', () => {
    beforeEach(() => {
      mockInject.mockResolvedValue({ success: true, created: true, configPath: '/mock/.kimi-code/config.toml' });
      mockKimiHookConfigInjector.mockImplementation(function () {
        return { inject: mockInject };
      });
      mockGetAgent.mockReturnValue({ name: 'kimi' });
    });

    it('strips Kimi model env vars and does not mutate the original env when agent is kimi', async () => {
      const env: Record<string, string> = {
        KIMI_MODEL_API_KEY: 'some-key',
        KIMI_MODEL_BASE_URL: 'http://localhost:1234',
        KIMI_MODEL_NAME: 'kimi-for-coding',
        OTHER_VAR: 'keep-me',
      };

      const hook = MoonshotSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'kimi' });

      expect(result.KIMI_MODEL_API_KEY).toBeUndefined();
      expect(result.KIMI_MODEL_BASE_URL).toBeUndefined();
      expect(result.KIMI_MODEL_NAME).toBeUndefined();
      expect(result.OTHER_VAR).toBe('keep-me');

      // Must not mutate the caller's object
      expect(env.KIMI_MODEL_API_KEY).toBe('some-key');
      expect(env.KIMI_MODEL_BASE_URL).toBe('http://localhost:1234');
      expect(env.KIMI_MODEL_NAME).toBe('kimi-for-coding');
    });

    it('returns env unchanged for non-kimi agents', async () => {
      const env: Record<string, string> = {
        KIMI_MODEL_API_KEY: 'some-key',
        OTHER_VAR: 'keep-me',
      };

      const hook = MoonshotSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'claude' });

      expect(result).toBe(env); // exact same reference — no copy created
      expect(result.KIMI_MODEL_API_KEY).toBe('some-key');
    });

    it('injects Kimi hooks when agent is kimi', async () => {
      const hook = MoonshotSubscriptionTemplate.agentHooks?.['*'];
      await hook!.beforeRun!({}, { agent: 'kimi' });

      expect(mockKimiHookConfigInjector).toHaveBeenCalledTimes(1);
      expect(mockInject).toHaveBeenCalledTimes(1);
    });

    it('strips vars and continues when agent is not in the registry', async () => {
      mockGetAgent.mockReturnValue(undefined);

      const env: Record<string, string> = { KIMI_MODEL_API_KEY: 'key' };
      const hook = MoonshotSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'kimi' });

      expect(result.KIMI_MODEL_API_KEY).toBeUndefined();
      expect(mockKimiHookConfigInjector).not.toHaveBeenCalled();
    });

    it('strips vars and continues when hook injection reports failure', async () => {
      mockInject.mockResolvedValue({ success: false, created: false, configPath: '/mock/.kimi-code/config.toml', error: 'disk full' });

      const env: Record<string, string> = { KIMI_MODEL_API_KEY: 'key' };
      const hook = MoonshotSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'kimi' });

      expect(result.KIMI_MODEL_API_KEY).toBeUndefined();
      expect(mockInject).toHaveBeenCalledTimes(1);
    });

    it('strips vars and does not throw when injector throws', async () => {
      mockInject.mockRejectedValue(new Error('ENOENT'));

      const env: Record<string, string> = { KIMI_MODEL_API_KEY: 'key' };
      const hook = MoonshotSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'kimi' });

      expect(result.KIMI_MODEL_API_KEY).toBeUndefined();
    });
  });
});
