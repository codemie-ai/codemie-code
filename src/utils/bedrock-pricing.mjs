// Bedrock regional-endpoint pricing.
//
// Amazon Bedrock bills a regional or multi-region (cross-region inference profile) endpoint at a
// premium over its global one, for the models Anthropic documents this two-endpoint-type pricing
// structure for — see
// https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock#regions. This
// module resolves a raw backend model id to its Bedrock region and applies that premium to a
// price/rate object; it knows nothing about routing decisions (Switchyard/LiteLLM tier, classifier
// cost — see the separate routing-headers.mjs) and nothing about any particular agent. Any agent
// whose requests can land on Bedrock through this proxy (Claude, but potentially others too) needs
// the same detection, so it lives here rather than under a specific agent's plugin directory.
//
// Deliberately plain JS with zero imports, living under src/utils/ rather than beside a specific
// agent's plugin: this file is deployed as-is to two different runtimes —
//   - Any agent's standalone statusline (e.g. the Claude one, plugin/statusline.mjs — no project
//     imports, `node <path>` after the CLI process exits) imports it by relative path; its own
//     installer deploys this file as a flat sibling (see statusline-installer.ts).
//   - src/utils/pricing.ts (the analytics/report pricing table) and
//     src/cli/commands/analytics/cost/usage-readers.ts import it as a normal TS import — see the
//     companion bedrock-pricing.d.mts for its types, since this file itself is plain JS, not
//     compiled.
// Because tsc does not compile `.mjs`, scripts/copy-plugins.js has an explicit copy entry for it
// (same pattern as pricing.json).

/**
 * The literal backend model LiteLLM dispatched to, e.g. `bedrock/converse/eu.anthropic.claude-
 * haiku-4-5-20251001-v1:0` or `bedrock/us.anthropic.claude-sonnet-5`. Present on every LiteLLM-
 * proxied response regardless of whether a routing decision was made at all — unlike
 * `parseRoutingHeaders()` (routing-headers.mjs), which returns `null` for an unrouted turn. Used
 * for Bedrock regional-endpoint pricing detection (see {@link isBedrockRegionalPremium}) because
 * the cleaned `routedModel`/`requestedModel` fields, and sometimes even the response's own
 * `model` field (observed on a "capable"-tier Switchyard turn), have the region qualifier
 * already stripped.
 *
 * @param {object | null | undefined} message
 * @returns {string | null}
 */
export function parseBackendModelName(message) {
  return message?.['x-litellm-model-name'] ?? null;
}

// Matches the Bedrock region/endpoint qualifier that sits directly before `.anthropic.` in a
// fully-qualified backend model id — `global` (the no-premium default), a geography code (`us`,
// `eu`, `jp`, `au` — Bedrock's cross-region inference profiles), or a literal AWS region
// (`us-east-2`). Matches with or without a leading `bedrock/`/`converse/` path segment.
const BEDROCK_REGION_PATTERN = /(?:^|\/)([a-z0-9-]+)\.anthropic\./i;

/**
 * The Bedrock region/endpoint qualifier embedded in a fully-qualified backend model id, or
 * `null` when the id carries none (a direct Anthropic API id, or a non-Bedrock provider).
 *
 * @param {string | null | undefined} rawModelId
 * @returns {string | null}
 */
export function bedrockEndpointRegion(rawModelId) {
  if (!rawModelId) return null;
  const match = BEDROCK_REGION_PATTERN.exec(String(rawModelId).toLowerCase());
  return match ? match[1] : null;
}

/**
 * True when `rawModelId` names a Bedrock regional or multi-region (cross-region inference
 * profile) endpoint rather than the global one. `global`, and any id with no Bedrock region
 * qualifier at all, are never regional.
 *
 * Says nothing about whether a premium actually applies, or how big it is — that is
 * model-specific (Anthropic documents it only for Sonnet 4.5+/Haiku 4.5+/Opus 4.5+) and lives as
 * a `bedrockRegionalMultiplier` field on the model's own pricing row; see
 * {@link applyBedrockRegionalPremium}.
 *
 * @param {string | null | undefined} rawModelId
 * @returns {boolean}
 */
export function isBedrockRegionalPremium(rawModelId) {
  const region = bedrockEndpointRegion(rawModelId);
  return region != null && region !== 'global';
}

/**
 * Applies a price/rate object's own `bedrockRegionalMultiplier` when `rawModelId` names a
 * regional/multi-region Bedrock endpoint (see {@link isBedrockRegionalPremium}) — a no-op
 * (returns `price` itself) otherwise, and when `price` carries no `bedrockRegionalMultiplier` at
 * all (a pre-4.5 model, which Anthropic does not document this pricing structure for). Confirmed
 * against a real LiteLLM billing breakdown: every priced component on a `us`-profile Sonnet 5
 * turn, and separately on `eu`- and `jp`-profile Haiku 4.5 turns in the same session, matched
 * exactly ×1.1 of the global rate, while a `global`-routed turn in the same session matched
 * ×1.0 with no premium.
 *
 * Shared by both callers — pricing.ts's `ModelPrice` (`cacheCreation`) and statusline.mjs's
 * deployed rate card (`cacheCreation`, or the raw `cacheWrite` spelling from an older install) —
 * so multiplies whichever cache-write field is actually present rather than assuming one shape.
 *
 * @param {object | null | undefined} price
 * @param {string | null | undefined} rawModelId
 * @returns {object | null | undefined}
 */
export function applyBedrockRegionalPremium(price, rawModelId) {
  if (price == null || price.bedrockRegionalMultiplier == null || !isBedrockRegionalPremium(rawModelId)) {
    return price;
  }
  const multiplier = price.bedrockRegionalMultiplier;
  return {
    ...price,
    ...(price.input != null && { input: price.input * multiplier }),
    ...(price.output != null && { output: price.output * multiplier }),
    ...(price.cacheRead != null && { cacheRead: price.cacheRead * multiplier }),
    ...(price.cacheCreation != null && { cacheCreation: price.cacheCreation * multiplier }),
    ...(price.cacheWrite != null && { cacheWrite: price.cacheWrite * multiplier }),
    ...(price.cacheWrite1h != null && { cacheWrite1h: price.cacheWrite1h * multiplier }),
  };
}
