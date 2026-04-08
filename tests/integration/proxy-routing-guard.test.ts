/**
 * Integration tests: proxy routing guard for anthropic-subscription
 *
 * Regression suite for the stale-CODEMIE_AUTH_METHOD bug:
 *
 *   A previous JWT-authenticated session writes CODEMIE_AUTH_METHOD=jwt to
 *   process.env via Object.assign(process.env, env) in BaseAgentAdapter.run().
 *   The next anthropic-subscription run must NOT start the CodeMie proxy even
 *   though the stale env var is present.
 *
 * Two defences are exercised together (as in production):
 *   1. exportProviderEnvVars always emits CODEMIE_AUTH_METHOD so envOverrides
 *      always wins over stale process.env values.
 *   2. shouldUseProxy early-returns false for providers with authType === 'none'.
 *
 * @group integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../../src/utils/config.js';
import { BaseAgentAdapter } from '../../src/agents/core/BaseAgentAdapter.js';
import type { AgentMetadata } from '../../src/agents/core/types.js';

// Importing the template registers anthropic-subscription in ProviderRegistry
// so that shouldUseProxy can resolve its authType without mocks.
import '../../src/providers/plugins/anthropic-subscription/index.js';

// ---------------------------------------------------------------------------
// Minimal concrete adapter used to call the private shouldUseProxy method
// ---------------------------------------------------------------------------
class TestAdapter extends BaseAgentAdapter {
  async run(): Promise<void> { /* no-op */ }

  callShouldUseProxy(env: NodeJS.ProcessEnv): boolean {
    return (this as any).shouldUseProxy(env);
  }
}

const adapterMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Test adapter',
  npmPackage: null,
  cliCommand: null,
  envMapping: { baseUrl: ['ANTHROPIC_BASE_URL'], apiKey: ['ANTHROPIC_AUTH_TOKEN'] },
  supportedProviders: ['anthropic-subscription', 'ai-run-sso', 'bearer-auth'],
  ssoConfig: { enabled: true, clientType: 'codemie-claude' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const STALE_JWT_ENV: NodeJS.ProcessEnv = { CODEMIE_AUTH_METHOD: 'jwt' };

const ANTHROPIC_SUBSCRIPTION_CONFIG = {
  provider: 'anthropic-subscription',
  baseUrl: 'https://api.anthropic.com',
  apiKey: '',
  authMethod: 'manual' as const,
  model: 'claude-sonnet-4-6',
  codeMieUrl: 'https://codemie.lab.epam.com',
  codeMieProject: 'my-project',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Proxy routing guard — anthropic-subscription with stale JWT env', () => {
  let savedAuthMethod: string | undefined;

  beforeEach(() => {
    savedAuthMethod = process.env.CODEMIE_AUTH_METHOD;
  });

  afterEach(() => {
    if (savedAuthMethod === undefined) {
      delete process.env.CODEMIE_AUTH_METHOD;
    } else {
      process.env.CODEMIE_AUTH_METHOD = savedAuthMethod;
    }
  });

  it('exportProviderEnvVars emits CODEMIE_AUTH_METHOD=manual for anthropic-subscription', () => {
    const providerEnv = ConfigLoader.exportProviderEnvVars(ANTHROPIC_SUBSCRIPTION_CONFIG);
    expect(providerEnv.CODEMIE_AUTH_METHOD).toBe('manual');
  });

  it('merging exportProviderEnvVars over stale process.env neutralises CODEMIE_AUTH_METHOD=jwt', () => {
    const providerEnv = ConfigLoader.exportProviderEnvVars(ANTHROPIC_SUBSCRIPTION_CONFIG);

    // Replicate what BaseAgentAdapter.run() does at line ~471
    const mergedEnv: NodeJS.ProcessEnv = { ...STALE_JWT_ENV, ...providerEnv };

    expect(mergedEnv.CODEMIE_AUTH_METHOD).toBe('manual');
  });

  it('shouldUseProxy returns false for anthropic-subscription even when CODEMIE_AUTH_METHOD=jwt is stale in process.env', () => {
    // Simulate a stale env from a previous JWT session
    process.env.CODEMIE_AUTH_METHOD = 'jwt';

    const providerEnv = ConfigLoader.exportProviderEnvVars(ANTHROPIC_SUBSCRIPTION_CONFIG);

    // Replicate BaseAgentAdapter.run() env assembly
    const env: NodeJS.ProcessEnv = { ...process.env, ...providerEnv };

    const adapter = new TestAdapter(adapterMetadata);
    expect(adapter.callShouldUseProxy(env)).toBe(false);
  });

  it('shouldUseProxy returns false for anthropic-subscription even with explicit CODEMIE_AUTH_METHOD=jwt in env', () => {
    // Defence-in-depth: authType:none guard fires before isJWTAuth is checked
    const env: NodeJS.ProcessEnv = {
      CODEMIE_PROVIDER: 'anthropic-subscription',
      CODEMIE_AUTH_METHOD: 'jwt',
    };

    const adapter = new TestAdapter(adapterMetadata);
    expect(adapter.callShouldUseProxy(env)).toBe(false);
  });

  it('shouldUseProxy still returns true for an SSO provider (regression)', () => {
    const env: NodeJS.ProcessEnv = { CODEMIE_PROVIDER: 'ai-run-sso' };

    const adapter = new TestAdapter(adapterMetadata);
    expect(adapter.callShouldUseProxy(env)).toBe(true);
  });

  it('shouldUseProxy still returns true for bearer-auth with CODEMIE_AUTH_METHOD=jwt (regression)', () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_PROVIDER: 'bearer-auth',
      CODEMIE_AUTH_METHOD: 'jwt',
    };

    const adapter = new TestAdapter(adapterMetadata);
    expect(adapter.callShouldUseProxy(env)).toBe(true);
  });
});
