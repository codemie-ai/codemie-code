/**
 * AnalyticsFormatter.displayCost — terminal summary always shows total cost, priced-session
 * coverage, and any unpriced or estimated models (spec section A).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import stripAnsi from 'strip-ansi';
import { AnalyticsFormatter } from '../formatter.js';
import type { CostSummary } from '../cost/types.js';

function baseSummary(overrides: Partial<CostSummary> = {}): CostSummary {
  return {
    totalCostUSD: 1.2345,
    pricedSessions: 1,
    totalSessions: 2,
    unpricedModels: [],
    estimatedModels: [],
    ...overrides,
  };
}

describe('AnalyticsFormatter.displayCost', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function output(): string {
    return stripAnsi(logSpy.mock.calls.map((args) => args.join(' ')).join('\n'));
  }

  it('always prints total cost and priced-session coverage', () => {
    const formatter = new AnalyticsFormatter();
    formatter.displayCost(baseSummary());

    const out = output();
    expect(out).toContain('$');
    expect(out).toContain('Priced sessions: 1/2');
  });

  it('omits the unpriced/estimated lines when both lists are empty', () => {
    const formatter = new AnalyticsFormatter();
    formatter.displayCost(baseSummary());

    const out = output();
    expect(out).not.toContain('Unpriced models:');
    expect(out).not.toContain('Estimated models:');
  });

  it('prints unpriced models when present', () => {
    const formatter = new AnalyticsFormatter();
    formatter.displayCost(baseSummary({ unpricedModels: ['gpt-5.5', 'glm-4.7'] }));

    const out = output();
    expect(out).toContain('Unpriced models:');
    expect(out).toContain('gpt-5.5');
    expect(out).toContain('glm-4.7');
  });

  it('prints estimated models when present', () => {
    const formatter = new AnalyticsFormatter();
    formatter.displayCost(baseSummary({ estimatedModels: ['claude-opus-4-7'] }));

    const out = output();
    expect(out).toContain('Estimated models:');
    expect(out).toContain('claude-opus-4-7');
  });

  it('prints both unpriced and estimated models together', () => {
    const formatter = new AnalyticsFormatter();
    formatter.displayCost(
      baseSummary({ unpricedModels: ['gpt-5.5'], estimatedModels: ['claude-opus-4-7'] })
    );

    const out = output();
    expect(out).toContain('Unpriced models:');
    expect(out).toContain('gpt-5.5');
    expect(out).toContain('Estimated models:');
    expect(out).toContain('claude-opus-4-7');
  });
});
