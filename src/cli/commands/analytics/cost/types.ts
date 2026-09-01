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
  cacheCreation: number;    // aggregate (5m + 1h) — for display and total
  cacheCreation1h: number;  // 1h-TTL subset; 0 when absent in transcript
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

/** One point in the per-turn model/tier/decision timeline shown in the session modal. */
export interface ModelTimelinePoint {
  t: number; // epoch ms when all records are timed, else the 1-based turn ordinal
  model: string; // normalized model name that was actually used
  costUSD: number; // per-turn cost attributed to this model
  tokens: number; // per-turn total tokens for this turn
  requestedModel?: string; // capable model that was originally requested
  capableModel?: string; // alias for requestedModel
  routingFamily?: 'switchyard' | 'litellm'; // which header family carried the decision
  routingTier?: 'efficient' | 'capable' | string;
  routingTierRaw?: string; // tier as emitted, before the two vocabularies are folded
  routedModel?: string; // model the router actually dispatched to
  classifierModel?: string; // LLM that made the routing decision
  routerType?: string; // router strategy, e.g. 'complexity'
  routerScore?: number; // numeric score from LiteLLM's heuristic scorer
  routingConfidence?: number;
  routingSource?: 'stage_router' | 'judge' | 'classifier' | string;
  decisionSource?: string;
  signalScore?: number;
  signalConfidence?: number;
  signalSeverity?: number;
  signalSpinning?: number;
  signalExploring?: number;
  signalProductionIntensity?: number;
  judgePSolve?: number;
  judgeCrux?: string;
  judgePrimaryRule?: string;
  judgeCapabilityBoundary?: string;
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
  modelTimeline?: ModelTimelinePoint[]; // per-turn model + routing metadata; absent when no routing data
  dispatches?: DispatchEvent[]; // top-level agent/skill/command invocations with timing; absent when none
  perModel: ModelCost[];
  priced: boolean; // true if the native log was found & parsed
  hadLog: boolean; // true if a native log path was located (priced<hadLog ⇒ parse/reader gap)
  // === Routing classifier cost (additive to costUSD; see routingCostKnown) ===
  judgeCostUSD?: number; // USD spent on the routing classifier LLM
  judgeInputTokens?: number;
  judgeOutputTokens?: number;
  judgeCachedTokens?: number;
  judgeCacheCreationTokens?: number;
  /**
   * True when every routed turn in this session reported its classifier cost — always the
   * case on Switchyard, and on LiteLLM builds that emit `x-litellm-classifier-cost`. False
   * when any routed turn reported none, making `judgeCostUSD` an understatement rather than a
   * measurement. Absent when the session had no routed turns at all.
   */
  routingCostKnown?: boolean;

  // === Usage provenance (from ParsedSession.usageMeta) ===
  /**
   * Billing units the provider itself charges in, when they differ from tokens.
   * Currently only GitHub Copilot CLI ("premium requests"), whose bill does not track
   * token volume — so `costUSD` is a comparable estimate, not that provider's invoice.
   */
  premiumRequests?: number;
  /** True when usage was reconstructed from partial data and understates actual use. */
  usagePartial?: boolean;
  /** Why this session has no usage data; absent when usage was found. */
  usageUnavailableReason?: string;
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
