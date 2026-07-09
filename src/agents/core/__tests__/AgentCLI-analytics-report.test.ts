import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { logger } from '../../../utils/logger.js';

// Inlined handleRun harness (mirrors AgentCLI-resume.test.ts): mock config
// loading and provider auth so handleRun reaches adapter.run(agentArgs, providerEnv).
function mockHandleRunDependencies(overrides: Record<string, unknown> = {}): void {
  vi.spyOn(ConfigLoader, 'load').mockResolvedValue({
    name: 'default',
    provider: 'litellm',
    model: 'claude-sonnet-4-6',
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    timeout: 0,
    debug: false,
    allowedDirs: [],
    ignorePatterns: ['node_modules'],
    ...overrides,
  } as Awaited<ReturnType<typeof ConfigLoader.load>>);
  vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({
    CODEMIE_API_KEY: 'test-key',
  });
  vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: true } as never);
  vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
}

function makeAdapter(runSpy: ReturnType<typeof vi.fn>): AgentAdapter {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    description: 'Test adapter for analytics-report flow',
    metadata: {
      name: 'claude',
      displayName: 'Claude Code',
      description: 'Test adapter for analytics-report flow',
      npmPackage: null,
      cliCommand: 'claude',
      envMapping: {},
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => true,
    run: runSpy,
    getVersion: async () => '1.0.0',
    getMetricsConfig: () => undefined,
  } as unknown as AgentAdapter;
}

describe('AgentCLI --no-analytics-report', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setAgentName').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setProfileName').mockImplementation(() => undefined);
    mockHandleRunDependencies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets CODEMIE_SESSION_ANALYTICS_REPORT=0 and does not forward the flag', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', '--no-analytics-report', 'chat']);

    expect(run).toHaveBeenCalledTimes(1);
    const [agentArgs, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT).toBe('0');
    expect(agentArgs).not.toContain('--analytics-report');
    expect(agentArgs).not.toContain('--no-analytics-report');
  });

  it('leaves the env var unset by default', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', 'chat']);

    expect(run).toHaveBeenCalledTimes(1);
    const [, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT).toBeUndefined();
  });
});
