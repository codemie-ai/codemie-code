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
 * Both are scoped to providers whose gateway is known to round-trip the tool-search payload. A
 * gateway that receives `tool_reference` blocks it cannot carry answers HTTP 400 rather than
 * degrading, so an unverified provider keeps the conservative values.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudePluginMetadata } from '../claude.plugin.js';

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
    env: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    await ClaudePluginMetadata.lifecycle?.beforeRun?.(env as never);
    return env;
  }

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
    it.each(['bedrock', 'ollama', 'anthropic-subscription', 'bearer-auth'])(
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
