/**
 * Main-transcript trigger orchestration for the `SessionStart`, `Stop`, `PreCompact`,
 * `PostCompact`, `SessionEnd`, `StopFailure`, and `SubagentStop` hook events.
 *
 * Each hook fire is a fresh CLI process, so this module reloads persisted parse state
 * (`./parse-state.js`), reads only the transcript lines appended since the last persisted
 * `mainOffset` (`./transcript-reader.js`), derives/merges `agent.usage.request` records for
 * those new lines (`./usage-request.js`), and returns one JSON string per completed request
 * plus (on `Stop`/`SessionEnd`) one `agent.session.summary` event. `SessionStart`
 * ({@link openSessionStartPass}) derives no events of its own — it only records this session's
 * starting point for `agent.git.snapshot` to read back later. `SubagentStop`
 * ({@link openSubagentPass}) derives usage for its own subagent transcript and may emit
 * `agent.subagent.usage`. `PostCompact` ({@link openPostCompactPass}) is its own case — see its
 * doc comment — because the `compact_boundary` line it reports on is not reliably present yet
 * when the hook fires.
 *
 * Commit-after-send: the exported `open*Pass` functions acquire the per-session parse-state
 * lock, load state, derive in memory, and return `{ events, finalize }` *without* persisting
 * anything yet. The caller (the plugin's handlers, via `OtlpAgentAdapter.processOtlpEvent`)
 * sends `events` to the spool and then calls `finalize(accepted)` exactly once: only an
 * accepted send persists the mutated state and advances the cursor; the lock is released either
 * way. A failed send therefore leaves the transcript cursor untouched, so the next hook
 * re-derives and re-sends the same events — the transcript itself is the retry log, no separate
 * one is needed. Holding the lock from read through commit (not just through derive) is what
 * makes this safe against a sibling hook for the same session: see `acquireParseStateLock`.
 *
 * Never throws: every path is wrapped so a read/parse/lock failure degrades to an empty pass
 * (`{ events: [], finalize: no-op }`) rather than interrupting the hook that triggered it
 * (`processOtlpEvent` must never block or fail on this) — any lock already acquired on that path
 * is released before returning.
 */

import { readFile, stat } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { mayHoldCopiedLines, resolveInheritedUuids } from './continuation.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import {
  acquireParseStateLock,
  isReopenedIdle,
  loadParseState,
  saveParseState,
  type TranscriptParseState,
  type OpenUsageRequest,
} from './parse-state.js';
import {
  resolveSessionEnvFields,
  resolveVolatileSessionEnvFields,
  sessionEnvFieldsEqual,
  type SessionEnvFields,
} from '../event-fields/session-env-fields.js';
import { readNewLines } from './transcript-reader.js';
import { parseUsageLine, mergeUsageRequest, buildUsageRequestEvent, usageRequestKey } from './usage-request.js';
import { isSyntheticModel } from './synthetic-model.js';
import {
  updateBranchCounts,
  buildSessionSummaryEvent,
  type SessionSummaryAccumulator,
  type NamedInvocationCounts,
} from './session-summary.js';
import {
  extractNamedInvocations,
  extractOrderedNamedInvocations,
} from '@/agents/plugins/claude/session/claude-named-invocations.js';
import { isCountedTranscriptLine, keepFirstByUuid } from '@/agents/plugins/claude/session/transcript-lines.js';
import {
  buildCompactionDoneEvent,
  collectClientVersions,
  collectCompactions,
  collectEditLineStats,
  countTurns,
  isGenuineUserTurn,
  latestTitle,
  type Compaction,
  type SignalLine,
} from './session-signals.js';
import {
  type SubagentFile,
  buildSubagentUsageEvent,
  type SubagentSnapshot,
  refreshHead,
  resolveSubagentSnapshot,
} from './subagent-usage.js';

/**
 * The subagent resolution of ONE hook pass. The session summary (`commands`) and the settling of
 * deferred subagents (usage) both need it, over the same candidates and the same main-transcript
 * text: whichever runs first stores it here and the other reuses it. Never kept across passes.
 */
interface PassSnapshot {
  snapshot?: SubagentSnapshot;
}

// Re-exported so callers (e.g. claude-code-otlp.plugin.ts) can import both `SubagentFile` and
// the pass openers from this one module.
export type { SubagentFile };

export type MainTranscriptTrigger = 'Stop' | 'PreCompact' | 'SessionEnd' | 'StopFailure';
type MainTranscriptDerivationTrigger = MainTranscriptTrigger | 'PostCompact';

/** One hook invocation's derived events, with the deferred commit described above. */
export interface TranscriptPass {
  events: Record<string, unknown>[];
  finalize: (accepted: boolean) => Promise<void>;
  /** The session was reopened by a `resume` and has shown no activity of its own yet: the caller
   *  must not forward its lifecycle event (and `events` is empty). Absent = forward as usual. */
  suppressLifecycle?: boolean;
}

const EMPTY_PASS: TranscriptPass = { events: [], finalize: async () => {} };

/**
 * Maximum time `openPostCompactPass` waits lock-free for `compact_boundary` lines to land.
 * `PostCompact` fires before Claude Code has necessarily flushed that line to disk — observed lag
 * ranges from under a second up to ~9s, since Claude Code appears to buffer the whole
 * post-compaction segment and flush it in one shot at a later internal checkpoint, not
 * progressively. The `PostCompact` hook entry is configured `async` (see
 * `connectors/claude-code-otlp.ts`) specifically so this wait never blocks Claude Code or the
 * user's own turn.
 */
const POST_COMPACT_WAIT_BUDGET_MS = 60_000;
const COMPACTION_POLL_INTERVAL_MS = 500;
const COMPACTION_SETTLE_INTERVAL_MS = 10_000;

/** `compact_boundary` lines seen so far by {@link scanCompactions}, plus the byte offset consumed. */
interface CompactionScan {
  compactions: Compaction[];
  offset: number;
  /** Uuids of lines a continued session copied from its parent: their boundaries are not its own. */
  excluded?: ReadonlySet<string>;
}

/**
 * Read only the transcript bytes appended since `scan.offset` and append any newly completed
 * `compact_boundary` lines to `scan.compactions`.
 *
 * `PostCompact` polls for up to a minute, so re-reading the whole file and `JSON.parse`-ing every
 * line on every poll is wasteful on a multi-megabyte transcript. This reads only the appended
 * bytes ({@link readNewLines} cuts at the last newline, so a partially flushed line is picked up
 * by a later poll) and parses only the lines whose text mentions `compact_boundary`.
 *
 * Deliberately not scoped to `state.mainOffset`: a sibling hook for the same session (e.g. the
 * `Stop` that resumes the turn right after compaction) can advance `mainOffset` past the boundary
 * line's position while `openPostCompactPass` is still waiting — nothing else in this module ever
 * looks for `compact_boundary`, so that line is never actually consumed by it, but relying on
 * `mainOffset` as a starting point would still miss it.
 *
 * Returns `false` when the transcript does not exist — there is nothing to wait for then.
 */
async function scanCompactions(transcriptPath: string, scan: CompactionScan): Promise<boolean> {
  try {
    await stat(transcriptPath);
  } catch {
    return false;
  }

  const { lines, nextOffset } = await readNewLines(transcriptPath, scan.offset);
  scan.offset = nextOffset;

  const boundaryLines: SignalLine[] = [];
  for (const line of lines) {
    if (!line.includes('compact_boundary')) continue;
    try {
      const parsed = JSON.parse(line) as SignalLine & { uuid?: unknown };
      if (typeof parsed.uuid === 'string' && scan.excluded?.has(parsed.uuid)) continue;
      boundaryLines.push(parsed);
    } catch {
      // Skip malformed lines rather than aborting the whole scan.
    }
  }

  for (const compaction of collectCompactions(boundaryLines)) {
    // A truncated/rotated transcript is re-read from byte 0 by `readNewLines`; skip a boundary
    // this pass already collected instead of reporting it twice.
    if (scan.compactions.some((existing) => existing.end === compaction.end)) continue;
    scan.compactions.push(compaction);
  }

  return true;
}

/**
 * `candidate` counts as newer than `lastEnd` when its own `end` parses to a later instant, or
 * `lastEnd` is empty (no compaction reported yet this session). A `candidate` with no parseable
 * `end` is never newer — nothing to dedupe against reliably.
 */
function isCompactionNewer(candidate: Compaction, lastEnd: string): boolean {
  const candidateMs = Date.parse(candidate.end);
  if (!Number.isFinite(candidateMs)) return false;
  if (!lastEnd) return true;
  const lastMs = Date.parse(lastEnd);
  return !Number.isFinite(lastMs) || candidateMs > lastMs;
}

