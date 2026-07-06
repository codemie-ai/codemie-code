import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentCLI, buildResumeEnvOverride, shouldBlockNonInteractiveResume } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import * as auditModule from '../session/session-origin-audit.js';
import { logger } from '../../../utils/logger.js';

class ExitError extends Error {
  constructor(public code?: string | number | null) {
    super(`process.exit:${code}`);
  }
}

function createAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'claude',
    displayName: 'Claude',
    description: 'Test adapter for resume flow',
    metadata: {
      name: 'claude',
      displayName: 'Claude',
      description: 'Test adapter for resume flow',
      npmPackage: null,
      cliCommand: 'claude',
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

function mockHandleRunDependencies(overrides: Record<string, unknown> = {}) {
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

describe('buildResumeEnvOverride', () => {
  it('returns CODEMIE_CONV_SYNC_DISABLED=1 for an external confirmed resume', () => {
    const env = buildResumeEnvOverride(true);
    expect(env).toEqual({ CODEMIE_CONV_SYNC_DISABLED: '1' });
  });

  it('returns empty object for a CodeMie-owned session', () => {
    const env = buildResumeEnvOverride(false);
    expect(env).toEqual({});
  });
});

describe('shouldBlockNonInteractiveResume', () => {
  let origNoPrompts: string | undefined;
  let origConvSyncDisabled: string | undefined;

  beforeEach(() => {
    origNoPrompts = process.env.CODEMIE_NO_PROMPTS;
    origConvSyncDisabled = process.env.CODEMIE_CONV_SYNC_DISABLED;
  });

  afterEach(() => {
    if (origNoPrompts === undefined) {
      delete process.env.CODEMIE_NO_PROMPTS;
    } else {
      process.env.CODEMIE_NO_PROMPTS = origNoPrompts;
    }

    if (origConvSyncDisabled === undefined) {
      delete process.env.CODEMIE_CONV_SYNC_DISABLED;
    } else {
      process.env.CODEMIE_CONV_SYNC_DISABLED = origConvSyncDisabled;
    }

    vi.restoreAllMocks();
  });

  it('returns true when CODEMIE_NO_PROMPTS=1', () => {
    process.env.CODEMIE_NO_PROMPTS = '1';
    expect(shouldBlockNonInteractiveResume()).toBe(true);
  });

  it('returns true when stdin is not a TTY (test environment default)', () => {
    delete process.env.CODEMIE_NO_PROMPTS;
    // In Vitest, process.stdin.isTTY is false/undefined — non-interactive by default
    expect(shouldBlockNonInteractiveResume()).toBe(true);
  });
});

describe('promptExternalResume', () => {
  it('prints the adapter-provided fallback resume command in non-interactive mode', async () => {
    const cli = new AgentCLI(createAdapter()) as unknown as {
      promptExternalResume: (sessionId: string, fallbackResumeCommand?: string) => Promise<boolean>;
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const confirmed = await cli.promptExternalResume('session-slug', 'test-agent resume session-slug');

    expect(confirmed).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Use 'test-agent resume session-slug' to resume without CodeMie tracking.")
    );

    errorSpy.mockRestore();
  });

  it('prints a generic native-agent fallback message when no fallback command is provided', async () => {
    const cli = new AgentCLI(createAdapter()) as unknown as {
      promptExternalResume: (sessionId: string, fallbackResumeCommand?: string) => Promise<boolean>;
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const confirmed = await cli.promptExternalResume('epmcdme-12992');

    expect(confirmed).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Resume without CodeMie tracking using the native agent CLI.')
    );

    errorSpy.mockRestore();
  });
});

describe('handleRun resume ownership flow', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setAgentName').mockImplementation(() => undefined);
    vi.spyOn(logger, 'setProfileName').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.CODEMIE_CONV_SYNC_DISABLED;
    vi.restoreAllMocks();
  });

  it('invokes the ownership resolver with the sanitized resume id, cwd, and env', async () => {
    mockHandleRunDependencies();
    const resolveResumeOwnership = vi.fn().mockResolvedValue({ supported: false });
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ resolveResumeOwnership, run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun(['--hello'], { resume: 'session-\u0007slug' });

    expect(resolveResumeOwnership).toHaveBeenCalledTimes(1);
    expect(resolveResumeOwnership).toHaveBeenCalledWith({
      resumeId: 'session-slug',
      cwd: process.cwd(),
      env: process.env,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('prompts, appends audit data, and injects the sync override for confirmed external resumes', async () => {
    mockHandleRunDependencies();
    const resolveResumeOwnership = vi.fn().mockResolvedValue({
      supported: true,
      owned: false,
      fallbackResumeCommand: 'claude --resume external-123',
      auditData: {
        source: 'native-cli',
        ownerCheck: 'marker-miss',
      },
    });
    const run = vi.fn().mockResolvedValue(undefined);
    const auditSpy = vi.spyOn(auditModule, 'appendAuditEvent').mockImplementation(() => {});
    const cli = new AgentCLI(createAdapter({ resolveResumeOwnership, run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
      promptExternalResume: (sessionId: string, fallbackResumeCommand?: string) => Promise<boolean>;
    };
    const promptSpy = vi.spyOn(cli, 'promptExternalResume').mockResolvedValue(true);

    await cli.handleRun([], { resume: 'external-123' });

    expect(promptSpy).toHaveBeenCalledWith('external-123', 'claude --resume external-123');
    expect(auditSpy).toHaveBeenCalledWith('resume_external_confirmed', {
      agent: 'claude',
      resumeId: 'external-123',
      source: 'native-cli',
      ownerCheck: 'marker-miss',
    });
    expect(run).toHaveBeenCalledWith(
      ['--resume', 'external-123'],
      expect.objectContaining({
        CODEMIE_CONV_SYNC_DISABLED: '1',
      }),
    );
    expect(process.env.CODEMIE_CONV_SYNC_DISABLED).toBeUndefined();
  });

  it('blocks unowned external resumes and records the blocked audit payload when confirmation is denied', async () => {
    mockHandleRunDependencies();
    const resolveResumeOwnership = vi.fn().mockResolvedValue({
      supported: true,
      owned: false,
      auditData: {
        source: 'native-cli',
      },
    });
    const run = vi.fn().mockResolvedValue(undefined);
    const auditSpy = vi.spyOn(auditModule, 'appendAuditEvent').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(code);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = new AgentCLI(createAdapter({ resolveResumeOwnership, run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
      promptExternalResume: (sessionId: string, fallbackResumeCommand?: string) => Promise<boolean>;
    };
    vi.spyOn(cli, 'promptExternalResume').mockResolvedValue(false);

    await expect(cli.handleRun([], { resume: 'external-456' })).rejects.toMatchObject({
      code: 1,
    });

    expect(auditSpy).toHaveBeenCalledWith('resume_blocked', {
      agent: 'claude',
      resumeId: 'external-456',
      source: 'native-cli',
    });
    expect(run).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('fails open when the ownership resolver throws and still runs without prompt or audit writes', async () => {
    mockHandleRunDependencies();
    const resolveResumeOwnership = vi.fn().mockRejectedValue(new Error('resolver boom'));
    const run = vi.fn().mockResolvedValue(undefined);
    const auditSpy = vi.spyOn(auditModule, 'appendAuditEvent').mockImplementation(() => {});
    const cli = new AgentCLI(createAdapter({ resolveResumeOwnership, run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
      promptExternalResume: (sessionId: string, fallbackResumeCommand?: string) => Promise<boolean>;
    };
    const promptSpy = vi.spyOn(cli, 'promptExternalResume').mockResolvedValue(true);

    await cli.handleRun([], { resume: 'resume-789' });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      ['--resume', 'resume-789'],
      expect.not.objectContaining({
        CODEMIE_CONV_SYNC_DISABLED: '1',
      }),
    );
  });
});
