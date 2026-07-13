import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { getCommandPath } from '../../../utils/processes.js';
import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import type { AgentMetadata } from '../types.js';
import { logger } from '../../../utils/logger.js';

// Provide a minimal ProviderRegistry stub so shouldUseProxy can look up authType
// without needing real provider templates to be registered.
// registerProvider / registerSetupSteps / registerHealthCheck must also be stubbed
// because provider templates call them as side-effects when their modules are imported
// transitively through BaseAgentAdapter.
vi.mock('../../../providers/core/registry.js', () => {
  const providers: Record<string, { authType: string }> = {
    'anthropic-subscription': { authType: 'none' },
    'ai-run-sso':             { authType: 'sso' },
    'bearer-auth':            { authType: 'jwt' },
  };
  return {
    ProviderRegistry: {
      registerProvider:    vi.fn((t: any) => t),
      registerSetupSteps:  vi.fn(),
      registerHealthCheck: vi.fn(),
      registerModelProxy:  vi.fn(),
      getProvider:         vi.fn((name: string) => providers[name]),
      getProviderNames:    vi.fn(() => Object.keys(providers)),
    },
  };
});

// --- Mocks required for the run() pipeline ---

const mockApplyReasoningEffort = vi.fn((args: string[]) => ({ args }));
vi.mock('../reasoning-effort.js', () => ({
  applyReasoningEffort: (...callArgs: any[]) => mockApplyReasoningEffort(callArgs[0]),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setSessionId: vi.fn(),
    setAgentName: vi.fn(),
    setProfileName: vi.fn(),
  },
}));

vi.mock('../../../utils/processes.js', () => ({
  detectGitBranch:    vi.fn(() => Promise.resolve(null)),
  detectGitRemoteRepo: vi.fn(() => Promise.resolve(null)),
  exec:               vi.fn(),
  installGlobal:      vi.fn(),
  uninstallGlobal:    vi.fn(),
  getCommandPath:     vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../../utils/profile.js', () => ({
  renderProfileInfo: vi.fn(() => ''),
}));

vi.mock('../../../utils/goodbye-messages.js', () => ({
  getRandomWelcomeMessage: vi.fn(() => 'Welcome'),
  getRandomGoodbyeMessage: vi.fn(() => 'Goodbye'),
}));

vi.mock('../../../cli/commands/skills/setup/sync.js', () => ({
  syncRegisteredSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lifecycle-helpers.js', () => ({
  executeOnSessionStart: vi.fn(() => Promise.resolve()),
  executeBeforeRun:      vi.fn((_adapter: any, _lifecycle: any, _name: any, env: any) => Promise.resolve(env)),
  executeEnrichArgs:     vi.fn((_lifecycle: any, _name: any, args: any) => Promise.resolve(args)),
  executeOnSessionEnd:   vi.fn(() => Promise.resolve()),
  executeAfterRun:       vi.fn(() => Promise.resolve()),
}));

vi.mock('../flag-transform.js', () => ({
  transformFlags: vi.fn((_args: any, _mappings: any) => _args),
}));

// Spy-able spawn that immediately resolves with exit code 0 via the 'exit' event
const mockSpawnedProcess = {
  kill: vi.fn(),
  on: vi.fn((event: string, cb: (code: number) => void) => {
    if (event === 'exit') setImmediate(() => cb(0));
  }),
};
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => mockSpawnedProcess),
  };
});

