/**
 * Type declarations for the plain-JS bedrock-pricing.mjs, so TypeScript consumers (pricing.ts,
 * usage-readers.ts) get full typing on an import that, at runtime, is not compiled by tsc:
 * scripts/copy-plugins.js copies it verbatim, and any agent's statusline installer deploys it as
 * a flat sibling — so the module itself must stay plain JS with zero project imports.
 */

/**
 * The literal backend model LiteLLM dispatched to (`x-litellm-model-name`), present on every
 * LiteLLM-proxied response regardless of whether a routing decision was made — see the
 * implementation's own doc comment. Takes a bag of header-shaped keys rather than a named
 * interface: the caller's message type may (SwitchyardHeaderSource/LitellmHeaderSource,
 * routing-headers.d.mts) or may not overlap with this one field, and TS treats a param type
 * with a single optional property as "weak" — erroring on an argument sharing no property names
 * with it at all, which a same-shaped-but-narrower caller type would trip.
 */
export declare function parseBackendModelName(message: object | null | undefined): string | null;

/** The Bedrock region/endpoint qualifier embedded in a fully-qualified backend model id, or `null`. */
export declare function bedrockEndpointRegion(rawModelId: string | null | undefined): string | null;

/**
 * True when `rawModelId` names a Bedrock regional/multi-region endpoint rather than a global
 * one. Says nothing about whether/how much of a premium applies — see
 * {@link applyBedrockRegionalPremium} — only about the endpoint's own shape.
 */
export declare function isBedrockRegionalPremium(rawModelId: string | null | undefined): boolean;

/** A price/rate object carrying an optional per-row Bedrock regional-endpoint premium. */
export interface BedrockPriceable {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  /** Set only on rows Anthropic documents the two-endpoint-type Bedrock pricing structure for
   * (Sonnet 4.5+, Haiku 4.5+, Opus 4.5+, and their dated snapshots). */
  bedrockRegionalMultiplier?: number;
}

/**
 * Applies `price.bedrockRegionalMultiplier` to every present rate field when `rawModelId` names
 * a regional/multi-region Bedrock endpoint — a no-op (returns `price` itself) otherwise, and
 * when `price` carries no `bedrockRegionalMultiplier` at all. See the implementation's own doc
 * comment for the source and verification against a real LiteLLM billing breakdown.
 */
export declare function applyBedrockRegionalPremium<T extends BedrockPriceable | null | undefined>(
  price: T,
  rawModelId: string | null | undefined
): T;
