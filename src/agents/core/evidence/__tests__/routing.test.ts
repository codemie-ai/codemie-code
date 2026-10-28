import { describe, it, expect, vi } from 'vitest';
import { BaseAgentAdapter } from '../../BaseAgentAdapter.js';
import type { AgentMetadata } from '../../types.js';
import { launchMode, routedViaCodemie, type RoutingInput } from '../routing.js';

vi.mock('../../../../providers/core/registry.js', () => {
  const providers: Record<string, { authType: string }> = {
    'anthropic-subscription': { authType: 'none' },
    'ai-run-sso': { authType: 'sso' },
  };
  return {
    ProviderRegistry: {
      registerProvider: vi.fn((t: unknown) => t),
      registerSetupSteps: vi.fn(),
      registerHealthCheck: vi.fn(),
      registerModelProxy: vi.fn(),
      getProvider: vi.fn((n: string) => providers[n]),
      getProviderNames: vi.fn(() => Object.keys(providers)),
    },
  };
});
vi.mock('../../../../providers/plugins/sso/index.js', () => ({
  CodeMieProxy: vi.fn().mockImplementation(function () {
    return { start: vi.fn(() => Promise.resolve({ port: 4567, url: 'http://127.0.0.1:4567' })), stop: vi.fn() };
  }),
}));

const GATEWAY = 'https://llm-gateway.example.com';
const ANALYTICS = 'https://codemie-api.example.com';
const meta: AgentMetadata = {
  name: 'test', displayName: 'T', description: 't', npmPackage: null, cliCommand: null, envMapping: {},
  supportedProviders: ['ai-run-sso'], ssoConfig: { enabled: true, clientType: 'codemie-claude' },
};
class TestAdapter extends BaseAgentAdapter {
  constructor() { super(meta); }
  async run(): Promise<void> { /* no-op */ }
}

/** Env produced by the real executor (setupProxy) for a managed SSO run. */
async function managedSsoEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    CODEMIE_SESSION_ID: 'sess-1',
    CODEMIE_PROVIDER: 'ai-run-sso',
    CODEMIE_BASE_URL: GATEWAY,
    CODEMIE_URL: ANALYTICS,
    CODEMIE_PROFILE_CONFIG: JSON.stringify({ baseUrl: GATEWAY + '/' }),
  };
  await (new TestAdapter() as unknown as { setupProxy(e: NodeJS.ProcessEnv): Promise<void> }).setupProxy(env);
  return env;
}

const input = (env: NodeJS.ProcessEnv, extra: Partial<RoutingInput> = {}): RoutingInput => ({
  env, codemieProvider: true, ...extra,
});

describe('launchMode', () => {
  it('managed iff CODEMIE_SESSION_ID is set', () => {
    expect(launchMode({ CODEMIE_SESSION_ID: 's' })).toBe('managed');
    expect(launchMode({ CODEMIE_SESSION_ID: '' })).toBe('native');
    expect(launchMode({})).toBe('native');
  });
});

