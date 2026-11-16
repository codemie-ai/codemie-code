/**
 * Tests for the effective prompt-cache setup resolver.
 *
 * `decidePromptCacheSetup` answers one question for the launch debug line and for
 * `codemie doctor`: which prompt-cache TTL will this Claude Code session ask for, and which
 * variable or settings file decided it. It is pure: the shell environment (before CodeMie's
 * defaults) and the already-read settings layers go in, a structured answer comes out.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import type { ClaudeSettingsLayer } from '@/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.js';
import {
  PROMPT_CACHE_PRECEDENCE,
  decidePromptCacheSetup,
  describePromptCacheSource,
} from '../prompt-cache.js';

const USER = '/home/u/.claude/settings.json';
const PROJECT = '/proj/.claude/settings.json';
const LOCAL = '/proj/.claude/settings.local.json';

/** Layers lowest to highest precedence; a layer not named is absent. */
function layers(overrides: Record<string, Record<string, unknown> | 'unreadable'> = {}): ClaudeSettingsLayer[] {
  return [USER, PROJECT, LOCAL].map((path) => {
    const layer = overrides[path];
    if (layer === undefined) return { path, state: 'absent' };
    if (layer === 'unreadable') return { path, state: 'unreadable' };
    return { path, state: 'ok', settings: layer };
  });
}

function decide(
  env: NodeJS.ProcessEnv,
  settings: ClaudeSettingsLayer[] = layers(),
  codemieDefaults = true
): ReturnType<typeof decidePromptCacheSetup> {
  return decidePromptCacheSetup({ env: { CODEMIE_PROVIDER: 'ai-run-sso', ...env }, codemieDefaults }, settings);
}

