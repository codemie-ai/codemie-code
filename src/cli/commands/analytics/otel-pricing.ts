/**
 * OTEL resolver-path pricing fallback.
 *
 * `codemie analytics otel` events carry an authoritative `cost_usd` when the collector itself
 * reports it. When absent, the event is priced through the same table (section B's resolver,
 * see `resolvePrice()`) that cost-enricher.ts's `priceUsage()` applies to native-log usage — kept
 * in its own module so otel-loader.ts's session/perModel bookkeeping doesn't have to carry the
 * pricing-table concern too.
 */

import type { TokenUsage } from './cost/types.js';
import { resolvePrice } from '@/utils/pricing.js';
import { costBreakdown } from './cost/cost-calculator.js';

/** Result of pricing one OTEL `api_request` event. */
export interface OtelEventPricing {
  /** USD attributed to this event; 0 when unpriced. */
  cost: number;
  /**
   * True only when the event carried usage (token total > 0) that the resolver could not price.
   * A zero-usage event is never flagged unpriced — there is no dollar amount to have gotten
   * wrong, so surfacing it would only add noise to `unpricedModels`.
   */
  unpriced: boolean;
  /** True when the resolved price came from a tier-estimate row, not a confirmed published price. */
  estimated: boolean;
  /** True when this event's cost came from the resolver table rather than a reported `cost_usd`. */
  tablePriced: boolean;
}

/**
 * Price one OTEL `api_request` event.
 *
 * @param hasReportedCost - Whether the event carried a usable `cost_usd` (see the caller's own
 *   numeric/finite check). A present `cost_usd` is authoritative and is never repriced.
 * @param reportedCost - The event's raw `cost_usd` attribute value (only read when
 *   `hasReportedCost` is true).
 * @param rawModel - The unnormalized model id. `resolvePrice()` does its own canonicalization
 *   internally, but also needs the raw form to detect a Bedrock regional-endpoint premium.
 * @param eventUsage - This event's own token usage (not the session running total).
 */
export function priceOtelEvent(hasReportedCost: boolean, reportedCost: unknown, rawModel: string, eventUsage: TokenUsage): OtelEventPricing {
  if (hasReportedCost) {
    return { cost: Number(reportedCost), unpriced: false, estimated: false, tablePriced: false };
  }
  const resolution = resolvePrice(rawModel);
  if (resolution) {
    return { cost: costBreakdown(eventUsage, resolution.price).total, unpriced: false, estimated: resolution.estimated, tablePriced: true };
  }
  return { cost: 0, unpriced: eventUsage.total > 0, estimated: false, tablePriced: false };
}