describe('routedViaCodemie - managed (real executor env)', () => {
  it('fixture has distinct roles: target != base, analytics separate', async () => {
    const env = await managedSsoEnv();
    expect(env.CODEMIE_TARGET_API_URL).toBe(GATEWAY);
    expect(env.CODEMIE_BASE_URL).toBe('http://127.0.0.1:4567');
  });

  it('proxy endpoint + target validated against profile => routed/proven', async () => {
    const env = await managedSsoEnv();
    const r = routedViaCodemie(input({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567/' }));
    expect(r).toEqual({ routed: true, routing_proof: 'proven' });
  });

  it('settings.json env wins over process env; default-port/trailing-slash variant still equal', async () => {
    const env = await managedSsoEnv();
    const r = routedViaCodemie(input({ ...env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, {
      settingsEnv: { ANTHROPIC_BASE_URL: 'HTTP://127.0.0.1:4567//' },
      profileBaseUrl: 'https://LLM-gateway.example.com:443',
    }));
    expect(r.routed).toBe(true);
  });

  it('settings.json override to a foreign host => unproven', async () => {
    const env = await managedSsoEnv();
    const r = routedViaCodemie(input({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567' }, {
      settingsEnv: { ANTHROPIC_BASE_URL: 'https://foreign.example.net' },
    }));
    expect(r).toEqual({ routed: false, routing_proof: 'unproven' });
  });

  it('loopback endpoint without target proof => unproven', async () => {
    const env = await managedSsoEnv();
    delete env.CODEMIE_TARGET_API_URL;
    const r = routedViaCodemie(input({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567' }));
    expect(r).toEqual({ routed: false, routing_proof: 'unproven' });
  });

  it('target not matching the configured profile model URL => unproven', async () => {
    const env = await managedSsoEnv();
    const r = routedViaCodemie(input({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567' }, {
      profileBaseUrl: 'https://other-gateway.example.com',
    }));
    expect(r.routing_proof).toBe('unproven');
  });

  it('target equal to the analytics host is NOT used as proof', async () => {
    const env = await managedSsoEnv();
    env.CODEMIE_TARGET_API_URL = ANALYTICS;
    const r = routedViaCodemie(input({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567' }, { profileBaseUrl: GATEWAY }));
    expect(r.routed).toBe(false);
  });

  it('non-loopback "proxy" URL => unproven', async () => {
    const env = await managedSsoEnv();
    env.CODEMIE_BASE_URL = 'https://evil.example.net';
    const r = routedViaCodemie(input({ ...env, ANTHROPIC_BASE_URL: 'https://evil.example.net' }));
    expect(r.routed).toBe(false);
  });

  it('managed direct subscription (no proxy), endpoint absent or api.anthropic.com => proven not routed', () => {
    const env = { CODEMIE_SESSION_ID: 's', CODEMIE_PROVIDER: 'anthropic-subscription', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
    expect(routedViaCodemie({ env, codemieProvider: false })).toEqual({ routed: false, routing_proof: 'proven' });
  });

  it('managed direct subscription with settings override to unknown host => unproven', () => {
    const env = { CODEMIE_SESSION_ID: 's', CODEMIE_PROVIDER: 'anthropic-subscription' };
    const r = routedViaCodemie({ env, codemieProvider: false, settingsEnv: { ANTHROPIC_BASE_URL: 'https://x.example.net' } });
    expect(r).toEqual({ routed: false, routing_proof: 'unproven' });
  });
});

describe('routedViaCodemie - native', () => {
  const profileBaseUrl = GATEWAY;
  it('effective endpoint equals the configured CodeMie model route => routed', () => {
    const r = routedViaCodemie({ env: { ANTHROPIC_BASE_URL: GATEWAY + '/' }, codemieProvider: true, profileBaseUrl });
    expect(r).toEqual({ routed: true, routing_proof: 'proven' });
  });
  it('settings.json endpoint overrides env', () => {
    const r = routedViaCodemie({
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, codemieProvider: true, profileBaseUrl,
      settingsEnv: { ANTHROPIC_BASE_URL: GATEWAY },
    });
    expect(r.routed).toBe(true);
  });
  it('analytics URL alone is not routing proof', () => {
    const r = routedViaCodemie({ env: { CODEMIE_URL: ANALYTICS }, codemieProvider: true, profileBaseUrl });
    expect(r).toEqual({ routed: false, routing_proof: 'unproven' });
  });
  it('endpoint equal to profile URL but non-CodeMie provider => unproven', () => {
    const r = routedViaCodemie({ env: { ANTHROPIC_BASE_URL: GATEWAY }, codemieProvider: false, profileBaseUrl });
    expect(r.routing_proof).toBe('unproven');
  });
  it('explicit api.anthropic.com => proven not routed; absent endpoint => unproven (never personal by default)', () => {
    expect(routedViaCodemie({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }, codemieProvider: false }))
      .toEqual({ routed: false, routing_proof: 'proven' });
    expect(routedViaCodemie({ env: {}, codemieProvider: false })).toEqual({ routed: false, routing_proof: 'unproven' });
  });
  it('unparsable URLs never throw and are unproven', () => {
    const r = routedViaCodemie({ env: { ANTHROPIC_BASE_URL: 'not a url' }, codemieProvider: true, profileBaseUrl });
    expect(r).toEqual({ routed: false, routing_proof: 'unproven' });
  });
});
