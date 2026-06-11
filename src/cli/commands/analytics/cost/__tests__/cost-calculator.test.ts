/**
 * Cost calculator unit tests
 */

import { describe, it, expect } from 'vitest';
import { emptyUsage, addUsage, costForUsage, costBreakdown } from '../cost-calculator.js';

describe('cost-calculator', () => {
  it('emptyUsage is all zeros', () => {
    expect(emptyUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 });
  });

  it('addUsage sums fields and total', () => {
    const a = { input: 10, output: 5, cacheRead: 2, cacheCreation: 1, total: 18 };
    expect(addUsage(emptyUsage(), a)).toEqual(a);
  });

  it('costForUsage applies per-1M pricing', () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0, total: 2_000_000 };
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 };
    expect(costForUsage(usage, price)).toBeCloseTo(18, 6); // 3 + 15
  });

  it('costForUsage includes cache read and creation', () => {
    const usage = { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 1_000_000, total: 2_000_000 };
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 };
    expect(costForUsage(usage, price)).toBeCloseTo(4.05, 6); // 0.3 + 3.75
  });

  it('costBreakdown splits per component and sums to costForUsage', () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000, cacheCreation: 1_000_000, total: 5_000_000 };
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 };
    const b = costBreakdown(usage, price);
    expect(b.input).toBeCloseTo(3, 6);
    expect(b.output).toBeCloseTo(15, 6);
    expect(b.cacheRead).toBeCloseTo(0.6, 6);
    expect(b.cacheCreation).toBeCloseTo(3.75, 6);
    expect(b.total).toBeCloseTo(22.35, 6);
    expect(b.total).toBeCloseTo(costForUsage(usage, price), 6);
  });
});
