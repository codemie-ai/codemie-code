/**
 * Edge-case coverage for BaseAgentAdapter.transformEnvVars model-tier logic
 * (src/agents/core/BaseAgentAdapter.ts). The main matrix lives in
 * model-tier-config.test.ts — this file only ADDS the tier-combination and
 * stale-clearing edges that matrix does not exercise:
 *   - sonnet+opus (no haiku) — subagent default NOT pinned
 *   - haiku+opus (no sonnet) — subagent default routed to opus
 *   - degenerate sonnet===haiku collapses to "no distinct sonnet tier"
 *   - empty-string sonnet (as ConfigLoader.exportProviderEnvVars emits) treated as absent
 *   - stale CLAUDE_CODE_SUBAGENT_MODEL / ANTHROPIC_DEFAULT_* cleared when a tier is
 *     removed on a config switch (EPMCDME-14355 / EPMCDME-12779)
 *   - multi-target envMapping arrays fan out to every listed var
 *
 * All expected values were probed against the real dist build first — these
 * assertions pin current contract behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMetadata } from '../types.js';
import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import type { SessionAdapter } from '../session/BaseSessionAdapter.js';

class MockSessionAdapter implements SessionAdapter {
  discoverSessions = vi.fn();
  parseSessionFile = vi.fn();
  processSession = vi.fn();
}

class TestAgentAdapter extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor(metadata: AgentMetadata) {
    super(metadata);
    this.sessionAdapter = new MockSessionAdapter();
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  public testTransformEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return this.transformEnvVars(env);
  }
}

const CLAUDE_MAPPING = {
  baseUrl: ['ANTHROPIC_BASE_URL'],
  apiKey: ['ANTHROPIC_AUTH_TOKEN'],
  model: ['ANTHROPIC_MODEL'],
  haikuModel: ['ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  sonnetModel: ['ANTHROPIC_DEFAULT_SONNET_MODEL'],
  opusModel: ['ANTHROPIC_DEFAULT_OPUS_MODEL'],
  subagentDefaultModel: ['CLAUDE_CODE_SUBAGENT_MODEL'],
};

function makeAdapter(): TestAgentAdapter {
  const metadata: AgentMetadata = {
    name: 'test-claude',
    displayName: 'Test Claude',
    description: 'Edge-case agent for model tier transform',
    cliCommand: 'test-claude',
    dataPaths: { home: '.test-claude' },
    envMapping: { ...CLAUDE_MAPPING },
  };
  return new TestAgentAdapter(metadata);
}

describe('transformEnvVars model-tier edge cases', () => {
  let adapter: TestAgentAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tier combinations that gate CLAUDE_CODE_SUBAGENT_MODEL', () => {
    it('sonnet + opus (no haiku): subagent default NOT pinned (per-subagent model honored)', () => {
      const result = adapter.testTransformEnvVars({
        CODEMIE_SONNET_MODEL: 'son',
        CODEMIE_OPUS_MODEL: 'op',
      });

      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('son');
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('op');
      // Distinct sonnet tier present -> subagent override left unset (EPMCDME-14355).
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    });

    it('haiku + opus (no sonnet): subagent default routed to opus', () => {
      const result = adapter.testTransformEnvVars({
        CODEMIE_HAIKU_MODEL: 'hk',
        CODEMIE_OPUS_MODEL: 'op',
      });

      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('hk');
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('op');
      // No distinct sonnet tier, opus provisioned -> subagents redirect to opus.
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBe('op');
      // ANTHROPIC_DEFAULT_SONNET_MODEL intentionally left unset (EPMCDME-12779).
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    });

    it('all three tiers present: subagent default NOT pinned and both defaults flow', () => {
      const result = adapter.testTransformEnvVars({
        CODEMIE_HAIKU_MODEL: 'hk',
        CODEMIE_SONNET_MODEL: 'son',
        CODEMIE_OPUS_MODEL: 'op',
      });

      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('hk');
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('son');
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('op');
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    });
  });

  describe('degenerate sonnet===haiku collapses to "no distinct sonnet tier"', () => {
    it('sonnet===haiku with opus: subagent routes to opus, sonnet slot left unset', () => {
      const result = adapter.testTransformEnvVars({
        CODEMIE_HAIKU_MODEL: 'x',
        CODEMIE_SONNET_MODEL: 'x',
        CODEMIE_OPUS_MODEL: 'op',
      });

      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('x');
      // sonnet equals haiku -> not treated as a distinct sonnet tier.
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('op');
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBe('op');
    });

    it('sonnet===haiku without opus: subagent routes to haiku, sonnet slot left unset', () => {
      const result = adapter.testTransformEnvVars({
        CODEMIE_HAIKU_MODEL: 'x',
        CODEMIE_SONNET_MODEL: 'x',
      });

      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('x');
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBe('x');
    });
  });

  describe('empty-string tier values (as exportProviderEnvVars emits for missing tiers)', () => {
    it('empty-string sonnet with haiku+opus is treated as absent -> subagent routes to opus', () => {
      const result = adapter.testTransformEnvVars({
        CODEMIE_HAIKU_MODEL: 'hk',
        CODEMIE_SONNET_MODEL: '',
        CODEMIE_OPUS_MODEL: 'op',
      });

      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('hk');
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('op');
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBe('op');
    });

    it('all tiers empty-string: no tier or subagent vars are set', () => {
      const result = adapter.testTransformEnvVars({
        CODEMIE_HAIKU_MODEL: '',
        CODEMIE_SONNET_MODEL: '',
        CODEMIE_OPUS_MODEL: '',
      });

      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    });
  });

  describe('stale vars cleared when a tier is removed on config switch', () => {
    it('clears stale CLAUDE_CODE_SUBAGENT_MODEL when all three tiers are freshly provisioned', () => {
      // Prior session pinned the subagent override; a full three-tier config must
      // NOT let that stale value survive (EPMCDME-14355).
      const result = adapter.testTransformEnvVars({
        CLAUDE_CODE_SUBAGENT_MODEL: 'stale-haiku',
        CODEMIE_HAIKU_MODEL: 'hk',
        CODEMIE_SONNET_MODEL: 'son',
        CODEMIE_OPUS_MODEL: 'op',
      });

      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    });

    it('clears stale subagent + haiku/opus defaults when switching to sonnet-only', () => {
      // Previous session had opus (subagent pinned to opus) plus haiku/opus defaults.
      // Switching to a sonnet-only config must wipe all of them, leaving only sonnet.
      const result = adapter.testTransformEnvVars({
        CLAUDE_CODE_SUBAGENT_MODEL: 'stale-op',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-op',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-hk',
        CODEMIE_SONNET_MODEL: 'son',
      });

      expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('son');
      expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
      expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    });
  });

  describe('multi-target envMapping arrays', () => {
    it('fans a tier value out to every listed target var and clears each stale one', () => {
      const metadata: AgentMetadata = {
        name: 'multi-target',
        displayName: 'Multi Target',
        description: 'Agent whose mapping lists two vars per tier',
        cliCommand: 'multi',
        dataPaths: { home: '.multi' },
        envMapping: {
          haikuModel: ['H1', 'H2'],
          subagentDefaultModel: ['SUB1', 'SUB2'],
        },
      };
      const multiAdapter = new TestAgentAdapter(metadata);

      const result = multiAdapter.testTransformEnvVars({
        SUB1: 'stale',
        H1: 'old-haiku',
        CODEMIE_HAIKU_MODEL: 'hk',
      });

      // Haiku-only routes subagent default to haiku across every mapped var.
      expect(result.H1).toBe('hk');
      expect(result.H2).toBe('hk');
      expect(result.SUB1).toBe('hk');
      expect(result.SUB2).toBe('hk');
    });
  });

  describe('isolation', () => {
    it('mutates the passed env in place and leaves unrelated keys untouched', () => {
      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/bin',
        UNRELATED: 'keep-me',
        CODEMIE_SONNET_MODEL: 'son',
      };
      const result = adapter.testTransformEnvVars(env);

      expect(result).toBe(env); // same object mutated in place
      expect(result.PATH).toBe('/usr/bin');
      expect(result.UNRELATED).toBe('keep-me');
      expect(result.CODEMIE_SONNET_MODEL).toBe('son'); // original CODEMIE_* preserved
    });
  });
});
