/**
 * Model pricing lookup.
 *
 * Data is the vendored `pricing.json` (sourced from agentlytics). To refresh,
 * re-copy that file. Prices are USD per 1,000,000 tokens. The source uses
 * `cacheWrite`; we expose it as `cacheCreation` to match Claude's terminology.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDirname } from '../../../../utils/paths.js';
import { normalizeModelName } from '../model-normalizer.js';
import { logger } from '../../../../utils/logger.js';

/** USD per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface RawPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const HERE = getDirname(import.meta.url);

let TABLE: Record<string, ModelPrice> | null = null;

function table(): Record<string, ModelPrice> {
  if (TABLE) {
    return TABLE;
  }
  const raw = JSON.parse(readFileSync(join(HERE, 'pricing.json'), 'utf-8')) as Record<string, RawPrice>;
  const built: Record<string, ModelPrice> = {};
  for (const [key, p] of Object.entries(raw)) {
    if (key.startsWith('_')) {
      continue; // skip _meta and similar
    }
    built[key.toLowerCase()] = {
      input: p.input ?? 0,
      output: p.output ?? 0,
      cacheRead: p.cacheRead ?? 0,
      cacheCreation: p.cacheWrite ?? 0,
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

/**
 * Look up pricing for a model. Returns null when no entry matches (the caller marks the model
 * `unpriced` — never a silent $0). Resolution order:
 *   1. Exact (normalized) match — authoritative.
 *   2. Longest key aligned to a segment boundary — a deliberate family fallback, logged as inexact.
 * Dots are folded to dashes first because the table keys use dashes (e.g. `gpt-4-1`, not `gpt-4.1`).
 */
export function lookupPrice(model: string): ModelPrice | null {
  const normalized = normalizeModelName(model).toLowerCase().replace(/\./g, '-');
  const prices = table();

  const exact = prices[normalized];
  if (exact) {
    return exact;
  }

  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(prices)) {
    if (isSegmentMatch(normalized, key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  if (best) {
    logger.debug(`[pricing] no exact entry for "${normalized}"; using family price "${best.key}"`);
    return best.price;
  }
  return null;
}
