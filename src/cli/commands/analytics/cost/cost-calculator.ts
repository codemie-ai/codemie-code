/**
 * Pure cost/token math. No I/O — safe to unit test in isolation.
 */

import type { TokenUsage } from './types.js';
import type { ModelPrice } from './pricing.js';

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    total: a.total + b.total,
  };
}

/** USD cost split by token component. Components sum to {@link costForUsage}. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

/** Per-component USD; price is per 1,000,000 tokens. */
export function costBreakdown(usage: TokenUsage, price: ModelPrice): CostBreakdown {
  const input = (usage.input * price.input) / 1_000_000;
  const output = (usage.output * price.output) / 1_000_000;
  const cacheRead = (usage.cacheRead * price.cacheRead) / 1_000_000;
  const cacheCreation = (usage.cacheCreation * price.cacheCreation) / 1_000_000;
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

/** USD; price is per 1,000,000 tokens. */
export function costForUsage(usage: TokenUsage, price: ModelPrice): number {
  return costBreakdown(usage, price).total;
}
