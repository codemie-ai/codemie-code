/**
 * Deployment-name resolution for Claude clients (Claude Desktop app, VS Code
 * Claude Code extension).
 *
 * Both clients pick a model from their own bundled catalog and send its
 * canonical, family-first name (`claude-opus-5`, `claude-sonnet-4-5`) with
 * every request. A tenant whose CodeMie deployments use a different token
 * order (e.g. version-first: `claude-5-opus`) rejects that name outright —
 * the gateway has no entry called `claude-opus-5`. This module maps the
 * requested name onto a deployment the gateway actually has, the same way
 * `codex-model-resolver.ts` does for Codex's undated/dated mismatch.
 *
 * Self-contained on purpose: the proxy must not depend on the CLI's
 * connector-side resolver (`src/cli/commands/proxy/connectors/model-name-
 * resolver.ts`), which is a config-write-time concern in a different layer
 * (`CLI → Registry → Plugin`, never reversed). The identity-parsing and
 * recency-ranking shape below is intentionally identical to that module's
 * Claude branch — proven logic, just re-homed for the request-time path.
 */

/**
 * Release date embedded in a deployment id, matched in either of the two
 * shapes real CodeMie deployments use: separator-delimited (`-2026-07-09`) or
 * concatenated (`-20260709`, e.g. `claude-opus-4-5-20251101`). Not anchored to
 * end-of-string: a deployment may carry a suffix after the date. The
 * `(?!\d)` guard stops the concatenated alternative from matching only part
 * of a longer digit run.
 */
const RELEASE_DATE_PATTERN =
  /[-._](?:(?:20\d{2})[-._](?:\d{2})[-._](?:\d{2})|(?:20\d{2})(?:\d{2})(?:\d{2}))(?!\d)/;
const CLAUDE_SEGMENT_PATTERN = /opus|sonnet|haiku/i;
const VERTEX_SUFFIX_PATTERN = /-vertex$/i;

/** Identity of a Claude model, independent of naming convention or dated deployment. */
interface ModelIdentity {
  segment: string;
  major: number;
  minor: number;
}

export type ClaudeResolutionKind = 'exact' | 'resolved' | 'unresolved';

export interface ClaudeModelResolution {
  model: string;
  kind: ClaudeResolutionKind;
}

function stripReleaseDate(name: string): string {
  const match = name.match(RELEASE_DATE_PATTERN);
  return match ? name.slice(0, match.index) : name;
}

/** Numeric [year, month, day] embedded in `id`, or `null` when it carries no release date. */
function extractReleaseDate(id: string): [number, number, number] | null {
  const match = id.match(RELEASE_DATE_PATTERN);
  if (!match) return null;
  const digits = match[0].match(/\d+/g) ?? [];
  const joined = digits.join('');
  if (joined.length < 8) return null;
  return [Number(joined.slice(0, 4)), Number(joined.slice(4, 6)), Number(joined.slice(6, 8))];
}

/**
 * Parse a Claude model name into its identity, regardless of whether the
 * family or the version token comes first (`claude-opus-5` vs. `claude-5-
 * opus`) and regardless of a trailing `-vertex` or release date.
 */
function parseIdentity(rawName: string): ModelIdentity | null {
  const name = stripReleaseDate(rawName.toLowerCase()).replace(VERTEX_SUFFIX_PATTERN, '');
  if (!name.startsWith('claude-')) return null;

  const tokens = name.slice('claude-'.length).split('-').filter(Boolean);
  const segmentToken = tokens.find((token) => CLAUDE_SEGMENT_PATTERN.test(token));
  if (!segmentToken) return null;

  const numbers = tokens.filter((token) => /^\d+$/.test(token)).map(Number);
  return { segment: segmentToken, major: numbers[0] ?? 0, minor: numbers[1] ?? 0 };
}

function sameIdentity(a: ModelIdentity | null, b: ModelIdentity): boolean {
  return a !== null && a.segment === b.segment && a.major === b.major && a.minor === b.minor;
}

/** True when a deployment name can serve a Claude Messages API request. */
export function isClaudeServableDeployment(name: string): boolean {
  return /^claude-/i.test(name);
}

interface RecencyScore {
  id: string;
  /** `1` for a canonical id, `0` for a `-vertex` one — canonical always outranks vertex. */
  nonVertexRank: 0 | 1;
  /** `[0, 0, 0]` when the id carries no parseable release date. */
  date: readonly [number, number, number];
}

function scoreForRecency(id: string): RecencyScore {
  return {
    id,
    nonVertexRank: VERTEX_SUFFIX_PATTERN.test(id) ? 0 : 1,
    date: extractReleaseDate(id) ?? [0, 0, 0],
  };
}

/**
 * Rank same-identity candidates: canonical (non-vertex) ids before `-vertex`
 * ones, then the parsed release date (newest first, undated sorts last),
 * then id text as a final deterministic tiebreak.
 */
export function rankDeploymentsByRecency(ids: string[]): string[] {
  return ids
    .map(scoreForRecency)
    .sort((a, b) => {
      if (a.nonVertexRank !== b.nonVertexRank) return b.nonVertexRank - a.nonVertexRank;
      for (let i = 0; i < a.date.length; i++) {
        if (a.date[i] !== b.date[i]) return b.date[i] - a.date[i];
      }
      return b.id.localeCompare(a.id);
    })
    .map((entry) => entry.id);
}

/**
 * Resolve the Claude model a client asked for to a deployment the gateway
 * has. Never substitutes a different capability tier (Opus for Sonnet, etc.)
 * — an unresolved request passes through unchanged so the gateway's own
 * error reaches the client, the same contract `resolveTenantModelId` uses
 * client-side.
 */
export function resolveClaudeDeployment(requested: string, available: string[]): ClaudeModelResolution {
  if (available.includes(requested)) {
    return { model: requested, kind: 'exact' };
  }

  const wanted = parseIdentity(requested);
  if (wanted) {
    const matches = available.filter((candidate) => sameIdentity(parseIdentity(candidate), wanted));
    if (matches.length > 0) {
      return { model: rankDeploymentsByRecency(matches)[0], kind: 'resolved' };
    }
  }

  return { model: requested, kind: 'unresolved' };
}
