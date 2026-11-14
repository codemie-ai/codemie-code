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
import { readFile } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { ClaudePluginMetadata } from '../claude.plugin.js';
import { claudeCacheDefaults } from '../prompt-cache.js';

const h = vi.hoisted(() => ({ resolverFails: false }));

vi.mock('fs/promises');
vi.mock('fs');

// The real resolver, with a switch to make it fail the way a broken settings read would.
vi.mock('../prompt-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt-cache.js')>();
  return {
    ...actual,
    resolvePromptCacheSetup: (input: Parameters<typeof actual.resolvePromptCacheSetup>[0]) =>
      h.resolverFails ? Promise.reject(new Error('settings exploded')) : actual.resolvePromptCacheSetup(input),
  };
});

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

describe('ClaudePluginMetadata.lifecycle.beforeRun — prompt-cache debug line', () => {
  const LINE = '[claude] prompt cache';
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    h.resolverFails = false;
    // No settings file anywhere: every layer is absent.
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runBeforeRun(env: Record<string, string>): Promise<Record<string, string>> {
    await ClaudePluginMetadata.lifecycle?.beforeRun?.(env as never);
    return env;
  }

  function cacheLines(): unknown[][] {
    return debug.mock.calls.filter((call: unknown[]) => call[0] === LINE);
  }

  it('logs one line naming the CodeMie default on ai-run-sso', async () => {
    await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' });

    expect(cacheLines()).toHaveLength(1);
    expect(cacheLines()[0][1]).toEqual({
      ttl: '1h',
      decidedBy: 'ENABLE_PROMPT_CACHING_1H',
      source: 'CodeMie default',
      confirmed: true,
      variables: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0', ENABLE_PROMPT_CACHING_1H: '1' },
    });
  });

  it('logs the shell as the source when FORCE_PROMPT_CACHING_5M is set', async () => {
    await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso', FORCE_PROMPT_CACHING_5M: '1' });

    expect(cacheLines()).toHaveLength(1);
    expect(cacheLines()[0][1]).toMatchObject({ ttl: '5m', decidedBy: 'FORCE_PROMPT_CACHING_5M', source: 'shell' });
  });

  it('still launches with the same environment when the resolver fails (Review Focus 4)', async () => {
    const logged = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' });

    h.resolverFails = true;
    debug.mockClear();
    const failed = await runBeforeRun({ CODEMIE_PROVIDER: 'ai-run-sso' });

    expect(failed).toEqual(logged);
    expect(failed.ENABLE_PROMPT_CACHING_1H).toBe('1');
    expect(cacheLines()).toHaveLength(1);
    expect(cacheLines()[0][1]).toEqual({ error: 'settings exploded' });
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
