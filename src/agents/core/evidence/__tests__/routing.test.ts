import { describe, it, expect, vi } from 'vitest';
import { BaseAgentAdapter } from '../../BaseAgentAdapter.js';
import type { AgentMetadata } from '../../types.js';
import { launchMode, localProxyCandidate, oauthAccountPays, routedViaCodemie, type RoutingInput } from '../routing.js';

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
  it('analytics URL alone is not routing proof (never routed)', () => {
    const r = routedViaCodemie({ env: { CODEMIE_URL: ANALYTICS }, codemieProvider: true, profileBaseUrl });
    expect(r.routed).toBe(false);
  });
  it('native endpoint under the gateway path prefix is routed; sibling host / sibling path is not', () => {
    const base = 'https://gw.example.com/llm';
    const at = (u: string) => routedViaCodemie({ env: { ANTHROPIC_BASE_URL: u }, codemieProvider: true, profileBaseUrl: base });
    expect(at('https://gw.example.com/llm/v1/anthropic')).toEqual({ routed: true, routing_proof: 'proven' });
    expect(at('https://gw.example.com/llm2')).toEqual({ routed: false, routing_proof: 'unproven' });
    expect(at('https://gw.example.com/other')).toEqual({ routed: false, routing_proof: 'unproven' });
    expect(at('https://gw.example.com.evil.net/llm')).toEqual({ routed: false, routing_proof: 'unproven' });
    expect(at('http://gw.example.com/llm')).toEqual({ routed: false, routing_proof: 'unproven' });
  });
  it('positively direct defaults are proven not routed: absent endpoint, Bedrock, Vertex (flag from env or settings)', () => {
    const direct = { routed: false, routing_proof: 'proven' };
    expect(routedViaCodemie({ env: {}, codemieProvider: true, profileBaseUrl })).toEqual(direct);
    expect(routedViaCodemie({ env: { CLAUDE_CODE_USE_BEDROCK: '1' }, codemieProvider: false })).toEqual(direct);
    expect(routedViaCodemie({ env: {}, settingsEnv: { CLAUDE_CODE_USE_VERTEX: 'true' }, codemieProvider: true, profileBaseUrl })).toEqual(direct);
    // The flag selects the cloud provider: a stale ANTHROPIC_BASE_URL is not the executor's endpoint.
    expect(routedViaCodemie({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://x.example.net' }, codemieProvider: false })).toEqual(direct);
  });
  it('foreign overrides stay unproven: custom Bedrock/Vertex base, foreign ANTHROPIC_BASE_URL', () => {
    const unproven = { routed: false, routing_proof: 'unproven' };
    expect(routedViaCodemie({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'https://x.example.net' }, codemieProvider: false })).toEqual(unproven);
    expect(routedViaCodemie({ env: { ANTHROPIC_BASE_URL: 'https://x.example.net' }, codemieProvider: false })).toEqual(unproven);
  });
  describe('cloud flags share one rule with oauthAccountPays (review: yes/on/unfamiliar/off)', () => {
    const viaGateway = { codemieProvider: true, profileBaseUrl: GATEWAY } as const;
    const flags = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const;
    const placements = [
      ['process env', (k: string, v: string) => ({ env: { [k]: v, ANTHROPIC_BASE_URL: GATEWAY } })],
      ['settings env', (k: string, v: string) => ({ env: { ANTHROPIC_BASE_URL: GATEWAY }, settingsEnv: { [k]: v } })],
    ] as const;

    it.each(flags.flatMap((f) => ['yes', 'on', 'YES', ' On ', '1', 'true'].map((v) => [f, v])))(
      '%s=%j selects the cloud provider: a gateway base URL is not the executor endpoint, org withheld',
      (flag, value) => {
        for (const [, build] of placements) {
          const input = { ...build(flag, value), ...viaGateway };
          expect(routedViaCodemie(input)).toEqual({ routed: false, routing_proof: 'proven' });
          expect(oauthAccountPays(input)).toBe(false);
        }
      }
    );

    it.each(flags.flatMap((f) => ['banana', '2', 'enabled'].map((v) => [f, v])))(
      '%s=%j (unfamiliar) is unproven and withholds the organization',
      (flag, value) => {
        for (const [, build] of placements) {
          const input = { ...build(flag, value), ...viaGateway };
          expect(routedViaCodemie(input)).toEqual({ routed: false, routing_proof: 'unproven' });
          expect(oauthAccountPays(input)).toBe(false);
        }
      }
    );

    it.each(flags.flatMap((f) => ['0', 'false', 'no', 'off', 'OFF', ''].map((v) => [f, v])))(
      '%s=%j is explicitly off: it behaves as unset and CodeMie routing is still provable',
      (flag, value) => {
        for (const [, build] of placements) {
          const input = { ...build(flag, value), ...viaGateway };
          expect(routedViaCodemie(input)).toEqual({ routed: true, routing_proof: 'proven' });
        }
      }
    );

    it.each(['1', 'true', 'yes', 'on', 'banana'])('Foundry %j is never provable', (value) => {
      for (const [, build] of placements) {
        const input = { ...build('CLAUDE_CODE_USE_FOUNDRY', value), ...viaGateway };
        expect(routedViaCodemie(input)).toEqual({ routed: false, routing_proof: 'unproven' });
        expect(oauthAccountPays(input)).toBe(false);
      }
    });
  });
  it('endpoint equal to profile URL but non-CodeMie provider => unproven', () => {
    const r = routedViaCodemie({ env: { ANTHROPIC_BASE_URL: GATEWAY }, codemieProvider: false, profileBaseUrl });
    expect(r.routing_proof).toBe('unproven');
  });
  it('explicit api.anthropic.com and an absent endpoint => proven not routed', () => {
    expect(routedViaCodemie({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }, codemieProvider: false }))
      .toEqual({ routed: false, routing_proof: 'proven' });
    expect(routedViaCodemie({ env: {}, codemieProvider: false })).toEqual({ routed: false, routing_proof: 'proven' });
  });
  it('unparsable URLs never throw and are unproven', () => {
    const r = routedViaCodemie({ env: { ANTHROPIC_BASE_URL: 'not a url' }, codemieProvider: true, profileBaseUrl });
    expect(r).toEqual({ routed: false, routing_proof: 'unproven' });
  });

  describe('settings env validation (CR-004, CR-006)', () => {
    const UNPROVEN = { routed: false, routing_proof: 'unproven' };
    const base = { env: {}, codemieProvider: true, profileBaseUrl } as const;

    it('a boolean/numeric flag in settings.json does not throw and selects the cloud provider', () => {
      expect(() => routedViaCodemie({ ...base, settingsEnv: { CLAUDE_CODE_USE_BEDROCK: true } })).not.toThrow();
      // Bedrock flag on its default endpoint, even with a gateway URL set: not the gateway.
      expect(routedViaCodemie({ ...base, settingsEnv: { CLAUDE_CODE_USE_BEDROCK: 1, ANTHROPIC_BASE_URL: GATEWAY } }))
        .toEqual({ routed: false, routing_proof: 'proven' });
    });

    it.each([
      ['object', { x: 1 }],
      ['null', null],
      ['array', ['a']],
    ])('a %s endpoint value is unknown: unproven, never direct', (_n, value) => {
      expect(routedViaCodemie({ ...base, settingsEnv: { ANTHROPIC_BASE_URL: value } })).toEqual(UNPROVEN);
    });

    it('an empty settings value overriding a non-empty process endpoint is unproven', () => {
      expect(routedViaCodemie({ ...base, env: { ANTHROPIC_BASE_URL: GATEWAY }, settingsEnv: { ANTHROPIC_BASE_URL: '' } })).toEqual(UNPROVEN);
    });

    it('unreadable settings (settingsUnknown) is unproven even with no endpoint anywhere', () => {
      expect(routedViaCodemie({ ...base, settingsUnknown: true })).toEqual(UNPROVEN);
      expect(routedViaCodemie({ ...base })).toEqual({ routed: false, routing_proof: 'proven' });
    });
  });
});

