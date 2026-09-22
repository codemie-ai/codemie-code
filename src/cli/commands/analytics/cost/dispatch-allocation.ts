import type { DispatchEventRaw, TokenUsage } from './types.js';
import { emptyUsage, addUsage, costBreakdown } from './cost-calculator.js';
import { lookupPrice } from '@/utils/pricing.js';
import { normalizeModelName } from '@/utils/model-normalizer.js';
import { sumUsageRecords, type UsageRecord } from './usage-readers.js';

/**
 * Attribute cost to a `skill` dispatch from the session's OWN already-priced usage records
 * whose timestamp falls inside the skill's [start, start + durationMs] window. Skills run
 * inline in the parent transcript (no separate subagent log to pull tokens from), so this is a
 * re-attribution of tokens already counted in the session total — same "ALLOCATION, don't add
 * to `seen`" semantics as the agent-dispatch path below. A dispatch with durationMs === 0 (no
 * matching tool_result found — see dispatch-extractor.ts) has no window to attribute from and is
 * left as "unknown" (absent costUSD/tokens), not zero.
 */
export function enrichSkillDispatchCost(dispatch: DispatchEventRaw, sessionRecords: UsageRecord[]): void {
  if (!dispatch.durationMs) return;
  const windowEnd = dispatch.start + dispatch.durationMs;
  const matched = sessionRecords.filter((r) => r.ts != null && r.ts >= dispatch.start && r.ts <= windowEnd);
  if (!matched.length) return;

  const usageByModel = sumUsageRecords(matched);
  let totalCost = 0;
  let totalTokens = emptyUsage();
  let priced = false;
  for (const [rawModel, usage] of usageByModel) {
    const model = normalizeModelName(rawModel);
    const price = lookupPrice(model);
    if (price) {
      totalCost += costBreakdown(usage, price).total;
      priced = true;
    }
    totalTokens = addUsage(totalTokens, usage);
  }
  if (priced) dispatch.costUSD = totalCost;
  dispatch.tokens = totalTokens;
}

/** Price accepted records with the same model normalization and token rate policy as session totals. */
export function priceAllocation(records: UsageRecord[]): { tokens: TokenUsage; costUSD?: number } {
  let tokens = emptyUsage();
  let costUSD = 0;
  let priced = records.length === 0;
  for (const [model, usage] of sumUsageRecords(records)) {
    const price = lookupPrice(normalizeModelName(model));
    tokens = addUsage(tokens, usage);
    if (price) { costUSD += costBreakdown(usage, price).total; priced = true; }
  }
  return { tokens, ...(priced && { costUSD }) };
}
