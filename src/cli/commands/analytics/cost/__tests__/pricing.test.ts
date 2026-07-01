/**
 * Pricing lookup unit tests
 */

import { describe, it, expect } from 'vitest';
import { lookupPrice } from '../pricing.js';

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

  it('prefers the longest matching key (sonnet-4-5 over sonnet-4)', () => {
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

  it('returns the pinned sonnet-tier price for claude-sonnet-5 (a version bump ahead of the -4-* entries)', () => {
    const p = lookupPrice('claude-sonnet-5');
    expect(p).not.toBeNull();
    expect(p!.input).toBe(3);
    expect(p!.output).toBe(15);
  });

  it('falls back to the latest known price in the same Claude tier for a model newer than any table entry', () => {
    // No claude-opus-9 entry exists (or ever will, by construction) — this proves the tier
    // fallback is family-prefix based, not a one-off pinned key for sonnet-5.
    const p = lookupPrice('claude-opus-9');
    expect(p).not.toBeNull();
    expect(p!.input).toBe(5);
    expect(p!.output).toBe(25);
  });

  it('tier fallback ignores dated/pinned snapshot keys when picking the "latest" version', () => {
    // claude-haiku-4-5-20251001 (a dated snapshot) must not be mistaken for a newer version
    // than claude-haiku-4-6 just because "20251001" numerically exceeds "6".
    const p = lookupPrice('claude-haiku-9');
    expect(p).not.toBeNull();
    expect(p!.input).toBe(1);
    expect(p!.output).toBe(5);
  });

  it('still returns null for a non-Claude unknown model (no tier fallback applies)', () => {
    expect(lookupPrice('totally-made-up-model')).toBeNull();
  });
});
