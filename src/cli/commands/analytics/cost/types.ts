/**
 * Token usage and cost types for the analytics HTML report.
 *
 * Cost is computed at report time by re-parsing each session's native agent log
 * (see cost-enricher.ts) and applying the pricing table (pricing.ts).
 */

/** Token usage normalized across agents. All counts default to 0 when unknown. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

/** Per-model cost line for one session. */
export interface ModelCost {
  model: string; // normalized model name
  tokens: TokenUsage;
  costUSD: number; // 0 when unpriced
  unpriced: boolean; // true when no pricing entry matched
}

/** Cost result for a single session. */
export interface SessionCost {
  sessionId: string;
  tokens: TokenUsage; // summed across models
  costUSD: number; // summed across models
  perModel: ModelCost[];
  priced: boolean; // true if the native log was found & parsed
  hadLog: boolean; // true if a native log path was located (priced<hadLog ⇒ parse/reader gap)
}

/** sessionId -> SessionCost */
export type SessionCostIndex = Map<string, SessionCost>;

/**
 * Per-agent pricing coverage — answers "which tools' metrics are included?".
 * Computed over the deduped, displayed session set (in payload-builder) so it stays
 * consistent with the report's headline session count.
 */
export interface AgentCoverage {
  agentName: string;
  total: number; // sessions for this agent
  priced: number; // sessions with token/cost data extracted
  withLog: number; // sessions whose native log was located (priced<withLog ⇒ parse/reader gap)
}

/** Run-level cost rollup for honesty banners. */
export interface CostSummary {
  totalCostUSD: number;
  pricedSessions: number;
  totalSessions: number;
  unpricedModels: string[]; // distinct models seen without a pricing entry
}
