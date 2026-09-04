import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicSubscriptionTemplate } from '../anthropic-subscription.template.js';

const { mockInstall, mockGetAgent } = vi.hoisted(() => ({
  mockInstall: vi.fn(),
  mockGetAgent: vi.fn(),
}));

vi.mock('../../../../agents/registry.js', () => ({
  AgentRegistry: { getAgent: mockGetAgent },
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

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

  it('recommends only the Sonnet family (not a pinned version)', () => {
    expect(AnthropicSubscriptionTemplate.recommendedModels).toEqual(['sonnet']);
  });

  describe('agentHooks - beforeRun (*)', () => {
    beforeEach(() => {
      mockInstall.mockResolvedValue({ success: true, targetPath: '/tmp/codemie-claude-plugin' });
      mockGetAgent.mockReturnValue({ getExtensionInstaller: () => ({ install: mockInstall }) });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('strips Anthropic auth vars and does not mutate the original env', async () => {
      const env: Record<string, string> = {
        ANTHROPIC_AUTH_TOKEN: 'some-token',
        ANTHROPIC_API_KEY: 'some-key',
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        OTHER_VAR: 'keep-me',
      };

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'claude' });

      expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(result.OTHER_VAR).toBe('keep-me');

      // Must not mutate the caller's object
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('some-token');
      expect(env.ANTHROPIC_API_KEY).toBe('some-key');
      expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:1234');
    });

    it('strips stale Anthropic model-tier env vars and does not mutate the original env', async () => {
      const env: Record<string, string> = {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-3-5-old',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-3-5-old',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-3-old',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-3-old',
        OTHER_VAR: 'keep-me',
      };

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'claude' });

      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      expect(result.OTHER_VAR).toBe('keep-me');

      // Must not mutate the caller's object
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-3-5-old');
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-3-5-old');
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-3-old');
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-opus-3-old');
    });

    it('sets CODEMIE_CLAUDE_EXTENSION_DIR when installer succeeds', async () => {
      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!({}, { agent: 'claude' });

      expect(result.CODEMIE_CLAUDE_EXTENSION_DIR).toBe('/tmp/codemie-claude-plugin');
    });

    it('returns env unchanged for non-Claude agents', async () => {
      const env: Record<string, string> = {
        ANTHROPIC_AUTH_TOKEN: 'some-token',
        OTHER_VAR: 'keep-me',
      };

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'gemini' });

      expect(result).toBe(env); // exact same reference — no copy created
    });

    it('strips vars and continues when agent is not in the registry', async () => {
      mockGetAgent.mockReturnValue(undefined);

      const env: Record<string, string> = { ANTHROPIC_API_KEY: 'key' };
      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'claude' });

      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.CODEMIE_CLAUDE_EXTENSION_DIR).toBeUndefined();
    });

    it('strips vars and continues when agent has no extension installer', async () => {
      mockGetAgent.mockReturnValue({ getExtensionInstaller: () => undefined });

      const env: Record<string, string> = { ANTHROPIC_API_KEY: 'key' };
      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'claude' });

      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.CODEMIE_CLAUDE_EXTENSION_DIR).toBeUndefined();
    });

    it('still sets CODEMIE_CLAUDE_EXTENSION_DIR when install reports failure', async () => {
      mockInstall.mockResolvedValue({ success: false, targetPath: '/tmp/codemie-claude-plugin', error: 'disk full' });

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!({}, { agent: 'claude' });

      expect(result.CODEMIE_CLAUDE_EXTENSION_DIR).toBe('/tmp/codemie-claude-plugin');
    });

    it('strips vars and does not throw when installer throws', async () => {
      mockInstall.mockRejectedValue(new Error('ENOENT'));

      const env: Record<string, string> = { ANTHROPIC_API_KEY: 'key' };
      const hook = AnthropicSubscriptionTemplate.agentHooks?.['*'];
      const result = await hook!.beforeRun!(env, { agent: 'claude' });

      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.CODEMIE_CLAUDE_EXTENSION_DIR).toBeUndefined();
    });
  });

  describe('agentHooks - enrichArgs (claude)', () => {
    const originalEnv = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
      } else {
        process.env.CODEMIE_CLAUDE_EXTENSION_DIR = originalEnv;
      }
    });

    it('prepends --plugin-dir when CODEMIE_CLAUDE_EXTENSION_DIR is set', () => {
      process.env.CODEMIE_CLAUDE_EXTENSION_DIR = '/tmp/codemie-claude-plugin';

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['claude'];
      const result = hook!.enrichArgs!(['--verbose'], { agent: 'claude' });

      expect(result).toEqual(['--plugin-dir', '/tmp/codemie-claude-plugin', '--verbose']);
    });

    it('returns args unchanged when CODEMIE_CLAUDE_EXTENSION_DIR is not set', () => {
      delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['claude'];
      const result = hook!.enrichArgs!(['--verbose'], { agent: 'claude' });

      expect(result).toEqual(['--verbose']);
    });

    it('does not inject --plugin-dir when it is already present in args', () => {
      process.env.CODEMIE_CLAUDE_EXTENSION_DIR = '/tmp/codemie-claude-plugin';

      const hook = AnthropicSubscriptionTemplate.agentHooks?.['claude'];
      const result = hook!.enrichArgs!(['--plugin-dir', '/custom/path', '--verbose'], { agent: 'claude' });

      expect(result).toEqual(['--plugin-dir', '/custom/path', '--verbose']);
    });
  });

  describe('agentHooks - enrichArgs (claude) --model passthrough', () => {
    beforeEach(() => {
      delete process.env.CODEMIE_CLI_MODEL;
      delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
    });
    afterEach(() => {
      delete process.env.CODEMIE_CLI_MODEL;
      delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
    });

    const enrich = (args: string[]): string[] => {
      const hook = AnthropicSubscriptionTemplate.agentHooks?.['claude'];
      return hook!.enrichArgs!(args, { agent: 'claude' });
    };

    it('injects --model when CODEMIE_CLI_MODEL is set', () => {
      process.env.CODEMIE_CLI_MODEL = 'claude-opus-4-5';
      expect(enrich(['--task', 'hi'])).toEqual(['--model', 'claude-opus-4-5', '--task', 'hi']);
    });

    it('injects nothing when CODEMIE_CLI_MODEL is unset', () => {
      expect(enrich(['--task', 'hi'])).toEqual(['--task', 'hi']);
    });

    it('does not double-inject when --model is already present', () => {
      process.env.CODEMIE_CLI_MODEL = 'claude-opus-4-5';
      expect(enrich(['--model', 'claude-haiku-4-5'])).toEqual(['--model', 'claude-haiku-4-5']);
    });

    it('does not double-inject when --model=value (equals form) is already present', () => {
      // Reachable only via raw passthrough after `--` (e.g. `-m X -- --model=Y`); the
      // guard must still recognise the equals form so the binary never gets two --model.
      process.env.CODEMIE_CLI_MODEL = 'claude-opus-4-5';
      expect(enrich(['--model=claude-haiku-4-5'])).toEqual(['--model=claude-haiku-4-5']);
    });

    it('composes with the --plugin-dir injection (plugin-dir first, then model)', () => {
      process.env.CODEMIE_CLI_MODEL = 'claude-opus-4-5';
      process.env.CODEMIE_CLAUDE_EXTENSION_DIR = '/ext';
      expect(enrich(['--task', 'hi'])).toEqual([
        '--plugin-dir', '/ext', '--model', 'claude-opus-4-5', '--task', 'hi'
      ]);
    });
  });

  describe('exportEnvVars', () => {
    it('always exports CODEMIE_API_KEY as empty string', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({} as any);
      expect(env.CODEMIE_API_KEY).toBe('');
    });

    it('always blanks CODEMIE_MODEL/HAIKU/SONNET/OPUS so the claude CLI uses its own defaults', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({
        model: 'claude-4-5-haiku',
        haikuModel: 'claude-haiku-4-5-20251001',
      } as any);

      expect(env.CODEMIE_MODEL).toBe('');
      expect(env.CODEMIE_HAIKU_MODEL).toBe('');
      expect(env.CODEMIE_SONNET_MODEL).toBe('');
      expect(env.CODEMIE_OPUS_MODEL).toBe('');
    });

    it('blanks model tiers regardless of what is configured (no alias normalization)', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({
        model: 'claude-opus-4-6',
        opusModel: 'claude-opus-4-6[1m]',
      } as any);

      expect(env.CODEMIE_MODEL).toBe('');
      expect(env.CODEMIE_OPUS_MODEL).toBe('');
    });

    it('blanks model tiers even when a current, non-legacy model is configured', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({
        model: 'claude-sonnet-4-6',
        haikuModel: 'claude-haiku-4-5-20251001',
        opusModel: 'claude-opus-4-7',
      } as any);

      expect(env.CODEMIE_MODEL).toBe('');
      expect(env.CODEMIE_HAIKU_MODEL).toBe('');
      expect(env.CODEMIE_OPUS_MODEL).toBe('');
    });

    it('exports CODEMIE_URL and CODEMIE_SYNC_API_URL when codeMieUrl is set', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({ codeMieUrl: 'https://codemie.example.com' } as any);

      expect(env.CODEMIE_URL).toBe('https://codemie.example.com');
      expect(env.CODEMIE_SYNC_API_URL).toContain('code-assistant-api');
    });

    it('exports CODEMIE_PROJECT when codeMieProject is set', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({
        codeMieUrl: 'https://codemie.example.com',
        codeMieProject: 'my-project',
      } as any);

      expect(env.CODEMIE_PROJECT).toBe('my-project');
    });

    it('omits CODEMIE_URL and CODEMIE_PROJECT when not configured', () => {
      const env = AnthropicSubscriptionTemplate.exportEnvVars!({} as any);

      expect(env.CODEMIE_URL).toBeUndefined();
      expect(env.CODEMIE_PROJECT).toBeUndefined();
    });
  });
});
