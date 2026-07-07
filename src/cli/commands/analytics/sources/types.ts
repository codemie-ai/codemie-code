/**
 * Analytics source seam.
 *
 * Every data backend implements {@link AnalyticsSource}: it loads its data and returns the
 * same {@link SourceResult} the aggregate → report pipeline consumes, so the CLI stays
 * agnostic to where the data came from.
 *
 * Today: {@link SessionsSource} (local ~/.codemie + native logs) and OtelSource
 * (flattened otel-events.jsonl). Future remote backends (Prometheus, Loki, Langfuse) become
 * one new `AnalyticsSource` + one thin `analytics <name>` subcommand each, with connection
 * URL + auth resolved from the `.codemie` config/profile (never CLI flags) — e.g.
 *   "analyticsSources": { "prod-langfuse": { "type": "langfuse", "url": "…", "authEnv": "LANGFUSE_TOKEN" } }
 * where `authEnv` names the env var holding the token. No connector code exists yet.
 */
import type { RawSessionData } from '../data-loader.js';
import type { AnalyticsFilter } from '../types.js';
import type { SessionCostIndex, CostSummary } from '../cost/types.js';

export interface SourceLoadOptions {
  filter: AnalyticsFilter;
  /** Sessions source only: skip native agent-log discovery. Ignored by other sources. */
  scanNative?: boolean;
  /** Sessions source only: include non-CodeMie-owned native sessions (tagged 'native-external') in output. Ignored by other sources. */
  includeExternal?: boolean;
}

export interface SourceResult {
  rawSessions: RawSessionData[];
  /**
   * Authoritative cost, present only when the source carries it in its own data
   * (e.g. OTEL `cost_usd`). Omitted when cost must be derived later from correlated logs
   * (local sessions → cost-enricher); the runner enriches in that case.
   */
  cost?: { index: SessionCostIndex; summary: CostSummary };
}

export interface AnalyticsSource {
  load(opts: SourceLoadOptions): Promise<SourceResult>;
}