/**
 * Lock-free: incrementally scans the transcript until no new boundaries have appeared for the
 * settle interval, or `waitBudgetMs` expires. The quiet period gives Claude Code time to flush
 * later boundaries from the same compaction sequence. Returns the accumulated scan so the
 * authoritative pass under the lock afterward can reuse it instead of re-reading the transcript,
 * and returns immediately when the transcript does not exist.
 */
async function waitForCompactionsToSettle(
  transcriptPath: string,
  afterEnd: string,
  waitBudgetMs: number,
  excluded: ReadonlySet<string> = new Set()
): Promise<CompactionScan> {
  const scan: CompactionScan = { compactions: [], offset: 0, excluded };
  const deadline = Date.now() + waitBudgetMs;
  let previousSignature: string | undefined;
  let stableSince: number | undefined;

  for (;;) {
    if (!(await scanCompactions(transcriptPath, scan))) return scan;

    const newer = scan.compactions.filter((compaction) => isCompactionNewer(compaction, afterEnd));
    const signature = newer.map((compaction) => compaction.end).join('\n');
    const now = Date.now();

    if (signature) {
      if (signature !== previousSignature) {
        previousSignature = signature;
        stableSince = now;
      } else if (stableSince !== undefined && now - stableSince >= COMPACTION_SETTLE_INTERVAL_MS) {
        return scan;
      }
    } else {
      previousSignature = undefined;
      stableSince = undefined;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return scan;

    await new Promise((resolve) => setTimeout(resolve, Math.min(COMPACTION_POLL_INTERVAL_MS, remainingMs)));
  }
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  isError?: boolean;
  input?: { file_path?: unknown; path?: unknown; notebook_path?: unknown; skill?: unknown };
}

interface TranscriptLine extends SignalLine {
  gitBranch?: string;
  uuid?: string;
  message?: { content?: unknown; model?: unknown };
}

/**
 * Collect the set of `tool_use_id` values whose matching `tool_result` block carries a truthy
 * `is_error`/`isError` flag.
 *
 * Shared between {@link buildFullAccumulator} (main transcript) and
 * {@link scanSubagentTranscript} (subagent transcript) so the error-correlation logic does not
 * drift between the two call sites.
 */
function collectErrorToolUseIds(parsedLines: TranscriptLine[]): Set<string> {
  const errorByToolUseId = new Set<string>();
  for (const parsed of parsedLines) {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as ContentBlock[]) {
      if (
        item?.type === 'tool_result' &&
        typeof item.tool_use_id === 'string' &&
        (item.is_error === true || item.isError === true)
      ) {
        errorByToolUseId.add(item.tool_use_id);
      }
    }
  }
  return errorByToolUseId;
}

/** The first non-empty `timestamp` among `parsedLines`, in order, or `''` when none carry one. */
function firstTimestamp(parsedLines: TranscriptLine[]): string {
  for (const line of parsedLines) {
    if (typeof line.timestamp === 'string' && line.timestamp) {
      return line.timestamp;
    }
  }
  return '';
}

function emptyAccumulator(): SessionSummaryAccumulator {
  return {
    models: {},
    toolCalls: {},
    toolResults: 0,
    filesEdited: new Set<string>(),
    filesWritten: new Set<string>(),
    linesAdded: null,
    linesRemoved: null,
    turns: 0,
    compactions: [],
    clientVersions: [],
    commandsInOrder: [],
    title: '',
    lastGitBranch: '',
  };
}

/** Total `tool_result` content blocks across `parsedLines` — the contract's `tool_results` count. */
function countToolResults(parsedLines: TranscriptLine[]): number {
  let count = 0;
  for (const parsed of parsedLines) {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as ContentBlock[]) {
      if (item?.type === 'tool_result') count += 1;
    }
  }
  return count;
}

/**
 * The `Skill` tool's invoked name (`input.skill`) on `parsed`'s assistant content, or `''` when
 * this line does not invoke one. Mirrors `claude-named-invocations.ts`'s own `Skill` detection,
 * but only needs the single name on one line rather than a session-wide count.
 */
function findSkillInvocation(parsed: TranscriptLine): string {
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return '';
  for (const item of content as ContentBlock[]) {
    if (item?.type === 'tool_use' && item.name === 'Skill' && typeof item.input?.skill === 'string') {
      const skill = item.input.skill.trim();
      if (skill) return skill;
    }
  }
  return '';
}

/** A user line that only records a local slash command or its output (`/exit`, `/model`, ...): no model work behind it. */
function isLocalCommandTurn(parsed: TranscriptLine): boolean {
  if (parsed.type !== 'user') return false;
  const content = parsed.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? String((content.find((block) => (block as { type?: unknown } | null)?.type === 'text') as { text?: unknown } | undefined)?.text ?? '')
        : '';
  return /^\s*<(command-name|command-message|local-command-)/.test(text);
}

/**
 * Work the user did: a real assistant answer or a genuine prompt. Synthetic placeholders, local
 * commands and the bookkeeping records Claude Code appends when it opens a session are not.
 */
function isOwnActivityLine(line: TranscriptLine): boolean {
  if (line.type === 'assistant') return !isSyntheticModel(String(line.message?.model ?? ''));
  return isGenuineUserTurn(line) && !isLocalCommandTurn(line);
}

/**
 * Recompute the full-session summary accumulator, named-invocation counts, and session start
 * time from byte 0 of the main transcript.
 *
 * `TranscriptParseState`'s fixed shape has no persisted field for any of
 * `SessionSummaryAccumulator`'s data or for `NamedInvocationCounts` — only `branchCounts` is
 * incrementally tracked there. So, for `Stop`/`SessionEnd`, this helper re-derives everything
 * else fresh from the whole transcript file every time. Transcripts are
 * not enormous and this only runs on `Stop`/`SessionEnd`, not on every hook.
 *
 * Never throws: a missing/unreadable transcript resolves to the emptiest defensible result
 * (empty accumulator, empty named-invocation counts, `startedAt: ''`); a malformed individual
 * line is skipped rather than aborting the whole scan.
 *
 * Known limitations (no reliable in-transcript signal found for any of these):
 * - `toolCalls[*].errors` is derived from a sibling `tool_result` block's `is_error`/`isError`
 *   flag (the same pattern `claude.session.ts`/`claude.metrics-processor.ts` already use for
 *   tool-use_id → error lookups) when one is found; otherwise a tool call's `.errors` stays 0.
 * - Lines added/removed come from the applied diff on the `tool_result` line
 *   (`toolUseResult.structuredPatch`, or a `create` result's `content`), not from the `tool_use`
 *   input, which only carries the *proposed* edit. They stay `null` until one such result is seen.
 * - Compactions come from `compact_boundary` system lines, not from the `PreCompact` hook, which
 *   fires before the boundary line exists.
 */
