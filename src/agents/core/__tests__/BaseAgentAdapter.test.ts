import { describe, it, expect, vi } from 'vitest';
import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import type { AgentMetadata } from '../types.js';

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
});
