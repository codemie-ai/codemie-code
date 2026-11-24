/**
 * Pure ticket-id extraction from free text (prompts, branch names). No I/O. Story-id
 * tiering and priority live in `story-resolver.ts`, which builds on these parsers.
 */

/**
 * Raw ticket-id candidate shape; `extractTicketMentions` filters these candidates (UUID
 * fragments, known non-ticket tokens) before anything counts as a ticket. Carries the
 * global (`g`) flag, so a stateful `.test()`/`.exec()` on THIS SAME instance across
 * repeated calls would corrupt `lastIndex` and silently skip matches on the next call.
 * Every consumer therefore builds a fresh `RegExp` from `TICKET_RE.source`/`TICKET_RE.flags`
 * (iterated with `String.prototype.matchAll()`) instead of reusing this exported instance.
 */
export const TICKET_RE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?!\d)/gi;

/**
 * Closed, extendable data list of upper-case key parts that are known NOT to be tickets
 * (standards, protocols, model and vendor families). Extending it takes one entry here plus
 * one assertion in `ticket-parser.test.ts`. Whoever adds a model family to
 * `src/utils/pricing.json` must add the family's first segment here. The O-series
 * (`O1`, `O3`, `O4`) is left off on purpose: `O1-12` is a plausible real key.
 */
const NON_TICKET_PREFIXES: ReadonlySet<string> = new Set([
  // standards and algorithms
  'SHA',
  'UTF',
  'ISO',
  'CVE',
  'CWE',
  'COVID',
  'X86',
  'X64',
  'AES',
  'RSA',
  'MD',
  // protocols
  'HTTP',
  'TLS',
  // model and vendor families
  'GPT',
  'CHATGPT',
  'CODEX',
  'CLAUDE',
  'GEMINI',
  'GROK',
  'LLAMA',
  'MISTRAL',
  'DEEPSEEK',
  'QWEN',
  'GLM',
  'KIMI',
  'SONNET',
  'OPUS',
  'HAIKU',
]);

/** The only character that joins two segments into one run (always as a single character). */
const RUN_JOIN = '-';

/** Group lengths of the 8-4-4-4-12 UUID layout. */
const UUID_GROUP_LENGTHS: readonly number[] = [8, 4, 4, 4, 12];

/** Hex characters in the UUID tail group; a key segment of exactly this length is UUID-shaped. */
const UUID_TAIL_LENGTH = 12;

interface Segment {
  start: number;
  end: number;
  text: string;
  /** Every character is `[0-9a-fA-F]`. */
  hex: boolean;
}

