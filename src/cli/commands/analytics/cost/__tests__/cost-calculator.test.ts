/**
 * Cost calculator unit tests
 */

import { describe, it, expect } from 'vitest';
import { emptyUsage, addUsage, costForUsage, costBreakdown } from '../cost-calculator.js';
import { lookupPrice } from '@/utils/pricing.js';

describe('cost-calculator', () => {
  it('emptyUsage is all zeros', () => {
    expect(emptyUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 0 });
  });

  it('addUsage sums fields and total', () => {
    const a = { input: 10, output: 5, cacheRead: 2, cacheCreation: 1, cacheCreation1h: 0, total: 18 };
    expect(addUsage(emptyUsage(), a)).toEqual(a);
  });

  it('costForUsage applies per-1M pricing', () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 2_000_000 };
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 };
    expect(costForUsage(usage, price)).toBeCloseTo(18, 6); // 3 + 15
  });

  it('costForUsage includes cache read and creation', () => {
    const usage = { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 1_000_000, cacheCreation1h: 0, total: 2_000_000 };
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 };
    expect(costForUsage(usage, price)).toBeCloseTo(4.05, 6); // 0.3 + 3.75
  });

  it('costBreakdown splits per component and sums to costForUsage', () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000, cacheCreation: 1_000_000, cacheCreation1h: 0, total: 5_000_000 };
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 };
    const b = costBreakdown(usage, price);
    expect(b.input).toBeCloseTo(3, 6);
    expect(b.output).toBeCloseTo(15, 6);
    expect(b.cacheRead).toBeCloseTo(0.6, 6);
    expect(b.cacheCreation).toBeCloseTo(3.75, 6);
    expect(b.total).toBeCloseTo(22.35, 6);
    expect(b.total).toBeCloseTo(costForUsage(usage, price), 6);
  });

  it('emptyUsage has cacheCreation1h === 0', () => {
    expect(emptyUsage().cacheCreation1h).toBe(0);
  });

  it('addUsage sums cacheCreation1h independently', () => {
    const a = { input: 0, output: 0, cacheRead: 0, cacheCreation: 100, cacheCreation1h: 60, total: 100 };
    const b = { input: 0, output: 0, cacheRead: 0, cacheCreation: 200, cacheCreation1h: 150, total: 200 };
    expect(addUsage(a, b).cacheCreation1h).toBe(210);
  });

  it('costBreakdown uses cacheWrite1h rate for all-1h tokens', () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000, cacheCreation1h: 1_000_000, total: 1_000_000 };
    const price = { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25, cacheWrite1h: 10.0 };
    const b = costBreakdown(usage, price);
    expect(b.cacheCreation).toBeCloseTo(10.0, 6);
    expect(b.total).toBeCloseTo(10.0, 6);
  });

  it('costBreakdown uses cacheCreation rate for all-5m tokens (cacheCreation1h === 0)', () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000, cacheCreation1h: 0, total: 1_000_000 };
    const price = { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25, cacheWrite1h: 10.0 };
    const b = costBreakdown(usage, price);
    expect(b.cacheCreation).toBeCloseTo(6.25, 6);
  });

  it('costBreakdown prices mixed 1h/5m buckets correctly', () => {
    // 1M at 1h-rate ($10) + 1M at 5m-rate ($6.25) = $16.25
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 2_000_000, cacheCreation1h: 1_000_000, total: 2_000_000 };
    const price = { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25, cacheWrite1h: 10.0 };
    const b = costBreakdown(usage, price);
    expect(b.cacheCreation).toBeCloseTo(16.25, 6);
    expect(b.total).toBeCloseTo(b.input + b.output + b.cacheRead + b.cacheCreation, 9);
  });

  it.each([
    { model: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.4, cacheCreation: 9, total: 21.4 },
    { model: 'claude-opus-5', input: 5, output: 25, cacheRead: 1, cacheCreation: 22.5, total: 53.5 },
  ])('prices $model mixed cache TTL usage once using the verified model entry', ({ model, ...expected }) => {
    // Creation is 3M total: 2M at 5m plus the 1M 1h subset, not 3M plus another 1M.
    const usage = {
      input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000,
      cacheCreation: 3_000_000, cacheCreation1h: 1_000_000, total: 7_000_000,
    };
    const price = lookupPrice(model)!;
    const actual = costBreakdown(usage, price);
    expect(actual.input).toBe(expected.input);
    expect(actual.output).toBe(expected.output);
    expect(actual.cacheRead).toBe(expected.cacheRead);
    expect(actual.cacheCreation).toBe(expected.cacheCreation);
    expect(actual.total).toBeCloseTo(expected.total, 12);
    expect(costForUsage(usage, price)).toBeCloseTo(expected.total, 12);
  });

  it('costBreakdown falls back to cacheCreation * 1.6 when cacheWrite1h is absent', () => {
    // price entry has no cacheWrite1h; fallback = 6.25 * 1.6 = 10.0
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000, cacheCreation1h: 1_000_000, total: 1_000_000 };
    const price = { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }; // no cacheWrite1h
    const b = costBreakdown(usage, price);
    expect(b.cacheCreation).toBeCloseTo(10.0, 6);
  });
});
