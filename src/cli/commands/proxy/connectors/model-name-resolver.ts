/**
 * Shared tenant model-name resolver for the VS Code Copilot BYOK and Claude
 * Desktop connectors.
 *
 * Generalizes `codex-model-resolver.ts`'s date-stripping identity-parse shape
 * to also strip known vendor prefixes (GPT) and match both token orders
 * (Claude family-first vs. version-first tenant naming). Kept separate from
 * `codex-model-resolver.ts` on purpose — that module is proven for Codex and
 * out of scope for this change.
 */

/**
 * Release date embedded in a tenant model id, matched in either of the two
 * shapes real CodeMie deployments use: separator-delimited (`-2026-07-09`) or
 * concatenated (`-20260709`, e.g. `claude-opus-4-5-20251101`). Not anchored to
 * end-of-string: a deployment may carry a suffix after the date. The
 * `(?!\d)` guard stops the concatenated alternative from matching only part
 * of a longer digit run.
 */
const RELEASE_DATE_PATTERN =
  /[-._](?:(?:20\d{2})[-._](?:\d{2})[-._](?:\d{2})|(?:20\d{2})(?:\d{2})(?:\d{2}))(?!\d)/;
const GPT_VENDOR_PREFIXES = ['openai.'];
const CLAUDE_SEGMENT_PATTERN = /opus|sonnet|haiku/i;
const VERTEX_SUFFIX_PATTERN = /-vertex$/i;

interface ModelIdentity {
  vendor: 'gpt' | 'claude';
  segment: string;
  major: number;
  minor: number;
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

function parseGptIdentity(rawName: string): ModelIdentity | null {
  let name = stripReleaseDate(rawName.toLowerCase());
  for (const prefix of GPT_VENDOR_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  const canonical = name.replace(/\./g, '-').replace(/-+$/, '');
  const versionMatch = canonical.match(/^gpt-(\d+)(?:-(\d+))?/);
  if (!versionMatch) return null;
  const rest = canonical.slice(versionMatch[0].length).replace(/^-/, '');
  return { vendor: 'gpt', segment: rest, major: Number(versionMatch[1]), minor: Number(versionMatch[2] ?? 0) };
}

function parseClaudeIdentity(rawName: string): ModelIdentity | null {
  const name = stripReleaseDate(rawName.toLowerCase()).replace(VERTEX_SUFFIX_PATTERN, '');
  if (!name.startsWith('claude-')) return null;
  const tokens = name.slice('claude-'.length).split('-').filter(Boolean);
  const segmentToken = tokens.find((t) => CLAUDE_SEGMENT_PATTERN.test(t));
  if (!segmentToken) return null;
  const numbers = tokens.filter((t) => /^\d+$/.test(t)).map(Number);
  return { vendor: 'claude', segment: segmentToken, major: numbers[0] ?? 0, minor: numbers[1] ?? 0 };
}

function sameIdentity(a: ModelIdentity | null, b: ModelIdentity): boolean {
  return a !== null && a.vendor === b.vendor && a.segment === b.segment
    && a.major === b.major && a.minor === b.minor;
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
 * Rank same-identity candidates and return the best one.
 *
 * `sameIdentity` only guarantees vendor/segment/major/minor equality — not a
 * shared textual shape — so candidates can legitimately mix a vendor-prefixed
 * undated id, a dashed/concatenated dated id, and a `-vertex`-suffixed id for
 * the very same model. Plain lexicographic comparison sorts those by their
 * first differing character, not by recency, which silently prefers the
 * wrong deployment. Rank instead by an explicit precedence: canonical
 * (non-vertex) ids before `-vertex` ones, then the parsed release date
 * (newest first, `[0, 0, 0]` for an undated id sorts last), then id text as a
 * final deterministic tiebreak.
 */
function pickMostRecent(ids: string[]): string {
  const [best] = ids
    .map(scoreForRecency)
    .sort((a, b) => {
      if (a.nonVertexRank !== b.nonVertexRank) return b.nonVertexRank - a.nonVertexRank;
      for (let i = 0; i < a.date.length; i++) {
        if (a.date[i] !== b.date[i]) return b.date[i] - a.date[i];
      }
      return b.id.localeCompare(a.id);
    });
  return best.id;
}

/**
 * Resolve a capability-table family name (e.g. `gpt-5.6-luna`, `claude-opus-5`)
 * to the exact tenant deployment id that serves it, or `undefined` when no
 * tenant deployment matches. Returns the tenant's id byte-for-byte — never a
 * normalized/canonical form — so the caller can use it directly as the
 * gateway model id.
 */
export function resolveTenantModelId(family: string, available: readonly string[]): string | undefined {
  if (available.includes(family)) return family;

  const gptWanted = parseGptIdentity(family);
  if (gptWanted) {
    const matches = available.filter((id) => sameIdentity(parseGptIdentity(id), gptWanted));
    if (matches.length > 0) return pickMostRecent(matches);
  }

  const claudeWanted = parseClaudeIdentity(family);
  if (claudeWanted) {
    const matches = available.filter((id) => sameIdentity(parseClaudeIdentity(id), claudeWanted));
    if (matches.length > 0) return pickMostRecent(matches);
  }

  return undefined;
}