async function buildFullAccumulator(
  transcriptPath: string,
  final: boolean,
  extra: readonly SubagentFile[],
  pass: PassSnapshot,
  excluded: ReadonlySet<string> = new Set()
): Promise<{
  acc: SessionSummaryAccumulator;
  named: NamedInvocationCounts;
  startedAt: string;
  endedAt: string;
  hasOwnLines: boolean;
}> {
  const acc = emptyAccumulator();

  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf-8');
  } catch {
    return { acc, named: extractOrderedNamedInvocations([]), startedAt: '', endedAt: '', hasOwnLines: false };
  }

  // Lines a continued session copied from its parent are not its own work: dropped here so no
  // summary figure (models, tools, turns, timestamps) includes them. A copy is told by its uuid,
  // but Claude Code also copies lines without one (`queue-operation`, ...) that carry a timestamp,
  // so for a continuation everything before the first own line with a uuid is a copy too.
  const rawLines: string[] = [];
  const allLines: TranscriptLine[] = [];
  let ownStarted = excluded.size === 0;

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptLine;
      if (typeof parsed?.uuid === 'string' && excluded.has(parsed.uuid)) continue;
      if (!ownStarted) {
        if (typeof parsed?.uuid !== 'string') continue;
        ownStarted = true;
      }
      allLines.push(parsed);
    } catch {
      // Skip malformed lines rather than aborting the whole scan.
    }
    rawLines.push(line);
  }
  const parsedLines = keepFirstByUuid(allLines.filter(isCountedTranscriptLine));

  // Pass 1: collect tool_result error flags keyed by their matching tool_use_id.
  const errorByToolUseId = collectErrorToolUseIds(parsedLines);
  acc.toolResults = countToolResults(parsedLines);

  // Pass 2: models, one count per distinct request — a request can span several
  // streaming/finalizing transcript lines, so lines are deduped by the same
  // `usageRequestKey()` key `state.openRequests` uses before counting.
  const modelByRequestKey = new Map<string, string>();
  for (const line of rawLines) {
    // scopeKind/scopeName/agentId/agentType don't affect this count (only `.model` is read), so
    // 'main' is used uniformly rather than re-deriving deriveMainEvents's active-skill state.
    const parsedUsage = parseUsageLine(line, 'main', '', '', '');
    if (parsedUsage) {
      if (!parsedUsage.isApiError) {
        modelByRequestKey.set(usageRequestKey(parsedUsage), parsedUsage.model);
      }
    }
  }
  for (const model of modelByRequestKey.values()) {
    if (isSyntheticModel(model)) continue;
    acc.models[model] = (acc.models[model] ?? 0) + 1;
  }

  // Pass 3: tool calls/errors, files edited/written (Edit/Write tool_use payloads).
  for (const parsed of parsedLines) {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as ContentBlock[]) {
      if (item?.type !== 'tool_use' || typeof item.name !== 'string') continue;

      const entry = acc.toolCalls[item.name] ?? { calls: 0, errors: 0 };
      entry.calls += 1;
      if (typeof item.id === 'string' && errorByToolUseId.has(item.id)) {
        entry.errors += 1;
      }
      acc.toolCalls[item.name] = entry;

      const filePath = item.input?.file_path ?? item.input?.path ?? item.input?.notebook_path;
      if (typeof filePath === 'string' && filePath) {
        if (item.name === 'Write') acc.filesWritten.add(filePath);
        if (item.name === 'Edit' || item.name === 'MultiEdit' || item.name === 'NotebookEdit') {
          acc.filesEdited.add(filePath);
        }
      }
    }
  }

  // A forked skill run as `/name` leaves no command wrapper; count its plain line when a fork
  // proves the prompt started one.
  // Resolved over the same candidates (discovered + hook-reported/deferred paths) the usage events
  // use, so a fork recovered from a path outside discovery is counted here too.
  pass.snapshot = await resolveSubagentSnapshot(transcriptPath, { final, extra, raw });
  const { slashPromptIds } = pass.snapshot;
  const named = extractOrderedNamedInvocations(parsedLines, slashPromptIds);
  acc.commandsInOrder = named.commandsInOrder;

  const { linesAdded, linesRemoved } = collectEditLineStats(parsedLines);
  acc.linesAdded = linesAdded;
  acc.linesRemoved = linesRemoved;
  acc.turns = countTurns(parsedLines);
  acc.compactions = collectCompactions(parsedLines);
  acc.clientVersions = collectClientVersions(parsedLines);
  acc.title = latestTitle(parsedLines);
  acc.lastGitBranch =
    [...parsedLines].reverse().find((line) => typeof line.gitBranch === 'string' && line.gitBranch)
      ?.gitBranch ?? '';

  // Real transcripts interleave non-message lines (file-history-snapshot, cost-state, ...)
  // without a `timestamp`, including at index 0/length-1 — so the first/last *timestamped*
  // line is used, not literally the first/last line.
  const startedAt = firstTimestamp(parsedLines);
  const endedAt = firstTimestamp([...parsedLines].reverse());

  // Own activity is the bar the usage pass uses: a real answer or a genuine prompt. The synthetic
  // placeholder and local-command lines written when a continuation is opened and closed are not.
  const hasOwnLines = parsedLines.some(isOwnActivityLine);

  return { acc, named, startedAt, endedAt, hasOwnLines };
}

/**
 * The seen-uuid set for a state saved before `seenMessageUuids` existed: the counted `user` /
 * `assistant` uuids in the bytes the earlier pass already read, so their re-written copies are not
 * counted again. A file now shorter than `mainOffset` seeds nothing: the reader re-reads it from
 * byte 0 as new lines never counted. `null` when the file is missing or unreadable, so the caller
 * leaves the field absent and the next pass seeds again.
 */
async function seedSeenUuids(transcriptPath: string, mainOffset: number): Promise<Set<string> | null> {
  const seen = new Set<string>();
  if (mainOffset <= 0) return seen;
  let buffer: Buffer;
  try {
    buffer = await readFile(transcriptPath);
  } catch {
    return null;
  }
  if (buffer.length < mainOffset) return seen;
  const head = buffer.subarray(0, mainOffset);
  for (const line of head.toString('utf-8').split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isCountedTranscriptLine(parsed)) keepFirstByUuid([parsed], seen);
  }
  return seen;
}

/** Complete lookups that found no parent before a session is taken to have none (EPMCDME-16992). */
const MAX_PARENT_LOOKUPS = 3;

/**
 * The uuids a continued session copied from its parent transcript (EPMCDME-16992), kept in `state`.
 * A found parent is final. A complete lookup that found nothing is repeated on the next passes (at
 * most {@link MAX_PARENT_LOOKUPS} of them), because the parent's `continued-in` record may not be
 * flushed yet on the first pass. An incomplete lookup (unreadable directory or sibling, more
 * candidates than the scan covers) is never final: it is repeated on every pass until it completes,
 * so a session is not taken to have no parent just because the scan could not finish.
 * Lines already reported before a late find stay reported, but every later event and the summary
 * (rebuilt from the whole transcript) exclude the copies. Empty for a session with no parent.
 *
 * A transcript with no line older than the session's own start cannot hold copies and skips the scan.
 * Known limits: a continuation in a project directory with more than 200 transcripts is scanned again on
 * every pass, and a first pass that runs before the parent's record is on disk reports the copied lines.
 */
async function ensureInherited(
  state: TranscriptParseState,
  sessionId: string,
  transcriptPath: string
): Promise<ReadonlySet<string>> {
  if (!state.inheritedResolved && !(await mayHoldCopiedLines(transcriptPath, state.sessionStartedAt))) {
    // No line is older than the session itself, so nothing was copied: the sibling scan would only cost time.
    state.inheritedResolved = true;
  }
  if (!state.inheritedResolved) {
    const uuids = await resolveInheritedUuids(transcriptPath, sessionId);
    if (uuids && uuids.length > 0) {
      state.inheritedUuids = uuids;
      state.inheritedResolved = true;
    } else if (uuids) {
      const previous = Number.isFinite(state.inheritedLookups) ? (state.inheritedLookups as number) : 0;
      state.inheritedLookups = previous + 1;
      if (state.inheritedLookups >= MAX_PARENT_LOOKUPS) state.inheritedResolved = true;
    }
  }
  return new Set(Array.isArray(state.inheritedUuids) ? state.inheritedUuids : []);
}

function mergeOpenUsageRequest(state: TranscriptParseState, parsed: OpenUsageRequest): string {
  const key = usageRequestKey(parsed);
  const existing = state.openRequests[key];

  // Older persisted states keyed API-error placeholders like normal requests. When a real row
  // now arrives under that legacy key, replace the placeholder instead of preserving its sticky
  // error flag; current API-error rows use a separate key namespace.
  if (existing?.isApiError && !parsed.isApiError) {
    state.openRequests[key] = parsed;
  } else {
    state.openRequests[key] = existing ? mergeUsageRequest(existing, parsed) : parsed;
  }
  return key;
}

/**
 * Derive the spool-bound events for one `Stop`/`PreCompact`/`PostCompact`/`SessionEnd`/
 * `StopFailure` hook fire, mutating `state` in memory. Does not persist anything — the caller (a
 * pass opener below) owns the commit, so several passes can share one in-memory `state` under
 * one lock (see `openSessionEndPass`).
 *
 * - Reads only the lines appended since `state.mainOffset`.
 * - Derives/merges `agent.usage.request` records for those new lines into `state.openRequests`,
 *   keyed by `usageRequestKey()`, and updates `state.branchCounts` from every new user line's
 *   `gitBranch` (regardless of whether that line carried usage).
 * - Returns one `agent.usage.request` JSON string per request key touched by this pass.
 * - On `Stop`/`SessionEnd` only, also returns exactly one `agent.session.summary` event
 *   (`phase: 'incremental'` on `Stop`, `'final'` on `SessionEnd`) built from a fresh full-file
 *   recompute (see {@link buildFullAccumulator}). `PreCompact`/`StopFailure` never return a
 *   summary.
 *
 * Scoping: Claude Code's own mark decides first. A line with `attributionSkill` (2.1.278+, set on
 * every line an inline skill — run as `/x` or through the `Skill` tool — or a command owns) is
 * scoped `scopeKind: 'skill'`, `scopeName: <attributionSkill>`; a line without it that has
 * `requestedModel` (2.1.295+, which would carry the mark if a skill owned it) is `scopeKind: 'main'`,
 * `scopeName: ''`. Only a line with neither falls back to the `state.activeSkill` heuristic:
 * `state.activeSkill` tracks which skill (if any) the main transcript is currently "inside" — set to
 * a skill's name when a `Skill` tool_use invokes it ({@link findSkillInvocation}, applied *after*
 * scoping that same line's own usage record, since the invoking turn itself still belongs to
 * whatever was active before it), and cleared on the next genuine new user turn
 * ({@link isGenuineUserTurn}). Such a line is scoped `scopeKind: 'skill'`,
 * `scopeName: state.activeSkill` while a skill is active, else `main`. The heuristic misses a
 * slash-invoked skill or command and scopes a skill whose work spans several turns without an
 * intervening user prompt as one continuous span.
 */
