/**
 * Tests for the Claude plugin's tool-search environment setup.
 *
 * Tool search defers MCP/deferrable tool definitions instead of loading them upfront, which removes
 * a large fixed cost from every turn (measured 44,396 -> 24,353 turn-one tokens). Reaching it takes
 * two variables, because three independent gates each switch it off:
 *
 *   1. ENABLE_TOOL_SEARCH=0 — CodeMie's own pre-2.1.69 workaround.
 *   2. CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 — a hard override; while set, upstream never even
 *      consults ENABLE_TOOL_SEARCH, so flipping only that one does nothing.
 *   3. Claude Code self-disables tool search behind any non-first-party ANTHROPIC_BASE_URL, which
 *      CodeMie always is, so it must be forced rather than left unset.
 *
 * Claude's default hook sets the conservative, gateway-safe values for every provider: a gateway
 * that receives `tool_reference` blocks it cannot carry answers HTTP 400 rather than degrading.
 * A provider whose connection does carry the payload declares the permissive values for the agent
 * in its own `agentHooks.<agent>.env` (sso, litellm, anthropic-subscription). These tests run the
 * launch order: provider env first (only where unset), then Claude's default `beforeRun`.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudePluginMetadata } from '../claude.plugin.js';
import { applyProviderAgentEnv } from '@/agents/core/launch-env.js';
// Registers the real provider templates, with their declared agent env.
import '@/providers/plugins/sso/sso.template.js';
import '@/providers/plugins/litellm/litellm.template.js';
import '@/providers/plugins/anthropic-subscription/anthropic-subscription.template.js';
import '@/providers/plugins/bedrock/bedrock.template.js';
import '@/providers/plugins/ollama/ollama.template.js';
import '@/providers/plugins/jwt/jwt.template.js';

vi.mock('fs/promises');
vi.mock('fs');

describe('ClaudePluginMetadata.lifecycle.beforeRun — tool-search env', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runBeforeRun(
    env: Record<string, string> = {},
    agentName = 'claude'
  ): Promise<Record<string, string>> {
    applyProviderAgentEnv(env, agentName);
    await ClaudePluginMetadata.lifecycle?.beforeRun?.(env as never);
    return env;
  }

  describe('on a provider that declares tool search for the agent', () => {
    it.each(['ai-run-sso', 'litellm', 'anthropic-subscription'])('%s enables tool search and allows betas', async (provider) => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: provider });
      expect(env.ENABLE_TOOL_SEARCH).toBe('true');
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('0');
    });

    it.each(['ai-run-sso', 'litellm', 'anthropic-subscription'])('%s declares the same for claude-acp', async (provider) => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: provider }, 'claude-acp');
      expect(env.ENABLE_TOOL_SEARCH).toBe('true');
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('0');
    });

    it('only ai-run-sso turns the auto mode server review off', async () => {
      expect((await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' })).CLAUDE_CODE_AUTO_MODE_SERVER).toBe('0');
      for (const provider of ['litellm', 'anthropic-subscription', 'bedrock', 'ollama', 'bearer-auth']) {
        expect((await runBeforeRun({ CODEMIE_PROVIDER: provider })).CLAUDE_CODE_AUTO_MODE_SERVER, provider).toBeUndefined();
      }
    });
  });

  describe('on a verified provider', () => {
    it('enables tool search on the CodeMie SSO proxy', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' });
      expect(env.ENABLE_TOOL_SEARCH).toBe('true');
    });

    it('allows experimental betas, without which the tool-search beta header is suppressed', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' });
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('0');
    });

    it('enables tool search on litellm too', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'litellm' });
      expect(env.ENABLE_TOOL_SEARCH).toBe('true');
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('0');
    });

    it('never writes an empty string, which the `!env.X` guard would treat as unset', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' });
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).not.toBe('');
      expect(env.ENABLE_TOOL_SEARCH).not.toBe('');
    });
  });

  describe('on an unverified provider', () => {
    it.each(['bedrock', 'ollama', 'bearer-auth'])(
      'keeps tool search and betas off for %s, whose gateway may reject tool_reference blocks',
      async (provider) => {
        const env = await runBeforeRun({ CODEMIE_PROVIDER: provider });
        expect(env.ENABLE_TOOL_SEARCH).toBe('0');
        expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
      }
    );

    it('stays conservative when no provider is set at all', async () => {
      const env = await runBeforeRun();
      expect(env.ENABLE_TOOL_SEARCH).toBe('0');
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    });
  });

  describe('explicit user values win everywhere', () => {
    it('does not override an explicit ENABLE_TOOL_SEARCH opt-out on a verified provider', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso', ENABLE_TOOL_SEARCH: '0' });
      expect(env.ENABLE_TOOL_SEARCH).toBe('0');
    });

    it('does not override an explicit ENABLE_TOOL_SEARCH opt-in on an unverified provider', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'bedrock', ENABLE_TOOL_SEARCH: 'true' });
      expect(env.ENABLE_TOOL_SEARCH).toBe('true');
    });

    it('preserves an explicit auto:N threshold rather than forcing true', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso', ENABLE_TOOL_SEARCH: 'auto:5' });
      expect(env.ENABLE_TOOL_SEARCH).toBe('auto:5');
    });

    it('does not override an explicit CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS opt-out', async () => {
      const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' });
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    });
  });
});
