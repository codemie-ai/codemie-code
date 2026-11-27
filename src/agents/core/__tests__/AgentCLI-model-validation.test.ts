/**
 * AgentCLI.handleRun checks the model value for the Claude adapter only: `-m` wins over `CODEMIE_MODEL`
 * (whichever the launch actually uses), a bad one exits 1 before the agent starts, and the message names the
 * source, the rule and the length but never the value. The pre-handleRun options debug log never echoes it either.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { logger } from '../../../utils/logger.js';
import { MODEL_VALUE_CASES, leakProbe } from '../../../utils/__tests__/model-value-cases.js';
import { describeModelValueViolation, validateModelValue } from '../../../utils/model-value.js';

class ExitError extends Error {
  constructor(public code?: string | number | null) {
    super(`process.exit:${code}`);
  }
}

type HandleRun = (args: string[], options: Record<string, unknown>) => Promise<void>;

const GOOD_MODEL = 'claude-sonnet-4-5';
const TEXT_ROWS = MODEL_VALUE_CASES.filter(c => !c.nonText);
const BAD_ROWS = TEXT_ROWS.filter(c => !c.valid);
const GOOD_ROWS = TEXT_ROWS.filter(c => c.valid);

// A NUL cannot live in an environment variable: the OS truncates it, so such a value never reaches the launcher.
const survivesEnv = (value: unknown): boolean => !(value as string).includes(String.fromCharCode(0));

function createAdapter(name: string, run: AgentAdapter['run']): AgentAdapter {
  return {
    name,
    displayName: name,
    description: 'model value validation test adapter',
    metadata: {
      name,
      displayName: name,
      description: 'model value validation test adapter',
      npmPackage: null,
      cliCommand: name,
      envMapping: { model: ['ANTHROPIC_MODEL'] },
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => true,
    run,
    getVersion: async () => null,
    getMetricsConfig: () => undefined,
  };
}

function buildCli(name: string, run: AgentAdapter['run']): { cli: AgentCLI; handleRun: HandleRun } {
  const cli = new AgentCLI(createAdapter(name, run));
  const handleRun = (cli as unknown as { handleRun: HandleRun }).handleRun.bind(cli);
  return { cli, handleRun };
}

function mockDependencies(onLoad?: () => void): void {
  vi.spyOn(ConfigLoader, 'load').mockImplementation(async () => {
    onLoad?.();
    return {
      name: 'default',
      provider: 'ai-run-sso',
      model: GOOD_MODEL,
      baseUrl: 'https://example.invalid',
      apiKey: '',
      timeout: 0,
      debug: false,
      allowedDirs: [],
      ignorePatterns: ['node_modules'],
    } as Awaited<ReturnType<typeof ConfigLoader.load>>;
  });
  vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({
    CODEMIE_MODEL: GOOD_MODEL,
    CODEMIE_API_KEY: 'not-required',
  });
  vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: false } as never);
  vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
}

function outputOf(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.flat().map(arg => (arg instanceof Error ? arg.message : String(arg))).join('\n');
}

describe('AgentCLI.handleRun - model value validation', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('CODEMIE_MODEL', undefined);
    mockDependencies();
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(code);
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function expectRejected(row: { value: unknown }, source: string, run: ReturnType<typeof vi.fn>): void {
    const message = describeModelValueViolation(validateModelValue(row.value)!);
    for (const output of [outputOf(errorSpy), outputOf(loggerErrorSpy)]) {
      expect(output).toContain(`${source}: ${message}`);
      const probe = leakProbe(row.value as string);
      if (probe) expect(output).not.toContain(probe);
    }
    expect(run).not.toHaveBeenCalled();
  }

  describe.each(BAD_ROWS)('bad value: $name', row => {
    it('is rejected from --model with exit 1 and no echo of the value', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      await expect(buildCli('claude', run).handleRun([], { model: row.value })).rejects.toMatchObject({ code: 1 });
      expectRejected(row, '--model', run);
    });

    it.runIf(survivesEnv(row.value))('is rejected from CODEMIE_MODEL', async () => {
      vi.stubEnv('CODEMIE_MODEL', row.value as string);
      const run = vi.fn().mockResolvedValue(undefined);
      await expect(buildCli('claude', run).handleRun([], {})).rejects.toMatchObject({ code: 1 });
      expectRejected(row, 'CODEMIE_MODEL', run);
    });

    it.runIf(survivesEnv(row.value))('is rejected when CODEMIE_MODEL only appears after the .env file is loaded', async () => {
      mockDependencies(() => vi.stubEnv('CODEMIE_MODEL', row.value as string));
      const run = vi.fn().mockResolvedValue(undefined);
      await expect(buildCli('claude', run).handleRun([], {})).rejects.toMatchObject({ code: 1 });
      expectRejected(row, 'CODEMIE_MODEL', run);
    });
  });

  describe.each(GOOD_ROWS)('good value: $name', row => {
    it('launches from --model', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      await buildCli('claude', run).handleRun([], { model: row.value });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('launches from CODEMIE_MODEL', async () => {
      vi.stubEnv('CODEMIE_MODEL', row.value as string);
      const run = vi.fn().mockResolvedValue(undefined);
      await buildCli('claude', run).handleRun([], {});
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  it('lets a valid --model win over an invalid CODEMIE_MODEL', async () => {
    vi.stubEnv('CODEMIE_MODEL', 'bad model');
    const run = vi.fn().mockResolvedValue(undefined);
    await buildCli('claude', run).handleRun([], { model: GOOD_MODEL });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty --model as empty even when CODEMIE_MODEL is valid', async () => {
    vi.stubEnv('CODEMIE_MODEL', GOOD_MODEL);
    const run = vi.fn().mockResolvedValue(undefined);
    await expect(buildCli('claude', run).handleRun([], { model: '' })).rejects.toMatchObject({ code: 1 });
    expect(outputOf(errorSpy)).toContain('--model: Invalid model value: empty. Received length: 0.');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects an empty CODEMIE_MODEL as empty', async () => {
    vi.stubEnv('CODEMIE_MODEL', '');
    const run = vi.fn().mockResolvedValue(undefined);
    await expect(buildCli('claude', run).handleRun([], {})).rejects.toMatchObject({ code: 1 });
    expect(outputOf(errorSpy)).toContain('CODEMIE_MODEL: Invalid model value: empty. Received length: 0.');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not validate for another agent', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await buildCli('codex', run).handleRun([], { model: 'bad model' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('AgentCLI action - options debug log', () => {
  const MARKER = 'claude-sonnet-4-5-DEBUG-MARKER';
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function parse(name: string, argv: string[]): Promise<ReturnType<typeof vi.fn>> {
    const { cli } = buildCli(name, vi.fn());
    const handleRun = vi.fn().mockResolvedValue(undefined);
    (cli as unknown as { handleRun: unknown }).handleRun = handleRun;
    await (cli as unknown as { program: { parseAsync: (a: string[], o: { from: string }) => Promise<unknown> } })
      .program.parseAsync(argv, { from: 'user' });
    return handleRun;
  }

  it.each(['claude', 'codex'])('never echoes the model for %s and logs its length instead', async name => {
    await parse(name, ['-m', MARKER]);
    const output = outputOf(debugSpy);
    expect(output).not.toContain(MARKER);
    expect(output).toContain(`<length ${MARKER.length}>`);
  });

  it('hands handleRun an empty string for -m with an empty value', async () => {
    const handleRun = await parse('claude', ['-m', '']);
    expect(handleRun).toHaveBeenCalledTimes(1);
    expect(handleRun.mock.calls[0][1]).toMatchObject({ model: '' });
  });
});