async function deriveMainEvents(
  state: TranscriptParseState,
  sessionId: string,
  transcriptPath: string,
  trigger: MainTranscriptDerivationTrigger,
  pass: PassSnapshot = {}
): Promise<Record<string, unknown>[]> {
  const { lines, nextOffset } = await readNewLines(transcriptPath, state.mainOffset);

  const events: Record<string, unknown>[] = [];
  const touchedKeys = new Set<string>();
  const seeded = Array.isArray(state.seenMessageUuids)
    ? new Set<string>(state.seenMessageUuids)
    : await seedSeenUuids(transcriptPath, state.mainOffset);
  const seenUuids = seeded ?? new Set<string>();
  const inherited = await ensureInherited(state, sessionId, transcriptPath);
  for (const uuid of inherited) seenUuids.add(uuid);
  let ownActivity = false;
  for (const line of lines) {
    let rawGitBranch = '';
    let isUserLine = false;
    let head: TranscriptLine | null = null;
    try {
      head = JSON.parse(line) as TranscriptLine;
      rawGitBranch = head?.gitBranch ?? '';
      isUserLine = head?.type === 'user';
    } catch {
      // Malformed line: still attempt usage parsing below (which has its own try/catch), but
      // there is no branch/skill/turn signal to read from it.
    }
    if (!isCountedTranscriptLine(head) || keepFirstByUuid([head], seenUuids).length === 0) {
      continue;
    }
    // The contract's branch counts are user lines per branch.
    if (rawGitBranch && isUserLine) {
      updateBranchCounts(state.branchCounts, rawGitBranch);
    }

    if (head && isGenuineUserTurn(head)) {
      state.activeSkill = '';
    }

    const parsed = parseUsageLine(line, 'main', '', '', '');
    // Only work the user did counts: a real assistant answer or a genuine prompt. Records Claude Code
    // appends on a reopen (hook attachments, mode / permission-mode / last-prompt lines) and its
    // synthetic placeholder answers are not activity.
    // Read from the line itself: `parsed` is null for a line without usage or ids.
    if (head && isOwnActivityLine(head)) {
      ownActivity = true;
    }
    if (parsed) {
      parsed.scopeName = parsed.attributionSkill || (parsed.requestedModel ? '' : state.activeSkill);
      parsed.scopeKind = parsed.scopeName ? 'skill' : 'main';
      touchedKeys.add(mergeOpenUsageRequest(state, parsed));
    }

    // Applied after this line's own usage is scoped — the turn that invokes a skill still
    // belongs to whatever context was active before it.
    if (head) {
      const skill = findSkillInvocation(head);
      if (skill) {
        state.activeSkill = skill;
      }
    }
  }
  state.mainOffset = nextOffset;
  if (seeded) state.seenMessageUuids = [...seenUuids];

  // A reopened session stays silent until it has done something: opening it must not change its
  // analytics (EPMCDME-16993).
  if (state.reopened && ownActivity) state.reopenActive = true;
  if (isReopenedIdle(state)) return [];

  // Same for a continuation: until it has work of its own, a synthetic placeholder or a local command
  // is all it holds, and reporting that would show the session as active.
  if (inherited.size > 0 && ownActivity) state.continuationActive = true;
  if (inherited.size > 0 && !state.continuationActive) return [];

  for (const key of touchedKeys) {
    const request = state.openRequests[key];
    // usageRequestKey isolates API-error rows even when request id and resolved model match a
    // normal request, so suppressing one cannot hide that normal request from downstream.
    if (!request.isApiError) {
      events.push(buildUsageRequestEvent(sessionId, request));
    }
  }

  if (trigger === 'Stop' || trigger === 'SessionEnd') {
    const { acc, named, startedAt, endedAt, hasOwnLines } = await buildFullAccumulator(
      transcriptPath,
      trigger === 'SessionEnd',
      deferredCandidates(state),
      pass,
      inherited
    );
    // A continued session with no work of its own has nothing to summarise: the figures would
    // otherwise be the parent's, stamped with the parent's timestamps.
    if (inherited.size > 0 && !hasOwnLines) return events;
    const phase = trigger === 'SessionEnd' ? 'final' : 'incremental';
    const summaryEvent = buildSessionSummaryEvent(
      sessionId,
      phase,
      acc,
      named,
      state.branchCounts,
      startedAt,
      endedAt
    );
    // Main-thread requests — 'main' and 'skill' are both made on the main thread, scoped with an
    // empty agentId; the contract's api_calls excludes subagent requests, including a forked
    // skill's (scopeKind: 'skill' too, but with its own agentId — see deriveSubagentEvents).
    summaryEvent.api_calls = Object.values(state.openRequests).filter(
      (r) => (r.scopeKind === 'main' || r.scopeKind === 'skill') && !r.agentId && !r.isApiError
    ).length;
    events.push(summaryEvent);
  }

  return events;
}

/**
 * Build a pass's `finalize`: persists `state` only when the send was accepted, then always
 * releases the lock — even if the save itself throws, so a disk error can never leak the lock.
 * A failed save is logged and otherwise swallowed: the next hook replays the same batch from the
 * transcript, which is harmless (the backend dedupes/collapses replays; see the delivery plan).
 */
function finalizeOf(
  sessionId: string,
  state: TranscriptParseState,
  release: () => Promise<void>
): (accepted: boolean) => Promise<void> {
  return async (accepted: boolean) => {
    try {
      if (accepted) {
        await saveParseState(sessionId, state);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[claude-code-otlp] failed to persist parse state', ...sanitizeLogArgs({ sessionId, err: msg }));
    } finally {
      await release();
    }
  };
}

export interface SessionStartPass extends TranscriptPass {
  sessionEnvFields: SessionEnvFields;
  gitHeadStart: string;
  /** A `resume` of a session whose start was already recorded: nothing new to announce. */
  reopened?: boolean;
}

/**
 * Open a commit-after-send pass for one `SessionStart` hook fire: records this session's
 * starting point (`gitHeadStart`, wall-clock `sessionStartedAt`) into parse state, under the
 * same lock and the same commit-only-on-accepted-send discipline every other pass here uses —
 * persisted only once the `agent.session.start`/`agent.session.env` batch actually lands.
 * `SessionEnd` (a later, separate CLI process) reads both back via {@link openSessionEndPass}
 * for `agent.git.snapshot`. Also records `sessionEnvFields` as the baseline
 * {@link openSessionEnvCheckPass} diffs against later in the session. Derives no events of its
 * own (`events` is always `[]`).
 *
 * First-write-wins: Claude Code fires `SessionStart` again later in the same session (e.g.
 * `source: 'compact'` after `/compact`, `source: 'resume'` on `claude -c`), always under the
 * same `sessionId`. Only the first fire — the one that finds no start recorded yet — sets
 * `gitHeadStart`/`sessionStartedAt`; later fires leave the already-persisted real session start
 * untouched, so `agent.git.snapshot`'s commit window always spans the whole session. The
 * returned `gitHeadStart` is the persisted first SHA, so the `agent.session.start` event agrees.
 *
 * `sessionEnvFields` is merged onto the prior `lastSessionEnvFields` snapshot rather than
 * overwriting it outright: a later fire's payload never carries `effort` (SDK contract), so
 * `effort` always carries forward from the prior snapshot when one exists; `permission_mode` and
 * `configured_model` prefer the fresh payload's own non-empty value, else fall back to the prior
 * snapshot's. With no prior snapshot (the true first fire), the freshly resolved fields are used
 * as-is. The merged result is both persisted and returned, so the caller sends exactly what gets
 * recorded as the new baseline.
 */
export async function openSessionStartPass(
  sessionId: string,
  gitHeadStart: string,
  sessionEnvFields: SessionEnvFields,
  source?: string
): Promise<SessionStartPass> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    // A resume of a session already started announces nothing: its start was reported once, and a
    // start stamped at the reopen would move the session's activity window (EPMCDME-16993).
    // Without a saved sessionStartedAt a resume is a first start here (the transition gate already
    // stops a resume without an evidence record), and a state with offset 0 is not moved to the file
    // size, which would drop never-reported work.
    const reopened = source === 'resume' && Boolean(state.sessionStartedAt);
    if (reopened) {
      state.reopened = true;
      state.reopenActive = false;
      state.reopenedAt = Date.now();
    }
    if (!state.gitHeadStart) {
      state.gitHeadStart = gitHeadStart;
    }
    if (!state.sessionStartedAt) {
      state.sessionStartedAt = new Date().toISOString();
    }
    const last = state.lastSessionEnvFields;
    const merged: SessionEnvFields = last
      ? {
          ...sessionEnvFields,
          effort: last.effort,
          permission_mode: sessionEnvFields.permission_mode || last.permission_mode,
          configured_model: sessionEnvFields.configured_model || last.configured_model,
        }
      : sessionEnvFields;
    // A reopen announces nothing, so it must not move the env baseline either: the first pass after
    // the session is active again diffs the resumed model/permission mode against it and reports it.
    if (!reopened || !last) {
      state.lastSessionEnvFields = merged;
    }
    return {
      events: [],
      finalize: finalizeOf(sessionId, state, release),
      sessionEnvFields: merged,
      gitHeadStart: state.gitHeadStart,
      reopened,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] SessionStart pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
    await release?.();
    return { ...EMPTY_PASS, sessionEnvFields, gitHeadStart };
  }
}

