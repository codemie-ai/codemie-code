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
import { normalizeModelName } from './model-normalizer.js';
import { logger } from './logger.js';
import { applyBedrockRegionalPremium } from './bedrock-pricing.mjs';

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
}

interface RawPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  bedrockRegionalMultiplier?: number;
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

function table(): Record<string, ModelPrice> {
  if (TABLE) {
    return TABLE;
  }
  const raw = JSON.parse(readFileSync(join(HERE, 'pricing.json'), 'utf-8')) as Record<string, RawPrice>;
  const built: Record<string, ModelPrice> = {};
  for (const [key, p] of Object.entries({ ...raw, ...CODEMIE_PRICES })) {
    if (key.startsWith('_')) {
      continue; // skip _meta and similar
    }
    built[key.toLowerCase()] = {
      input: p.input ?? 0,
      output: p.output ?? 0,
      cacheRead: p.cacheRead ?? 0,
      cacheCreation: p.cacheWrite ?? 0,
      cacheWrite1h: p.cacheWrite1h,
      bedrockRegionalMultiplier: p.bedrockRegionalMultiplier,
    };
  }
  TABLE = built;
  return TABLE;
}

/**
 * True when `key` aligns to a segment boundary within `name` (delimited by `-` or the
 * string edges), so a key is never matched mid-token — e.g. `gpt-4` does not match inside
 * `gpt-4o` (which resolves to its own `gpt-4o` entry), and `gpt-4` does not match `gpt-4.1`
 * (folded to `gpt-4-1`, which has its own entry).
 */
function isSegmentMatch(name: string, key: string): boolean {
  for (let from = 0; ; ) {
    const idx = name.indexOf(key, from);
    if (idx === -1) {
      return false;
    }
    const before = idx === 0 ? '-' : name[idx - 1];
    const afterIdx = idx + key.length;
    const after = afterIdx === name.length ? '-' : name[afterIdx];
    if (before === '-' && after === '-') {
      return true;
    }
    from = idx + 1;
  }
}

/** Claude pricing tiers whose per-tier rate has stayed flat across every `-4-*` version bump seen so far. */
const CLAUDE_TIERS = ['claude-opus', 'claude-sonnet', 'claude-haiku'];

/**
 * Parse the version segments trailing a tier prefix into a numeric tuple for comparison, e.g.
 * `claude-sonnet-4-8` under tier `claude-sonnet` -> `[4, 8]`. Returns null for keys that don't
 * fit the plain `<tier>(-<digits>)*` shape — non-numeric segments (`-latest`) or a long numeric
 * segment (a pinned date snapshot like `-20250514`, 8 digits) — since those aren't meaningful
 * "is this newer" signals and would otherwise outrank a real version bump by raw magnitude.
 */
function tierVersionTuple(key: string, tier: string): number[] | null {
  const rest = key.slice(tier.length);
  if (!rest) {
    return [0];
  }
  const segments = rest.split('-').filter(Boolean);
  const nums: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment) || segment.length >= 8) {
      return null;
    }
    nums.push(Number(segment));
  }
  return nums;
}

function compareVersionTuples(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Fall back to the latest known price within the same Claude tier (opus/sonnet/haiku) when a
 * model name matches no table entry at all — e.g. a new major-version model (`claude-sonnet-5`)
 * that shares no version segment with any `-4-*` key, so {@link isSegmentMatch} can't find it.
 * Every version bump observed within a tier so far has kept the same per-token rate, so the
 * latest known entry is the best available estimate; callers must still log this as inexact.
 */
function claudeTierFallback(normalized: string, prices: Record<string, ModelPrice>): { key: string; price: ModelPrice } | null {
  const tier = CLAUDE_TIERS.find((t) => normalized === t || normalized.startsWith(`${t}-`));
  if (!tier) {
    return null;
  }
  let best: { key: string; version: number[]; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(prices)) {
    if (key !== tier && !key.startsWith(`${tier}-`)) {
      continue;
    }
    const version = tierVersionTuple(key, tier);
    if (version === null) {
      continue;
    }
    if (!best || compareVersionTuples(version, best.version) > 0) {
      best = { key, version, price };
    }
  }
  return best ? { key: best.key, price: best.price } : null;
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

/**
 * Look up pricing for a model. Returns null when no entry matches (the caller marks the model
 * `unpriced` — never a silent $0). Resolution order:
 *   1. Exact (normalized) match — authoritative.
 *   2. Longest key aligned to a segment boundary — a deliberate family fallback, logged as inexact.
 *   3. Latest same-tier Claude price — for a model newer than every table entry, logged as inexact.
 * Dots are folded to dashes first because the table keys use dashes (e.g. `gpt-4-1`, not `gpt-4.1`).
 *
 * `model` is also checked, in its original unnormalized form, for a Bedrock region qualifier
 * (see {@link applyBedrockRegionalPremium}) — pass the raw backend id straight through rather
 * than pre-normalizing it, or the premium this exists to detect is invisible by the time it gets
 * here.
 */
export function lookupPrice(model: string): ModelPrice | null {
  const normalized = normalizeModelName(model).toLowerCase().replace(/\./g, '-');
  const prices = table();

  const exact = prices[normalized];
  if (exact) {
    return applyBedrockRegionalPremium(exact, model);
  }

  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(prices)) {
    if (isSegmentMatch(normalized, key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  if (best) {
    logger.debug(`[pricing] no exact entry for "${normalized}"; using family price "${best.key}"`);
    return applyBedrockRegionalPremium(best.price, model);
  }

  const tierFallback = claudeTierFallback(normalized, prices);
  if (tierFallback) {
    logger.debug(`[pricing] no entry for "${normalized}"; using latest same-tier price "${tierFallback.key}"`);
    return applyBedrockRegionalPremium(tierFallback.price, model);
  }

  return null;
}
