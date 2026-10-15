/**
 * Transcript signals for `agent.session.summary`.
 *
 * Pure functions over already-parsed main-transcript lines: edit-diff line counts, user turns,
 * compaction boundaries, client versions and the session title. No I/O — the orchestrator reads
 * and parses the file once and hands the lines in.
 */

/** The subset of a transcript line these extractors read; every field is optional. */
export interface SignalLine {
  type?: string;
  subtype?: string;
  timestamp?: string;
  version?: string;
  aiTitle?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
  toolUseResult?: unknown;
  compactMetadata?: {
    trigger?: unknown;
    preTokens?: unknown;
    postTokens?: unknown;
    durationMs?: unknown;
  };
}

/** One compaction, in the contract's `compactions[]` element shape (`null` = not reported). */
export interface Compaction {
  start: string | null;
  end: string;
  duration_ms: number | null;
  trigger: string;
  pre_tokens: number | null;
  post_tokens: number | null;
  dropped_tokens: number | null;
}

/** Lines added/removed by edits whose result carried a diff; `null` when no edit was measured. */
export interface EditLineStats {
  linesAdded: number | null;
  linesRemoved: number | null;
}

/** The contract's cap for `title`. */
const TITLE_MAX_LENGTH = 200;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `+`/`-` line counts of a `structuredPatch` (an array of `{ lines: string[] }` hunks). */
function countPatchLines(patch: unknown[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    const lines = (hunk as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/** Lines in a file body; a trailing newline does not start another line. */
function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}

/**
 * Sum the diff stats of every tool result that reports one.
 *
 * Claude Code attaches the applied change to the user line carrying the `tool_result`:
 * `toolUseResult.structuredPatch` for edits, and `toolUseResult.type === 'create'` plus the file
 * `content` for new files. A failed edit has neither, so only applied edits are counted.
 */
export function collectEditLineStats(lines: readonly SignalLine[]): EditLineStats {
  let linesAdded: number | null = null;
  let linesRemoved: number | null = null;

  for (const line of lines) {
    const result = line.toolUseResult;
    if (!result || typeof result !== 'object') continue;
    const { structuredPatch, type, content } = result as {
      structuredPatch?: unknown;
      type?: unknown;
      content?: unknown;
    };

    let added: number | null = null;
    let removed = 0;
    if (Array.isArray(structuredPatch)) {
      const counts = countPatchLines(structuredPatch);
      added = counts.added;
      removed = counts.removed;
    } else if (type === 'create' && typeof content === 'string') {
      added = countContentLines(content);
    }
    if (added === null) continue;

    linesAdded = (linesAdded ?? 0) + added;
    linesRemoved = (linesRemoved ?? 0) + removed;
  }

  return { linesAdded, linesRemoved };
}

/**
 * Count real user prompts: user lines with text (a plain string or a `text` block) that are not
 * meta, sidechain or compaction-summary lines. Lines holding only `tool_result` blocks are not
 * prompts.
 */
export function countTurns(lines: readonly SignalLine[]): number {
  let turns = 0;
  for (const line of lines) {
    if (line.type !== 'user' || line.isMeta || line.isSidechain || line.isCompactSummary) continue;
    const content = line.message?.content;
    if (typeof content === 'string') {
      turns += 1;
    } else if (
      Array.isArray(content) &&
      content.some((block) => (block as { type?: unknown } | null)?.type === 'text')
    ) {
      turns += 1;
    }
  }
  return turns;
}

/**
 * One {@link Compaction} per `compact_boundary` system line. `end` is the boundary line's
 * timestamp and `start` is `end - durationMs`; `dropped_tokens` is `pre - post`.
 */
export function collectCompactions(lines: readonly SignalLine[]): Compaction[] {
  const compactions: Compaction[] = [];
  for (const line of lines) {
    if (line.type !== 'system' || line.subtype !== 'compact_boundary') continue;

    const meta = line.compactMetadata ?? {};
    const end = typeof line.timestamp === 'string' ? line.timestamp : '';
    const durationMs = asNumber(meta.durationMs);
    const endMs = Date.parse(end);
    const pre = asNumber(meta.preTokens);
    const post = asNumber(meta.postTokens);

    compactions.push({
      start:
        durationMs !== null && Number.isFinite(endMs)
          ? new Date(endMs - durationMs).toISOString()
          : null,
      end,
      duration_ms: durationMs,
      trigger: typeof meta.trigger === 'string' ? meta.trigger : '',
      pre_tokens: pre,
      post_tokens: post,
      dropped_tokens: pre !== null && post !== null && pre >= post ? pre - post : null,
    });
  }
  return compactions;
}

/** Distinct client versions, in order of first appearance. */
export function collectClientVersions(lines: readonly SignalLine[]): string[] {
  const versions = new Set<string>();
  for (const line of lines) {
    if (typeof line.version === 'string' && line.version) versions.add(line.version);
  }
  return [...versions];
}

/** The latest `ai-title`, cut to the contract's 200 characters; `''` when there is none. */
export function latestTitle(lines: readonly SignalLine[]): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string' && line.aiTitle.trim()) {
      return line.aiTitle.trim().slice(0, TITLE_MAX_LENGTH);
    }
  }
  return '';
}