/** Inputs a trigger hook can supply for one env-check (standalone or folded into a sibling pass). */
export interface SessionEnvCheckInput {
  /** The firing hook's own `effort?.level ?? ''` / `permission_mode ?? ''` — free, no I/O. */
  effort: string;
  permissionMode: string;
  /** Hook cwd, used to build a full baseline if no SessionStart snapshot was recorded. */
  cwd?: string;
  /**
   * Present only on triggers willing to pay for a full recompute (`PostModelSwitch`,
   * `ConfigChange`) — `output_style`/`plugins`/`mcp_servers`/`provider`/`api_host` are only
   * re-read from disk/env when this is set. `configuredModel` is optional because
   * `ConfigChangeHookInput` doesn't carry a model at all; omitting it keeps whatever the last
   * snapshot already had (`PostModelSwitch`'s `to_model` always provides it explicitly).
   * `replaceEffort` is set for `PostModelSwitch`: an empty effort then clears the previous value
   * because the new model may not support effort. `ConfigChange` leaves it unset.
   */
  full?: { cwd: string; configuredModel?: string; replaceEffort?: boolean };
}

export interface SessionEnvCheckResult {
  /** The full, updated snapshot to send as a new `agent.session.env` record — `null` when
   *  nothing actually changed (the common case), or when there's no baseline and no cwd to build one. */
  sessionEnvFields: SessionEnvFields | null;
  finalize: (accepted: boolean) => Promise<void>;
}

const NOOP_FINALIZE = async (): Promise<void> => {};

/**
 * The model of the newest request parsed so far for this session that sets the session's model:
 * its `requestedModel`, else its `model`. Used as a last-resort fallback for `configured_model`
 * when neither the triggering hook's own payload nor the prior `agent.session.env` snapshot has
 * one — e.g. the Claude Code desktop app's `SessionStart` carries no `model` until the first
 * `/compact` or model switch, even though every transcript line already reports the model that
 * actually answered. A request counts when it has an empty `agentId` and a non-empty,
 * non-`<synthetic>` `model`, and is either scoped `main` or scoped `skill` with neither
 * `attributionSkill` nor `requestedModel`. A fork never counts (its `agentId`), on any version. A
 * line Claude Code marked with `attributionSkill` (2.1.278+) never counts: an inline skill or a
 * command can run on its own `model:`. An unmarked line without `requestedModel` (before 2.1.295)
 * counts whatever its scope — the `activeSkill` heuristic may have scoped it `skill`, but nothing
 * on the line says a skill owned it, so the fallback reads it as it always has.
 * `requestedModel` is preferred because it has the form SessionStart `model` and the model-switch
 * hooks use (`claude-opus-5-5[1m]`), while `model` drops `[1m]` and can be the provider's id.
 * `''` when no such request exists yet.
 */
function latestKnownModel(openRequests: Record<string, OpenUsageRequest>): string {
  let best: OpenUsageRequest | undefined;
  for (const req of Object.values(openRequests)) {
    if (req.agentId || !req.model || isSyntheticModel(req.model)) {
      continue;
    }
    const unmarkedSkill = req.scopeKind === 'skill' && !req.attributionSkill && !req.requestedModel;
    if (req.scopeKind !== 'main' && !unmarkedSkill) {
      continue;
    }
    if (!best || req.timestamp > best.timestamp) {
      best = req;
    }
  }
  return best ? best.requestedModel || best.model : '';
}

/**
 * Diffs a recomputed `agent.session.env` snapshot against `state.lastSessionEnvFields`, mutating
 * it and returning the new snapshot only when something changed (`null` otherwise). No lock/load
 * of its own — the caller must already hold the per-session lock for `state`.
 */
async function computeSessionEnvUpdate(
  state: TranscriptParseState,
  input: SessionEnvCheckInput
): Promise<SessionEnvFields | null> {
  const last = state.lastSessionEnvFields;
  const full = input.full ?? (!last && input.cwd ? { cwd: input.cwd, replaceEffort: false } : undefined);
  if (!last && !full) {
    return null;
  }

  let candidate: SessionEnvFields;
  if (full) {
    const configuredModel = full.configuredModel ?? last?.configured_model ?? latestKnownModel(state.openRequests);
    const resolved = await resolveSessionEnvFields(full.cwd, configuredModel, input.permissionMode);
    candidate = {
      ...resolved,
      effort: full.replaceEffort ? input.effort : input.effort || last?.effort || '',
      permission_mode: input.permissionMode || last?.permission_mode || '',
    };
  } else {
    const volatile = await resolveVolatileSessionEnvFields(input.effort, input.permissionMode);
    candidate = {
      ...last!,
      ...volatile,
      configured_model: last!.configured_model || latestKnownModel(state.openRequests),
      effort: input.effort || last!.effort,
      permission_mode: input.permissionMode || last!.permission_mode,
    };
  }

  if (last && sessionEnvFieldsEqual(last, candidate)) {
    return null;
  }

  state.lastSessionEnvFields = candidate;
  return candidate;
}

/** `{ type: 'agent.session.env', session_id, ...fields }` — the one shape every env-check caller sends. */
export function buildSessionEnvEvent(sessionId: string, fields: SessionEnvFields): Record<string, unknown> {
  return {
    type: 'agent.session.env',
    session_id: sessionId,
    ...fields,
  };
}

/**
 * Standalone commit-after-send pass for an env-check with no sibling pass to fold into
 * (`onPostModelSwitch`/`onConfigChange`). Every other trigger folds the check into its own
 * already-held lock instead of acquiring this one a second time.
 */
export async function openSessionEnvCheckPass(
  sessionId: string,
  input: SessionEnvCheckInput
): Promise<SessionEnvCheckResult> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    // A reopened session with no activity of its own announces nothing, not even an env change; the
    // change stays uncommitted and is reported by the first check once the session is active again.
    const candidate = isReopenedIdle(state) ? null : await computeSessionEnvUpdate(state, input);

    if (!candidate) {
      await release();
      return { sessionEnvFields: null, finalize: NOOP_FINALIZE };
    }

    return { sessionEnvFields: candidate, finalize: finalizeOf(sessionId, state, release) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] session-env check pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
    await release?.();
    return { sessionEnvFields: null, finalize: NOOP_FINALIZE };
  }
}

/** Forget `agentId` as deferred (its usage is being derived now). */
function clearDeferred(state: TranscriptParseState, agentId: string): void {
  if (state.deferredAgentIds) {
    state.deferredAgentIds = state.deferredAgentIds.filter((id) => id !== agentId);
  }
  if (state.deferredSubagentFiles) {
    delete state.deferredSubagentFiles[agentId];
  }
}