describe('routedViaCodemie - native via local proxy daemon', () => {
  const PROXY = 'http://127.0.0.1:4001';
  const env = { ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'gw' };
  const daemon = { url: PROXY, targetUrl: GATEWAY, profile: 'p' };
  const PROVEN_ROUTED = { routed: true, routing_proof: 'proven' };
  const NOT_PROVEN = { routed: false, routing_proof: 'unproven' };
  /** A native session on profile `p` with the live daemon above, unless overridden. */
  const via = (e: NodeJS.ProcessEnv, extra: Partial<RoutingInput> = {}): RoutingInput =>
    input(e, { profileBaseUrl: GATEWAY, profileName: 'p', localProxy: daemon, ...extra });

  it('endpoint is the live daemon, its target is the profile route and it serves the hook profile => routed/proven', () => {
    expect(routedViaCodemie(via(env))).toEqual(PROVEN_ROUTED);
  });

  it("only the daemon's own host form matches: localhost and [::1] are other sockets than 127.0.0.1", () => {
    expect(routedViaCodemie(via({ ...env, ANTHROPIC_BASE_URL: 'http://localhost:4001' }))).toEqual(NOT_PROVEN);
    expect(routedViaCodemie(via({ ...env, ANTHROPIC_BASE_URL: 'http://[::1]:4001/' }))).toEqual(NOT_PROVEN);
    expect(routedViaCodemie(via({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4001/' }))).toEqual(PROVEN_ROUTED);
  });

  it('a loopback endpoint on another port is unproven', () => {
    expect(routedViaCodemie(via({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4002' }))).toEqual(NOT_PROVEN);
  });

  it('no localProxy is unproven', () => {
    expect(routedViaCodemie(via(env, { localProxy: undefined }))).toEqual(NOT_PROVEN);
  });

  it('a daemon target that is not the profile route is unproven', () => {
    expect(routedViaCodemie(via(env, { localProxy: { ...daemon, targetUrl: 'https://other.example.com' } }))).toEqual(NOT_PROVEN);
  });

  it('a daemon without a target and a profile without a base URL is unproven (never undefined === undefined)', () => {
    expect(routedViaCodemie(via(env, { profileBaseUrl: undefined, localProxy: { url: PROXY, profile: 'p' } }))).toEqual(NOT_PROVEN);
  });

  it('a daemon started for another profile is unproven, even on the same base URL', () => {
    expect(routedViaCodemie(via(env, { profileName: 'other' }))).toEqual(NOT_PROVEN);
    expect(routedViaCodemie(via(env, { localProxy: { url: PROXY, targetUrl: GATEWAY } }))).toEqual(NOT_PROVEN);
    expect(routedViaCodemie(via(env, { profileName: undefined }))).toEqual(NOT_PROVEN);
  });

  it('a non-CodeMie provider is never proven routed', () => {
    expect(routedViaCodemie(via(env, { codemieProvider: false })).routed).toBe(false);
  });

  it('a settings.json endpoint pointing at the proxy is proven', () => {
    expect(routedViaCodemie(via({}, { settingsEnv: { ANTHROPIC_BASE_URL: PROXY } }))).toEqual(PROVEN_ROUTED);
  });

  it('a cloud provider base URL is never compared to the proxy', () => {
    expect(routedViaCodemie(via({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: PROXY })).routed).toBe(false);
  });

  describe('localProxyCandidate', () => {
    it('is true for a native CodeMie launch on a loopback endpoint', () => {
      expect(localProxyCandidate(input(env))).toBe(true);
      expect(localProxyCandidate(input({}, { settingsEnv: { ANTHROPIC_BASE_URL: PROXY } }))).toBe(true);
    });

    it('is false for a remote endpoint, a managed launch, a non-CodeMie provider, unreadable settings or any unresolvable cloud flag', () => {
      expect(localProxyCandidate(input({ ANTHROPIC_BASE_URL: GATEWAY }))).toBe(false);
      expect(localProxyCandidate(input({ ...env, CODEMIE_SESSION_ID: 's' }))).toBe(false);
      expect(localProxyCandidate(input(env, { codemieProvider: false }))).toBe(false);
      expect(localProxyCandidate(input(env, { settingsUnknown: true }))).toBe(false);
      expect(localProxyCandidate(input({ ...env, CLAUDE_CODE_USE_BEDROCK: '1' }))).toBe(false);
      expect(localProxyCandidate(input({ ...env, CLAUDE_CODE_USE_FOUNDRY: '1' }))).toBe(false);
      expect(localProxyCandidate(input({ ...env, CLAUDE_CODE_USE_VERTEX: 'maybe' }))).toBe(false);
    });

    it('agrees with routedViaCodemie: whenever it is false, a live daemon cannot prove the session', () => {
      for (const e of [{ ...env, CLAUDE_CODE_USE_FOUNDRY: '1' }, { ...env, CLAUDE_CODE_USE_VERTEX: 'maybe' }, { ...env, CLAUDE_CODE_USE_BEDROCK: '1' }]) {
        expect(localProxyCandidate(input(e))).toBe(false);
        expect(routedViaCodemie(via(e)).routed).toBe(false);
      }
    });
  });
});
