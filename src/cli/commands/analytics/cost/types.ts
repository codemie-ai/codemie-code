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
  /**
   * The literal alias/id the `model` param actually held for this turn — from Claude Code's own
   * `type: 'attachment'` model-identity markers (see usage-readers.ts's
   * `extractModelIdentityTimeline`), resolved to whichever marker was most recent at this turn's
   * timestamp. Unlike `requestedModel` (the header's capable-tier ceiling for Switchyard), this
   * is exact even for a custom Switchyard variant name — and stays correct turn-by-turn across
   * an in-session `/model` switch. Absent when this agent's log has no such marker.
   */
  requestedAlias?: string;
  routingFamily?: string; // opaque, backend-internal id of which mechanism decided — informational only
  routingTier?: 'simple' | 'middle' | 'complex' | 'reasoning' | string;
  routingTierRaw?: string; // tier as emitted, before folded to the common vocabulary
  routedModel?: string; // model the router actually dispatched to
  classifierModel?: string; // LLM that made the routing decision
  routerType?: string; // router strategy, e.g. 'stage', 'composite'
  routingSource?: 'stage_router' | 'judge' | string;
  decisionSource?: string; // why the router chose this tier, e.g. llm-classifier, ambiguous

  // === Cost savings (from the backend's counterfactual-model header — see
  // routing-headers.mjs's header comment) ===
  /** Backend-reported model to reprice this turn's usage at for the savings estimate below
   * (`x-codemie-routing-counterfactual-model`). Unlike `requestedModel`, which on some routing
   * families is a router/tier alias (e.g. `claude-smart-router`), this is always a priceable
   * model. Absent when the backend reported no counterfactual for this turn. */
  counterfactualModel?: string;
  /**
   * What this turn would have cost had `counterfactualModel` answered it instead, repricing
   * this turn's actual token usage at that model's rate — see cost-enricher.ts's
   * `buildModelTimeline`. Absent when `counterfactualModel` is absent, or has no pricing entry.
   */
  estimatedMaxCostUSD?: number;
  /** max(0, estimatedMaxCostUSD - costUSD). Absent under the same condition as estimatedMaxCostUSD. */
  potentialSavingsUSD?: number;
}

/** Max points kept per session series — downsample guard so the embedded payload stays small. */
export const MAX_SERIES_POINTS = 40;

/** One dispatched invocation (agent/skill/command) on a session's activity timeline. */
export interface DispatchEvent {
  kind: 'agent' | 'skill' | 'command';
  name: string;
  start: number;       // epoch ms of the tool_use / command
  durationMs: number;  // tool_result − tool_use; 0 for skills/commands/unmatched
  /** Stable invocation identity. Native Claude dispatches use the tool-use ID. */
  id?: string;
  /** Stable identity of the agent invocation that owns this step. */
  ownerAgentId?: string;
  /** Agent ID assigned by Claude to an Agent/Task invocation. */
  agentId?: string;
  /** Parent agent invocation's dispatch ID. Absent for root-owned steps. */
  parentId?: string;
  depth?: number;
  relationshipStatus?: 'resolved' | 'root' | 'missing' | 'conflict' | 'cycle';
  acknowledgedAt?: number;
  observedEnd?: number;
  completedAt?: number;
  /** Authoritative completion span, or observed subtree activity for incomplete work. */
  elapsedMs?: number;
  status?: 'completed' | 'failed' | 'incomplete' | 'unknown';
  tokens?: TokenUsage; // own accepted usage; excludes descendants and cross-session replay
  costUSD?: number;    // priced own usage; absent when unpriced or attribution is unavailable
  /** Own accepted usage plus descendants with resolved ancestry. Overlaps ancestor totals. */
  inclusiveTokens?: TokenUsage;
  inclusiveCostUSD?: number;
  attributionStatus?: 'exact' | 'estimated' | 'unavailable' | 'ambiguous';
  /** Skill/command windows are overlapping estimates within their canonical owner only. */
  attributionScope?: 'own' | 'owner-window';
  tools?: Array<{ name: string; calls: number }>; // top tool call counts from subagent; max 8
}

/**
 * Internal dispatch event used during cost enrichment — carries _toolUseId to join
 * against parsed.subagents. Stripped before the event is stored in SessionCost.dispatches.
 */
export type DispatchEventRaw = DispatchEvent & { _toolUseId?: string; _taskId?: string };

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
  /** True only when dispatch extraction retained the full invocation list. Legacy lists may be capped. */
  dispatchesComplete?: boolean;
  /** Actual native-family capture time and observed activity bounds, in epoch milliseconds. */
  capturedAt?: number;
  observedStart?: number;
  observedEnd?: number;
  /** Native token estimates are distinct from amounts reported by the source itself. */
  costSource?: 'native-estimate' | 'authoritative';
  costBasis?: 'standard-api-tokens' | 'source-reported';
  perModel: ModelCost[];
  /** Disjoint Claude root allocation. Session = root own + top-level inclusive + unlinked. */
  rootOwnTokens?: TokenUsage;
  rootOwnCostUSD?: number;
  /** Accepted usage whose owner cannot be reached from the root through resolved ancestry. */
  unlinkedTokens?: TokenUsage;
  unlinkedCostUSD?: number;
  unlinkedAgentIds?: string[];
  priced: boolean; // true if the native log was found & parsed
  hadLog: boolean; // true if a native log path was located (priced<hadLog ⇒ parse/reader gap)
  /**
   * The native log path actually used to resolve `hadLog`/pricing — either
   * `raw.agentSessionFile` or the ~/.codemie/sessions/{id}.json correlation-file
   * fallback (see cost-enricher.ts's `loadAgentSessionFile`). Set iff `hadLog` is
   * true, so a consumer never has to reconcile "cost was priced" against "no file
   * to show" — those two must always agree.
   */
  agentSessionFile?: string;

  // === Routing classifier cost (additive to costUSD; see routingCostKnown) ===
  classifierCostUSD?: number; // USD spent on the routing classifier LLM
  /**
   * True when every routed turn in this session reported its classifier cost. False when any
   * routed turn reported none, making `classifierCostUSD` an understatement rather than a
   * measurement. Absent when the session had no routed turns at all.
   */
  routingCostKnown?: boolean;
  /**
   * Percentage (0-100, rounded) of this session's turns where routing measurably changed the
   * outcome — the turn's actual model (`routedModel`, falling back to `model`) differs from its
   * backend-reported `counterfactualModel` (see `ModelTimelinePoint`). A turn with no
   * `counterfactualModel` reported does not count as routed under this definition. Absent when
   * the session has no modelTimeline data at all.
   */
  routedTurnsPct?: number;

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