/**
 * Derive one subagent and register it as settled: its path, its type and any positive skill
 * evidence — never a guessed scope. The registry is the memory of "known scope + path + offset", so
 * a later `Stop`/`StopFailure`/`PreCompact`/`SessionEnd` sends what was appended since (nothing
 * proves a subagent file complete: it can be created after `SubagentStop`, and a prefix still yields
 * a summary) without resolving the subagent again. Usage already proven is sent now, and the
 * offsets keep unchanged requests from being sent again.
 */
async function deriveOrRetain(
  state: TranscriptParseState,
  sessionId: string,
  file: SubagentFile
): Promise<Record<string, unknown>[]> {
  clearDeferred(state, file.agentId);
  const events = await deriveSubagentEvents(state, sessionId, file);
  // Correlation metadata the file did not have yet is filled from its changed content (no scope guess).
  await refreshHead(file);
  const { agentId, filePath, toolUseId, agentType, spawnDepth, description, skillName } = file;
  state.deferredAgentIds = [...new Set([...(state.deferredAgentIds ?? []), agentId])];
  (state.deferredSubagentFiles ??= {})[agentId] = {
    filePath,
    toolUseId,
    agentType,
    spawnDepth,
    description,
    skillName,
    // Settled = the scope is known (proved, or already sent). A subagent left an agent only because the
    // session ended is not: a resumed session resolves it again.
    ...(file.unproven ? {} : { settled: true }),
    promptId: file.promptId || undefined,
    headDone: file.headDone,
    headSize: file.headSize,
  };
  return events;
}

/**
 * The candidate with the scope the registry already knows (a proved skill, or a settled agent): a
 * later partial update — a repeated `SubagentStop` whose evidence is temporarily missing — never
 * overwrites it.
 */
function withKnownScope(state: TranscriptParseState, file: SubagentFile): SubagentFile {
  const known = state.deferredSubagentFiles?.[file.agentId];
  if (!known || (!known.settled && !known.skillName)) return file;
  return {
    ...file,
    toolUseId: file.toolUseId ?? known.toolUseId,
    agentType: file.agentType ?? known.agentType,
    spawnDepth: file.spawnDepth ?? known.spawnDepth,
    description: (known.skillName ? known.description : undefined) || file.description || known.description,
    skillName: known.skillName,
    pending: undefined,
    unproven: undefined,
    settled: known.settled,
    promptId: known.promptId,
    headDone: known.headDone,
    headSize: known.headSize,
  };
}

/** Persist head facts a snapshot learned about a registered file whose offset did not move. */
function syncHead(state: TranscriptParseState, file: SubagentFile): void {
  const entry = state.deferredSubagentFiles?.[file.agentId];
  if (!entry?.settled || file.pending) return;
  entry.promptId = file.promptId || undefined;
  entry.headDone = file.headDone;
  entry.headSize = file.headSize;
}

/** The deferred subagents as file candidates, at the paths their `SubagentStop` reported. */
function deferredCandidates(state: TranscriptParseState): SubagentFile[] {
  return Object.entries(state.deferredSubagentFiles ?? {}).map(([agentId, f]) => ({ agentId, ...f }));
}

/**
 * Derive the usage of subagents whose `SubagentStop` was deferred because they could not yet be
 * told from a skill fork (see `fork-skill.ts`; a scope cannot be corrected once sent). Runs on
 * `Stop`, `StopFailure` and `PreCompact`, when new evidence or usage may have arrived. Pending
 * candidates stay deferred; covered settled candidates stay registered without re-derivation.
 * Registration also survives `SessionEnd`: a resumed session still needs the known scope and
 * nonstandard paths to reconstruct commands and consume later bytes. No-op without registered
 * candidates. A failing subagent is skipped, state intact.
 */
async function settleDeferredSubagents(
  state: TranscriptParseState,
  sessionId: string,
  transcriptPath: string,
  pass: PassSnapshot,
  cwd?: string
): Promise<Record<string, unknown>[]> {
  if (!state.deferredAgentIds?.length) {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  // Same resolution the session summary used in this pass, when there was one (no re-read).
  pass.snapshot ??= await resolveSubagentSnapshot(transcriptPath, { extra: deferredCandidates(state) });
  for (const rawFile of pass.snapshot.files) {
    if (rawFile.pending || !state.deferredAgentIds.includes(rawFile.agentId)) continue;
    const file: SubagentFile = { ...rawFile, cwd };
    syncHead(state, file);
    // Covered by its offset: nothing to send now, but more may still be appended - stay registered.
    if (await subagentAlreadyCovered(state, file)) continue;
    const snapshot = structuredClone(state);
    try {
      events.push(...(await deriveOrRetain(state, sessionId, file)));
    } catch (err) {
      Object.assign(state, snapshot);
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[claude-code-otlp] deferred subagent failed', ...sanitizeLogArgs({ sessionId, agentId: file.agentId, err: msg }));
    }
  }
  return events;
}

/**
 * Open a commit-after-send pass for one `Stop`/`PreCompact`/`StopFailure` hook fire: acquires the
 * per-session lock, loads state, derives in memory via {@link deriveMainEvents}, and returns the
 * events plus a `finalize` that commits only on an accepted send (see the module doc).
 *
 * `envCheck`, when given, diffs against this same already-loaded `state` and appends a fresh
 * `agent.session.env` record to `events` when something changed.
 *
 * On any failure — including a lock-wait timeout — releases whatever lock it holds and returns
 * an empty pass, so the caller still forwards the raw hook event with no `finalize` (existing
 * behaviour: the next hook resumes from the last saved offsets).
 *
 * `PostCompact` never calls this — see {@link openPostCompactPass}.
 */
export async function openMainTranscriptPass(
  sessionId: string,
  transcriptPath: string,
  trigger: MainTranscriptTrigger,
  envCheck?: SessionEnvCheckInput
): Promise<TranscriptPass> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    const pass: PassSnapshot = {};
    const events = await deriveMainEvents(state, sessionId, transcriptPath, trigger, pass);
    // Any pass that reads the main transcript may find the evidence a deferred subagent waits for
    // (also a failed turn, or a compaction): resolved ones are sent, unresolved ones stay deferred.
    // A reopened session with no activity of its own sends nothing (the plugin drops this pass's
    // payload), so it must not consume deferred subagents or the env baseline either: both stay for
    // the first pass after the session is active again.
    const idle = isReopenedIdle(state);
    if (!idle && (trigger === 'Stop' || trigger === 'StopFailure' || trigger === 'PreCompact')) {
      events.push(...(await settleDeferredSubagents(state, sessionId, transcriptPath, pass, envCheck?.cwd)));
    }

    if (envCheck && !idle) {
      const updated = await computeSessionEnvUpdate(state, envCheck);
      if (updated) events.push(buildSessionEnvEvent(sessionId, updated));
    }

    return {
      events,
      finalize: finalizeOf(sessionId, state, release),
      suppressLifecycle: idle,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] main transcript pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
    await release?.();
    return EMPTY_PASS;
  }
}

/**
 * Open the commit-after-send pass for one `PostCompact` hook fire.
 *
 * Unlike every other pass in this module, this one does *not* hold the per-session lock for its
 * whole duration. `PostCompact` can fire before Claude Code has flushed the `compact_boundary`
 * line it reports on (see {@link POST_COMPACT_WAIT_BUDGET_MS}), so waiting for it — up to a full
 * minute — would otherwise stall every sibling hook for the same session (a concurrently-running
 * subagent's `SubagentStop`, or the `Stop` that resumes the turn right after compaction) behind
 * the lock for no reason. Instead:
 *
 * 1. A lock-free peek at the persisted `lastCompactionEnd` marker, then a lock-free
 *    {@link waitForCompactionsToSettle} poll. The poll is incremental — each tick reads only the
 *    bytes appended since the previous one and parses only `compact_boundary` lines — and returns
 *    immediately when the transcript does not exist. It allows a quiet interval after detecting
 *    new boundaries so delayed lines from the same compaction sequence can be collected together.
 * 2. Only once that resolves (found, or the budget ran out) does it acquire the lock — briefly,
 *    like every other pass — reload fresh state, run the normal {@link deriveMainEvents} for
 *    `agent.usage.request`, and re-check for all compactions newer than the now-fresh
 *    `state.lastCompactionEnd` (not reusing the lock-free peek's possibly-stale value). A sibling
 *    hook may have advanced `state.mainOffset` past a boundary line while this was waiting —
 *    harmless, since {@link scanCompactions} never relies on `mainOffset`.
 *
 * The hook entry is also configured `async` (`connectors/claude-code-otlp.ts`) so Claude Code
 * itself never waits on this either.
 */
