/**
 * Model family tests
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import { isClaudeFamilyModel, routerTierTargets } from '../model-family.js';

const tiers = (simple: string, complex: string) => ({
  simple: { model: simple },
  medium: { model: simple },
  complex: { model: complex },
  reasoning: { model: complex },
});

describe('isClaudeFamilyModel', () => {
  it.each([
    ['a Claude deployment', { base_name: 'claude-sonnet-5' }, true],
    ['a model named only by its label', { base_name: 'bedrock-x', label: 'Bedrock Claude Sonnet 5' }, true],
    ['a model served by the Anthropic provider', { base_name: 'm1', provider: 'anthropic' }, true],
    ['a GPT deployment', { base_name: 'gpt-5', label: 'GPT-5' }, false],
  ])('judges %s by its names', (_case, model, expected) => {
    expect(isClaudeFamilyModel(model)).toBe(expected);
  });

  it('judges a router by its tiers, not its alias', () => {
    // Claude-only tiers behind a family-agnostic alias.
    expect(isClaudeFamilyModel({ base_name: 'sy-signal-v2', is_router: true, tiers: tiers('claude-haiku-5-5', 'claude-sonnet-5') }))
      .toBe(true);
    // A Claude-named alias that also routes to GPT.
    expect(isClaudeFamilyModel({ base_name: 'claude-router-mixed', is_router: true, tiers: tiers('gpt-5-mini', 'claude-sonnet-5') }))
      .toBe(false);
  });

  it('reads the tiers of a declared LiteLLM auto-router', () => {
    expect(isClaudeFamilyModel({
      base_name: 'smart-router',
      litellm_router: { is_router: true, tiers: tiers('claude-haiku-5-5', 'claude-opus-5-5') },
    })).toBe(true);
  });

  it('falls back to counterfactual_model, then to the alias, for a router without tiers', () => {
    expect(isClaudeFamilyModel({
      base_name: 'claude-smart-router',
      litellm_router: { is_router: true, counterfactual_model: 'gpt-5.6-terra-2026-07-09' },
    })).toBe(false);
    expect(isClaudeFamilyModel({ base_name: 'claude-router-premium', is_router: true })).toBe(true);
  });
});

describe('routerTierTargets', () => {
  it('lists each tier target once', () => {
    expect(routerTierTargets({ tiers: tiers('claude-haiku-5-5', 'claude-sonnet-5') }))
      .toEqual(['claude-haiku-5-5', 'claude-sonnet-5']);
  });

  it('is empty for a plain model', () => {
    expect(routerTierTargets({})).toEqual([]);
  });
});
