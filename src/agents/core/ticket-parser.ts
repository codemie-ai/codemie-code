/**
 * Pure ticket-id extraction from free text (prompts, branch names). No I/O. Story-id
 * tiering and priority live in `story-resolver.ts`, which builds on these parsers.
 */

/**
 * Shared ticket-id pattern. Carries the global (`g`) flag, so a stateful `.test()`/`.exec()`
 * on THIS SAME instance across repeated calls would corrupt `lastIndex` and silently skip
 * matches on the next call. Every consumer therefore builds a fresh `RegExp` from
 * `TICKET_RE.source`/`TICKET_RE.flags` (used via `String.prototype.match()`) instead of
 * reusing this exported instance.
 */
export const TICKET_RE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?!\d)/gi;

/**
 * Explicit marker-phrase pattern: `story: X`, `story #X`, or `ticket: X`,
 * case-insensitive on the marker word. A `:` or `#` separator is required
 * so ordinary wording like `user story X` does not override the branch tier.
 * The captured id itself already covers both cases via its own
 * `[A-Za-z]`/`[A-Za-z0-9]` ranges — the result is still upper-cased before
 * returning, consistent with every other regex-derived tier in this module.
 */
const MARKER_RE = /\b(?:story|ticket)\b\s*[:#]\s*([A-Za-z][A-Za-z0-9]+-\d+)/i;

/** Upper bound on `ticket_mentions`, so a pasted log cannot bloat the event. */
const MAX_TICKET_MENTIONS = 20;

/**
 * Every distinct `TICKET_RE` match in the text, upper-cased, in first-seen order, capped at
 * `limit`. Empty for empty/falsy text or a non-positive limit.
 */
export function extractTicketMentions(text: string, limit: number): string[] {
  if (!text || limit <= 0) {
    return [];
  }

  const matches = text.match(new RegExp(TICKET_RE.source, TICKET_RE.flags)) ?? [];
  const distinct = new Set<string>();
  for (const match of matches) {
    distinct.add(match.toUpperCase());
    if (distinct.size >= limit) {
      break;
    }
  }
  return [...distinct];
}

/** The id of the first `story: X` / `ticket #X` phrase, upper-cased; '' when absent. */
export function extractTicketMarker(text: string): string {
  if (!text) {
    return '';
  }
  return text.match(MARKER_RE)?.[1]?.toUpperCase() ?? '';
}

/** Opt-in for prompt-submit events: values derived from the full, untruncated prompt. */
export interface PromptFields {
  /** Upper-cased id from a `story:` / `ticket #` phrase, '' when absent. */
  story_marker: string;
  /** Every distinct ticket-shaped id, upper-cased, first-seen order, capped. */
  ticket_mentions: string[];
  /** Full prompt length in UTF-16 code units (the unit of the 200-char `prompt_body` cut). */
  prompt_length: number;
}

/** Only derived values leave this function, never the prompt text itself. */
export function parsePromptFields(prompt: string): PromptFields {
  return {
    story_marker: extractTicketMarker(prompt),
    ticket_mentions: extractTicketMentions(prompt, MAX_TICKET_MENTIONS),
    prompt_length: prompt.length,
  };
}