export async function openPostCompactPass(
  sessionId: string,
  transcriptPath: string,
  waitBudgetMs: number = POST_COMPACT_WAIT_BUDGET_MS
): Promise<TranscriptPass> {
  const peekState = await loadParseState(sessionId);
  const scan = await waitForCompactionsToSettle(
    transcriptPath,
    peekState.lastCompactionEnd,
    waitBudgetMs,
    new Set(Array.isArray(peekState.inheritedUuids) ? peekState.inheritedUuids : [])
  );

  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    const events = await deriveMainEvents(state, sessionId, transcriptPath, 'PostCompact');
    // A reopened session with no activity of its own announces nothing; `lastCompactionEnd` stays
    // put, so a compaction is reported by the first pass after the session is active again.
    if (isReopenedIdle(state)) {
      return { events: [], finalize: finalizeOf(sessionId, state, release) };
    }

    // The parent lookup may only have resolved in the pass above: boundaries collected before that
    // may be copies, so start the scan over with the resolved set.
    const inherited = new Set(Array.isArray(state.inheritedUuids) ? state.inheritedUuids : []);
    if (inherited.size > (scan.excluded?.size ?? 0)) {
      scan.compactions = [];
      scan.offset = 0;
    }
    scan.excluded = inherited;

    // Catch up with anything appended while the lock was being acquired; only the appended bytes
    // are read, so this stays cheap even on a large transcript (and no-ops while it is unchanged).
    await scanCompactions(transcriptPath, scan);
    const boundaries = scan.compactions;
    const newCompactions = boundaries.filter((compaction) =>
      isCompactionNewer(compaction, state.lastCompactionEnd)
    );
    for (const compaction of newCompactions) {
      events.push(buildCompactionDoneEvent(sessionId, compaction));
    }
    if (newCompactions.length > 0) {
      state.lastCompactionEnd = newCompactions[newCompactions.length - 1].end;
    } else if (boundaries.length === 0) {
      logger.warn(
        '[claude-code-otlp] compact_boundary not found after PostCompact wait',
        ...sanitizeLogArgs({ sessionId, waitBudgetMs })
      );
    } else {
      // The transcript has boundary lines, none of them new to this pass — not a missing line but
      // one already accounted for (or unusable, e.g. a boundary with no parseable timestamp). Keep
      // this at debug so a normal repeat PostCompact does not look like a gap.
      logger.debug(
        '[claude-code-otlp] compact_boundary already accounted for; nothing new after PostCompact wait',
        ...sanitizeLogArgs({ sessionId, lastCompactionEnd: state.lastCompactionEnd, boundaries: boundaries.length })
      );
    }

    return { events, finalize: finalizeOf(sessionId, state, release) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] PostCompact pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
    await release?.();
    return EMPTY_PASS;
  }
}

interface SubagentScanResult {
  toolCalls: Record<string, number>;
  toolErrors: Record<string, number>;
  toolResults: number;
  skillsInvoked: Record<string, number>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** True when the file is missing, unreadable, or has no parseable lines — the phantom guard. */
  isEmpty: boolean;
}

/**
 * Recompute one subagent transcript's tool-call/tool-error/tool-result/skill-invocation
 * aggregates and timing span from byte 0 of its own file (the subagent-transcript analogue of
 * {@link buildFullAccumulator}'s "recompute fresh each time" approach — `TranscriptParseState`
 * has no persisted field for any of these either).
 *
 * - `toolCalls`/`toolErrors` reuse {@link collectErrorToolUseIds} for the same `tool_use_id` →
 *   `tool_result.is_error` correlation {@link buildFullAccumulator} uses, but tally into two
 *   parallel `Record<string, number>` maps (not the combined `{calls, errors}` shape
 *   `SessionSummaryAccumulator` uses) to match {@link buildSubagentUsageEvent}'s own
 *   `tool_calls`/`tool_errors` parameter shapes; `toolResults` reuses {@link countToolResults}.
 * - `skillsInvoked` is `extractNamedInvocations(parsedLines).skillInvocations`, taken verbatim.
 * - `startedAt`/`endedAt` are the first/last *timestamped* line via {@link firstTimestamp} (real
 *   subagent transcripts interleave untimestamped lines, e.g. `attachment`, at either end).
 * - `durationMs` is `Date.parse(endedAt) - Date.parse(startedAt)`, guarded by `Number.isFinite`
 *   (covers a missing/unparseable timestamp on either end, and a single-line file) so it is
 *   never `NaN` — falls back to `0`.
 *
 * Never throws: a missing/unreadable file or an empty file both resolve to the emptiest
 * defensible result with `isEmpty: true`; a malformed individual line is skipped rather than
 * aborting the whole scan.
 */
async function scanSubagentTranscript(filePath: string): Promise<SubagentScanResult> {
  const empty: SubagentScanResult = {
    toolCalls: {},
    toolErrors: {},
    toolResults: 0,
    skillsInvoked: {},
    startedAt: '',
    endedAt: '',
    durationMs: 0,
    isEmpty: true,
  };

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return empty;
  }

  const rawLines = raw.split('\n').filter((line) => line.trim().length > 0);
  const allLines: TranscriptLine[] = [];
  for (const line of rawLines) {
    try {
      allLines.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // Skip malformed lines rather than aborting the whole scan.
    }
  }
  const parsedLines = keepFirstByUuid(allLines.filter(isCountedTranscriptLine));

  if (parsedLines.length === 0) {
    return empty;
  }

  const errorByToolUseId = collectErrorToolUseIds(parsedLines);
  const toolCalls: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};

  for (const parsed of parsedLines) {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as ContentBlock[]) {
      if (item?.type !== 'tool_use' || typeof item.name !== 'string') continue;
      toolCalls[item.name] = (toolCalls[item.name] ?? 0) + 1;
      if (typeof item.id === 'string' && errorByToolUseId.has(item.id)) {
        toolErrors[item.name] = (toolErrors[item.name] ?? 0) + 1;
      }
    }
  }

  const toolResults = countToolResults(parsedLines);
  const named = extractNamedInvocations(parsedLines);
  const startedAt = firstTimestamp(parsedLines);
  const endedAt = firstTimestamp([...parsedLines].reverse());
  const diff = Date.parse(endedAt) - Date.parse(startedAt);
  const durationMs = Number.isFinite(diff) ? Math.max(0, diff) : 0;

  return {
    toolCalls,
    toolErrors,
    toolResults,
    skillsInvoked: named.skillInvocations,
    startedAt,
    endedAt,
    durationMs,
    isEmpty: false,
  };
}

/**
 * Whether `state` already covers `subagentFile` — true when a prior pass (that subagent's own
 * `SubagentStop`, or an earlier backstop run) already advanced its persisted offset to the
 * file's current size, so re-scanning would only resend the same cumulative `agent.subagent.usage`
 * event as a duplicate. False whenever that cannot be established (never-seen agent, growth
 * since the last offset, or a file-stat failure) — an extra pass is strictly better than
 * silently dropping one.
 */
async function subagentAlreadyCovered(state: TranscriptParseState, subagentFile: SubagentFile): Promise<boolean> {
  const offset = state.subagentOffsets[subagentFile.agentId];
  if (offset === undefined) {
    return false;
  }
  try {
    const info = await stat(subagentFile.filePath);
    // An empty file at offset 0 has consumed nothing: not covered, so a deferred candidate survives.
    return offset > 0 && info.size === offset;
  } catch {
    return false;
  }
}

/**
 * Derive the spool-bound events for one subagent file, mutating `state` in memory. Does not
 * persist anything — see {@link deriveMainEvents}'s doc for why.
 *
 * - Reads only the lines appended since `state.subagentOffsets[subagentFile.agentId]`
 *   (defaulting to 0 for a never-before-seen agent).
 * - Derives/merges `agent.usage.request` records for those new lines into `state.openRequests`,
 *   scoped `scopeKind: 'agent'`, keyed by `usageRequestKey()` — same merge/key convention
 *   {@link deriveMainEvents} uses for the main transcript.
 * - Returns one `agent.usage.request` JSON string per request key touched by *this* pass (no new
 *   lines means no new events — a no-op reparse returns nothing at this layer).
 * - Also returns one `agent.subagent.usage` event summarizing this agent's *cumulative* usage
 *   (every `scopeKind: 'agent'` record in `state.openRequests` for this `agentId`, not just the
 *   ones touched this pass) plus a fresh full-file tool-call/error/result/skill/timing scan (see
 *   {@link scanSubagentTranscript}) — unless that scan reports `isEmpty` (the file is missing or
 *   has no parseable lines), in which case no `agent.subagent.usage` event is returned at all: a
 *   subagent with no transcript content has nothing real to summarize, so one is never
 *   fabricated with all-zero fields. A re-run with nothing new since the last pass (but a
 *   non-empty file) still returns the event, summarizing unchanged cumulative state, rather than
 *   being skipped — callers that only want to re-run when something changed should check
 *   {@link subagentAlreadyCovered} first.
 */
