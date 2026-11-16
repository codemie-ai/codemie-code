/**
 * Claude's launch-config lines for `codemie doctor`: the prompt-cache TTL a session started from
 * this directory would ask for, what decided it, and how to change it. Moved from the former
 * standalone PromptCacheCheck. The resolver is mocked here, so each case pins how one resolution
 * is worded and graded.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PromptCacheSetup } from '../prompt-cache.js';
import type { LaunchConfigContext } from '@/agents/core/types.js';
import type { ClaudeSettingsLayer } from '@/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.js';

const h = vi.hoisted(() => ({ resolveMock: vi.fn() }));

// The resolver is replaced; describePromptCacheSource stays real (pure).
vi.mock('../prompt-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt-cache.js')>();
  return { ...actual, resolvePromptCacheSetup: h.resolveMock };
});

import { describeClaudeLaunchConfig, toLaunchSettingsLayers } from '../launch-config-report.js';

const SETTINGS = '/proj/.claude/settings.local.json';

function setup(overrides: Partial<PromptCacheSetup> = {}): PromptCacheSetup {
  return {
    ttl: '1h',
    decidedBy: 'ENABLE_PROMPT_CACHING_1H',
    value: '1',
    source: { kind: 'codemie-default' },
    confirmed: true,
    variables: { ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0' },
    ...overrides,
  };
}

function ctx(provider: string, overrides: Partial<LaunchConfigContext> = {}): LaunchConfigContext {
  return {
    shellEnv: { PATH: '/bin' },
    provider,
    profileName: 'work',
    cwd: '/proj',
    defaultsApply: provider !== 'bedrock',
    ...overrides,
  };
}

async function run(
  provider: string,
  resolved: PromptCacheSetup,
  agentName = 'claude',
  overrides: Partial<LaunchConfigContext> = {}
): ReturnType<typeof describeClaudeLaunchConfig> {
  h.resolveMock.mockResolvedValue(resolved);
  return describeClaudeLaunchConfig(ctx(provider, overrides), agentName);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('describeClaudeLaunchConfig', () => {
  it('resolves from the current shell and directory, with CodeMie defaults on', async () => {
    await run('ai-run-sso', setup());

    expect(h.resolveMock).toHaveBeenCalledTimes(1);
    const input = h.resolveMock.mock.calls[0][0];
    expect(input.codemieDefaults).toBe(true);
    expect(input.cwd).toBe('/proj');
    expect(input.env.CODEMIE_PROVIDER).toBe('ai-run-sso');
  });

  it('hands the shell environment to the resolver', async () => {
    await run('ai-run-sso', setup(), 'claude', {
      shellEnv: { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CONFIG_DIR: '/custom/claude' },
    });

    const input = h.resolveMock.mock.calls[0][0];
    expect(input.env.FORCE_PROMPT_CACHING_5M).toBe('1');
    expect(input.env.CLAUDE_CONFIG_DIR).toBe('/custom/claude');
  });

  it.each([true, false])('passes defaultsApply=%s to the resolver as codemieDefaults', async (defaultsApply) => {
    await run('ai-run-sso', setup(), 'claude', { defaultsApply });

    expect(h.resolveMock.mock.calls[0][0].codemieDefaults).toBe(defaultsApply);
  });

  it('is info "not confirmed" on bedrock when the shell asks for 1h', async () => {
    const lines = await run('bedrock', setup({ source: { kind: 'shell' }, confirmed: true }));

    expect(lines[0]).toEqual({ status: 'info', message: 'Prompt cache: 1h TTL requested, not verified on this provider' });
  });

  it('warns when a settings file blanks the variable, naming the file to edit', async () => {
    const lines = await run(
      'ai-run-sso',
      setup({ ttl: 'unknown', decidedBy: 'ENABLE_PROMPT_CACHING_1H', value: '', source: { kind: 'settings', path: SETTINGS } })
    );

    expect(lines[0].status).toBe('warn');
    expect(lines[0].message).toContain('ENABLE_PROMPT_CACHING_1H=(empty)');
    expect(lines[0].message).toContain(SETTINGS);
    expect(lines[0].hint).toBe(`Remove ENABLE_PROMPT_CACHING_1H from ${SETTINGS}`);
  });

  it('strips terminal control sequences from repository-controlled names, values and paths', async () => {
    const lines = await run(
      'ai-run-sso',
      setup({
        ttl: 'disabled',
        decidedBy: 'DISABLE_PROMPT_CACHING_\x1b]0;owned\x07EVIL',
        value: '\x1b[2K\x1b[32m1‮',
        source: { kind: 'settings', path: '/proj/\x1b[1A.claude/settings.json' },
        subagent: {
          ttl: 'unknown',
          decidedBy: 'subagentPromptCacheTtl',
          source: { kind: 'settings', path: '/proj/\x1b[1A.claude/settings.json' },
        },
      })
    );

    // lines[0] is the outcome, lines[1] the subagent warning: the two lines built from settings text.
    for (const line of lines.slice(0, 2)) {
      expect(`${line.message}${line.hint ?? ''}`).not.toMatch(/[^\x20-\x7e]/);
    }
    expect(lines[1].hint).toBe('Remove subagentPromptCacheTtl from /proj/.claude/settings.json');
    expect(lines[0].message).toContain('DISABLE_PROMPT_CACHING_EVIL=1, from /proj/.claude/settings.json');
    expect(lines[0].hint).toBe('Remove DISABLE_PROMPT_CACHING_EVIL from /proj/.claude/settings.json');
  });

  it.each(['ENABLE_PROMPT_CACHING_1H', 'CLAUDE_CODE_PROMPT_CACHE_TTL'])(
    'adds no line when %s gives a verified 1h: its environment row already says so',
    async (decidedBy) => {
      expect(await run('ai-run-sso', setup({ decidedBy, value: decidedBy === 'ENABLE_PROMPT_CACHING_1H' ? '1' : '1h' }))).toEqual([]);
    }
  );

  it('still names a settings key that decides a verified 1h, since no environment row shows it', async () => {
    const lines = await run('ai-run-sso', setup({ decidedBy: 'promptCacheTtl', value: '1h', source: { kind: 'settings', path: SETTINGS } }));

    expect(lines).toEqual([{ status: 'ok', message: `Prompt cache: 1h TTL (set by promptCacheTtl=1h, from ${SETTINGS})` }]);
  });

  it('is info "not confirmed" on a clean ollama profile', async () => {
    const lines = await run('ollama', setup({ confirmed: false }));

    expect(lines[0]).toEqual({ status: 'info', message: 'Prompt cache: 1h TTL requested, not verified on this provider' });
  });

  it('reports the bedrock gap as info, naming the launching command', async () => {
    const lines = await run(
      'bedrock',
      setup({ ttl: '5m', decidedBy: 'upstream default', value: undefined, source: { kind: 'upstream-default' } })
    );

    expect(lines[0].status).toBe('info');
    expect(lines[0].message).toContain('bedrock');
    expect(lines[0].message).toContain('known gap');
    expect(lines[0].message).toContain('codemie-claude');
    expect(lines.some((l) => l.status === 'warn')).toBe(false);
  });

  it('warns when a shell variable forces 5m, naming the variable and how to remove it', async () => {
    const lines = await run('ai-run-sso', setup({ ttl: '5m', decidedBy: 'FORCE_PROMPT_CACHING_5M', value: '1', source: { kind: 'shell' } }));

    expect(lines[0].status).toBe('warn');
    expect(lines[0].message).toContain('FORCE_PROMPT_CACHING_5M=1');
    expect(lines[0].message).toContain('shell');
    expect(lines[0].hint).toContain('unset FORCE_PROMPT_CACHING_5M');
  });

  it('warns when a settings file decides, naming the key and the file', async () => {
    const lines = await run(
      'ai-run-sso',
      setup({ ttl: '5m', decidedBy: 'promptCacheTtl', value: '5m', source: { kind: 'settings', path: SETTINGS } })
    );

    expect(lines[0].status).toBe('warn');
    expect(lines[0].message).toContain('promptCacheTtl=5m');
    expect(lines[0].message).toContain(SETTINGS);
    expect(lines[0].hint).toContain('promptCacheTtl');
    expect(lines[0].hint).toContain(SETTINGS);
  });

  it('warns when prompt caching is disabled', async () => {
    const lines = await run('ai-run-sso', setup({ ttl: 'disabled', decidedBy: 'DISABLE_PROMPT_CACHING', value: '1', source: { kind: 'shell' } }));

    expect(lines[0].status).toBe('warn');
    expect(lines[0].message).toContain('disabled');
    expect(lines[0].message).toContain('DISABLE_PROMPT_CACHING=1');
  });

  it('warns when a settings file is unreadable, naming the file to fix', async () => {
    const lines = await run(
      'ai-run-sso',
      setup({ ttl: 'unknown', decidedBy: 'unreadable settings', value: undefined, source: { kind: 'settings', path: SETTINGS } })
    );

    expect(lines[0].status).toBe('warn');
    expect(lines[0].message).toContain('unreadable settings');
    expect(lines[0].message).toContain(SETTINGS);
    expect(lines[0].hint).toMatch(/JSON|permissions/);
    expect(lines[0].hint).toContain(SETTINGS);
  });

  it('adds a warning for a subagent override that is not 1h', async () => {
    const lines = await run(
      'ai-run-sso',
      setup({ subagent: { ttl: '5m', decidedBy: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', source: { kind: 'shell' } } })
    );

    // The main 1h needs no line of its own; the subagent override does.
    expect(lines).toHaveLength(1);
    expect(lines[0].status).toBe('warn');
    expect(lines[0].message).toContain('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL');
    expect(lines[0].hint).toContain('unset CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL');
  });

  it('says nothing extra about a subagent override of 1h', async () => {
    const lines = await run(
      'ai-run-sso',
      setup({ subagent: { ttl: '1h', decidedBy: 'subagentPromptCacheTtl', source: { kind: 'settings', path: SETTINGS } } })
    );

    expect(lines.some((l) => l.status === 'warn')).toBe(false);
  });

  it.each([
    ['ai-run-sso', setup()],
    ['ollama', setup({ confirmed: false })],
    ['bedrock', setup({ ttl: '5m', decidedBy: 'upstream default', value: undefined, source: { kind: 'upstream-default' } })],
    ['ai-run-sso', setup({ ttl: 'disabled', decidedBy: 'DISABLE_PROMPT_CACHING', value: '1', source: { kind: 'shell' } })],
  ] as const)('is at most one prompt-cache line, with no billing-check command (%s)', async (provider, resolved) => {
    const lines = await run(provider, resolved);

    expect(lines.length).toBeLessThanOrEqual(1);
    for (const line of lines) expect(line.message).toMatch(/^Prompt cache: /);
    expect(JSON.stringify(lines)).not.toMatch(/output-format|ephemeral_|To confirm what is billed/);
  });

  it('never claims a cost effect', async () => {
    const lines = await run('ai-run-sso', setup());

    expect(JSON.stringify(lines)).not.toMatch(/cheaper|saving|lower spend|reduc/i);
  });
});

describe('toLaunchSettingsLayers', () => {
  it('maps env and marks a non-object env unreadable', () => {
    const layers: ClaudeSettingsLayer[] = [
      { path: '/a', state: 'absent' },
      { path: '/b', state: 'ok', settings: { env: { X: '1' }, other: true } },
      { path: '/c', state: 'ok', settings: { model: 'x' } },
      { path: '/d', state: 'ok', settings: { env: ['not', 'an', 'object'] } },
      { path: '/e', state: 'unreadable' },
    ];

    expect(toLaunchSettingsLayers(layers)).toEqual([
      { path: '/a', state: 'absent' },
      { path: '/b', state: 'ok', env: { X: '1' } },
      { path: '/c', state: 'ok' },
      { path: '/d', state: 'unreadable' },
      { path: '/e', state: 'unreadable' },
    ]);
  });
});
