import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { logger } from '../../../utils/logger.js';

// ---------------------------------------------------------------------------
// `-s` ownership in AgentCLI.
//
// codex (`-s, --sandbox <mode>`) and gemini (`-s, --sandbox`) own `-s` natively,
// so the wrapper registers only the long `--silent` for them and must forward
// `-s` untouched. Other agents keep `-s, --silent` as a wrapper flag.
//
// Seam: drive `cli.run([...])` so real Commander parsing runs, then inspect the
// agentArgs handed to adapter.run() and whether setSilentMode(true) was called.
// stdin/stdout are forced to TTY so auto-silent (non-interactive) does not mask
// the explicit --silent flag.
// ---------------------------------------------------------------------------

function mockHandleRunDependencies(): void {
  vi.spyOn(ConfigLoader, 'load').mockResolvedValue({
    name: 'default',
    provider: 'litellm',
    model: 'test-model',
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    timeout: 0,
    debug: false,
    allowedDirs: [],
    ignorePatterns: ['node_modules'],
  } as Awaited<ReturnType<typeof ConfigLoader.load>>);
  vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({ CODEMIE_API_KEY: 'test-key' });
  vi.spyOn(ConfigLoader, 'hasGlobalConfig').mockResolvedValue(true);
  vi.spyOn(ConfigLoader, 'hasLocalConfig').mockResolvedValue(true);
  vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: true } as never);
  vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
}

function makeAdapter(
  name: string,
  run: ReturnType<typeof vi.fn>,
  setSilentMode: ReturnType<typeof vi.fn>
): AgentAdapter {
  return {
    name,
    displayName: name,
    description: 'Test adapter for -s flag ownership',
    metadata: {
      name,
      displayName: name,
      description: 'Test adapter for -s flag ownership',
      npmPackage: null,
      cliCommand: name,
      envMapping: {},
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => true,
    run,
    setSilentMode,
    getVersion: async () => '1.0.0',
    getMetricsConfig: () => undefined,
  } as unknown as AgentAdapter;
}

describe('AgentCLI -s flag ownership', () => {
  const origStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const origStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  let run: ReturnType<typeof vi.fn>;
  let setSilentMode: ReturnType<typeof vi.fn>;

  function restoreTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, desc?: PropertyDescriptor): void {
    if (desc) Object.defineProperty(stream, 'isTTY', desc);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }

  async function runCli(agent: string, argv: string[]): Promise<string[]> {
    const cli = new AgentCLI(makeAdapter(agent, run, setSilentMode));
    await cli.run(['node', `codemie-${agent}`, ...argv]);
    expect(run).toHaveBeenCalledTimes(1);
    return run.mock.calls[0][0] as string[];
  }

  beforeEach(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setAgentName').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setProfileName').mockImplementation(() => undefined);
    mockHandleRunDependencies();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    run = vi.fn().mockResolvedValue(undefined);
    setSilentMode = vi.fn();
  });

  afterEach(() => {
    restoreTTY(process.stdin, origStdinTTY);
    restoreTTY(process.stdout, origStdoutTTY);
    vi.restoreAllMocks();
  });

  describe.each(['codex', 'gemini'])('%s (native -s = --sandbox)', (agent) => {
    it('forwards short -s with its value and the trailing stdin marker', async () => {
      const agentArgs = await runCli(agent, ['exec', '-s', 'read-only', '-']);

      expect(agentArgs).toEqual(['exec', '-s', 'read-only', '-']);
      expect(setSilentMode).not.toHaveBeenCalled();
    });

    it('forwards long --sandbox with its value and the trailing stdin marker', async () => {
      const agentArgs = await runCli(agent, ['exec', '--sandbox', 'read-only', '-']);

      expect(agentArgs).toEqual(['exec', '--sandbox', 'read-only', '-']);
      expect(setSilentMode).not.toHaveBeenCalled();
    });

    it('enables wrapper silent mode via --silent without swallowing a following -s', async () => {
      const agentArgs = await runCli(agent, ['--silent', 'exec', '-s', 'read-only', '-']);

      expect(setSilentMode).toHaveBeenCalledWith(true);
      expect(agentArgs).toEqual(['exec', '-s', 'read-only', '-']);
      expect(agentArgs).not.toContain('--silent');
    });

    it('forwards the full T3 commit-generation pattern, consuming only --profile and --model', async () => {
      const agentArgs = await runCli(agent, [
        '--profile', 'work',
        '--model', 'gpt-5-mini',
        'exec',
        '-s', 'read-only',
        '-',
      ]);

      expect(agentArgs).toEqual(['exec', '-s', 'read-only', '-']);
    });
  });

  it('gemini forwards -s as a bare boolean sandbox flag before -p', async () => {
    const agentArgs = await runCli('gemini', ['-s', '-p', 'hello']);

    expect(agentArgs).toEqual(['-s', '-p', 'hello']);
    expect(setSilentMode).not.toHaveBeenCalled();
  });

  describe.each(['claude', 'opencode'])('%s (-s remains the wrapper silent flag)', (agent) => {
    it('consumes -s as silent mode and does not forward it', async () => {
      const agentArgs = await runCli(agent, ['-s', 'chat']);

      expect(setSilentMode).toHaveBeenCalledWith(true);
      expect(agentArgs).not.toContain('-s');
      expect(agentArgs).toEqual(['chat']);
    });

    it('still accepts --silent', async () => {
      const agentArgs = await runCli(agent, ['--silent', 'chat']);

      expect(setSilentMode).toHaveBeenCalledWith(true);
      expect(agentArgs).toEqual(['chat']);
    });
  });
});
