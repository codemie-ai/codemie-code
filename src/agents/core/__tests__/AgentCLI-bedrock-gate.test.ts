/**
 * Provider-settings check on launch: AgentCLI asks the adapter's optional `checkProviderSettings` hook
 * before auth and applies the agreed switch just before the provider env export. Core knows nothing about
 * which agent implements the hook or what it checks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter, ProviderSettingsCheckInput, ProviderSettingsCheckOutcome } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';

class ExitError extends Error {
  constructor(public code?: string | number | null) {
    super(`process.exit:${code}`);
  }
}

type HandleRun = (args: string[], options: Record<string, unknown>) => Promise<void>;

function adapter(name: string, run: AgentAdapter['run'], check?: AgentAdapter['checkProviderSettings']): AgentAdapter {
  return {
    name,
    displayName: name,
    description: 'provider settings check test adapter',
    metadata: {
      name,
      displayName: name,
      description: 'provider settings check test adapter',
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
    warnOnceIfUntested: async () => {},
    ...(check ? { checkProviderSettings: check } : {}),
  };
}

describe('AgentCLI.handleRun - provider settings check', () => {
  let calls: string[];
  let validateAuth: ReturnType<typeof vi.fn>;
  let provider: string;
  let check: ReturnType<typeof vi.fn<(input: ProviderSettingsCheckInput) => Promise<ProviderSettingsCheckOutcome>>>;
  let apply: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    provider = 'litellm';
    validateAuth = vi.fn(async () => {
      calls.push('auth');
      return { valid: true };
    });
    apply = vi.fn(async () => {
      calls.push('apply');
      return { backupDir: null };
    });
    check = vi.fn(async () => {
      calls.push('check');
      return { kind: 'proceed' as const, apply };
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function build(run: AgentAdapter['run'], withCheck = true): HandleRun {
    const cli = new AgentCLI(adapter('test-agent', run, withCheck ? check : undefined)) as unknown as {
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

  it('runs the check before auth and applies the switch after compatibility, before the env export', async () => {
    await build(vi.fn().mockResolvedValue(undefined))([], {});

    expect(calls).toEqual(['check', 'auth', 'compat', 'apply', 'export']);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ flow: 'launch', profile: expect.objectContaining({ provider: 'litellm' }) })
    );
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('runs no check for an adapter without the hook', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    await build(run, false)([], {});

    expect(calls).toEqual(['auth', 'compat', 'export']);
    expect(run).toHaveBeenCalled();
  });

  it('prints the guidance, exits 1 and never reaches auth on a stop outcome', async () => {
    mockExit();
    check.mockResolvedValue({ kind: 'stop', guidance: 'GUIDANCE-TEXT' });
    const run = vi.fn().mockResolvedValue(undefined);

    await expect(build(run)([], {})).rejects.toMatchObject({ code: 1 });

    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('GUIDANCE-TEXT');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('GUIDANCE-TEXT');
    expect(validateAuth).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('passes canPrompt=false for a --task run', async () => {
    await build(vi.fn().mockResolvedValue(undefined))([], { task: 'x' });
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ canPrompt: false }));
  });

  it('passes canPrompt=false for --silent at a terminal, and true for a plain interactive run', async () => {
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.stubEnv('CODEMIE_NO_PROMPTS', '');
    try {
      await build(vi.fn().mockResolvedValue(undefined))([], {});
      expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ canPrompt: true }));

      await build(vi.fn().mockResolvedValue(undefined))([], { silent: true });
      expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ canPrompt: false }));
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('prints the backup folder when a launch step fails after the switch was applied', async () => {
    mockExit();
    apply.mockResolvedValue({ backupDir: '/tmp/backup-dir' });
    const run = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(build(run)([], {})).rejects.toMatchObject({ code: 1 });

    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('Backup of your test-agent settings: /tmp/backup-dir');
  });
});
