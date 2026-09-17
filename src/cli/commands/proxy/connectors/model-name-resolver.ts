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

const RELEASE_DATE_PATTERN = /[-._](20\d{2})[-._](\d{2})[-._](\d{2})/;
const GPT_VENDOR_PREFIXES = ['openai.'];
const CLAUDE_SEGMENT_PATTERN = /opus|sonnet|haiku/i;

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
  const name = stripReleaseDate(rawName.toLowerCase()).replace(/-vertex$/, '');
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

// Lexicographic descending is sufficient: embedded dates are fixed-width YYYY-MM-DD.
function pickMostRecent(ids: string[]): string {
  return [...ids].sort((a, b) => b.localeCompare(a))[0];
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
