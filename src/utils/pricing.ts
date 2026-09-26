/**
 * Model pricing lookup.
 *
 * Data is the vendored `pricing.json` (sourced from agentlytics). To refresh,
 * re-copy that file. Prices are USD per 1,000,000 tokens. The source uses
 * `cacheWrite`; we expose it as `cacheCreation` to match Claude's terminology.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDirname } from './paths.js';
import { applyBedrockRegionalPremium } from './bedrock-pricing.mjs';
import { ConfigurationError } from './errors.js';
import { priceTableKey, resolvePriceKey, type PriceMatch } from './price-resolution.js';

export { canonicalizeModelId } from './price-resolution.js';

/** USD per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheWrite1h?: number;
  /**
   * Amazon Bedrock's premium for a regional/multi-region endpoint over this model's global one
   * — present only on rows where Anthropic documents the two-endpoint-type Bedrock pricing
   * structure (Sonnet 4.5+, Haiku 4.5+, Opus 4.5+ and their dated snapshots). Absent (no premium)
   * on every older row, since Anthropic does not document this structure applying there. See
   * isBedrockRegionalPremium()'s own doc comment (bedrock-pricing.mjs) for the source.
   */
  bedrockRegionalMultiplier?: number;
  /**
   * True when this row is not a directly published rate but an estimate (e.g. a tier-price
   * carried forward for a model generation with no confirmed pricing yet). Every row's
   * provenance should be cited in `pricing.json`'s `_meta.sources`/`note`; this flag is what
   * callers use to surface "estimated" alongside the resolved price rather than presenting it
   * as authoritative.
   */
  estimated?: boolean;
}

export interface RawPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  bedrockRegionalMultiplier?: number;
  estimated?: boolean;
}

/**
 * CodeMie-specific ids the vendored table will never carry. Merged over the vendored rows
 * in {@link table}, so re-copying `pricing.json` from agentlytics does not silently drop them.
 *
 * `claude-smart-router` is a Switchyard routing alias, not a generation model. The alias bills
 * only the Haiku classifier hop that picks a target; the generation itself is billed against the
 * model the router dispatched to, which arrives in the response body's own `model` field and is
 * priced from its own row. Haiku rates therefore price what this id actually costs — without a
 * row at all, `lookupPrice` returns null and the turn drops out of every cost total.
 */
const CODEMIE_PRICES: Record<string, RawPrice> = {
  'claude-smart-router': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
};

const HERE = getDirname(import.meta.url);

let TABLE: Record<string, ModelPrice> | null = null;

function toModelPrice(p: RawPrice): ModelPrice {
  return {
    input: p.input ?? 0,
    output: p.output ?? 0,
    cacheRead: p.cacheRead ?? 0,
    cacheCreation: p.cacheWrite ?? 0,
    cacheWrite1h: p.cacheWrite1h,
    bedrockRegionalMultiplier: p.bedrockRegionalMultiplier,
    estimated: p.estimated,
  };
}

function pricesEqual(a: ModelPrice, b: ModelPrice): boolean {
  return (
    a.input === b.input
    && a.output === b.output
    && a.cacheRead === b.cacheRead
    && a.cacheCreation === b.cacheCreation
    && a.cacheWrite1h === b.cacheWrite1h
    && a.bedrockRegionalMultiplier === b.bedrockRegionalMultiplier
    && a.estimated === b.estimated
  );
}

/**
 * Builds the rate card from a bag of raw rows (a parsed `pricing.json`, an injected fixture for
 * tests, or any merge of the two): every key is lowercased and dots are turned to dashes, so
 * `GLM-4.7` and `glm-4-7` land on the same table entry. When two distinct raw keys normalize to
 * the same table key, they must carry identical prices — that is the only way the pricing data
 * itself can declare two spellings of the same model (e.g. `gemini-3.7-flash` / `gemini-3-7-flash`)
 * — otherwise the table is ambiguous and this throws rather than silently picking one.
 */
export function buildPriceTable(rows: Record<string, RawPrice>): Record<string, ModelPrice> {
  const built: Record<string, ModelPrice> = {};
  for (const [rawKey, raw] of Object.entries(rows)) {
    if (rawKey.startsWith('_')) {
      continue; // skip _meta and similar
    }
    const key = priceTableKey(rawKey);
    const price = toModelPrice(raw);
    const existing = built[key];
    if (existing && !pricesEqual(existing, price)) {
      throw new ConfigurationError(
        `[pricing] "${rawKey}" normalizes to key "${key}", which already holds a different price`,
      );
    }
    built[key] = price;
  }
  return built;
}

function table(): Record<string, ModelPrice> {
  if (TABLE) {
    return TABLE;
  }
  const raw = JSON.parse(readFileSync(join(HERE, 'pricing.json'), 'utf-8')) as Record<string, RawPrice>;
  TABLE = buildPriceTable({ ...raw, ...CODEMIE_PRICES });
  return TABLE;
}

/**
 * The fully built rate card: the vendored table with {@link CODEMIE_PRICES} merged over it and every
 * key lowercased. Exported so consumers that cannot import this module — the standalone Claude
 * statusline, which runs as a detached `node <path>` process — can be handed the same rates rather
 * than a copy of the raw `pricing.json`, which carries none of the CodeMie-only rows.
 */
export function priceTable(): Record<string, ModelPrice> {
  return table();
}

/** How {@link resolvePrice} matched an observed model id to a table row. */
export interface PriceResolution {
  price: ModelPrice;
  key: string;
  match: PriceMatch;
  estimated: boolean;
}

/**
 * Resolves pricing for a model, reporting how it was matched. Returns null when no entry
 * matches (the caller marks the model `unpriced` — never a silent $0, and never a guessed
 * family/tier price). The lookup order (exact, then one snapshot suffix stripped, then a
 * version-first Claude id reordered to family-first) lives in {@link resolvePriceKey}, shared
 * with the Claude statusline so the two can never price the same id differently.
 *
 * `model` is also checked, in its original unnormalized form, for a Bedrock region qualifier
 * (see {@link applyBedrockRegionalPremium}) — pass the raw backend id straight through rather
 * than pre-normalizing it, or the premium this exists to detect is invisible by the time it gets
 * here.
 */
export function resolvePrice(model: string): PriceResolution | null {
  const prices = table();
  const hit = resolvePriceKey(model, (key) => (Object.hasOwn(prices, key) ? prices[key] : undefined));
  if (!hit) {
    return null;
  }
  return {
    price: applyBedrockRegionalPremium(hit.value, model),
    key: hit.key,
    match: hit.match,
    estimated: hit.value.estimated ?? false,
  };
}

/**
 * Look up pricing for a model. Returns null when no entry matches. Thin wrapper over
 * {@link resolvePrice} for callers that only need the price, not its provenance.
 */
export function lookupPrice(model: string): ModelPrice | null {
  return resolvePrice(model)?.price ?? null;
}
