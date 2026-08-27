import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { logger } from '../../../utils/logger.js';

// ---------------------------------------------------------------------------
// Global CLI flag -> env / config mapping in AgentCLI.
//
// Seam: drive the full `cli.run(['node', 'codemie-<agent>', ...flags])` entry
// point (mirrors AgentCLI-analytics-report.test.ts) so real Commander parsing
// runs, and inspect (a) what ConfigLoader.load received as CLI overrides and
// (b) the (agentArgs, providerEnv) pair handed to adapter.run().
//
// Existing AgentCLI-*.test.ts already cover effort / resume / analytics-report
// / print-config; this file adds the untested flags: -m/--model, --timeout,
// --status, --jwt-token, plus the collectPassThroughArgs config-only exclusion.
// ---------------------------------------------------------------------------

function mockHandleRunDependencies(overrides: Record<string, unknown> = {}): {
  loadSpy: ReturnType<typeof vi.spyOn>;
} {
  const loadSpy = vi.spyOn(ConfigLoader, 'load').mockResolvedValue({
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
  // exportProviderEnvVars is mocked to a fixed object; env vars derived from
  // config (CODEMIE_MODEL / CODEMIE_TIMEOUT / CODEMIE_PROVIDER / CODEMIE_BASE_URL)
  // are produced there, so for model/timeout we assert the ConfigLoader.load
  // override instead. Env vars written directly onto providerEnv by handleRun
  // (CODEMIE_STATUS, CODEMIE_JWT_TOKEN, CODEMIE_AUTH_METHOD) are asserted via run().
  vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({
    CODEMIE_API_KEY: 'test-key',
  });
  vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: true } as never);
  vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
  return { loadSpy };
}

function makeAdapter(runSpy: ReturnType<typeof vi.fn>): AgentAdapter {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    description: 'Test adapter for flag-env mapping',
    metadata: {
      name: 'claude',
      displayName: 'Claude Code',
      description: 'Test adapter for flag-env mapping',
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

describe('AgentCLI global flag -> env/config mapping', () => {
  let origJwtToken: string | undefined;
  let origAuthMethod: string | undefined;

  beforeEach(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setAgentName').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setProfileName').mockImplementation(() => undefined);
    // Capture any global env that the --jwt-token path mutates so we can restore.
    origJwtToken = process.env.CODEMIE_JWT_TOKEN;
    origAuthMethod = process.env.CODEMIE_AUTH_METHOD;
  });

  afterEach(() => {
    if (origJwtToken === undefined) delete process.env.CODEMIE_JWT_TOKEN;
    else process.env.CODEMIE_JWT_TOKEN = origJwtToken;
    if (origAuthMethod === undefined) delete process.env.CODEMIE_AUTH_METHOD;
    else process.env.CODEMIE_AUTH_METHOD = origAuthMethod;
    vi.restoreAllMocks();
  });

  // --- -m / --model ---------------------------------------------------------

  it('-m forwards the model override to ConfigLoader.load (drives CODEMIE_MODEL)', async () => {
    const { loadSpy } = mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', '-m', 'gpt-5-mini', 'chat']);

    expect(loadSpy).toHaveBeenCalledTimes(1);
    const overrides = loadSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(overrides.model).toBe('gpt-5-mini');
    // Config-only flag must not be forwarded to the agent argv.
    const [agentArgs] = run.mock.calls[0];
    expect(agentArgs).not.toContain('-m');
    expect(agentArgs).not.toContain('--model');
    expect(agentArgs).not.toContain('gpt-5-mini');
  });

  it('--model long form is equivalent to -m', async () => {
    const { loadSpy } = mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', '--model', 'sonnet-x']);

    const overrides = loadSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(overrides.model).toBe('sonnet-x');
  });

  it('leaves model override undefined when -m is absent', async () => {
    const { loadSpy } = mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', 'chat']);

    const overrides = loadSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(overrides.model).toBeUndefined();
  });

  // --- --timeout (parseInt at Commander level) ------------------------------

  it('--timeout is parsed to a number (parseInt) and forwarded to ConfigLoader.load', async () => {
    const { loadSpy } = mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', '--timeout', '45', 'chat']);

    const overrides = loadSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(overrides.timeout).toBe(45);
    expect(typeof overrides.timeout).toBe('number');
  });

  it('--timeout with trailing non-digits still parseInt-truncates (Commander parseInt)', async () => {
    const { loadSpy } = mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', '--timeout', '30s']);

    const overrides = loadSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(overrides.timeout).toBe(30);
  });

  // --- --status -------------------------------------------------------------

  it('--status sets CODEMIE_STATUS=1 on providerEnv and does not forward the flag', async () => {
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', '--status', 'chat']);

    expect(run).toHaveBeenCalledTimes(1);
    const [agentArgs, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_STATUS).toBe('1');
    expect(agentArgs).not.toContain('--status');
  });

  it('leaves CODEMIE_STATUS unset when --status is absent', async () => {
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', 'chat']);

    const [, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_STATUS).toBeUndefined();
  });

  // --- --jwt-token ----------------------------------------------------------

  it('--jwt-token sets process.env token + auth method and stamps providerEnv', async () => {
    mockHandleRunDependencies();
    // Avoid touching the filesystem in the hasNoConfig branch.
    vi.spyOn(ConfigLoader, 'hasGlobalConfig').mockResolvedValue(true);
    vi.spyOn(ConfigLoader, 'hasLocalConfig').mockResolvedValue(true);
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', '--jwt-token', 'jwt-abc123', 'chat']);

    // process.env is mutated directly by handleRun (restored in afterEach).
    expect(process.env.CODEMIE_JWT_TOKEN).toBe('jwt-abc123');
    expect(process.env.CODEMIE_AUTH_METHOD).toBe('jwt');

    // providerEnv (spread into the subprocess) also carries the override so it
    // wins over the SSO auth method emitted by exportProviderEnvVars.
    const [agentArgs, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_JWT_TOKEN).toBe('jwt-abc123');
    expect(providerEnv.CODEMIE_AUTH_METHOD).toBe('jwt');
    // Config-only flag is not forwarded to the agent argv.
    expect(agentArgs).not.toContain('--jwt-token');
    expect(agentArgs).not.toContain('jwt-abc123');
  });

  it('does not set JWT env vars when --jwt-token is absent', async () => {
    delete process.env.CODEMIE_JWT_TOKEN;
    delete process.env.CODEMIE_AUTH_METHOD;
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run(['node', 'codemie-claude', 'chat']);

    expect(process.env.CODEMIE_JWT_TOKEN).toBeUndefined();
    const [, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_JWT_TOKEN).toBeUndefined();
  });

  // --- collectPassThroughArgs config-only exclusion -------------------------

  it('strips all config-only flags but forwards positionals and unknown options', async () => {
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));

    await cli.run([
      'node',
      'codemie-claude',
      '--status',
      '--silent',
      '-m', 'my-model',
      '--timeout', '5',
      '--profile', 'work',
      '--provider', 'litellm',
      'chat',
      '--custom-agent-flag', 'value',
    ]);

    const [agentArgs] = run.mock.calls[0];

    // Config-only flags handled by the CodeMie CLI layer must NOT reach the agent.
    for (const configOnly of [
      '--status', '--silent', '-m', '--model', '--timeout',
      '--profile', '--provider', 'my-model', 'work',
    ]) {
      expect(agentArgs).not.toContain(configOnly);
    }

    // Positional args and unknown (agent-owned) flags ARE forwarded.
    expect(agentArgs).toContain('chat');
    expect(agentArgs).toContain('--custom-agent-flag');
    expect(agentArgs).toContain('value');
  });
});
