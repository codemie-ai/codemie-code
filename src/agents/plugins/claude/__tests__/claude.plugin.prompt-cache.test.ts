/**
 * Tests for the Claude plugin's prompt-cache environment setup.
 *
 * CodeMie asks Claude Code for the 1-hour prompt-cache TTL (`ENABLE_PROMPT_CACHING_1H=1`) instead
 * of the upstream 5-minute default, on every provider that runs the agent's default `beforeRun`.
 * A non-empty value set by the user is kept as is, whatever it says.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudePluginMetadata } from '../claude.plugin.js';
import { claudeCacheDefaults } from '../prompt-cache.js';

vi.mock('fs/promises');
vi.mock('fs');

describe('ClaudePluginMetadata.lifecycle.beforeRun — prompt-cache env', () => {
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

  it.each(['ai-run-sso', 'litellm', 'ollama'])('requests the 1h cache TTL on %s', async (provider) => {
    const env = await runBeforeRun({ CODEMIE_PROVIDER: provider });
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe('1');
  });

  it.each(['0', 'true'])('keeps an explicit shell value %s', async (value) => {
    const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso', ENABLE_PROMPT_CACHING_1H: value });
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe(value);
  });

  it('treats an empty value as unset', async () => {
    const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso', ENABLE_PROMPT_CACHING_1H: '' });
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe('1');
  });

  it('never injects CLAUDE_CODE_PROMPT_CACHE_TTL', async () => {
    const env = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' });
    expect(env).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL');
  });
});

describe('claudeCacheDefaults', () => {
  it('returns nothing when both variables are already set', () => {
    expect(
      claudeCacheDefaults({
        CODEMIE_PROVIDER: 'ai-run-sso',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        ENABLE_PROMPT_CACHING_1H: '0',
      })
    ).toEqual({});
  });

  it.each(['ai-run-sso', 'litellm'])('allows experimental betas on the verified provider %s', (provider) => {
    expect(claudeCacheDefaults({ CODEMIE_PROVIDER: provider })).toEqual({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0',
      ENABLE_PROMPT_CACHING_1H: '1',
    });
  });

  it.each(['ollama', 'bedrock', undefined])('keeps experimental betas off for %s', (provider) => {
    expect(claudeCacheDefaults({ CODEMIE_PROVIDER: provider })).toEqual({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      ENABLE_PROMPT_CACHING_1H: '1',
    });
  });

  it('fills only the variable that is empty or unset', () => {
    expect(claudeCacheDefaults({ CODEMIE_PROVIDER: 'ai-run-sso', ENABLE_PROMPT_CACHING_1H: 'true' })).toEqual({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0',
    });
    expect(claudeCacheDefaults({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '', ENABLE_PROMPT_CACHING_1H: '1' })).toEqual({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    });
  });
});
