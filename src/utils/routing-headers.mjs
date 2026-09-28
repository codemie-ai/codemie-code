// Routing-header domain layer.
//
// The CodeMie proxy's routing-header-injector plugin copies the upstream router's canonical
// x-codemie-routing-* response headers onto the message body verbatim — hyphens intact, no key
// transformation (see src/providers/plugins/sso/proxy/plugins/routing-header-injector.plugin.ts)
// — where the agent persists them in its own transcript. parseRoutingHeaders() is the ONE place
// that turns those raw header fields into the RoutingDecision domain entity (see
// routing-headers.d.mts) — every consumer reads the parsed entity, not the raw header strings.
//
// The proxy emits a single header vocabulary regardless of which mechanism actually made the
// routing decision on the backend (CodeMie Switchyard, LiteLLM's own auto-router, or anything
// added later) — that distinction is backend-internal and never reaches this repo. This module
// treats routing as one abstract concept: whatever the proxy reports is parsed uniformly.
// `x-codemie-routing-family` is carried through as an opaque, informational string (purely for
// display/analytics — e.g. "switchyard" vs "litellm" today) — nothing here branches on it.
//
// Scoped to the routing DECISION only (tier, routed/requested model, classifier cost) — not
// agent-specific, not about model pricing. Resolving a backend model id for Bedrock regional
// pricing lives in the separate bedrock-pricing.mjs, even though it also reads a header off the
// same message object: that's a pricing concern any agent going through this proxy needs,
// independent of whether a routing decision was made at all.
//
// Deliberately plain JS with zero imports, living under src/utils/ rather than beside a specific
// agent's plugin: this file is deployed as-is to two different runtimes —
//   - Any agent's standalone statusline (e.g. the Claude one, plugin/statusline.mjs — no project
//     imports, `node <path>` after the CLI process exits) imports it by relative path; its own
//     installer deploys this file as a flat sibling (see statusline-installer.ts).
//   - The analytics cost engine (src/cli/commands/analytics/cost/usage-readers.ts) imports it
//     too, as a normal TS import — see the companion routing-headers.d.mts for its types, since
//     this file itself is plain JS, not compiled.
// Because tsc does not compile `.mjs`, scripts/copy-plugins.js has an explicit copy entry for it
// (same pattern as pricing.json).

const CODEMIE_ROUTING_HEADERS = [
  'x-codemie-routed-model',
  'x-codemie-requested-model',
  'x-codemie-routing-tier',
  'x-codemie-routing-decision-source',
  'x-codemie-routing-source',
  'x-codemie-routing-router-type',
  'x-codemie-routing-family',
  'x-codemie-routing-classifier-model',
  'x-codemie-routing-classifier-cost-usd',
  'x-codemie-routing-counterfactual-model',
];

function hasAnyHeader(message, headerNames) {
  return headerNames.some((name) => message?.[name] != null);
}

/**
 * Parse one turn's routing decision out of its transcript message. Returns `null` when the
 * message carries no routing metadata at all — the common case for non-routed deployments and
 * for requests that name a literal model ID.
 *
 * @param {object | null | undefined} message
 * @returns {import('./routing-headers.d.mts').RoutingDecision | null}
 */
export function parseRoutingHeaders(message) {
  if (!hasAnyHeader(message, CODEMIE_ROUTING_HEADERS)) return null;

  const routingTier = normalizeRoutingTier(message['x-codemie-routing-tier']);
  const classifierCostUSD = parseOptFloat(message['x-codemie-routing-classifier-cost-usd']);

  return {
    ...(message['x-codemie-requested-model'] != null && { requestedModel: message['x-codemie-requested-model'] }),
    ...(routingTier != null && { routingTier }),
    ...(message['x-codemie-routing-tier'] != null && { routingTierRaw: message['x-codemie-routing-tier'] }),
    ...(message['x-codemie-routed-model'] != null && { routedModel: message['x-codemie-routed-model'] }),
    ...(message['x-codemie-routing-classifier-model'] != null && { classifierModel: message['x-codemie-routing-classifier-model'] }),
    ...(message['x-codemie-routing-router-type'] != null && { routerType: message['x-codemie-routing-router-type'] }),
    ...(message['x-codemie-routing-source'] != null && { routingSource: message['x-codemie-routing-source'] }),
    ...(message['x-codemie-routing-decision-source'] != null && { decisionSource: message['x-codemie-routing-decision-source'] }),
    // Opaque passthrough of whichever backend mechanism made the decision — informational only.
    ...(message['x-codemie-routing-family'] != null && { routingFamily: message['x-codemie-routing-family'] }),
    // Backend-computed counterfactual: the model this turn's usage should be repriced at to
    // estimate "what this would have cost unrouted" — see cost-enricher.ts's `buildModelTimeline`.
    ...(message['x-codemie-routing-counterfactual-model'] != null && { counterfactualModel: message['x-codemie-routing-counterfactual-model'] }),
    // Known iff the proxy reported a classifier cost for this turn — absence means "no
    // classifier ran / not measured", not "zero".
    routingCostKnown: classifierCostUSD != null,
    ...(classifierCostUSD != null && { classifierCostUSD }),
  };
}

function parseOptFloat(s) {
  if (s == null) return undefined;
  const v = parseFloat(s);
  return Number.isNaN(v) ? undefined : v;
}

function normalizeRoutingTier(raw) {
  if (raw == null) return undefined;
  const key = String(raw).trim().toLowerCase();
  const map = {
    'simple': 'simple',
    'efficient': 'middle',
    'medium': 'middle',
    'capable': 'complex',
    'complex': 'complex',
    'reasoning': 'reasoning',
  };
  return map[key] ?? key;
}
