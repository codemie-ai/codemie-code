/**
 * Claude's launch env declaration: the one list `beforeRun` applies and `codemie doctor` describes.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as launchEnvDefaults from '../launch-env-defaults.js';
import { CLAUDE_LAUNCH_ENV_DEFAULTS, CLAUDE_PROMPT_CACHE_WATCHED } from '../launch-env-defaults.js';
import { claudeCacheDefaults } from '../prompt-cache.js';
import { ClaudePluginMetadata } from '../claude.plugin.js';

vi.mock('fs/promises');
vi.mock('fs');

function declared(name: string): (typeof CLAUDE_LAUNCH_ENV_DEFAULTS)[number] {
  const found = CLAUDE_LAUNCH_ENV_DEFAULTS.find((d) => d.name === name);
  if (!found) throw new Error(`${name} is not declared`);
  return found;
}

const PROVIDERS = ['ai-run-sso', 'litellm', 'anthropic-subscription', 'bedrock', 'ollama', 'jwt', undefined];

describe('CLAUDE_LAUNCH_ENV_DEFAULTS', () => {
  it('declares exactly the eight variables in launch order', () => {
    expect(CLAUDE_LAUNCH_ENV_DEFAULTS.map((d) => d.name)).toEqual([
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'ENABLE_PROMPT_CACHING_1H',
      'CLAUDE_CODE_AUTO_MODE_SERVER',
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'DISABLE_AUTOUPDATER',
      'FORCE_AUTOUPDATE_PLUGINS',
      'ENABLE_TOOL_SEARCH',
      'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    ]);
  });

  it.each(PROVIDERS)('the same provider-neutral, gateway-safe values on provider %s', (provider) => {
    const env: NodeJS.ProcessEnv = provider ? { CODEMIE_PROVIDER: provider } : {};
    const value = (name: string): string | undefined => declared(name).value(env)?.value;

    expect(value('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS')).toBe('1');
    expect(value('ENABLE_PROMPT_CACHING_1H')).toBe('1');
    expect(value('CLAUDE_CODE_AUTO_MODE_SERVER')).toBeUndefined();
    expect(value('CLAUDE_CODE_ENABLE_TELEMETRY')).toBe('0');
    expect(value('DISABLE_AUTOUPDATER')).toBe('1');
    expect(value('FORCE_AUTOUPDATE_PLUGINS')).toBe('1');
    expect(value('ENABLE_TOOL_SEARCH')).toBe('0');
  });

  it('names no provider: provider-specific values come from the providers', () => {
    expect(Object.keys(launchEnvDefaults).filter((key) => key.endsWith('_PROVIDERS'))).toEqual([]);
  });

  it('autocompact comes from the profile when set', () => {
    const autocompact = declared('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(autocompact.value({ CODEMIE_PROFILE_CONFIG: '{"claudeAutocompactPct":70}' })).toEqual({ value: '70', from: 'profile' });
    expect(autocompact.value({})).toEqual({ value: '85', from: 'codemie-default' });
    expect(autocompact.value({ CODEMIE_PROFILE_CONFIG: '{not json' })).toEqual({ value: '85', from: 'codemie-default' });
  });

  it.each(PROVIDERS)('claudeCacheDefaults equals the first two declarations on provider %s', (provider) => {
    const env: NodeJS.ProcessEnv = provider ? { CODEMIE_PROVIDER: provider } : {};
    expect(claudeCacheDefaults(env)).toEqual({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: declared('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS').value(env)?.value,
      ENABLE_PROMPT_CACHING_1H: declared('ENABLE_PROMPT_CACHING_1H').value(env)?.value,
    });
  });

  it('the Claude metadata carries the defaults, then the watched prompt-cache variables', () => {
    expect(ClaudePluginMetadata.launchEnvDefaults).toEqual([...CLAUDE_LAUNCH_ENV_DEFAULTS, ...CLAUDE_PROMPT_CACHE_WATCHED]);
  });
});

describe('CLAUDE_PROMPT_CACHE_WATCHED', () => {
  it('watches every variable that can shorten, override or disable the prompt cache', () => {
    expect(CLAUDE_PROMPT_CACHE_WATCHED.map((d) => d.name)).toEqual([
      'FORCE_PROMPT_CACHING_5M',
      'CLAUDE_CODE_PROMPT_CACHE_TTL',
      'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
      'DISABLE_PROMPT_CACHING',
      'DISABLE_PROMPT_CACHING_HAIKU',
      'DISABLE_PROMPT_CACHING_SONNET',
      'DISABLE_PROMPT_CACHING_OPUS',
    ]);
  });

  it.each(PROVIDERS)('CodeMie sets none of them (provider %s)', (provider) => {
    const env: NodeJS.ProcessEnv = provider ? { CODEMIE_PROVIDER: provider } : {};
    for (const watched of CLAUDE_PROMPT_CACHE_WATCHED) expect(watched.value(env), watched.name).toBeUndefined();
  });
});

describe('beforeRun applies the declaration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  });

  it('sets every declared variable to its declared value, keeping a pre-set one', async () => {
    const shell: NodeJS.ProcessEnv = { CODEMIE_PROVIDER: 'ai-run-sso', ENABLE_TOOL_SEARCH: '0' };
    const env: Record<string, string> = { ...(shell as Record<string, string>) };

    await ClaudePluginMetadata.lifecycle?.beforeRun?.(env as never, {} as never);

    for (const d of CLAUDE_LAUNCH_ENV_DEFAULTS) {
      if (d.name === 'ENABLE_TOOL_SEARCH') continue;
      expect(env[d.name], d.name).toBe(d.value(shell)?.value);
    }
    expect(env.ENABLE_TOOL_SEARCH).toBe('0');
  });

});