interface Run {
  start: number;
  end: number;
  segments: Segment[];
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexLetterCode(code: number): boolean {
  return (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isAlnumCode(code: number): boolean {
  return isDigitCode(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * One-pass tokenizer. A segment is a maximal `[A-Za-z0-9]+`; segments joined by a single
 * `RUN_JOIN` (and, with `joinDigitDot`, a `.` between two digits) form one run. Every other
 * character, including a doubled dash, ends the run.
 */
function tokenizeRuns(text: string, { joinDigitDot }: { joinDigitDot: boolean }): Run[] {
  const runs: Run[] = [];
  let run: Run | null = null;
  let previous: Segment | null = null;
  let i = 0;
  while (i < text.length) {
    if (!isAlnumCode(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    let hex = true;
    while (i < text.length && isAlnumCode(text.charCodeAt(i))) {
      const code = text.charCodeAt(i);
      if (!isDigitCode(code) && !isHexLetterCode(code)) {
        hex = false;
      }
      i++;
    }
    const segment: Segment = { start, end: i, text: text.slice(start, i), hex };

    let joins = false;
    if (previous && previous.end + 1 === start) {
      const separator = text[previous.end];
      joins =
        separator === RUN_JOIN ||
        (joinDigitDot &&
          separator === '.' &&
          isDigitCode(text.charCodeAt(previous.end - 1)) &&
          isDigitCode(text.charCodeAt(start)));
    }
    if (run && joins) {
      run.segments.push(segment);
      run.end = segment.end;
    } else {
      run = { start: segment.start, end: segment.end, segments: [segment] };
      runs.push(run);
    }
    previous = segment;
  }
  return runs;
}

/** A UUID window spans at most this many segments, so a bounded read is exact. */
const MAX_UUID_WINDOW = UUID_GROUP_LENGTHS.length;

/**
 * True when the all-hex segment at `target` sits inside a window of 3+ consecutive all-hex
 * segments whose lengths equal consecutive UUID groups, the window holding the 8 or 12 group.
 */
function coversUuidWindow(segments: Segment[], target: number): boolean {
  if (!segments[target]?.hex) {
    return false;
  }
  let low = target;
  while (low > 0 && target - low < MAX_UUID_WINDOW - 1 && segments[low - 1].hex) {
    low--;
  }
  let high = target;
  while (high < segments.length - 1 && high - target < MAX_UUID_WINDOW - 1 && segments[high + 1].hex) {
    high++;
  }

  const lastGroup = UUID_GROUP_LENGTHS.length - 1;
  for (let start = low; start <= target; start++) {
    for (let group = 0; group <= lastGroup; group++) {
      if (segments[start].text.length !== UUID_GROUP_LENGTHS[group]) {
        continue;
      }
      let end = start;
      while (
        end < high &&
        group + (end - start) < lastGroup &&
        segments[end + 1].text.length === UUID_GROUP_LENGTHS[group + (end - start) + 1]
      ) {
        end++;
      }
      for (let windowEnd = Math.max(target, start + 2); windowEnd <= end; windowEnd++) {
        if (group === 0 || group + (windowEnd - start) === lastGroup) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Rule 1: a candidate is UUID-shaped when its key or number segment sits in a UUID window, or
 * its key segment is itself the 12-hex tail group. `keyIndex` is the key segment's index in the
 * run; the number segment is the next one.
 */
function isUuidShaped(run: Run, keyIndex: number): boolean {
  const key = run.segments[keyIndex];
  if (key.hex && key.text.length === UUID_TAIL_LENGTH) {
    return true;
  }
  return coversUuidWindow(run.segments, keyIndex) || coversUuidWindow(run.segments, keyIndex + 1);
}

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

export interface ExtractTicketMentionsOptions {
  /** `'prompt'` (default) applies rules 1-2; `'branch'` applies rule 1 only. */
  source?: 'prompt' | 'branch';
  /** Rule 3: list upper-case-key ids before lower-case ones. Default `false` (first-seen order). */
  preferUpperCase?: boolean;
}

/**
 * Every distinct `TICKET_RE` candidate that survives the filters below, upper-cased, capped at
 * `limit`. Empty for empty/falsy text or a non-positive limit. Defaults: `source: 'prompt'`,
 * `preferUpperCase: false` (first-seen order).
 *
 * A segment is a maximal `[A-Za-z0-9]+`; segments joined by a single `-` form a run (space, `_`,
 * `.`, `/`, `=`, `:` and `--` end it; for rule 2 a `.` between two digits also joins).
 *
 * 1. UUID shape (both sources): a candidate is dropped when its key or number segment is all-hex
 *    and sits in a window of 3+ consecutive all-hex segments matching consecutive 8-4-4-4-12
 *    UUID groups (the window holds the 8 or 12 group), or when its key segment is itself 12 hex
 *    characters. Words glued to a pasted UUID and numeric suffixes after it are covered. This
 *    uses its own segment layout and deliberately NOT the whole-string UUID patterns at
 *    `src/utils/paths.ts` / `assistant-builder/conversations.ts`: partial pastes, glued words and
 *    suffixes are in scope here, and those patterns would miss them.
 * 2. Known non-ticket prefix (`'prompt'` only): a candidate is dropped when its whole key part is
 *    in `NON_TICKET_PREFIXES` (exact, case-insensitive), or when the run holding it starts with
 *    such a token, so the tail of a full model id (`gpt-4o-mini-2024-07-18` -> `MINI-2024`) is
 *    dropped too. A real key glued by a dash to such a leading token is an accepted loss.
 * 3. Upper-case preference (`preferUpperCase`): after rules 1-2, ids whose key part has no
 *    lower-case letter come first, then the rest, each in first-seen order, before `limit`
 *    applies. An id is upper-case when any surviving occurrence is.
 */
export function extractTicketMentions(
  text: string,
  limit: number,
  options: ExtractTicketMentionsOptions = {}
): string[] {
  if (!text || limit <= 0) {
    return [];
  }
  const { source = 'prompt', preferUpperCase = false } = options;

  // id -> written upper-case at least once; Map keeps first-seen order
  const found = new Map<string, boolean>();
  let upperCount = 0;
  let runs: Run[] | null = null;
  let runIndex = 0;
  let segmentIndex = 0;

  for (const match of text.matchAll(new RegExp(TICKET_RE.source, TICKET_RE.flags))) {
    runs ??= tokenizeRuns(text, { joinDigitDot: true });

    // Matches arrive in increasing order, so the run/segment pointers only move forward.
    const position = match.index;
    while (runIndex < runs.length - 1 && runs[runIndex].end <= position) {
      runIndex++;
      segmentIndex = 0;
    }
    const run = runs[runIndex];
    while (segmentIndex < run.segments.length - 1 && run.segments[segmentIndex].end <= position) {
      segmentIndex++;
    }

    if (isUuidShaped(run, segmentIndex)) {
      continue;
    }

    const keyPart = match[0].slice(0, match[0].indexOf('-'));
    if (
      source === 'prompt' &&
      (NON_TICKET_PREFIXES.has(keyPart.toUpperCase()) ||
        NON_TICKET_PREFIXES.has(run.segments[0].text.toUpperCase()))
    ) {
      continue;
    }

    const id = match[0].toUpperCase();
    const isUpper = !/[a-z]/.test(keyPart);
    const seenUpper = found.get(id);
    if (seenUpper === undefined) {
      found.set(id, isUpper);
      upperCount += isUpper ? 1 : 0;
    } else if (isUpper && !seenUpper) {
      found.set(id, true);
      upperCount++;
    }

    if (preferUpperCase ? upperCount >= limit : found.size >= limit) {
      break;
    }
  }

  const ids = [...found.keys()];
  if (!preferUpperCase) {
    return ids;
  }
  const upper = ids.filter((id) => found.get(id));
  const lower = ids.filter((id) => !found.get(id));
  return [...upper, ...lower].slice(0, limit);
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
  /** Every distinct id surviving the `extractTicketMentions` filters, upper-cased, first-seen order (no case ranking), capped. */
  ticket_mentions: string[];
  /** Length of the raw prompt as typed, pasted-content tags included, in UTF-16 code units; not the length of the cleaned `prompt_body` source. */
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
