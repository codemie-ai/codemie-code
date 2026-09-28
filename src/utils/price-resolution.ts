/**
 * Model-id → pricing-table-key resolution, shared by every consumer that prices a model id:
 * src/utils/pricing.ts (the analytics report's resolvePrice()) and the standalone Claude
 * statusline (src/agents/plugins/claude/plugin/statusline.ts, bundled into one self-contained file
 * by scripts/bundle-statusline.mjs). Keeping one copy is what stops the live statusline cost and
 * the analytics report from disagreeing on the same transcript.
 *
 * Deliberately free of I/O and of any import beyond model-normalizer.ts (itself dependency-free),
 * so the statusline bundle stays small and never drags in fs/config/keytar-bearing modules. It
 * knows nothing about the shape of a price row — callers pass a key lookup over their own table.
 */

import { normalizeModelName } from './model-normalizer.js';

/**
 * A trailing snapshot/version suffix stripped once during lookup (never during canonicalization):
 * an 8-digit date (`-20260205`), a dashed date (`-2026-02-05`), or the `-latest`/`-preview` tags.
 * Applied at most once, so a key that is itself dated (`gpt-4o-2024-05-13`) is tried as an exact
 * match first and never has a second suffix stripped from it.
 */
const SNAPSHOT_SUFFIX_PATTERN = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/;

/**
 * Matches a Claude id given in version-first order — `claude-<ver>-<family>[<rest>]`, where `ver`
 * is one or more dash-separated numeric segments and `family` is `opus`/`sonnet`/`haiku` — so it
 * can be reordered to the family-first form (`claude-<family>-<ver>[<rest>]`) the pricing table
 * keys newer Claude generations under (e.g. `claude-sonnet-4-5`, `claude-opus-4-8`; see
 * pricing.json's own rows). Never applied to a key that is already family-first, since that
 * doesn't match this pattern in the first place.
 */
const CLAUDE_VERSION_FIRST_PATTERN = /^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku)(-.+)?$/;

/** How an observed model id was matched to a table key. */
export type PriceMatch = 'exact' | 'snapshot' | 'reordered';

/** A table key an observed id resolved to, the value found under it, and how it matched. */
export interface PriceKeyHit<T> {
  key: string;
  match: PriceMatch;
  value: T;
}

/**
 * The table-key form of a raw pricing-data key: lowercased, dots turned to dashes, so `GLM-4.7`
 * and `glm-4-7` land on the same entry. Both sides of a lookup must be folded the same way —
 * observed ids go through {@link canonicalizeModelId}, which ends in this same folding.
 */
export function priceTableKey(rawKey: string): string {
  return rawKey.toLowerCase().replace(/\./g, '-');
}

/**
 * Canonicalizes an observed model id into the form used as a pricing-table key. Extends
 * {@link normalizeModelName} (which strips Bedrock/Kimi/vendor-path prefixes) with:
 *   1. Lowercasing, dots turned to dashes, and `@` turned to `-` (so Vertex's `claude-x@20260205`
 *      folds to the same shape as a dated id).
 *   2. Stripping a trailing `-vertex` suffix.
 * Used by the pricing resolver, the statusline and cost reconciliation, so every consumer treats
 * the same observed id the same way.
 */
export function canonicalizeModelId(model: string): string {
  return priceTableKey(normalizeModelName(model))
    .replace(/@/g, '-')
    .replace(/-vertex$/, '');
}

/**
 * Reorders a version-first Claude id (`claude-4-5-sonnet`) to the family-first form
 * (`claude-sonnet-4-5`) the table keys such rows under, preserving any trailing suffix (a
 * snapshot date, `-latest`, ...). Returns null when `id` isn't in that shape.
 */
function reorderClaudeVersionFamily(id: string): string | null {
  const match = id.match(CLAUDE_VERSION_FIRST_PATTERN);
  if (!match) {
    return null;
  }
  const [, version, family, rest = ''] = match;
  return `claude-${family}-${version}${rest}`;
}

/** `key` with one trailing snapshot suffix stripped, or null when it carries none. */
function withoutSnapshot(key: string): string | null {
  const stripped = key.replace(SNAPSHOT_SUFFIX_PATTERN, '');
  return stripped === key ? null : stripped;
}

/**
 * The ordered table keys tried for an observed id, against its {@link canonicalizeModelId} form:
 *   1. Exact match — keeps distinct dated rows (e.g. `gpt-4o-2024-05-13`) authoritative.
 *   2. Exact match after stripping one trailing snapshot suffix — e.g. `claude-opus-4-6-20260205`
 *      resolves to the `claude-opus-4-6` row.
 *   3. A version-first Claude id (`claude-4-5-sonnet`) reordered to the table's family-first form
 *      (`claude-sonnet-4-5`), tried exact and then with a trailing snapshot suffix stripped — only
 *      once steps 1-2 have already failed on the as-is id. That ordering is what keeps every
 *      pre-existing version-first key (`claude-3-5-sonnet`, `claude-3-7-sonnet-20250219`, ...)
 *      resolving unchanged: those rows match as-is at step 1 and this fallback is never reached.
 * There is no segment/family match and no same-tier fallback.
 */
function priceKeyCandidates(model: string): Array<{ key: string; match: PriceMatch }> {
  const canonical = canonicalizeModelId(model);
  const candidates: Array<{ key: string; match: PriceMatch }> = [{ key: canonical, match: 'exact' }];
  const snapshot = withoutSnapshot(canonical);
  if (snapshot) {
    candidates.push({ key: snapshot, match: 'snapshot' });
  }
  const reordered = reorderClaudeVersionFamily(canonical);
  if (reordered) {
    candidates.push({ key: reordered, match: 'reordered' });
    const reorderedSnapshot = withoutSnapshot(reordered);
    if (reorderedSnapshot) {
      candidates.push({ key: reorderedSnapshot, match: 'reordered' });
    }
  }
  return candidates;
}

/**
 * Resolves an observed model id against a pricing table through `lookup`, trying the keys of
 * {@link priceKeyCandidates} in order and returning the first hit. Returns null when nothing
 * matches — the model is unpriced, never a guessed price.
 */
export function resolvePriceKey<T>(model: string, lookup: (key: string) => T | undefined): PriceKeyHit<T> | null {
  for (const { key, match } of priceKeyCandidates(model)) {
    const value = key ? lookup(key) : undefined;
    if (value !== undefined) {
      return { key, match, value };
    }
  }
  return null;
}
