/**
 * Pure cost/token math. No I/O — safe to unit test in isolation.
 */

import type { TokenUsage } from './types.js';
import type { ModelPrice } from './pricing.js';

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheCreation1h: a.cacheCreation1h + b.cacheCreation1h,
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

/**
 * Anthropic prices a 1h-TTL cache write at 2× base input and a 5m-TTL write at
 * 1.25× base input, so a 1h write costs 2.0 / 1.25 = 1.6× the 5m write. Used as a
 * fallback when a model's pricing row has no explicit `cacheWrite1h`.
 */
const CACHE_WRITE_1H_TO_5M_RATIO = 1.6;

/** USD for cache-creation tokens, split by TTL bucket. Per 1,000,000 tokens. */
function cacheCreationCost(usage: TokenUsage, price: ModelPrice): number {
  // cacheCreation1h is the 1h-TTL subset of the aggregate cacheCreation; the rest
  // is the 5m-TTL bucket. Clamp the subset to the aggregate so a malformed transcript
  // (1h > aggregate) can never price more tokens than were actually written.
  const tokens1h = Math.min(usage.cacheCreation1h, usage.cacheCreation);
  const tokens5m = usage.cacheCreation - tokens1h;
  const rate1h = price.cacheWrite1h ?? price.cacheCreation * CACHE_WRITE_1H_TO_5M_RATIO;
  return (tokens1h * rate1h + tokens5m * price.cacheCreation) / 1_000_000;
}

/** Per-component USD; price is per 1,000,000 tokens. */
export function costBreakdown(usage: TokenUsage, price: ModelPrice): CostBreakdown {
  const input = (usage.input * price.input) / 1_000_000;
  const output = (usage.output * price.output) / 1_000_000;
  const cacheRead = (usage.cacheRead * price.cacheRead) / 1_000_000;
  const cacheCreation = cacheCreationCost(usage, price);
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

/** USD; price is per 1,000,000 tokens. */
export function costForUsage(usage: TokenUsage, price: ModelPrice): number {
  return costBreakdown(usage, price).total;
}