// Stub CodeMieProxy so setupProxy doesn't try to start a real proxy server
vi.mock('../../../providers/plugins/sso/index.js', () => ({
  CodeMieProxy: vi.fn().mockImplementation(() => ({
    start: vi.fn(() => Promise.resolve()),
    stop:  vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock('../../../utils/mcp-config.js', () => ({
  getMCPConfigSummary: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../../utils/extensions-scan.js', () => ({
  getExtensionsScanSummary: vi.fn(() => Promise.resolve(null)),
}));

/**
 * Test adapter that extends BaseAgentAdapter
 * Used to test protected methods and metadata access
 */
class TestAdapter extends BaseAgentAdapter {
  constructor(metadata: AgentMetadata) {
    super(metadata);
  }

  // Expose protected metadata for testing
  getMetadata(): AgentMetadata {
    return this.metadata;
  }

  // Implement required abstract methods (no-ops for testing)
  async run(): Promise<void> {
    // No-op for testing
  }
}

describe('BaseAgentAdapter', () => {
  describe('setSilentMode', () => {
    it('should set silentMode to true when enabled', () => {
      const metadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping: {},
        supportedProviders: ['openai'],
        silentMode: false // Start as false
      };

      const adapter = new TestAdapter(metadata);

      // Initial state
      expect(adapter.getMetadata().silentMode).toBe(false);

      // Call setter
      adapter.setSilentMode(true);

      // Verify it changed
      expect(adapter.getMetadata().silentMode).toBe(true);
    });

    it('should set silentMode to false when disabled', () => {
      const metadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping: {},
        supportedProviders: ['openai'],
        silentMode: true // Start as true
      };

      const adapter = new TestAdapter(metadata);

      // Initial state
      expect(adapter.getMetadata().silentMode).toBe(true);

      // Call setter
      adapter.setSilentMode(false);

      // Verify it changed
      expect(adapter.getMetadata().silentMode).toBe(false);
    });

    it('should not affect original metadata object (verify cloning)', () => {
      const originalMetadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping: {},
        supportedProviders: ['openai'],
        silentMode: false
      };

      const adapter = new TestAdapter(originalMetadata);

      // Modify via setter
      adapter.setSilentMode(true);

      // Original should be unchanged (verify shallow copy worked)
      expect(originalMetadata.silentMode).toBe(false);
      expect(adapter.getMetadata().silentMode).toBe(true);
    });
  });

  describe('constructor metadata cloning', () => {
    it('should create a shallow copy of metadata', () => {
      const envMapping = { apiKey: ['TEST_KEY'] };
      const lifecycle = {
        beforeRun: async (env: NodeJS.ProcessEnv) => env
      };

      const metadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping,
        supportedProviders: ['openai'],
        lifecycle
      };

      const adapter = new TestAdapter(metadata);

      // Top-level object should be different (cloned)
      expect(adapter.getMetadata()).not.toBe(metadata);

      // Nested objects should be same reference (shallow copy)
      expect(adapter.getMetadata().envMapping).toBe(envMapping);
      expect(adapter.getMetadata().lifecycle).toBe(lifecycle);
    });
  });

  describe('proxy selection', () => {
    // Shared metadata with ssoConfig enabled (same as the real claude plugin)
    const proxyCapableMetadata: AgentMetadata = {
      name: 'test',
      displayName: 'Test Agent',
      description: 'Test agent for unit testing',
      npmPackage: null,
      cliCommand: null,
      envMapping: {},
      supportedProviders: ['anthropic-subscription', 'ai-run-sso', 'bearer-auth'],
      ssoConfig: { enabled: true, clientType: 'codemie-claude' },
    };

    it('does not enable the model proxy just because CodeMie analytics sync is configured', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);

      expect((adapter as any).shouldUseProxy({
        CODEMIE_PROVIDER: 'anthropic-subscription',
        CODEMIE_URL: 'https://codemie.lab.epam.com',
        CODEMIE_SYNC_API_URL: 'https://codemie.lab.epam.com/code-assistant-api',
      })).toBe(false);
    });

    it('does not start proxy for authType:none even when CODEMIE_AUTH_METHOD=jwt is stale in env', () => {
      // Regression guard for the stale-env contamination bug:
      // A previous JWT session writes CODEMIE_AUTH_METHOD=jwt to process.env.
      // The next anthropic-subscription run must NOT start the proxy.
      const adapter = new TestAdapter(proxyCapableMetadata);

      expect((adapter as any).shouldUseProxy({
        CODEMIE_PROVIDER: 'anthropic-subscription',
        CODEMIE_AUTH_METHOD: 'jwt',   // stale value from a prior JWT session
        CODEMIE_URL: 'https://codemie.lab.epam.com',
        CODEMIE_SYNC_API_URL: 'https://codemie.lab.epam.com/code-assistant-api',
      })).toBe(false);
    });

    it('does not start proxy when CODEMIE_PROVIDER is absent', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);
      expect((adapter as any).shouldUseProxy({})).toBe(false);
    });

    it('starts proxy for SSO provider when ssoConfig is enabled', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);

      expect((adapter as any).shouldUseProxy({
        CODEMIE_PROVIDER: 'ai-run-sso',
      })).toBe(true);
    });

    it('starts proxy for JWT auth method on a non-native provider', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);

      expect((adapter as any).shouldUseProxy({
        CODEMIE_PROVIDER: 'bearer-auth',
        CODEMIE_AUTH_METHOD: 'jwt',
      })).toBe(true);
    });

    it('does not start proxy when ssoConfig is disabled even for an SSO provider', () => {
      const noProxyMetadata: AgentMetadata = {
        ...proxyCapableMetadata,
        ssoConfig: { enabled: false, clientType: 'codemie-claude' },
      };
      const adapter = new TestAdapter(noProxyMetadata);

      expect((adapter as any).shouldUseProxy({
        CODEMIE_PROVIDER: 'ai-run-sso',
      })).toBe(false);
    });
  });

  describe('buildProxyConfig authMethod guard', () => {
    const proxyCapableMetadata: AgentMetadata = {
      name: 'test',
      displayName: 'Test Agent',
      description: 'Test agent for unit testing',
      npmPackage: null,
      cliCommand: null,
      envMapping: {},
      supportedProviders: ['ai-run-sso'],
      ssoConfig: { enabled: true, clientType: 'codemie-claude' },
    };

    const baseEnv = {
      CODEMIE_BASE_URL: 'https://api.example.com',
      CODEMIE_PROVIDER: 'ai-run-sso',
    };

    it('maps sso auth method correctly', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);
      const config = (adapter as any).buildProxyConfig({
        ...baseEnv,
        CODEMIE_AUTH_METHOD: 'sso',
      });
      expect(config.authMethod).toBe('sso');
    });

    it('maps jwt auth method correctly', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);
      const config = (adapter as any).buildProxyConfig({
        ...baseEnv,
        CODEMIE_AUTH_METHOD: 'jwt',
      });
      expect(config.authMethod).toBe('jwt');
    });

    it('sets authMethod to undefined for manual auth method', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);
      const config = (adapter as any).buildProxyConfig({
        ...baseEnv,
        CODEMIE_AUTH_METHOD: 'manual',
      });
      expect(config.authMethod).toBeUndefined();
    });

    it('sets authMethod to undefined when CODEMIE_AUTH_METHOD is not set', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);
      const config = (adapter as any).buildProxyConfig(baseEnv);
      expect(config.authMethod).toBeUndefined();
    });

    it('sets authMethod to undefined for unknown auth methods', () => {
      const adapter = new TestAdapter(proxyCapableMetadata);
      const config = (adapter as any).buildProxyConfig({
        ...baseEnv,
        CODEMIE_AUTH_METHOD: 'api-key',
      });
      expect(config.authMethod).toBeUndefined();
    });
  });

  describe('reasoning effort injection', () => {
    // A minimal adapter that delegates to BaseAgentAdapter.run() so the injection
    // code path is exercised. It uses isBuiltIn=false + cliCommand so the spawn
    // path (where transformedArgs is consumed) is taken. spawn itself is mocked.
    class RunPipelineAdapter extends BaseAgentAdapter {
      // Expose metadata for assertions
      getMetadata(): AgentMetadata { return this.metadata; }
    }

    const effortMetadata: AgentMetadata = {
      name: 'effort-agent',
      displayName: 'Effort Agent',
      description: 'Agent with reasoningEffort config',
      npmPackage: null,
      cliCommand: 'effort-agent-bin',
      envMapping: {},
      supportedProviders: ['anthropic-subscription'],
      silentMode: true,
      reasoningEffort: {
        strategy: 'cli-flag',
        flag: '--effort',
        supportedLevels: ['low', 'medium', 'high'],
      },
    };

    beforeEach(() => {
      vi.clearAllMocks();
      // Default: applyReasoningEffort passes args through unchanged
      mockApplyReasoningEffort.mockImplementation((args: string[]) => ({ args }));
      // Clean up any CODEMIE_REASONING_EFFORT that leaked into process.env from a
      // previous test (BaseAgentAdapter.run() calls Object.assign(process.env, env))
      delete process.env['CODEMIE_REASONING_EFFORT'];
    });

    it('calls applyReasoningEffort when metadata.reasoningEffort is defined and CODEMIE_REASONING_EFFORT is set', async () => {
      const adapter = new RunPipelineAdapter(effortMetadata);

      await adapter.run([], { CODEMIE_REASONING_EFFORT: 'high' });

      expect(mockApplyReasoningEffort).toHaveBeenCalledOnce();
      // First positional arg to the mock is the args array
      expect(mockApplyReasoningEffort).toHaveBeenCalledWith(expect.any(Array));
    });

    it('does not call applyReasoningEffort when CODEMIE_REASONING_EFFORT is absent', async () => {
      const adapter = new RunPipelineAdapter(effortMetadata);

      await adapter.run([], {});

      expect(mockApplyReasoningEffort).not.toHaveBeenCalled();
    });

    it('does not call applyReasoningEffort when metadata.reasoningEffort is not declared', async () => {
      const noEffortMetadata: AgentMetadata = {
        ...effortMetadata,
        reasoningEffort: undefined,
      };
      const adapter = new RunPipelineAdapter(noEffortMetadata);

      await adapter.run([], { CODEMIE_REASONING_EFFORT: 'high' });

      expect(mockApplyReasoningEffort).not.toHaveBeenCalled();
    });

    it('logs a warning when CODEMIE_REASONING_EFFORT is set but metadata.reasoningEffort is absent', async () => {
      const noEffortMetadata: AgentMetadata = {
        ...effortMetadata,
        reasoningEffort: undefined,
      };
      const adapter = new RunPipelineAdapter(noEffortMetadata);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Should complete without throwing (warn-and-continue path, spec §6.4)
        await expect(adapter.run([], { CODEMIE_REASONING_EFFORT: 'high' })).resolves.toBeUndefined();

        // logger.warn must have been called with a message mentioning the agent is not supported
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('not supported'),
        );

        // console.error (yellow chalk warning) must also have been called
        expect(consoleErrorSpy).toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('run() — Windows command path quoting', () => {
    class RunPathAdapter extends BaseAgentAdapter {}

    const baseMetadata: AgentMetadata = {
      name: 'path-agent',
      displayName: 'Path Agent',
      description: 'Windows path quoting tests',
      npmPackage: null,
      cliCommand: null,
      envMapping: {},
      supportedProviders: ['anthropic-subscription'],
      silentMode: true,
    };

    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      // Force Windows detection regardless of host OS so tests are portable
      platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as NodeJS.Platform);
      delete process.env['CODEMIE_REASONING_EFFORT'];
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it('wraps commandPath in double-quotes when getCommandPath returns null and path contains (', async () => {
      const spawnMock = vi.mocked(spawn);

      const adapter = new RunPathAdapter({
        ...baseMetadata,
        cliCommand: 'C:\\Users\\Name(Org\\bin\\cmd.exe',
      });

      await adapter.run([], {});

      expect(spawnMock).toHaveBeenCalledWith(
        '"C:\\Users\\Name(Org\\bin\\cmd.exe"',
        [],
        expect.objectContaining({ shell: true }),
      );
    });

    it.each([
      [' ', 'space'],
      ['\t', 'tab'],
      [',', 'comma'],
      [';', 'semicolon'],
      ['=', 'equals'],
      ['(', 'open paren'],
      [')', 'close paren'],
      ['&', 'ampersand'],
      ['|', 'pipe'],
      ['<', 'less-than'],
      ['>', 'greater-than'],
      ['^', 'caret'],
      ['%', 'percent'],
      ['[', 'open bracket'],
      [']', 'close bracket'],
      ['{', 'open brace'],
      ['}', 'close brace'],
    ])('wraps commandPath in double-quotes when path contains %s (%s)', async (char) => {
      const spawnMock = vi.mocked(spawn);

      const adapter = new RunPathAdapter({
        ...baseMetadata,
        cliCommand: `C:\\Users\\Name${char}Org\\bin\\cmd.exe`,
      });

      await adapter.run([], {});

      expect(spawnMock).toHaveBeenCalledWith(
        `"C:\\Users\\Name${char}Org\\bin\\cmd.exe"`,
        [],
        expect.objectContaining({ shell: true }),
      );
    });

    it('leaves commandPath unchanged when path has no CMD.EXE metacharacters', async () => {
      const spawnMock = vi.mocked(spawn);

      const adapter = new RunPathAdapter({
        ...baseMetadata,
        cliCommand: 'C:\\Users\\Normal\\bin\\cmd.exe',
      });

      await adapter.run([], {});

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Users\\Normal\\bin\\cmd.exe',
        [],
        expect.objectContaining({ shell: true }),
      );
    });

    it('does not double-quote when getCommandPath returns a path that already contains ( (existing branch quotes it once)', async () => {
      const spawnMock = vi.mocked(spawn);
      vi.mocked(getCommandPath).mockResolvedValueOnce('C:\\Users\\Name(Org\\bin\\cmd.exe');

      const adapter = new RunPathAdapter({
        ...baseMetadata,
        cliCommand: 'C:\\Users\\Name(Org\\bin\\cmd.exe',
      });

      await adapter.run([], {});

      const firstArg = spawnMock.mock.calls[0]?.[0] as string;
      // Quoted exactly once — starts with " but not ""
      expect(firstArg).toBe('"C:\\Users\\Name(Org\\bin\\cmd.exe"');
      expect(firstArg.startsWith('""')).toBe(false);
    });
  });
});
