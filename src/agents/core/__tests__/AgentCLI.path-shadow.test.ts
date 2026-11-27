import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import type { ShadowVerdict } from '../../../utils/path-shadow.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { logger } from '../../../utils/logger.js';

// Launch-time PATH shadow reporting (EPMCDME-16969): handleRun consults
// adapter.checkPathShadow() and reports on stderr only.

const MANAGED = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const ACTIVE = 'C:\\Tools\\bin\\pi.cmd';

function makeAdapter(opts: {
  installed: boolean;
  verdict?: ShadowVerdict | 'throw' | 'absent';
  run: ReturnType<typeof vi.fn>;
}): AgentAdapter {
  const adapter: Record<string, unknown> = {
    name: 'pi',
    displayName: 'Pi',
    description: 'test',
    metadata: {
      name: 'pi',
      displayName: 'Pi',
      description: 'test',
      npmPackage: '@scope/pi',
      cliCommand: 'pi',
      envMapping: {},
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => opts.installed,
    run: opts.run,
    setSilentMode: vi.fn(),
    getVersion: async () => '1.0.0',
    getMetricsConfig: () => undefined,
  };
  if (opts.verdict !== 'absent') {
    adapter.checkPathShadow = vi.fn(async () => {
      if (opts.verdict === 'throw') throw new Error('boom');
      return opts.verdict ?? { status: 'unknown' };
    });
  }
  return adapter as unknown as AgentAdapter;
}

describe('AgentCLI launch PATH shadow reporting', () => {
  const origStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const origStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  let run: ReturnType<typeof vi.fn>;
  let errors: string[];
  let stdout: string[];

  function restoreTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, desc?: PropertyDescriptor): void {
    if (desc) Object.defineProperty(stream, 'isTTY', desc);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }

  async function launch(adapter: AgentAdapter): Promise<void> {
    const cli = new AgentCLI(adapter);
    await cli.run(['node', 'codemie-pi']);
  }

  beforeEach(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setAgentName').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setProfileName').mockImplementation(() => undefined);
    vi.spyOn(ConfigLoader, 'load').mockResolvedValue({
      name: 'default', provider: 'litellm', model: 'm', baseUrl: 'https://example.invalid',
      apiKey: 'k', timeout: 0, debug: false, allowedDirs: [], ignorePatterns: [],
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({ CODEMIE_API_KEY: 'k' });
    vi.spyOn(ConfigLoader, 'hasGlobalConfig').mockResolvedValue(true);
    vi.spyOn(ConfigLoader, 'hasLocalConfig').mockResolvedValue(true);
    vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: true } as never);
    vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    errors = [];
    stdout = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    run = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreTTY(process.stdin, origStdinTTY);
    restoreTTY(process.stdout, origStdoutTTY);
    vi.restoreAllMocks();
  });

  it('warns on stderr about the active location before the agent starts when shadowed', async () => {
    let errorsAtRun = '';
    run.mockImplementation(async () => { errorsAtRun = errors.join('\n'); });
    await launch(makeAdapter({ installed: true, verdict: { status: 'shadowed', active: ACTIVE, managedDir: MANAGED }, run }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(errorsAtRun).toContain('shadows the CodeMie-managed');
    expect(errorsAtRun).toContain(ACTIVE);
    expect(stdout.join('\n')).not.toContain('shadows');
  });

  it('prints the not-on-PATH hint instead of the bare install block', async () => {
    const adapter = makeAdapter({
      installed: false,
      verdict: { status: 'missing-on-path', managedDir: MANAGED, shimPath: `${MANAGED}\\pi.cmd` },
      run,
    });
    await expect(launch(adapter)).rejects.toThrow('exit:1');

    const out = errors.join('\n');
    expect(out).toContain('Agent not found on PATH');
    expect(out).toContain(`${MANAGED}\\pi.cmd`);
    expect(out).not.toContain('is not installed');
    expect(out).not.toContain('Install it with');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the existing install block when the verdict is missing', async () => {
    await expect(launch(makeAdapter({ installed: false, verdict: { status: 'missing' }, run }))).rejects.toThrow('exit:1');

    const out = errors.join('\n');
    expect(out).toContain('Pi is not installed');
    expect(out).toContain('Install it with');
    expect(out).not.toContain('not found on PATH');
  });

  it('prints nothing extra when clear', async () => {
    await launch(makeAdapter({ installed: true, verdict: { status: 'clear' }, run }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(errors.join('\n')).not.toContain('shadows');
  });

  it('treats a throwing or absent checkPathShadow as unknown', async () => {
    await launch(makeAdapter({ installed: true, verdict: 'throw', run }));
    await launch(makeAdapter({ installed: true, verdict: 'absent', run }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(errors.join('\n')).not.toContain('shadows');
  });

  it('asks for the verdict once, without resolving the npm prefix', async () => {
    const adapter = makeAdapter({ installed: true, verdict: { status: 'clear' }, run });
    await launch(adapter);
    expect(adapter.checkPathShadow).toHaveBeenCalledTimes(1);
    expect(adapter.checkPathShadow).toHaveBeenCalledWith();
  });
});