describe('decidePromptCacheSetup — precedence', () => {
  it('keeps every order in one exported table: variable sources, main TTL, subagent TTL', () => {
    expect(PROMPT_CACHE_PRECEDENCE.variableSources.map((row) => row.name)).toEqual([
      'settings env',
      'shell',
      'CodeMie default',
    ]);
    expect(PROMPT_CACHE_PRECEDENCE.ttl.map((row) => row.name)).toEqual([
      'DISABLE_PROMPT_CACHING*',
      'FORCE_PROMPT_CACHING_5M',
      'CLAUDE_CODE_PROMPT_CACHE_TTL',
      'promptCacheTtl',
      'ENABLE_PROMPT_CACHING_1H',
      'blank settings env entry',
    ]);
    expect(PROMPT_CACHE_PRECEDENCE.subagent.map((row) => row.name)).toEqual([
      'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
      'subagentPromptCacheTtl',
    ]);
  });

  it.each([
    ['DISABLE_PROMPT_CACHING', { DISABLE_PROMPT_CACHING: '1' }, {}, 'disabled', 'DISABLE_PROMPT_CACHING', '1'],
    ['a DISABLE_PROMPT_CACHING_<model> variant', { DISABLE_PROMPT_CACHING_SONNET: 'TRUE' }, {}, 'disabled', 'DISABLE_PROMPT_CACHING_SONNET', 'TRUE'],
    ['FORCE_PROMPT_CACHING_5M', { FORCE_PROMPT_CACHING_5M: 'true' }, {}, '5m', 'FORCE_PROMPT_CACHING_5M', 'true'],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL=1h', { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, {}, '1h', 'CLAUDE_CODE_PROMPT_CACHE_TTL', '1h'],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL=5m', { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, {}, '5m', 'CLAUDE_CODE_PROMPT_CACHE_TTL', '5m'],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL=2h', { CLAUDE_CODE_PROMPT_CACHE_TTL: '2h' }, {}, 'unknown', 'CLAUDE_CODE_PROMPT_CACHE_TTL', '2h'],
    ['settings promptCacheTtl=5m', {}, { promptCacheTtl: '5m' }, '5m', 'promptCacheTtl', '5m'],
    ['settings promptCacheTtl=1h', {}, { promptCacheTtl: '1h' }, '1h', 'promptCacheTtl', '1h'],
    ['settings promptCacheTtl=forever', {}, { promptCacheTtl: 'forever' }, 'unknown', 'promptCacheTtl', 'forever'],
    ['ENABLE_PROMPT_CACHING_1H=true', { ENABLE_PROMPT_CACHING_1H: 'true' }, {}, '1h', 'ENABLE_PROMPT_CACHING_1H', 'true'],
  ] as const)('%s decides on its own', (_name, env, userSettings, ttl, decidedBy, value) => {
    const setup = decide(env, layers({ [USER]: userSettings }));
    expect(setup).toMatchObject({ ttl, decidedBy, value });
  });

  it.each([
    ['DISABLE_PROMPT_CACHING over FORCE_PROMPT_CACHING_5M', { DISABLE_PROMPT_CACHING: '1', FORCE_PROMPT_CACHING_5M: '1' }, {}, 'disabled', 'DISABLE_PROMPT_CACHING'],
    ['FORCE_PROMPT_CACHING_5M over CLAUDE_CODE_PROMPT_CACHE_TTL', { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, {}, '5m', 'FORCE_PROMPT_CACHING_5M'],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL over promptCacheTtl', { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, { promptCacheTtl: '5m' }, '1h', 'CLAUDE_CODE_PROMPT_CACHE_TTL'],
    ['promptCacheTtl over ENABLE_PROMPT_CACHING_1H', { ENABLE_PROMPT_CACHING_1H: '1' }, { promptCacheTtl: '5m' }, '5m', 'promptCacheTtl'],
  ] as const)('%s', (_name, env, userSettings, ttl, decidedBy) => {
    expect(decide(env, layers({ [USER]: userSettings }))).toMatchObject({ ttl, decidedBy });
  });

  it('a switch that is set but not truthy does not decide', () => {
    const setup = decide({ DISABLE_PROMPT_CACHING: '0', FORCE_PROMPT_CACHING_5M: 'false' });
    expect(setup).toMatchObject({ ttl: '1h', decidedBy: 'ENABLE_PROMPT_CACHING_1H' });
  });

  it.each([
    ['DISABLE_PROMPT_CACHING', 'yes'],
    ['DISABLE_PROMPT_CACHING_SONNET', 'on'],
    ['FORCE_PROMPT_CACHING_5M', 'on'],
  ])('%s=%s is unknown, never a confident 1h', (name, value) => {
    expect(decide({ [name]: value })).toMatchObject({
      ttl: 'unknown',
      decidedBy: name,
      value,
      source: { kind: 'shell' },
    });
  });

  it('a clearly disabling variant wins over an ambiguous one', () => {
    expect(decide({ DISABLE_PROMPT_CACHING: 'yes', DISABLE_PROMPT_CACHING_SONNET: '1' })).toMatchObject({
      ttl: 'disabled',
      decidedBy: 'DISABLE_PROMPT_CACHING_SONNET',
    });
  });
});

describe('decidePromptCacheSetup — sources', () => {
  it('reports the CodeMie default when nothing else is set', () => {
    expect(decide({})).toMatchObject({
      ttl: '1h',
      decidedBy: 'ENABLE_PROMPT_CACHING_1H',
      value: '1',
      source: { kind: 'codemie-default' },
    });
  });

  it('reports the shell when the user set the variable to 1', () => {
    expect(decide({ ENABLE_PROMPT_CACHING_1H: '1' })).toMatchObject({ ttl: '1h', source: { kind: 'shell' } });
  });

  it('falls to the upstream 5m default where CodeMie applies no defaults', () => {
    const setup = decidePromptCacheSetup({ env: {}, codemieDefaults: false }, layers());
    expect(setup).toMatchObject({ ttl: '5m', decidedBy: 'upstream default', source: { kind: 'upstream-default' } });
    expect(setup.value).toBeUndefined();
    expect(setup.variables).toEqual({});
  });

  it.each(['0', 'yes'])('a shell ENABLE_PROMPT_CACHING_1H=%s is unknown, neither 5m nor 1h (Review Focus 2)', (value) => {
    expect(decide({ ENABLE_PROMPT_CACHING_1H: value })).toMatchObject({
      ttl: 'unknown',
      decidedBy: 'ENABLE_PROMPT_CACHING_1H',
      value,
      source: { kind: 'shell' },
    });
  });

  it('a settings env entry overrides the shell, and the highest file is named (Review Focus 3)', () => {
    const setup = decide(
      { ENABLE_PROMPT_CACHING_1H: '1' },
      layers({
        [USER]: { env: { FORCE_PROMPT_CACHING_5M: '0', ENABLE_PROMPT_CACHING_1H: '0' } },
        [LOCAL]: { env: { ENABLE_PROMPT_CACHING_1H: 'off' } },
      })
    );
    expect(setup).toMatchObject({
      ttl: 'unknown',
      decidedBy: 'ENABLE_PROMPT_CACHING_1H',
      value: 'off',
      source: { kind: 'settings', path: LOCAL },
    });
    expect(setup.variables).toMatchObject({ ENABLE_PROMPT_CACHING_1H: 'off', FORCE_PROMPT_CACHING_5M: '0' });
  });

  it('a settings env entry that blanks the variable is unknown, naming that file', () => {
    const setup = decide(
      { ENABLE_PROMPT_CACHING_1H: '1' },
      layers({ [LOCAL]: { env: { ENABLE_PROMPT_CACHING_1H: '' } } })
    );
    expect(setup).toMatchObject({
      ttl: 'unknown',
      decidedBy: 'ENABLE_PROMPT_CACHING_1H',
      value: '',
      source: { kind: 'settings', path: LOCAL },
    });
  });

  it('a blanked settings entry does not decide when a lower row does', () => {
    const setup = decide({}, layers({ [LOCAL]: { env: { FORCE_PROMPT_CACHING_5M: '' } } }));
    expect(setup).toMatchObject({ ttl: '1h', decidedBy: 'ENABLE_PROMPT_CACHING_1H', source: { kind: 'codemie-default' } });
  });

  it('an empty shell value is still treated as unset', () => {
    expect(decide({ ENABLE_PROMPT_CACHING_1H: '' })).toMatchObject({ ttl: '1h', source: { kind: 'codemie-default' } });
  });

  it('names the highest settings file that sets promptCacheTtl', () => {
    const setup = decide({}, layers({ [USER]: { promptCacheTtl: '1h' }, [PROJECT]: { promptCacheTtl: '5m' } }));
    expect(setup).toMatchObject({ ttl: '5m', source: { kind: 'settings', path: PROJECT } });
  });

  it.each([
    ['an array', []],
    ['a string', 'ENABLE_PROMPT_CACHING_1H=1'],
  ])('a valid settings file whose env is %s is unknown, naming that file (Review Focus 1)', (_name, env) => {
    const setup = decide({ ENABLE_PROMPT_CACHING_1H: '1' }, layers({ [PROJECT]: { env } }));
    expect(setup).toMatchObject({
      ttl: 'unknown',
      decidedBy: 'unreadable settings',
      source: { kind: 'settings', path: PROJECT },
    });
  });

  it('an unreadable settings file is unknown even when a switch would otherwise decide', () => {
    const setup = decide({ FORCE_PROMPT_CACHING_5M: '1' }, layers({ [LOCAL]: 'unreadable' }));
    expect(setup).toMatchObject({
      ttl: 'unknown',
      decidedBy: 'unreadable settings',
      source: { kind: 'settings', path: LOCAL },
    });
  });
});

describe('decidePromptCacheSetup — confirmed', () => {
  // At launch ai-run-sso's declared agent env (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='0') is already
  // in the environment the resolver sees: applyProviderAgentEnv runs before Claude's hook.
  it('is confirmed when the provider allows experimental betas, as ai-run-sso declares', () => {
    const setup = decide({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0' });
    expect(setup.confirmed).toBe(true);
    expect(setup.variables).toEqual({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0', ENABLE_PROMPT_CACHING_1H: '1' });
  });

  it('is not confirmed on ollama, where CodeMie keeps experimental betas off', () => {
    expect(decide({ CODEMIE_PROVIDER: 'ollama' })).toMatchObject({ ttl: '1h', confirmed: false });
  });

  it.each(['1', 'true'])('is not confirmed when the shell sets the betas switch to %s', (value) => {
    expect(decide({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: value })).toMatchObject({ ttl: '1h', confirmed: false });
  });

  it('is not confirmed when the betas switch holds a value that is neither on nor off', () => {
    expect(decide({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'yes' })).toMatchObject({ ttl: '1h', confirmed: false });
  });
});

describe('decidePromptCacheSetup — subagent override', () => {
  it('is absent when nothing overrides the subagent TTL', () => {
    expect(decide({}).subagent).toBeUndefined();
  });

  it('reports the variable ahead of the settings key', () => {
    const setup = decide(
      { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' },
      layers({ [USER]: { subagentPromptCacheTtl: '1h' } })
    );
    expect(setup.subagent).toEqual({
      ttl: '5m',
      decidedBy: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
      source: { kind: 'shell' },
    });
    expect(setup.ttl).toBe('1h');
  });

  it('reports the settings key when the variable is not set', () => {
    expect(decide({}, layers({ [USER]: { subagentPromptCacheTtl: '1h' } })).subagent).toEqual({
      ttl: '1h',
      decidedBy: 'subagentPromptCacheTtl',
      source: { kind: 'settings', path: USER },
    });
  });
});

describe('describePromptCacheSource', () => {
  it.each([
    [{ kind: 'shell' }, 'shell'],
    [{ kind: 'codemie-default' }, 'CodeMie default'],
    [{ kind: 'upstream-default' }, 'Claude Code default'],
    [{ kind: 'settings', path: LOCAL }, LOCAL],
  ] as const)('%o reads as %s', (source, text) => {
    expect(describePromptCacheSource(source)).toBe(text);
  });
});
