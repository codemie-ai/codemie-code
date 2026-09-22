/**
 * AgentCLI.handleRun must mark an explicit --model CLI flag by setting
 * CODEMIE_MODEL_SOURCE=cli on the env handed to adapter.run() — the signal
 * resolveClaudeModel() relies on to never silently substitute a user-requested
 * model for the live catalog's top-ranked one.
 *
 * Mirrors the mocking pattern established in AgentCLI-print-config.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
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

function mockHandleRunDependencies(model: string) {
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

  it('does not set CODEMIE_MODEL_SOURCE when --model is not passed (implicit/profile-sourced model)', async () => {
    mockHandleRunDependencies('claude-sonnet-5[1m]');
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    // No `model` in options — same as launching without --model, interactive or not.
    await cli.handleRun([], {});

    const [, env] = run.mock.calls[0] as [string[], Record<string, unknown>, unknown];
    expect(env.CODEMIE_MODEL_SOURCE).toBeUndefined();
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
