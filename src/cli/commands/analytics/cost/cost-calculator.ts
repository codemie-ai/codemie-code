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

/** USD; price is per 1,000,000 tokens. */
export function costForUsage(usage: TokenUsage, price: ModelPrice): number {
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheCreation * price.cacheCreation) /
    1_000_000
  );
}
