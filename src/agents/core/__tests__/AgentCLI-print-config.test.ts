import { describe, it, expect, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';

class ExitError extends Error {
  constructor(public code?: string | number | null) {
    super(`process.exit:${code}`);
  }
}

function createAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'opencode',
    displayName: 'OpenCode',
    description: 'Test adapter for print-config',
    metadata: {
      name: 'opencode',
      displayName: 'OpenCode',
      description: 'Test adapter for print-config',
      npmPackage: null,
      cliCommand: 'opencode',
      envMapping: {},
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

function mockHandleRunDependencies() {
  vi.spyOn(ConfigLoader, 'load').mockResolvedValue({
    name: 'default',
    provider: 'litellm',
    model: 'gpt-5',
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    timeout: 0,
    debug: false,
    allowedDirs: [],
    ignorePatterns: ['node_modules'],
  } as Awaited<ReturnType<typeof ConfigLoader.load>>);
  vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({
    CODEMIE_API_KEY: 'test-key',
  });
  vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: true } as never);
  vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
}

describe('handleRun --print-config', () => {
  it('forwards { dryRun: true } to adapter.run() for the opencode agent', async () => {
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], { printConfig: true });

    expect(run).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), { dryRun: true });
  });

  it('calls adapter.run() with no third argument when --print-config is not passed', async () => {
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], {});

    expect(run).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), undefined);
  });

  it('rejects with exit code 1 and never calls adapter.run() for a non-opencode agent', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(code);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = new AgentCLI(createAdapter({ name: 'claude', run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await expect(cli.handleRun([], { printConfig: true })).rejects.toMatchObject({ code: 1 });

    expect(run).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