async function deriveSubagentEvents(
  state: TranscriptParseState,
  sessionId: string,
  subagentFile: SubagentFile
): Promise<Record<string, unknown>[]> {
  const fromOffset = state.subagentOffsets[subagentFile.agentId] ?? 0;
  const { lines, nextOffset } = await readNewLines(subagentFile.filePath, fromOffset);

  const touchedKeys = new Set<string>();
  const agentType = subagentFile.agentType ?? '';
  // A forked skill (EPMCDME-15968: a slash-command skill run as a background subagent) scopes
  // its usage as `scope_kind: 'skill'` / `scope_name: <skillName>`, same as the main transcript's
  // `deriveMainEvents` does for an inline skill (`state.activeSkill`) — a regular subagent keeps
  // `scope_kind: 'agent'` / `scope_name: <agentType>`. `agentId` is kept either way, so the
  // backend's per-agent cost join is unaffected.
  const scopeKind = subagentFile.skillName ? 'skill' : 'agent';
  const scopeName = subagentFile.skillName || agentType;
  for (const line of lines) {
    const parsed = parseUsageLine(line, scopeKind, scopeName, subagentFile.agentId, agentType);
    if (parsed) {
      touchedKeys.add(mergeOpenUsageRequest(state, parsed));
    }
  }
  state.subagentOffsets[subagentFile.agentId] = nextOffset;

  const events: Record<string, unknown>[] = [];
  for (const key of touchedKeys) {
    const request = state.openRequests[key];
    // usageRequestKey isolates API-error rows even when request id and resolved model match a
    // normal request, so suppressing one cannot hide that normal request from downstream.
    if (!request.isApiError) {
      events.push(buildUsageRequestEvent(sessionId, request));
    }
  }

  // Cumulative usage for this agent — every record of its own scope_kind ('skill' for a forked
  // skill, 'agent' otherwise) known for it so far, not just the ones touched this pass
  // (consistent with buildFullAccumulator's own "recomputed from full state" framing for the
  // sibling agent.session.summary event).
  const usageRequestsForAgent = Object.values(state.openRequests).filter(
    (r) => r.scopeKind === scopeKind && r.agentId === subagentFile.agentId && !r.isApiError
  );

  const scan = await scanSubagentTranscript(subagentFile.filePath);
  if (!scan.isEmpty) {
    events.push(
      buildSubagentUsageEvent(
        sessionId,
        subagentFile,
        usageRequestsForAgent,
        scan.toolCalls,
        scan.toolErrors,
        scan.toolResults,
        scan.skillsInvoked,
        scan.startedAt,
        scan.endedAt,
        scan.durationMs
      )
    );
  }

  return events;
}

/**
 * Open a commit-after-send pass for one `SubagentStop` hook fire. Same acquire/derive/finalize
 * shape as {@link openMainTranscriptPass}, for {@link deriveSubagentEvents}, with the same
 * optional `envCheck` folding.
 */
export async function openSubagentPass(
  sessionId: string,
  subagentFile: SubagentFile,
  envCheck?: SessionEnvCheckInput
): Promise<TranscriptPass> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    // A subagent that may still prove to be a skill fork sends nothing yet: the backend keeps the
    // max() of scope_kind/scope_name per request, so a wrong first scope could not be fixed later.
    let events: Record<string, unknown>[] = [];
    const incoming = withKnownScope(state, subagentFile);
    if (incoming.pending) {
      state.deferredAgentIds = [...new Set([...(state.deferredAgentIds ?? []), incoming.agentId])];
      const { agentId, filePath, toolUseId, agentType, spawnDepth, description } = incoming;
      (state.deferredSubagentFiles ??= {})[agentId] = { filePath, toolUseId, agentType, spawnDepth, description };
    } else {
      // A resolved stop (also a later one of a subagent deferred before) is derived now; if its file
      // has no content yet the candidate stays deferred (with its positive evidence) until it does.
      events = await deriveOrRetain(state, sessionId, incoming);
    }

    if (envCheck) {
      const updated = await computeSessionEnvUpdate(state, envCheck);
      if (updated) events.push(buildSessionEnvEvent(sessionId, updated));
    }

    return { events, finalize: finalizeOf(sessionId, state, release) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] subagent transcript pass failed', ...sanitizeLogArgs({ sessionId, agentId: subagentFile.agentId, err: msg }));
    await release?.();
    return EMPTY_PASS;
  }
}

export interface SessionEndPass extends TranscriptPass {
  /** `TranscriptParseState.gitHeadStart`/`sessionStartedAt`, read back from the same locked load
   *  above — `agent.git.snapshot`'s inputs, written once at `SessionStart` by
   *  {@link openSessionStartPass}. `''` on a failed/empty pass, same as every other field here. */
  gitHeadStart: string;
  sessionStartedAt: string;
}

const EMPTY_SESSION_END_PASS: SessionEndPass = { ...EMPTY_PASS, gitHeadStart: '', sessionStartedAt: '' };

/**
 * Open a commit-after-send pass for one `SessionEnd` hook fire: the main transcript plus the
 * backstop scan over every subagent file discovered for this session (`findSubagentFiles()`),
 * all against **one** in-memory `state` under **one** lock acquisition (so there is exactly one
 * save at the end, instead of one per collector as a loop of separate passes would do).
 *
 * `api_calls` (computed from `scopeKind: 'main' | 'skill'` records with an empty `agentId`) is
 * never inflated by a subagent's records, including a forked skill's own `scopeKind: 'skill'`
 * ones — see the `agentId` guard in {@link deriveMainEvents}. A subagent whose offset already
 * covers its file ({@link subagentAlreadyCovered}) is skipped — its own `SubagentStop` (or an
 * earlier backstop run) already reported it. Sharing one `state` across subagents loses the
 * per-collector isolation separate passes would give it, so each subagent derivation first
 * snapshots `state` and restores it if that one subagent throws — a failing subagent can never
 * leave `openRequests`/`subagentOffsets` half-mutated and committed, but it also never blocks the
 * other subagents or the main events already derived. `envCheck` is folded in the same way as
 * {@link openMainTranscriptPass}.
 */
export async function openSessionEndPass(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  envCheck?: SessionEnvCheckInput
): Promise<SessionEndPass> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    const pass: PassSnapshot = {};
    const events = await deriveMainEvents(state, sessionId, transcriptPath, 'SessionEnd', pass);

    // End of the session: nothing more will arrive, so a subagent still unproven is an agent. The
    // summary above resolved the same candidates with the same `final`: reuse it.
    // A reopened session with no activity of its own sends nothing at all (the plugin drops this
    // pass's payload), so the backstop must not consume subagent state or the env baseline either:
    // they stay for the first pass after the session is active again.
    const idle = isReopenedIdle(state);
    pass.snapshot ??= await resolveSubagentSnapshot(transcriptPath, {
      final: true,
      extra: deferredCandidates(state),
    });
    for (const rawFile of idle ? [] : pass.snapshot.files) {
      // The sidecar carries no cwd/worktree of its own — the SessionEnd hook's cwd is the best
      // available stand-in (subagents share their parent session's cwd).
      const file: SubagentFile = { ...rawFile, cwd };
      syncHead(state, file);
      if (await subagentAlreadyCovered(state, file)) {
        continue;
      }
      const snapshot = structuredClone(state);
      try {
        events.push(...(await deriveOrRetain(state, sessionId, file)));
      } catch (err) {
        Object.assign(state, snapshot);
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug('[claude-code-otlp] SessionEnd subagent backstop failed', ...sanitizeLogArgs({ sessionId, agentId: file.agentId, err: msg }));
      }
    }

    if (envCheck && !idle) {
      const updated = await computeSessionEnvUpdate(state, envCheck);
      if (updated) events.push(buildSessionEnvEvent(sessionId, updated));
    }

    return {
      events,
      finalize: finalizeOf(sessionId, state, release),
      gitHeadStart: state.gitHeadStart,
      sessionStartedAt: state.sessionStartedAt,
      suppressLifecycle: idle,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] SessionEnd pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
    await release?.();
    return EMPTY_SESSION_END_PASS;
  }
}
