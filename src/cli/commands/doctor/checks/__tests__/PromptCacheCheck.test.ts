/**
 * `codemie doctor` — Claude prompt-cache check.
 *
 * The check reports which prompt-cache TTL a `codemie-claude` session started from this directory
 * would ask for and what decided it. It only reads: the resolver is mocked here, so each case pins
 * how one resolution is worded and graded. The check never fails doctor (`success` stays true).
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PromptCacheSetup } from '@/agents/plugins/claude/prompt-cache.js';

const h = vi.hoisted(() => ({
  loadMock: vi.fn(),
  getInstalledAgentsMock: vi.fn(),
  resolveMock: vi.fn(),
}));

vi.mock('@/utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/config.js')>();
  (actual.ConfigLoader as unknown as Record<string, unknown>).load = h.loadMock;
  return actual;
});

vi.mock('@/agents/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/registry.js')>();
  (actual.AgentRegistry as unknown as Record<string, unknown>).getInstalledAgents = h.getInstalledAgentsMock;
  return actual;
});

// The resolver is replaced; describePromptCacheSource stays real (pure).
vi.mock('@/agents/plugins/claude/prompt-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/plugins/claude/prompt-cache.js')>();
  return { ...actual, resolvePromptCacheSetup: h.resolveMock };
});

import { PromptCacheCheck } from '../PromptCacheCheck.js';

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

async function run(provider: string, resolved: PromptCacheSetup): Promise<Awaited<ReturnType<PromptCacheCheck['run']>>> {
  h.loadMock.mockResolvedValue({ name: 'work', provider });
  h.resolveMock.mockResolvedValue(resolved);
  return new PromptCacheCheck().run();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getInstalledAgentsMock.mockResolvedValue([{ name: 'claude', displayName: 'Claude Code' }]);
});

describe('PromptCacheCheck', () => {
  it('is skipped with a single info line when Claude Code is not installed', async () => {
    h.getInstalledAgentsMock.mockResolvedValue([{ name: 'gemini', displayName: 'Gemini CLI' }]);

    const result = await new PromptCacheCheck().run();

    expect(result).toEqual({
      name: 'Claude Prompt Cache',
      success: true,
      details: [{ status: 'info', message: 'Claude Code not installed (skipped)' }],
    });
    expect(h.loadMock).not.toHaveBeenCalled();
    expect(h.resolveMock).not.toHaveBeenCalled();
  });

  it('starts by naming the profile and the directory it evaluated', async () => {
    const result = await run('ai-run-sso', setup());

    expect(result.details[0].status).toBe('info');
    expect(result.details[0].message).toContain('work');
    expect(result.details[0].message).toContain(process.cwd());
  });

  it('resolves from the current shell and directory, with CodeMie defaults on', async () => {
    await run('ai-run-sso', setup());

    expect(h.resolveMock).toHaveBeenCalledTimes(1);
    const input = h.resolveMock.mock.calls[0][0];
    expect(input.codemieDefaults).toBe(true);
    expect(input.cwd).toBe(process.cwd());
    expect(input.env.CODEMIE_PROVIDER).toBe('ai-run-sso');
  });

  it('is ok on a clean ai-run-sso profile, naming the source', async () => {
    const result = await run('ai-run-sso', setup());

    expect(result.details[1].status).toBe('ok');
    expect(result.details[1].message).toContain('1h');
    expect(result.details[1].message).toContain('CodeMie default');
  });

  it('is info "not confirmed" on a clean ollama profile', async () => {
    const result = await run('ollama', setup({ confirmed: false }));

    expect(result.details[1]).toEqual({
      status: 'info',
      message: '1h requested, not confirmed on this provider path',
    });
  });

  it('reports the bedrock gap as info and resolves without CodeMie defaults', async () => {
    const result = await run(
      'bedrock',
      setup({ ttl: '5m', decidedBy: 'upstream default', value: undefined, source: { kind: 'upstream-default' } })
    );

    expect(h.resolveMock.mock.calls[0][0].codemieDefaults).toBe(false);
    expect(result.details[1].status).toBe('info');
    expect(result.details[1].message).toContain('bedrock');
    expect(result.details[1].message).toContain('known gap');
    expect(result.details.some((d) => d.status === 'warn')).toBe(false);
  });

  it('warns when a shell variable forces 5m, naming the variable and how to remove it', async () => {
    const result = await run(
      'ai-run-sso',
      setup({ ttl: '5m', decidedBy: 'FORCE_PROMPT_CACHING_5M', value: '1', source: { kind: 'shell' } })
    );

    expect(result.details[1].status).toBe('warn');
    expect(result.details[1].message).toContain('FORCE_PROMPT_CACHING_5M=1');
    expect(result.details[1].message).toContain('shell');
    expect(result.details[1].hint).toContain('unset FORCE_PROMPT_CACHING_5M');
  });

  it('warns when a settings file decides, naming the key and the file', async () => {
    const result = await run(
      'ai-run-sso',
      setup({ ttl: '5m', decidedBy: 'promptCacheTtl', value: '5m', source: { kind: 'settings', path: SETTINGS } })
    );

    expect(result.details[1].status).toBe('warn');
    expect(result.details[1].message).toContain('promptCacheTtl=5m');
    expect(result.details[1].message).toContain(SETTINGS);
    expect(result.details[1].hint).toContain('promptCacheTtl');
    expect(result.details[1].hint).toContain(SETTINGS);
  });

  it('warns when prompt caching is disabled', async () => {
    const result = await run(
      'ai-run-sso',
      setup({ ttl: 'disabled', decidedBy: 'DISABLE_PROMPT_CACHING', value: '1', source: { kind: 'shell' } })
    );

    expect(result.details[1].status).toBe('warn');
    expect(result.details[1].message).toContain('disabled');
    expect(result.details[1].message).toContain('DISABLE_PROMPT_CACHING=1');
  });

  it('warns when a settings file is unreadable, naming the file to fix', async () => {
    const result = await run(
      'ai-run-sso',
      setup({ ttl: 'unknown', decidedBy: 'unreadable settings', value: undefined, source: { kind: 'settings', path: SETTINGS } })
    );

    expect(result.details[1].status).toBe('warn');
    expect(result.details[1].message).toContain('unreadable settings');
    expect(result.details[1].message).toContain(SETTINGS);
    expect(result.details[1].hint).toMatch(/JSON|permissions/);
    expect(result.details[1].hint).toContain(SETTINGS);
  });

  it('adds a warning for a subagent override that is not 1h', async () => {
    const result = await run(
      'ai-run-sso',
      setup({ subagent: { ttl: '5m', decidedBy: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', source: { kind: 'shell' } } })
    );

    expect(result.details[1].status).toBe('ok');
    expect(result.details[2].status).toBe('warn');
    expect(result.details[2].message).toContain('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL');
    expect(result.details[2].hint).toContain('unset CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL');
  });

  it('says nothing extra about a subagent override of 1h', async () => {
    const result = await run(
      'ai-run-sso',
      setup({ subagent: { ttl: '1h', decidedBy: 'subagentPromptCacheTtl', source: { kind: 'settings', path: SETTINGS } } })
    );

    expect(result.details.some((d) => d.status === 'warn')).toBe(false);
  });

  it.each([
    ['ai-run-sso', setup()],
    ['ollama', setup({ confirmed: false })],
    ['bedrock', setup({ ttl: '5m', decidedBy: 'upstream default', value: undefined, source: { kind: 'upstream-default' } })],
    ['ai-run-sso', setup({ ttl: 'disabled', decidedBy: 'DISABLE_PROMPT_CACHING', value: '1', source: { kind: 'shell' } })],
  ] as const)('always succeeds and ends with the confirming command (%s)', async (provider, resolved) => {
    const result = await run(provider, resolved);

    const last = result.details[result.details.length - 1];
    expect(result.success).toBe(true);
    expect(last.status).toBe('info');
    expect(last.message).toContain('codemie-claude -p "hi" --output-format json');
    expect(last.message).toContain('usage.cache_creation.ephemeral_1h_input_tokens');
    expect(last.message).toContain('ephemeral_5m_input_tokens');
  });

  it('turns a failing ConfigLoader.load() into one warning and still succeeds (Review Focus 5)', async () => {
    h.loadMock.mockRejectedValue(new Error('profile file is corrupt'));

    const result = await new PromptCacheCheck().run();

    expect(result.success).toBe(true);
    expect(result.details).toHaveLength(1);
    expect(result.details[0].status).toBe('warn');
    expect(result.details[0].message).toContain('profile file is corrupt');
  });

  it('never claims a cost effect', async () => {
    const result = await run('ai-run-sso', setup());

    expect(JSON.stringify(result.details)).not.toMatch(/cheaper|saving|lower spend|reduc/i);
  });
});
