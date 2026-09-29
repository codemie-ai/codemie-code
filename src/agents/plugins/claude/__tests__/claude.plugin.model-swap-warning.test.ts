/**
 * Tests for the stderr warning the Claude plugin prints when beforeRun swaps the session model.
 * A dropped `[1m]` opt-in on a still-live model must not be reported as "not available" — the
 * model is available, only its 1M-context opt-in is not (EPMCDME-14763).
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../core/types.js';
import type { ClaudeModelResolution, ClaudeModelTier } from '../claude.models.js';

vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../statusline-installer.js', () => ({
  installStatusline: vi.fn(),
}));

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getCodemieHome: vi.fn(() => '/home/testuser/.codemie'),
  getCodemiePath: vi.fn((...parts: string[]) => `/home/testuser/.codemie/${parts.join('/')}`),
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setProfileName: vi.fn(),
    setSessionId: vi.fn(),
  },
}));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

const resolveClaudeModelMock = vi.fn<(env: NodeJS.ProcessEnv, tier: ClaudeModelTier) => Promise<ClaudeModelResolution | null>>();

vi.mock('../claude.models.js', () => ({
  resolveClaudeModel: resolveClaudeModelMock,
  listRouterModelIds: vi.fn(async () => []),
  buildModelLabelMap: vi.fn(async () => ({})),
  buildModelPickerOptions: vi.fn(async () => []),
}));

type HookEnv = NodeJS.ProcessEnv;
type BeforeRunFn = (env: HookEnv, config: AgentConfig) => Promise<HookEnv>;

describe('Claude Plugin – model swap warning', () => {
  let beforeRun: BeforeRunFn;
  let stderr: string[];

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    stderr = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '));
    });

    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function resolveModelTierTo(resolution: ClaudeModelResolution): void {
    resolveClaudeModelMock.mockImplementation(async (_env, tier) => (tier === 'model' ? resolution : null));
  }

  it('says the 1M-context opt-in was dropped, not that a live model is unavailable', async () => {
    resolveModelTierTo({
      selectedModel: 'claude-opus-4-5',
      availableModels: ['claude-opus-4-5'],
      reason: 'one-million-unsupported',
    });
    const env: HookEnv = { CODEMIE_MODEL: 'claude-opus-4-5[1m]' };

    await beforeRun(env, {});

    const output = stderr.join('\n');
    expect(output).toContain('does not support 1M context');
    expect(output).toContain('claude-opus-4-5');
    expect(output).not.toContain('is not available');
    expect(output).not.toContain('codemie models list');
    expect(env.CODEMIE_MODEL).toBe('claude-opus-4-5');
  });

  it('applies "[1m]" silently when the catalog reports a 1M window for the configured model', async () => {
    resolveModelTierTo({
      selectedModel: 'claude-opus-5[1m]',
      availableModels: ['claude-opus-5'],
      reason: 'one-million-enabled',
    });
    const env: HookEnv = { CODEMIE_MODEL: 'claude-opus-5' };

    await beforeRun(env, {});

    expect(stderr).toEqual([]);
    expect(env.CODEMIE_MODEL).toBe('claude-opus-5[1m]');
  });

  it('keeps the "not available" warning and models-list hint for a retired model', async () => {
    resolveModelTierTo({
      selectedModel: 'claude-opus-5',
      availableModels: ['claude-opus-5'],
      reason: 'unavailable',
    });
    const env: HookEnv = { CODEMIE_MODEL: 'claude-opus-4-1' };

    await beforeRun(env, {});

    const output = stderr.join('\n');
    expect(output).toContain('is not available in this CodeMie catalog');
    expect(output).toContain('codemie models list');
    expect(env.CODEMIE_MODEL).toBe('claude-opus-5');
  });
});
