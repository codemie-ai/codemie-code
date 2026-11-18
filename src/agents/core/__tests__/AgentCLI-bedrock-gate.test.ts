/**
 * Claude launcher gate: an inherited Bedrock flag is dropped from the codemie-claude process itself, and
 * the settings conflict gate runs before auth (switch applied just before the provider env export).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';

const gate = vi.hoisted(() => ({
  detectAndAsk: vi.fn(),
  applyConsented: vi.fn(),
}));

vi.mock('../../plugins/claude/cloud-provider-conflict/gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plugins/claude/cloud-provider-conflict/gate.js')>();
  return { ...actual, detectAndAsk: gate.detectAndAsk, applyConsented: gate.applyConsented };
});

class ExitError extends Error {
  constructor(public code?: string | number | null) {
    super(`process.exit:${code}`);
  }
}

const FLAG = 'CLAUDE_CODE_USE_BEDROCK';
const TOKEN = { plan: null, deps: {} };

type HandleRun = (args: string[], options: Record<string, unknown>) => Promise<void>;

function adapter(name: string, run: AgentAdapter['run']): AgentAdapter {
  return {
    name,
    displayName: name,
    description: 'bedrock gate test adapter',
    metadata: {
      name,
      displayName: name,
      description: 'bedrock gate test adapter',
      npmPackage: null,
      cliCommand: name,
      envMapping: {},
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

describe('AgentCLI.handleRun - Bedrock settings conflict gate', () => {
  let calls: string[];
  let validateAuth: ReturnType<typeof vi.fn>;
  let provider: string;

  beforeEach(() => {
    calls = [];
    provider = 'litellm';
    validateAuth = vi.fn(async () => {
      calls.push('auth');
      return { valid: true };
    });
    gate.detectAndAsk.mockReset().mockImplementation(async () => {
      calls.push('gate');
      return { kind: 'proceed', token: TOKEN };
    });
    gate.applyConsented.mockReset().mockImplementation(async () => {
      calls.push('apply');
      return { backupDir: null, files: [], changed: [] };
    });

    vi.spyOn(ConfigLoader, 'load').mockImplementation(
      async () =>
        ({
          name: 'default',
          provider,
          model: 'gpt-5',
          baseUrl: 'https://example.invalid',
          apiKey: 'test-key',
          timeout: 0,
          debug: false,
          allowedDirs: [],
          ignorePatterns: ['node_modules'],
        }) as Awaited<ReturnType<typeof ConfigLoader.load>>
    );
    vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockImplementation(() => {
      calls.push('export');
      return { CODEMIE_API_KEY: 'test-key' };
    });
    vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: true } as never);
    vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue({ validateAuth } as never);
    vi.stubEnv(FLAG, '1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env[FLAG];
  });

  function build(name: string, run: AgentAdapter['run']): HandleRun {
    const cli = new AgentCLI(adapter(name, run)) as unknown as {
      handleRun: HandleRun;
      validateCompatibility: (config: unknown) => boolean;
    };
    vi.spyOn(cli, 'validateCompatibility').mockImplementation(() => {
      calls.push('compat');
      return true;
    });
    return cli.handleRun.bind(cli);
  }

  function mockExit(): void {
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(code);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }

  it('removes the inherited flag from process.env and the env handed to the adapter for a non-Bedrock profile', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    await build('claude', run)([], {});

    expect(FLAG in process.env).toBe(false);
    expect(process.env[FLAG]).not.toBe('undefined');
    const env = run.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(env)).not.toContain(FLAG);
    expect(Object.values(env)).not.toContain('undefined');
  });

  it('leaves the flag alone and does not call the gate for a bedrock profile', async () => {
    provider = 'bedrock';
    const run = vi.fn().mockResolvedValue(undefined);

    await build('claude', run)([], {});

    expect(process.env[FLAG]).toBe('1');
    expect(gate.detectAndAsk).not.toHaveBeenCalled();
    expect(gate.applyConsented).not.toHaveBeenCalled();
  });

  it('leaves the flag alone and does not call the gate for a non-Claude agent', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    await build('codex', run)([], {});

    expect(process.env[FLAG]).toBe('1');
    expect(gate.detectAndAsk).not.toHaveBeenCalled();
    expect(gate.applyConsented).not.toHaveBeenCalled();
  });

  it('runs the gate before auth and applies the consent after compatibility, before the env export', async () => {
    await build('claude', vi.fn().mockResolvedValue(undefined))([], {});

    expect(calls).toEqual(['gate', 'auth', 'compat', 'apply', 'export']);
    expect(gate.detectAndAsk).toHaveBeenCalledWith(
      expect.objectContaining({ flow: 'claude-agent', profile: expect.objectContaining({ provider: 'litellm' }) })
    );
    expect(gate.applyConsented).toHaveBeenCalledWith(TOKEN);
  });

  it('prints the guidance, exits 1 from AgentCLI and never reaches auth on a stop outcome', async () => {
    mockExit();
    gate.detectAndAsk.mockResolvedValue({ kind: 'stop', reason: 'managed', guidance: 'GUIDANCE-TEXT' });
    const run = vi.fn().mockResolvedValue(undefined);

    await expect(build('claude', run)([], {})).rejects.toMatchObject({ code: 1 });

    const printed = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join('\n');
    expect(printed).toContain('GUIDANCE-TEXT');
    expect(validateAuth).not.toHaveBeenCalled();
    expect(gate.applyConsented).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('passes canPrompt=false for the ACP agent and for a --task run', async () => {
    await build('claude-acp', vi.fn().mockResolvedValue(undefined))([], {});
    expect(gate.detectAndAsk).toHaveBeenLastCalledWith(expect.objectContaining({ canPrompt: false }));

    await build('claude', vi.fn().mockResolvedValue(undefined))([], { task: 'x' });
    expect(gate.detectAndAsk).toHaveBeenLastCalledWith(expect.objectContaining({ canPrompt: false }));
  });

  it('passes canPrompt=false for --silent at a terminal, and true for a plain interactive run', async () => {
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.stubEnv('CODEMIE_NO_PROMPTS', '');
    try {
      await build('claude', vi.fn().mockResolvedValue(undefined))([], {});
      expect(gate.detectAndAsk).toHaveBeenLastCalledWith(expect.objectContaining({ canPrompt: true }));

      await build('claude', vi.fn().mockResolvedValue(undefined))([], { silent: true });
      expect(gate.detectAndAsk).toHaveBeenLastCalledWith(expect.objectContaining({ canPrompt: false }));
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('prints the backup folder when a launch step fails after the switch was applied', async () => {
    mockExit();
    gate.applyConsented.mockResolvedValue({ backupDir: '/tmp/backup-dir', files: [], changed: [] });
    const run = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(build('claude', run)([], {})).rejects.toMatchObject({ code: 1 });

    const printed = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(printed).toContain('Backup of your Claude settings: /tmp/backup-dir');
  });
});
