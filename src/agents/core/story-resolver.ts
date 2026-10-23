import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractTicketMarker, extractTicketMentions } from './ticket-parser.js';

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
 * Known limitation: the default config location is Claude-flavoured
 * (`<cwd>/.claude/analytics.local.json`). It is a parameter so another adapter
 * can point at its own file without touching this module. The env var name
 * (`SDLC_ANALYTICS_STORY_ID`) stays shared.
 */
export const DEFAULT_EXPLICIT_CONFIG_PATH: readonly string[] = ['.claude', 'analytics.local.json'];

interface AnalyticsLocalConfig {
  storyId?: unknown;
}

/**
 * Explicit story-id tier: `SDLC_ANALYTICS_STORY_ID` env var first, falling
 * back to the `storyId` field of `<cwd>/<explicitConfigPath>` (default `.claude/analytics.local.json`).
 * Read-only — this never writes that file. Swallows every failure (missing
 * file, malformed JSON, permission error) and resolves to `null` instead of
 * throwing. The resolved `storyId` is taken verbatim from its source (env or
 * file) and is NOT upper-cased, unlike the regex-derived `resolveBranchStory`
 * tier: a value a user/config explicitly supplied is already exact, whereas
 * free text scanned by a case-insensitive regex needs normalizing.
 */
export async function resolveExplicitStory(
  cwd: string,
  explicitConfigPath: readonly string[] = DEFAULT_EXPLICIT_CONFIG_PATH
): Promise<ExplicitStoryResult | null> {
  const envStoryId = process.env['SDLC_ANALYTICS_STORY_ID'];
  if (envStoryId) {
    return { storyId: envStoryId, storySource: 'explicit' };
  }

  try {
    const filePath = join(cwd, ...explicitConfigPath);
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

  const [storyId] = extractTicketMentions(branch, 1);
  return storyId ? { storyId, storySource: 'branch' } : null;
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

  const storyId = extractTicketMarker(promptText);
  return storyId ? { storyId, storySource: 'marker' } : null;
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

  const [storyId] = extractTicketMentions(promptText, 1);
  return storyId ? { storyId, storySource: 'mention' } : null;
}

export type StoryResult = ExplicitStoryResult | BranchStoryResult | MarkerStoryResult | MentionStoryResult;

export interface ResolveStoryInput {
  cwd: string;
  /** Current git branch; empty/undefined skips the branch tier. */
  branch?: string;
  /** Prompt text; marker and mention tiers apply only when provided. */
  prompt?: string;
  explicitConfigPath?: readonly string[];
}

/**
 * Effective story for one hook invocation. Priority: explicit -> marker ->
 * branch -> mention. Marker and mention only apply when `prompt` is provided.
 * Runs in the hook process, so the explicit tier sees the invoking shell's env.
 */
export async function resolveStoryFor({
  cwd,
  branch,
  prompt,
  explicitConfigPath,
}: ResolveStoryInput): Promise<StoryResult | null> {
  return (
    (await resolveExplicitStory(cwd, explicitConfigPath)) ??
    (prompt ? resolveMarkerStory(prompt) : null) ??
    resolveBranchStory(branch ?? '') ??
    (prompt ? resolveMentionStory(prompt) : null)
  );
}
