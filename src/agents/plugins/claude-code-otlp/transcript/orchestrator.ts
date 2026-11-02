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
import { sanitizeLogArgs } from '@/utils/security.js';
import {
  acquireParseStateLock,
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
  latestTitle,
  type Compaction,
  type SignalLine,
} from './session-signals.js';
import { type SubagentFile, buildSubagentUsageEvent, findSubagentFiles } from './subagent-usage.js';

// Re-exported so callers (e.g. claude-code-otlp.plugin.ts) can import both `SubagentFile` and
// the pass openers from this one module.
export type { SubagentFile };

export type MainTranscriptTrigger = 'Stop' | 'PreCompact' | 'SessionEnd' | 'StopFailure';
type MainTranscriptDerivationTrigger = MainTranscriptTrigger | 'PostCompact';

/** One hook invocation's derived events, with the deferred commit described above. */
export interface TranscriptPass {
  events: Record<string, unknown>[];
  finalize: (accepted: boolean) => Promise<void>;
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
      boundaryLines.push(JSON.parse(line) as SignalLine);
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
  waitBudgetMs: number
): Promise<CompactionScan> {
  const scan: CompactionScan = { compactions: [], offset: 0 };
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

/**
 * Whether `parsed` is a genuine new user turn (a real prompt, not a line carrying only
 * `tool_result` blocks) — the same criteria `session-signals.ts`'s `countTurns` uses.
 */
function isGenuineUserTurn(parsed: TranscriptLine): boolean {
  if (parsed.type !== 'user' || parsed.isMeta || parsed.isSidechain || parsed.isCompactSummary) {
    return false;
  }
  const content = parsed.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((block) => (block as { type?: unknown } | null)?.type === 'text');
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
async function buildFullAccumulator(transcriptPath: string): Promise<{
  acc: SessionSummaryAccumulator;
  named: NamedInvocationCounts;
  startedAt: string;
  endedAt: string;
}> {
  const acc = emptyAccumulator();

  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf-8');
  } catch {
    return { acc, named: extractOrderedNamedInvocations([]), startedAt: '', endedAt: '' };
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

  const named = extractOrderedNamedInvocations(parsedLines);
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

  return { acc, named, startedAt, endedAt };
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
  trigger: MainTranscriptDerivationTrigger
): Promise<Record<string, unknown>[]> {
  const { lines, nextOffset } = await readNewLines(transcriptPath, state.mainOffset);

  const events: Record<string, unknown>[] = [];
  const touchedKeys = new Set<string>();
  const seeded = Array.isArray(state.seenMessageUuids)
    ? new Set<string>(state.seenMessageUuids)
    : await seedSeenUuids(transcriptPath, state.mainOffset);
  const seenUuids = seeded ?? new Set<string>();
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

  for (const key of touchedKeys) {
    const request = state.openRequests[key];
    // usageRequestKey isolates API-error rows even when request id and resolved model match a
    // normal request, so suppressing one cannot hide that normal request from downstream.
    if (!request.isApiError) {
      events.push(buildUsageRequestEvent(sessionId, request));
    }
  }

  if (trigger === 'Stop' || trigger === 'SessionEnd') {
    const { acc, named, startedAt, endedAt } = await buildFullAccumulator(transcriptPath);
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
  sessionEnvFields: SessionEnvFields
): Promise<SessionStartPass> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
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
    state.lastSessionEnvFields = merged;
    return {
      events: [],
      finalize: finalizeOf(sessionId, state, release),
      sessionEnvFields: merged,
      gitHeadStart: state.gitHeadStart,
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
    const candidate = await computeSessionEnvUpdate(state, input);

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
    const events = await deriveMainEvents(state, sessionId, transcriptPath, trigger);

    if (envCheck) {
      const updated = await computeSessionEnvUpdate(state, envCheck);
      if (updated) events.push(buildSessionEnvEvent(sessionId, updated));
    }

    return { events, finalize: finalizeOf(sessionId, state, release) };
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
  const scan = await waitForCompactionsToSettle(transcriptPath, peekState.lastCompactionEnd, waitBudgetMs);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    const events = await deriveMainEvents(state, sessionId, transcriptPath, 'PostCompact');

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
    return info.size === offset;
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
    const events = await deriveSubagentEvents(state, sessionId, subagentFile);

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
    const events = await deriveMainEvents(state, sessionId, transcriptPath, 'SessionEnd');

    const subagentFiles = await findSubagentFiles(transcriptPath);
    for (const rawFile of subagentFiles) {
      // The sidecar carries no cwd/worktree of its own — the SessionEnd hook's cwd is the best
      // available stand-in (subagents share their parent session's cwd).
      const file: SubagentFile = { ...rawFile, cwd };
      if (await subagentAlreadyCovered(state, file)) {
        continue;
      }
      const snapshot = structuredClone(state);
      try {
        events.push(...(await deriveSubagentEvents(state, sessionId, file)));
      } catch (err) {
        Object.assign(state, snapshot);
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug('[claude-code-otlp] SessionEnd subagent backstop failed', ...sanitizeLogArgs({ sessionId, agentId: file.agentId, err: msg }));
      }
    }

    if (envCheck) {
      const updated = await computeSessionEnvUpdate(state, envCheck);
      if (updated) events.push(buildSessionEnvEvent(sessionId, updated));
    }

    return {
      events,
      finalize: finalizeOf(sessionId, state, release),
      gitHeadStart: state.gitHeadStart,
      sessionStartedAt: state.sessionStartedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] SessionEnd pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
    await release?.();
    return EMPTY_SESSION_END_PASS;
  }
}
