/**
 * AgentCLI.handleRun must mark an explicit --model CLI flag by setting
 * CODEMIE_MODEL_SOURCE=cli on the env handed to adapter.run() — the signal
 * resolveClaudeModel() relies on to never silently substitute a user-requested
 * model for the live catalog's top-ranked one.
 *
 * Mirrors the mocking pattern established in AgentCLI-print-config.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';

function createAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    description: 'Test adapter for model-source propagation',
    metadata: {
      name: 'claude',
      displayName: 'Claude Code',
      description: 'Test adapter for model-source propagation',
      npmPackage: null,
      cliCommand: 'claude',
      envMapping: { model: ['ANTHROPIC_MODEL'] },
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => true,
    run: async () => {},
    getVersion: async () => null,
    getMetricsConfig: () => undefined,
    ...overrides,
  };
}

function mockHandleRunDependencies(model: string, extraConfig: Record<string, unknown> = {}) {
  vi.spyOn(ConfigLoader, 'load').mockResolvedValue({
    name: 'default',
    provider: 'ai-run-sso',
    model,
    baseUrl: 'https://example.invalid',
    apiKey: '',
    timeout: 0,
    debug: false,
    allowedDirs: [],
    ignorePatterns: ['node_modules'],
    ...extraConfig,
  } as Awaited<ReturnType<typeof ConfigLoader.load>>);
  vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({
    CODEMIE_MODEL: model,
    CODEMIE_API_KEY: 'not-required',
  });
  vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: false } as never);
  vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
}

describe('AgentCLI.handleRun — CODEMIE_MODEL_SOURCE propagation', () => {
  it('sets CODEMIE_MODEL_SOURCE=cli when --model is passed explicitly (non-interactive, "claude-sonnet-5[1m]")', async () => {
    mockHandleRunDependencies('claude-sonnet-5[1m]');
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], { model: 'claude-sonnet-5[1m]', task: 'do something' });

    expect(run).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ CODEMIE_MODEL_SOURCE: 'cli', CODEMIE_MODEL: 'claude-sonnet-5[1m]' }),
      undefined
    );
  });

  it('sets CODEMIE_MODEL_SOURCE=cli when --model is passed explicitly ("claude-sonnet-5", no regression)', async () => {
    mockHandleRunDependencies('claude-sonnet-5');
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], { model: 'claude-sonnet-5', task: 'do something' });

    expect(run).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ CODEMIE_MODEL_SOURCE: 'cli', CODEMIE_MODEL: 'claude-sonnet-5' }),
      undefined
    );
  });

  it('sets CODEMIE_MODEL_SOURCE=default when --model is not passed (implicit/profile-sourced model)', async () => {
    mockHandleRunDependencies('claude-sonnet-5[1m]');
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    // No `model` in options — same as launching without --model, interactive or not.
    await cli.handleRun([], {});

    // Distinct from 'cli'/'env': codex-models.ts's isExplicitModelChoice() treats only those
    // two as an explicit user choice, so 'default' must stay a real, distinguishable value
    // rather than the field being merely present-or-absent.
    const [, env] = run.mock.calls[0] as [string[], Record<string, unknown>, unknown];
    expect(env.CODEMIE_MODEL_SOURCE).toBe('default');
  });

  it('also propagates CODEMIE_MODEL_SOURCE=cli in interactive mode (no --task) — no regression', async () => {
    mockHandleRunDependencies('claude-sonnet-5[1m]');
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], { model: 'claude-sonnet-5[1m]' });

    expect(run).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ CODEMIE_MODEL_SOURCE: 'cli' }),
      undefined
    );
  });
});

describe('AgentCLI.handleRun — per-agent models (EPMCDME-15641)', () => {
  type Cli = { handleRun: (args: string[], options: Record<string, unknown>) => Promise<void> };
  const agentAdapter = (run: AgentAdapter['run'], name = 'codex'): AgentAdapter => {
    const base = createAdapter({ run });
    return { ...base, name, displayName: 'Codex', metadata: { ...base.metadata, name } };
  };
  // The top-level model mirrors the first agent (claude); codex has its own active model.
  const perAgent = {
    agentModels: {
      claude: { models: ['claude-x'], model: 'claude-x' },
      codex: { models: ['gpt-5.4', 'gpt-5.5'], model: 'gpt-5.4' },
    },
  };
  const incompatibleCodex = {
    agentModels: {
      claude: { models: ['claude-x'], model: 'claude-x' },
      codex: { models: ['claude-x'], model: 'claude-x' },
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEMIE_MODEL;
  });

  function exportedConfig(): Record<string, unknown> {
    const spy = vi.mocked(ConfigLoader.exportProviderEnvVars);
    return spy.mock.calls[spy.mock.calls.length - 1][0] as unknown as Record<string, unknown>;
  }

  it('launches the agent with its own active model and only its own models', async () => {
    mockHandleRunDependencies('claude-x', perAgent);
    const run = vi.fn().mockResolvedValue(undefined);

    await (new AgentCLI(agentAdapter(run)) as unknown as Cli).handleRun([], {});

    expect(run).toHaveBeenCalled();
    expect(exportedConfig().model).toBe('gpt-5.4');
    expect(exportedConfig().agentModels).toEqual({ codex: perAgent.agentModels.codex });
  });

  it('folds an ACP agent into its base agent models', async () => {
    mockHandleRunDependencies('claude-x', perAgent);
    const run = vi.fn().mockResolvedValue(undefined);

    await (new AgentCLI(agentAdapter(run, 'codex-acp')) as unknown as Cli).handleRun([], {});

    expect(exportedConfig().model).toBe('gpt-5.4');
  });

  it('blocks a persisted incompatible agent active model (exit 1)', async () => {
    mockHandleRunDependencies('claude-x', incompatibleCodex);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const run = vi.fn().mockResolvedValue(undefined);

    await expect((new AgentCLI(agentAdapter(run)) as unknown as Cli).handleRun([], {})).rejects.toThrow();

    expect(exit).toHaveBeenCalledWith(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('launches with the --model value instead of the agent active model', async () => {
    // ConfigLoader.load already merges --model into the top-level model.
    mockHandleRunDependencies('claude-x', incompatibleCodex);
    const run = vi.fn().mockResolvedValue(undefined);

    await (new AgentCLI(agentAdapter(run)) as unknown as Cli).handleRun([], { model: 'claude-x' });

    expect(run).toHaveBeenCalled();
    expect(exportedConfig().model).toBe('claude-x');
  });

  it('launches when CODEMIE_MODEL is set, keeping that model', async () => {
    mockHandleRunDependencies('my-env-model', perAgent);
    process.env.CODEMIE_MODEL = 'my-env-model';
    const run = vi.fn().mockResolvedValue(undefined);

    await (new AgentCLI(agentAdapter(run)) as unknown as Cli).handleRun([], {});

    expect(run).toHaveBeenCalled();
    expect(exportedConfig().model).toBe('my-env-model');
  });

  it('ignores an inherited CODEMIE_MODEL with --profile, launching the agent active model', async () => {
    // ConfigLoader.load drops CODEMIE_MODEL when --profile is given (profile protection).
    mockHandleRunDependencies('claude-x', perAgent);
    process.env.CODEMIE_MODEL = 'parent-session-model';
    const run = vi.fn().mockResolvedValue(undefined);

    await (new AgentCLI(agentAdapter(run)) as unknown as Cli).handleRun([], { profile: 'default' });

    expect(run).toHaveBeenCalled();
    expect(exportedConfig().model).toBe('gpt-5.4');
  });
});
