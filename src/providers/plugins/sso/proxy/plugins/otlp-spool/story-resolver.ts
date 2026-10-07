import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shared ticket-id pattern used by every story-id tier that scans free text
 * (branch names today; marker/mention text in a later task). Carries the
 * global (`g`) flag, so a stateful `.test()`/`.exec()` on THIS SAME instance
 * across repeated calls would corrupt `lastIndex` and silently skip matches
 * on the next call. Every consumer in this module therefore either builds a
 * fresh `RegExp` from `TICKET_RE.source`/`TICKET_RE.flags` (used here via
 * `String.prototype.match()`, which — called on a freshly constructed regex
 * — reads all matches once and does not leave mutated `lastIndex` state
 * behind for the next caller) before each match, rather than reusing this
 * exported instance's `lastIndex` across calls.
 */
export const TICKET_RE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?!\d)/gi;

export interface ExplicitStoryResult {
  storyId: string;
  storySource: 'explicit';
}

export interface BranchStoryResult {
  storyId: string;
  storySource: 'branch';
}

export interface MarkerStoryResult {
  storyId: string;
  storySource: 'marker';
}

export interface MentionStoryResult {
  storyId: string;
  storySource: 'mention';
}

/**
 * Explicit marker-phrase pattern: `story: X` or `ticket #X`, case-insensitive
 * on the marker word, with an optional `:`/`#` separator and optional
 * surrounding whitespace. The captured id itself already covers both cases
 * via its own `[A-Za-z]`/`[A-Za-z0-9]` ranges — the result is still
 * upper-cased before returning, consistent with every other regex-derived
 * tier in this module.
 */
const MARKER_RE = /(?:story|ticket)\s*[:#]?\s*([A-Za-z][A-Za-z0-9]+-\d+)/i;

interface AnalyticsLocalConfig {
  storyId?: unknown;
}

/**
 * Explicit story-id tier: `SDLC_ANALYTICS_STORY_ID` env var first, falling
 * back to the `storyId` field of `<cwd>/.claude/analytics.local.json`.
 * Read-only — this never writes that file. Swallows every failure (missing
 * file, malformed JSON, permission error) and resolves to `null` instead of
 * throwing. The resolved `storyId` is taken verbatim from its source (env or
 * file) and is NOT upper-cased, unlike the regex-derived `resolveBranchStory`
 * tier: a value a user/config explicitly supplied is already exact, whereas
 * free text scanned by a case-insensitive regex needs normalizing.
 */
export async function resolveExplicitStory(cwd: string): Promise<ExplicitStoryResult | null> {
  const envStoryId = process.env['SDLC_ANALYTICS_STORY_ID'];
  if (envStoryId) {
    return { storyId: envStoryId, storySource: 'explicit' };
  }

  try {
    const filePath = join(cwd, '.claude', 'analytics.local.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as AnalyticsLocalConfig;
    if (typeof parsed.storyId === 'string' && parsed.storyId.length > 0) {
      return { storyId: parsed.storyId, storySource: 'explicit' };
    }
  } catch {
    /* missing file, malformed JSON, permission error: fall through to null */
  }

  return null;
}

/**
 * Branch story-id tier: the first `TICKET_RE` match found anywhere in the
 * branch name, upper-cased. Returns `null` when the branch carries no
 * ticket-shaped substring.
 */
export function resolveBranchStory(branch: string): BranchStoryResult | null {
  if (!branch) {
    return null;
  }

  // Fresh RegExp per call: avoids reusing TICKET_RE's own `lastIndex` across
  // invocations (the classic stateful-global-regex-in-a-loop bug).
  const matches = branch.match(new RegExp(TICKET_RE.source, TICKET_RE.flags));
  if (!matches || matches.length === 0) {
    return null;
  }

  return { storyId: matches[0].toUpperCase(), storySource: 'branch' };
}

/**
 * Marker story-id tier: an explicit `story: X` / `ticket #X` phrase found
 * anywhere in prompt text, case-insensitive on the marker word, upper-cased
 * on return. Returns `null` when no marker phrase is present (including an
 * empty/falsy `promptText`).
 */
export function resolveMarkerStory(promptText: string): MarkerStoryResult | null {
  if (!promptText) {
    return null;
  }

  const match = promptText.match(MARKER_RE);
  if (!match || !match[1]) {
    return null;
  }

  return { storyId: match[1].toUpperCase(), storySource: 'marker' };
}

/**
 * Mention story-id tier: the first bare `TICKET_RE` match found anywhere in
 * prompt text, upper-cased. This is the lowest-priority tier — it only
 * applies when no explicit/marker/branch tier already resolved a story.
 * Returns `null` when no ticket-shaped substring exists (including an
 * empty/falsy `promptText`).
 */
export function resolveMentionStory(promptText: string): MentionStoryResult | null {
  if (!promptText) {
    return null;
  }

  // Fresh RegExp per call: avoids reusing TICKET_RE's own `lastIndex` across
  // invocations (the classic stateful-global-regex-in-a-loop bug).
  const matches = promptText.match(new RegExp(TICKET_RE.source, TICKET_RE.flags));
  if (!matches || matches.length === 0) {
    return null;
  }

  return { storyId: matches[0].toUpperCase(), storySource: 'mention' };
}
