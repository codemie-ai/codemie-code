/**
 * Type declarations for the plain-JS routing-headers.mjs, so TypeScript consumers (the analytics
 * cost engine — src/cli/commands/analytics/cost/usage-readers.ts) get full typing on an import
 * that, at runtime, is not compiled by tsc: scripts/copy-plugins.js copies it verbatim, and any
 * agent's statusline installer deploys it as a flat sibling — so the module itself must stay
 * plain JS with zero project imports.
 */

/**
 * CodeMie's canonical routing headers, as the proxy's routing-header-injector plugin copies
 * them onto the message body — key is the lowercased header name, hyphens intact (no underscore
 * conversion; see that plugin's own header comment for why). One vocabulary regardless of which
 * mechanism made the routing decision on the backend (CodeMie Switchyard, LiteLLM's own
 * auto-router, or anything added later) — that distinction never reaches this repo.
 */
export interface RoutingHeaderSource {
  /** The model the router actually dispatched to. Confirmed against live traffic to always
   * match the response body's own `model`, so it's a corroborating signal rather than the
   * sole source — `model` remains authoritative when this is absent. */
  'x-codemie-routed-model'?: string;
  /** Injected by the CodeMie proxy when routing is active. */
  'x-codemie-requested-model'?: string;
  'x-codemie-routing-tier'?: string;
  /** Why the router chose this tier, e.g. llm-classifier, ambiguous. */
  'x-codemie-routing-decision-source'?: string;
  /** Routing decision source: 'stage_router' (rule-based) or 'judge' (LLM-based). */
  'x-codemie-routing-source'?: string;
  /** Router strategy, e.g. 'stage', 'composite'. */
  'x-codemie-routing-router-type'?: string;
  /** Opaque, backend-internal identifier of which mechanism made the decision (e.g.
   * "switchyard", "litellm") — informational only, never branched on in this repo. */
  'x-codemie-routing-family'?: string;
  /** Routing classifier LLM call cost (present when the classifier was invoked). */
  'x-codemie-routing-classifier-model'?: string;
  'x-codemie-routing-classifier-cost-usd'?: string;
  /** Backend-computed counterfactual model: repricing this turn's usage at this model's rate
   * estimates what the turn would have cost unrouted, for the cost-savings calculation — see
   * `estimatedMaxCostUSD`/`potentialSavingsUSD` in the analytics cost types. Present on any
   * routing family (not just Switchyard), unlike `x-codemie-requested-model`, which on some
   * families is a router/tier alias rather than a priceable model. */
  'x-codemie-routing-counterfactual-model'?: string;
}

/** One turn's routing decision, parsed from {@link RoutingHeaderSource}. */
export interface RoutingDecision {
  /** The capable model that was originally requested, when routing selected a cheaper model. */
  requestedModel?: string;
  /** Raw tier string as emitted, before being folded to the common vocabulary. */
  routingTierRaw?: string;
  /** Model the router actually dispatched to. */
  routedModel?: string;
  /** The LLM used to make the routing decision. */
  classifierModel?: string;
  /** Router strategy, e.g. 'stage', 'composite'. */
  routerType?: string;
  /**
   * True when this turn's routing cost was reported, so `classifierCostUSD == null` means "no
   * classifier ran" rather than "not measured".
   */
  routingCostKnown?: boolean;
  /** Routing tier for this turn, folded to a common vocabulary: 'simple' | 'middle' | 'complex' | 'reasoning'. */
  routingTier?: 'simple' | 'middle' | 'complex' | 'reasoning' | string;
  /** Routing decision source: 'stage_router' (rule-based) or 'judge' (LLM-based). */
  routingSource?: 'stage_router' | 'judge' | string;
  /** Why the router chose this tier, e.g. llm-classifier, ambiguous. */
  decisionSource?: string;
  /** Opaque, backend-internal identifier of which mechanism made the decision — informational
   * only, carried through for display/analytics, never branched on in this repo. */
  routingFamily?: string;
  /** Classifier LLM call cost in USD for this turn. */
  classifierCostUSD?: number;
  /** Backend-computed model to reprice this turn's usage at for the cost-savings estimate
   * (`x-codemie-routing-counterfactual-model`) — see cost-enricher.ts's `buildModelTimeline`. */
  counterfactualModel?: string;
}

/**
 * Parse one turn's routing decision out of its transcript message — see routing-headers.mjs.
 * Returns `null` when the message carries no routing metadata at all — the common case for
 * non-routed deployments and for requests that name a literal model ID.
 */
export declare function parseRoutingHeaders(message: RoutingHeaderSource | null | undefined): RoutingDecision | null;
