import { describe, expect, it } from 'vitest';
import { AnthropicSubscriptionTemplate } from '../anthropic-subscription.template.js';

describe('AnthropicSubscriptionTemplate', () => {
  it('has the correct provider name', () => {
    expect(AnthropicSubscriptionTemplate.name).toBe('anthropic-subscription');
  });

  it('requires no API key (authType none)', () => {
    expect(AnthropicSubscriptionTemplate.requiresAuth).toBe(false);
    expect(AnthropicSubscriptionTemplate.authType).toBe('none');
  });

  it('points to the Anthropic API base URL', () => {
    expect(AnthropicSubscriptionTemplate.defaultBaseUrl).toBe('https://api.anthropic.com');
  });

  it('includes recommended Claude models', () => {
    expect(AnthropicSubscriptionTemplate.recommendedModels).toContain('claude-sonnet-4-6');
    expect(AnthropicSubscriptionTemplate.recommendedModels.length).toBeGreaterThan(0);
  });

  describe('agentHooks - claude beforeRun', () => {
    it('removes ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY from env', async () => {
      const env: Record<string, string> = {
        ANTHROPIC_AUTH_TOKEN: 'some-token',
        ANTHROPIC_API_KEY: 'some-key',
        OTHER_VAR: 'keep-me'
      };

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['claude'];
      expect(hook).toBeDefined();

      const result = await hook!.beforeRun!(env);

      expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.OTHER_VAR).toBe('keep-me');
    });

    it('is a no-op when auth vars are not set', async () => {
      const env: Record<string, string> = { SOME_VAR: 'value' };

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['claude'];
      const result = await hook!.beforeRun!(env);

      expect(result).toEqual({ SOME_VAR: 'value' });
    });
  });

  describe('exportEnvVars', () => {
    it('exports CODEMIE_API_KEY as empty string', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({} as any);

      expect(env.CODEMIE_API_KEY).toBe('');
    });

    it('exports CODEMIE_URL and CODEMIE_SYNC_API_URL when codeMieUrl is set', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({
        codeMieUrl: 'https://codemie.example.com'
      } as any);

      expect(env.CODEMIE_URL).toBe('https://codemie.example.com');
      expect(env.CODEMIE_SYNC_API_URL).toContain('code-assistant-api');
    });

    it('exports CODEMIE_PROJECT when codeMieProject is set', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({
        codeMieUrl: 'https://codemie.example.com',
        codeMieProject: 'my-project'
      } as any);

      expect(env.CODEMIE_PROJECT).toBe('my-project');
    });

    it('does not export CODEMIE_URL or CODEMIE_PROJECT when not configured', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({} as any);

      expect(env.CODEMIE_URL).toBeUndefined();
      expect(env.CODEMIE_PROJECT).toBeUndefined();
    });
  });
});
