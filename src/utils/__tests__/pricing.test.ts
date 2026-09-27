/**
 * Pricing lookup unit tests
 */

import { describe, it, expect } from 'vitest';
import { lookupPrice, resolvePrice, canonicalizeModelId, buildPriceTable } from '../pricing.js';
import { ConfigurationError } from '../errors.js';

describe('lookupPrice', () => {
  it('returns a price for a known Claude model (per-1M USD)', () => {
    const p = lookupPrice('claude-sonnet-4-5-20250929');
    expect(p).not.toBeNull();
    expect(p!.input).toBeGreaterThan(0);
    expect(p!.output).toBeGreaterThan(0);
  });

  it('matches Bedrock-style names via normalization', () => {
    const p = lookupPrice('converse/global.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(p).not.toBeNull();
  });

  it('resolves both sonnet-4-5 and sonnet-4-0 to their own exact rows', () => {
    const sonnet45 = lookupPrice('claude-sonnet-4-5');
    const sonnet4 = lookupPrice('claude-sonnet-4-0');
    expect(sonnet45).not.toBeNull();
    expect(sonnet4).not.toBeNull();
  });

  it('returns a price for Kimi models', () => {
    const forCoding = lookupPrice('kimi-for-coding');
    expect(forCoding).not.toBeNull();
    expect(forCoding!.input).toBeGreaterThan(0);

    const k2Dash = lookupPrice('kimi-k2-5');
    expect(k2Dash).not.toBeNull();
    expect(k2Dash!.input).toBe(forCoding!.input);
    expect(k2Dash!.output).toBe(forCoding!.output);
  });

  it('returns a price for Gemini models', () => {
    const flash37 = lookupPrice('gemini-3.7-flash');
    expect(flash37).not.toBeNull();
    expect(flash37!.input).toBe(0.5);
    expect(flash37!.output).toBe(3.0);

    const flash35 = lookupPrice('gemini-3-5-flash');
    expect(flash35).not.toBeNull();
    expect(flash35!.input).toBe(0.5);
    expect(flash35!.output).toBe(3.0);

    const gemini = lookupPrice('gemini');
    expect(gemini).toBeNull();

    const unknownFutureModel = lookupPrice('gemini-4-ultra');
    expect(unknownFutureModel).toBeNull();
  });

  it('matches Kimi Code wire-log model names via normalization', () => {
    const p = lookupPrice('kimi-code/kimi-for-coding');
    expect(p).not.toBeNull();
    expect(p!.input).toBeGreaterThan(0);
  });

  it('returns null for an unknown model', () => {
    expect(lookupPrice('totally-made-up-model')).toBeNull();
  });

  it('claude-opus-4-8 has cacheWrite1h of 10.0', () => {
    const p = lookupPrice('claude-opus-4-8');
    expect(p).not.toBeNull();
    expect(p!.cacheWrite1h).toBeCloseTo(10.0, 6);
  });

  it('claude-haiku-4-5 has cacheWrite1h of 2.0', () => {
    const p = lookupPrice('claude-haiku-4-5');
    expect(p).not.toBeNull();
    expect(p!.cacheWrite1h).toBeCloseTo(2.0, 6);
  });

  it('non-Anthropic model (gpt-5) has no cacheWrite1h', () => {
    const p = lookupPrice('gpt-5');
    expect(p).not.toBeNull();
    expect(p!.cacheWrite1h).toBeUndefined();
  });

  it.each([
    'claude-sonnet-5',
    'claude-sonnet-5-20260901',
    'converse/global.anthropic.claude-sonnet-5-v1:0',
  ])('uses the verified five Sonnet 5 token rates for %s', (model) => {
    expect(lookupPrice(model)).toEqual({
      input: 2, output: 10, cacheRead: 0.2, cacheCreation: 2.5, cacheWrite1h: 4, bedrockRegionalMultiplier: 1.1, estimated: undefined,
    });
  });

  it.each([
    'claude-opus-5',
    'claude-opus-5-20260901',
    'converse/global.anthropic.claude-opus-5-v1:0',
  ])('uses the verified five Opus 5 token rates for %s', (model) => {
    expect(lookupPrice(model)).toEqual({
      input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25, cacheWrite1h: 10, bedrockRegionalMultiplier: 1.1, estimated: undefined,
    });
  });

  it('returns null for a model newer than any table entry (no tier fallback)', () => {
    // No claude-opus-9 entry exists — the segment/tier fallback that used to guess a price
    // for this is removed; an unrecognized model must stay unpriced.
    expect(lookupPrice('claude-opus-9')).toBeNull();
  });

  it('returns null for a dated model with no matching tier (no tier fallback)', () => {
    expect(lookupPrice('claude-haiku-9')).toBeNull();
  });

  it('still returns null for a non-Claude unknown model (no tier fallback applies)', () => {
    expect(lookupPrice('totally-made-up-model')).toBeNull();
  });

  it('returns null for a wrong-model-family guess (gpt-5.9 must not resolve to gpt-5)', () => {
    expect(lookupPrice('gpt-5.9')).toBeNull();
  });

  it('returns null for claude-opus-6 (no family/tier guess)', () => {
    expect(lookupPrice('claude-opus-6')).toBeNull();
  });
});

describe('canonicalizeModelId', () => {
  it('passes through a plain id lowercased with dots turned to dashes', () => {
    expect(canonicalizeModelId('glm-4.7')).toBe('glm-4-7');
  });

  it('strips Bedrock prefixes and version suffix (existing normalizeModelName behavior)', () => {
    expect(canonicalizeModelId('converse/global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('strips the combined bedrock/converse/ prefix', () => {
    expect(canonicalizeModelId('bedrock/converse/us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('strips the openai. vendor prefix', () => {
    expect(canonicalizeModelId('openai.gpt-4o')).toBe('gpt-4o');
  });

  it('strips the openai/ vendor prefix', () => {
    expect(canonicalizeModelId('openai/gpt-4o')).toBe('gpt-4o');
  });

  it('strips the azure/ vendor prefix', () => {
    expect(canonicalizeModelId('azure/gpt-4o')).toBe('gpt-4o');
  });

  it('strips the vertex_ai/ vendor prefix', () => {
    expect(canonicalizeModelId('vertex_ai/gemini-3-pro')).toBe('gemini-3-pro');
  });

  it('turns @ into a dash, matching a Vertex-style dated id to the dash form', () => {
    expect(canonicalizeModelId('claude-opus-4-6@20260205')).toBe('claude-opus-4-6-20260205');
  });

  it('strips a trailing -vertex suffix', () => {
    expect(canonicalizeModelId('claude-opus-5-vertex')).toBe('claude-opus-5');
  });

  it('strips the moonshotai. vendor prefix and folds the dotted remainder to dashes', () => {
    expect(canonicalizeModelId('moonshotai.kimi-k2.5')).toBe('kimi-k2-5');
  });

  it('strips the qwen. vendor prefix', () => {
    expect(canonicalizeModelId('qwen.qwen3-coder-480b-a35b-v1')).toBe('qwen3-coder-480b-a35b-v1');
  });
});

describe('resolvePrice', () => {
  it('returns null for an unknown model', () => {
    expect(resolvePrice('gpt-5.9')).toBeNull();
  });

  it('returns null for claude-opus-6', () => {
    expect(resolvePrice('claude-opus-6')).toBeNull();
  });

  it.each([
    'claude-opus-4-6-20260205',
    'claude-opus-4-6@20260205',
  ])('resolves %s to key claude-opus-4-6 via snapshot-suffix stripping', (model) => {
    const resolution = resolvePrice(model);
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('claude-opus-4-6');
    expect(resolution!.match).toBe('snapshot');
  });

  it('gives an exact match for a dated id that has its own table row', () => {
    const resolution = resolvePrice('gpt-4o-2024-05-13');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('gpt-4o-2024-05-13');
    expect(resolution!.match).toBe('exact');
  });

  it('resolves openai.gpt-4o via vendor-prefix stripping', () => {
    const resolution = resolvePrice('openai.gpt-4o');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('gpt-4o');
  });

  it('resolves azure/gpt-4o via vendor-prefix stripping', () => {
    const resolution = resolvePrice('azure/gpt-4o');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('gpt-4o');
  });

  it('resolves vertex_ai/gemini-3-pro via vendor-prefix stripping', () => {
    const resolution = resolvePrice('vertex_ai/gemini-3-pro');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('gemini-3-pro');
  });

  it('resolves a -vertex suffixed id', () => {
    const resolution = resolvePrice('claude-opus-5-vertex');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('claude-opus-5');
  });

  it('resolves the dotted glm-4.7 id', () => {
    const resolution = resolvePrice('glm-4.7');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('glm-4-7');
    expect(resolution!.match).toBe('exact');
  });

  it('reports estimated:true for an estimated row', () => {
    const resolution = resolvePrice('claude-sonnet-4-7');
    expect(resolution).not.toBeNull();
    expect(resolution!.estimated).toBe(true);
  });

  it('reports estimated:false for a non-estimated row', () => {
    const resolution = resolvePrice('claude-sonnet-5');
    expect(resolution).not.toBeNull();
    expect(resolution!.estimated).toBe(false);
  });

  it('resolves the combined bedrock/converse/ prefix to claude-haiku-4-5-20251001', () => {
    const resolution = resolvePrice('bedrock/converse/us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('claude-haiku-4-5-20251001');
  });

  it.each([
    'claude-4-5-sonnet',
    'claude-4-5-sonnet-vertex',
    'claude-4.5-sonnet',
  ])('reorders version-first %s to the family-first claude-sonnet-4-5 row', (model) => {
    const resolution = resolvePrice(model);
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('claude-sonnet-4-5');
    expect(resolution!.match).toBe('reordered');
  });

  it.each([
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'claude-3-opus',
    'claude-3-sonnet',
    'claude-3-haiku',
    'claude-3-7-sonnet-20250219',
  ])('still resolves the existing old-style Claude key %s unchanged, without reordering', (model) => {
    const resolution = resolvePrice(model);
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe(model);
    expect(resolution!.match).toBe('exact');
  });

  it('resolves moonshotai.kimi-k2.5 to the kimi-k2-5 row via vendor-prefix stripping', () => {
    const resolution = resolvePrice('moonshotai.kimi-k2.5');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('kimi-k2-5');
  });

  it('resolves qwen.qwen3-coder-480b-a35b-v1 to its own row once the qwen. prefix is stripped', () => {
    const resolution = resolvePrice('qwen.qwen3-coder-480b-a35b-v1');
    expect(resolution).not.toBeNull();
    expect(resolution!.key).toBe('qwen3-coder-480b-a35b-v1');
  });

  it('leaves an unknown qwen variant unpriced once the qwen. prefix is stripped (no such row)', () => {
    expect(resolvePrice('qwen.qwen3-coder-7b-a1b-v1')).toBeNull();
  });

  it('still applies the Bedrock regional premium for the combined bedrock/converse/ prefix', () => {
    // us. is a regional endpoint qualifier (not global), so the row's own 1.1x
    // bedrockRegionalMultiplier must still apply once the double prefix is stripped.
    const resolution = resolvePrice('bedrock/converse/us.anthropic.claude-haiku-4-5-20251001-v1:0');
    const global = resolvePrice('claude-haiku-4-5-20251001');
    expect(resolution).not.toBeNull();
    expect(global).not.toBeNull();
    expect(resolution!.price.input).toBeCloseTo(global!.price.input * 1.1, 6);
  });
});

describe('buildPriceTable', () => {
  it('lowercases keys and turns dots into dashes', () => {
    const built = buildPriceTable({ 'GLM-4.7': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } });
    expect(built['glm-4-7']).toEqual({
      input: 1, output: 2, cacheRead: 0.1, cacheCreation: 0.2, cacheWrite1h: undefined,
      bedrockRegionalMultiplier: undefined, estimated: undefined,
    });
  });

  it('allows two keys that collide after normalization when their prices are identical', () => {
    const raw = {
      'gemini-3.7-flash': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
      'gemini-3-7-flash': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
    };
    expect(() => buildPriceTable(raw)).not.toThrow();
  });

  it('throws a ConfigurationError when two keys collide after normalization with different prices', () => {
    const raw = {
      'gemini-3.7-flash': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
      'gemini-3-7-flash': { input: 999, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
    };
    expect(() => buildPriceTable(raw)).toThrow(ConfigurationError);
  });

  it('carries the estimated flag through', () => {
    const built = buildPriceTable({ 'foo-bar': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, estimated: true } });
    expect(built['foo-bar'].estimated).toBe(true);
  });
});

describe('Kimi K3 / K2.6 rows (platform.kimi.ai/docs/pricing/chat, 2026-09-27)', () => {
  it('prices kimi-k3 at $3/$15 with $0.30 cache read and $3/$6 cache writes', () => {
    expect(lookupPrice('kimi-k3')).toEqual({
      input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3, cacheWrite1h: 6,
      bedrockRegionalMultiplier: undefined, estimated: undefined,
    });
  });

  it('prices the bare k3 id kimi-code logs identically to kimi-k3', () => {
    expect(lookupPrice('k3')).toEqual(lookupPrice('kimi-k3'));
  });

  it('prices kimi-k2.6 at $0.95/$4 with $0.16 cache read', () => {
    const price = lookupPrice('kimi-k2.6');
    expect(price).toMatchObject({ input: 0.95, output: 4, cacheRead: 0.16, cacheCreation: 0.95 });
  });
});
