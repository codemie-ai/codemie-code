/**
 * Azure OpenAI Template — beforeRun hook tests
 *
 * Verifies the claude-specific beforeRun hook correctly configures Claude Code
 * for Azure / EPAM DIAL usage, including DIAL compatibility settings that
 * prevent HTTP 400 errors caused by Anthropic-native request fields.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import { AzureOpenAITemplate } from '../azure-openai.template.js';

/** Build a minimal env simulating what BaseAgentAdapter.transformEnvVars produces */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CODEMIE_PROVIDER: 'azure-openai',
    CODEMIE_BASE_URL: 'https://my-epam-dial.example.com',
    CODEMIE_AZURE_OPENAI_BASE_URL: 'https://my-epam-dial.example.com',
    CODEMIE_API_KEY: 'test-api-key-1234567890',
    CODEMIE_MODEL: 'anthropic.claude-sonnet-4-6',
    AZURE_OPENAI_API_KEY: 'test-api-key-1234567890', // set by wildcard hook first
    ANTHROPIC_BASE_URL: 'https://my-epam-dial.example.com',
    ANTHROPIC_AUTH_TOKEN: 'test-api-key-1234567890',
    ...overrides,
  };
}

/**
 * Invoke the claude-specific beforeRun hook directly.
 * The wildcard hook runs first in production but here we test the claude hook in isolation.
 */
async function runClaudeBeforeRunHook(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const claudeHook = AzureOpenAITemplate.agentHooks?.['claude']?.beforeRun;
  if (!claudeHook) {
    throw new Error('claude beforeRun hook not found in AzureOpenAITemplate');
  }
  return claudeHook(env, { agent: 'claude', agentDisplayName: 'Claude Code' } as any);
}

// ──────────────────────────────────────────────────────────────────────────────
describe('AzureOpenAITemplate — claude.beforeRun hook', () => {

  describe('Azure mode activation', () => {
    it('sets CLAUDE_CODE_USE_AZURE_OPENAI=1', async () => {
      const env = makeEnv();
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_CODE_USE_AZURE_OPENAI).toBe('1');
    });

    it('sets ANTHROPIC_BASE_URL to the Azure/DIAL endpoint', async () => {
      const env = makeEnv();
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ANTHROPIC_BASE_URL).toBe('https://my-epam-dial.example.com');
    });

    it('prefers CODEMIE_AZURE_OPENAI_BASE_URL over CODEMIE_BASE_URL for ANTHROPIC_BASE_URL', async () => {
      const env = makeEnv({
        CODEMIE_BASE_URL: 'http://localhost:3001', // proxy URL
        CODEMIE_AZURE_OPENAI_BASE_URL: 'https://real-dial-endpoint.example.com',
      });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ANTHROPIC_BASE_URL).toBe('https://real-dial-endpoint.example.com');
    });

    it('removes ANTHROPIC_AUTH_TOKEN to prevent Anthropic API auth attempt', async () => {
      const env = makeEnv({ ANTHROPIC_AUTH_TOKEN: 'should-be-removed' });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it('sets ANTHROPIC_MODEL to the deployment name from CODEMIE_MODEL', async () => {
      const env = makeEnv({ CODEMIE_MODEL: 'anthropic.claude-sonnet-4-6' });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ANTHROPIC_MODEL).toBe('anthropic.claude-sonnet-4-6');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('DIAL/Azure compatibility — cache_control prevention', () => {
    it('disables prompt caching (ENABLE_PROMPT_CACHING_1H=0) to prevent cache_control in requests', async () => {
      const env = makeEnv();
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ENABLE_PROMPT_CACHING_1H).toBe('0');
    });

    it('overrides ENABLE_PROMPT_CACHING_1H even if previously set to 1', async () => {
      const env = makeEnv({ ENABLE_PROMPT_CACHING_1H: '1' });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ENABLE_PROMPT_CACHING_1H).toBe('0');
    });

    it('disables experimental betas (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1) to prevent beta headers', async () => {
      const env = makeEnv();
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    });

    it('overrides CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS even if previously unset', async () => {
      const env = makeEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    });

    it('disables thinking-related features that DIAL rejects', async () => {
      const env = makeEnv({
        CLAUDE_CODE_DISABLE_THINKING: undefined,
        MAX_THINKING_TOKENS: undefined,
        DISABLE_INTERLEAVED_THINKING: undefined,
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: undefined,
      });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_CODE_DISABLE_THINKING).toBe('1');
      expect(result.MAX_THINKING_TOKENS).toBe('0');
      expect(result.DISABLE_INTERLEAVED_THINKING).toBe('1');
      expect(result.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe('1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('Claude Code essential defaults (re-applied because agent default hook is skipped)', () => {
    it('sets CLAUDE_CODE_ENABLE_TELEMETRY=0 when not already configured', async () => {
      const env = makeEnv({ CLAUDE_CODE_ENABLE_TELEMETRY: undefined });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('0');
    });

    it('does not override CLAUDE_CODE_ENABLE_TELEMETRY if user already set it', async () => {
      const env = makeEnv({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    });

    it('sets DISABLE_AUTOUPDATER=1 when not already configured', async () => {
      const env = makeEnv({ DISABLE_AUTOUPDATER: undefined });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.DISABLE_AUTOUPDATER).toBe('1');
    });

    it('does not override DISABLE_AUTOUPDATER if user already set it', async () => {
      const env = makeEnv({ DISABLE_AUTOUPDATER: '0' });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.DISABLE_AUTOUPDATER).toBe('0');
    });

    it('sets ENABLE_TOOL_SEARCH=0 when not already configured', async () => {
      const env = makeEnv({ ENABLE_TOOL_SEARCH: undefined });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ENABLE_TOOL_SEARCH).toBe('0');
    });

    it('sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 as default', async () => {
      const env = makeEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: undefined });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('80');
    });

    it('reads claudeAutocompactPct from CODEMIE_PROFILE_CONFIG when set', async () => {
      const env = makeEnv({
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: undefined,
        CODEMIE_PROFILE_CONFIG: JSON.stringify({ claudeAutocompactPct: 60 }),
      });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('60');
    });

    it('uses default autocompact 80 when CODEMIE_PROFILE_CONFIG is malformed JSON', async () => {
      const env = makeEnv({
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: undefined,
        CODEMIE_PROFILE_CONFIG: 'not-valid-json{{{',
      });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('80');
    });

    it('does not override CLAUDE_AUTOCOMPACT_PCT_OVERRIDE if already set', async () => {
      const env = makeEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50');
    });

    it('pins Anthropic family aliases to the active Azure deployment', async () => {
      const env = makeEnv({
        ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
        ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
        ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
        ANTHROPIC_DEFAULT_FABLE_MODEL: undefined,
        CLAUDE_CODE_SUBAGENT_MODEL: undefined,
      });
      const result = await runClaudeBeforeRunHook(env);
      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic.claude-sonnet-4-6');
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic.claude-sonnet-4-6');
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic.claude-sonnet-4-6');
      expect(result.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('anthropic.claude-sonnet-4-6');
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBe('inherit');
    });
  });
});
