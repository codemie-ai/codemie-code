import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '../../registry.js';
import {
  classifyWithPredicate,
  classifyModelForAgent,
  getClassifierAgents,
  compatibleHarnesses,
  uncoveredHarness,
} from '../model-compat.js';

const isClaude = (id: string) => /claude/i.test(id);
const isGpt = (id: string) => /gpt/i.test(id);

function fakeAgent(name: string, predicate?: (id: string) => boolean, supportedProviders: string[] = []) {
  return {
    name,
    metadata: {
      name,
      supportedProviders,
      ...(predicate
        ? { classifyModel: (id: string, ctx?: { isRouter?: boolean }) => classifyWithPredicate(predicate, id, ctx) }
        : {}),
    },
  };
}

const agents = new Map([
  ['claude', fakeAgent('claude', isClaude)],
  ['codex', fakeAgent('codex', isGpt, ['litellm', 'ai-run-sso'])],
  ['codex-acp', fakeAgent('codex-acp', isGpt, ['litellm', 'ai-run-sso'])],
  ['opencode', fakeAgent('opencode', undefined, ['litellm'])],
]);

beforeEach(() => {
  vi.spyOn(AgentRegistry, 'getAgent').mockImplementation((n: string) => agents.get(n) as never);
  vi.spyOn(AgentRegistry, 'getAllAgents').mockImplementation(() => [...agents.values()] as never);
});
afterEach(() => vi.restoreAllMocks());

describe('classifyWithPredicate', () => {
  it('returns compatible when the predicate matches', () => {
    expect(classifyWithPredicate(isClaude, 'claude-sonnet-4')).toBe('compatible');
  });

  it('returns incompatible for a router that names another vendor family', () => {
    expect(classifyWithPredicate(isClaude, 'gpt-smart-router')).toBe('incompatible');
  });

  it('returns unverified for a router name with no definite family', () => {
    expect(classifyWithPredicate(isClaude, 'sy-router')).toBe('unverified');
  });

  it('returns unverified for a catalog-flagged router with no definite family', () => {
    expect(classifyWithPredicate(isClaude, 'sy-signal-terra-luna', { isRouter: true })).toBe('unverified');
  });

  it('returns incompatible for an unknown non-router name', () => {
    expect(classifyWithPredicate(isClaude, 'my-custom-model')).toBe('incompatible');
  });
});

describe('classifyModelForAgent', () => {
  it('treats an agent without a classifier as compatible', () => {
    expect(classifyModelForAgent('opencode', 'anything')).toBe('compatible');
    expect(classifyModelForAgent('not-an-agent', 'anything')).toBe('compatible');
  });

  it('reports a confirmed id as unverified', () => {
    expect(classifyModelForAgent('claude', 'gpt-5', { confirmedModels: ['gpt-5'] })).toBe('unverified');
    expect(classifyModelForAgent('claude', 'gpt-5')).toBe('incompatible');
  });

  it('folds an ACP agent into its base agent', () => {
    expect(classifyModelForAgent('codex-acp', 'claude-x')).toBe('incompatible');
    expect(classifyModelForAgent('codex-acp', 'gpt-5.4')).toBe('compatible');
  });

  it('is incompatible when the provider is outside the agent supportedProviders', () => {
    expect(classifyModelForAgent('codex', 'gpt-5.4', { provider: 'moonshot-subscription' })).toBe('incompatible');
    expect(classifyModelForAgent('codex', 'gpt-5.4', { provider: 'litellm' })).toBe('compatible');
  });

  it('never restricts an unrestricted agent by provider', () => {
    expect(classifyModelForAgent('opencode', 'x', { provider: 'moonshot-subscription' })).toBe('compatible');
  });

  it('honors the isRouter hint, boolean or per-id lookup', () => {
    expect(classifyModelForAgent('claude', 'sy-signal-terra', { isRouter: true })).toBe('unverified');
    expect(classifyModelForAgent('claude', 'sy-signal-terra', { isRouter: (id) => id === 'sy-signal-terra' })).toBe('unverified');
    expect(classifyModelForAgent('claude', 'sy-signal-terra', { isRouter: () => false })).toBe('incompatible');
  });

  it('classifies gpt-smart-router incompatible and sy-router unverified for claude', () => {
    expect(classifyModelForAgent('claude', 'gpt-smart-router')).toBe('incompatible');
    expect(classifyModelForAgent('claude', 'sy-router')).toBe('unverified');
  });
});

describe('getClassifierAgents', () => {
  it('lists base agents that define a classifier, without ACP variants', () => {
    expect(getClassifierAgents()).toEqual(['claude', 'codex']);
  });
});

describe('compatibleHarnesses', () => {
  it('returns only the harnesses the model works with', () => {
    expect(compatibleHarnesses(['claude', 'codex'], 'claude-sonnet-4')).toEqual(['claude']);
    expect(compatibleHarnesses(['claude', 'codex'], 'gpt-5.4')).toEqual(['codex']);
  });
});

describe('uncoveredHarness', () => {
  it('names the harness that has no non-incompatible model', () => {
    expect(uncoveredHarness(['codex'], ['claude-sonnet-4'])).toBe('codex');
  });

  it('returns undefined when every harness is covered', () => {
    expect(uncoveredHarness(['claude', 'codex'], ['claude-sonnet-4', 'gpt-5.4'])).toBeUndefined();
  });

  it('never fails for unrestricted harnesses', () => {
    expect(uncoveredHarness(['opencode'], ['claude-sonnet-4'])).toBeUndefined();
  });

  it('counts a confirmed model as coverage', () => {
    expect(uncoveredHarness(['codex'], ['claude-x'], { confirmedModels: ['claude-x'] })).toBeUndefined();
  });
});
