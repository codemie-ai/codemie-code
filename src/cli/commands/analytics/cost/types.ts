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

/** One cumulative point in a session's token & cost growth series. */
export interface CostSeriesPoint {
  t: number; // epoch ms when all records are timed, else the 1-based turn ordinal
  cost: number; // cumulative USD up to and including this turn
  tokens: number; // cumulative total tokens up to and including this turn
}

/** Max points kept per session series — downsample guard so the embedded payload stays small. */
export const MAX_SERIES_POINTS = 40;

/** One dispatched invocation (agent/skill/command) on a session's activity timeline. */
export interface DispatchEvent {
  kind: 'agent' | 'skill' | 'command';
  name: string;
  start: number;       // epoch ms of the tool_use / command
  durationMs: number;  // tool_result − tool_use; 0 for skills/commands/unmatched
  tokens?: TokenUsage; // from subagent transcript; absent when no meta match or unpriced model
  costUSD?: number;    // priced from tokens; absent when unpriced or no meta match
  tools?: Array<{ name: string; calls: number }>; // top tool call counts from subagent; max 8
}

/**
 * Internal dispatch event used during cost enrichment — carries _toolUseId to join
 * against parsed.subagents. Stripped before the event is stored in SessionCost.dispatches.
 */
export type DispatchEventRaw = DispatchEvent & { _toolUseId?: string };

/** Max dispatch events kept per session — payload guard for very long runs. */
export const MAX_DISPATCHES = 60;

/** Cost result for a single session. */
export interface SessionCost {
  sessionId: string;
  tokens: TokenUsage; // summed across models
  costUSD: number; // summed across models
  cacheReadCostUSD?: number; // USD attributable to cache reads (subset of costUSD); 0 when unpriced
  costSeries?: CostSeriesPoint[]; // per-turn cumulative cost/token growth; absent when no per-turn data
  dispatches?: DispatchEvent[]; // top-level agent/skill/command invocations with timing; absent when none
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
