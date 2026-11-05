/**
 * In-process analytics load/enrich/aggregate pipeline, shared by the interactive
 * `codemie analytics` command and the unattended `codemie analytics sync` report builder.
 *
 * Extracted verbatim from `runAnalytics` (src/cli/commands/analytics/index.ts) so both callers
 * share one implementation. No console output and no `process.exit` here — callers own how
 * (or whether) they report the "no sessions"/"empty aggregate" cases to the user.
 */
import { AnalyticsAggregator } from './aggregator.js';
import type { AnalyticsFilter, RootAnalytics } from './types.js';
import type { AnalyticsSource } from './sources/types.js';
import type { SessionCostIndex, CostSummary } from './cost/types.js';

export type LoadAnalyticsResult =
  | { kind: 'ok'; analytics: RootAnalytics; costResult: { index: SessionCostIndex; summary: CostSummary } }
  | { kind: 'empty-raw' }
  | { kind: 'empty-aggregate' };

/**
 * Loads raw sessions from `source`, enriches cost (authoritative from the source when present,
 * otherwise derived from correlated native logs via the cost-enricher), and aggregates into
 * {@link RootAnalytics}.
 *
 * Returns a discriminated union rather than throwing/printing so callers (interactive CLI,
 * unattended sync) decide independently how to react to "no sessions" vs "sessions but no
 * measurable analytics".
 */
export async function loadAnalytics(
  source: AnalyticsSource,
  filter: AnalyticsFilter,
  includeExternal: boolean | undefined,
  normalize: boolean
): Promise<LoadAnalyticsResult> {
  const { rawSessions, cost } = await source.load({ filter, includeExternal });

  if (rawSessions.length === 0) {
    return { kind: 'empty-raw' };
  }

  // Cost computed BEFORE aggregation so zero-delta sessions that still carry real usage are
  // retained instead of dropped as "empty". Authoritative from the source (OTEL) when present;
  // otherwise always enriched from correlated native logs. Both branches populate the same
  // shape, so `costResult` narrows without a throw or a non-null assertion.
  let costResult: NonNullable<typeof cost>;
  if (cost) {
    costResult = cost;
  } else {
    const { enrichCosts, realDeps } = await import('./cost/cost-enricher.js');
    costResult = await enrichCosts(rawSessions, realDeps);
  }
  const keepSessionIds = new Set(
    [...costResult.index.values()].filter((c) => c.tokens.total > 0).map((c) => c.sessionId)
  );

  const analytics = AnalyticsAggregator.aggregate(rawSessions, normalize, keepSessionIds);

  if (analytics.totalSessions === 0) {
    return { kind: 'empty-aggregate' };
  }

  return { kind: 'ok', analytics, costResult };
}
