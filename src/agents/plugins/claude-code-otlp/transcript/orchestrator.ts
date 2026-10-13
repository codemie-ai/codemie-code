/**
 * Main-transcript trigger orchestration for the `Stop`, `PreCompact`, `SessionEnd`, and
 * `StopFailure` hook events.
 *
 * Each hook fire is a fresh CLI process, so this module reloads persisted parse state
 * (`./parse-state.js`), reads only the transcript lines appended since the last persisted
 * `mainOffset` (`./transcript-reader.js`), derives/merges `agent.usage.request` records for
 * those new lines (`./usage-request.js`), and returns one JSON string per completed request
 * plus (on `Stop`/`SessionEnd`) one `agent.session.summary` event.
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
import { acquireParseStateLock, loadParseState, saveParseState, type TranscriptParseState } from './parse-state.js';
import { readNewLines } from './transcript-reader.js';
import { parseUsageLine, mergeUsageRequest, buildUsageRequestEvent, usageRequestKey } from './usage-request.js';
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
import {
  collectClientVersions,
  collectCompactions,
  collectEditLineStats,
  countTurns,
  latestTitle,
  type SignalLine,
} from './session-signals.js';
import { type SubagentFile, buildSubagentUsageEvent, findSubagentFiles } from './subagent-usage.js';

// Re-exported so callers (e.g. claude-code-otlp.plugin.ts) can import both `SubagentFile` and
// the pass openers from this one module.
export type { SubagentFile };

export type MainTranscriptTrigger = 'Stop' | 'PreCompact' | 'SessionEnd' | 'StopFailure';

/** One hook invocation's derived events, with the deferred commit described above. */
export interface TranscriptPass {
  events: Record<string, unknown>[];
  finalize: (accepted: boolean) => Promise<void>;
}

const EMPTY_PASS: TranscriptPass = { events: [], finalize: async () => {} };

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
  const parsedLines: TranscriptLine[] = [];

  for (const line of rawLines) {
    try {
      parsedLines.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // Skip malformed lines rather than aborting the whole scan.
    }
  }

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
      modelByRequestKey.set(usageRequestKey(parsedUsage), parsedUsage.model);
    }
  }
  for (const model of modelByRequestKey.values()) {
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
 * Derive the spool-bound events for one `Stop`/`PreCompact`/`SessionEnd`/`StopFailure` hook fire,
 * mutating `state` in memory. Does not persist anything — the caller (a pass opener below) owns
 * the commit, so several passes can share one in-memory `state` under one lock (see
 * `openSessionEndPass`).
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
 * Scoping: `state.activeSkill` tracks which skill (if any) the main transcript is currently
 * "inside" — set to a skill's name when a `Skill` tool_use invokes it ({@link findSkillInvocation},
 * applied *after* scoping that same line's own usage record, since the invoking turn itself still
 * belongs to whatever was active before it), and cleared on the next genuine new user turn
 * ({@link isGenuineUserTurn}) — a fresh prompt is treated as leaving any skill context the
 * previous turn's work was under. Every usage record is scoped `scopeKind: 'skill'`,
 * `scopeName: state.activeSkill` while a skill is active, else `scopeKind: 'main'`, `scopeName: ''`.
 * This is a heuristic, not a tracked boundary Claude Code itself reports — a skill whose work
 * spans multiple turns without an intervening user prompt is scoped as one continuous span.
 */
async function deriveMainEvents(
  state: TranscriptParseState,
  sessionId: string,
  transcriptPath: string,
  trigger: MainTranscriptTrigger
): Promise<Record<string, unknown>[]> {
  const { lines, nextOffset } = await readNewLines(transcriptPath, state.mainOffset);

  const touchedKeys = new Set<string>();
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
    // The contract's branch counts are user lines per branch.
    if (rawGitBranch && isUserLine) {
      updateBranchCounts(state.branchCounts, rawGitBranch);
    }

    if (head && isGenuineUserTurn(head)) {
      state.activeSkill = '';
    }

    const scopeKind = state.activeSkill ? 'skill' : 'main';
    const parsed = parseUsageLine(line, scopeKind, state.activeSkill, '', '');
    if (parsed) {
      const key = usageRequestKey(parsed);
      const existing = state.openRequests[key];
      state.openRequests[key] = existing ? mergeUsageRequest(existing, parsed) : parsed;
      touchedKeys.add(key);
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

  const events: Record<string, unknown>[] = [];
  for (const key of touchedKeys) {
    events.push(buildUsageRequestEvent(sessionId, state.openRequests[key]));
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
    // Main-thread requests — 'main' and 'skill' are both made on the main thread; the
    // contract's api_calls excludes only subagent ('agent') requests.
    summaryEvent.api_calls = Object.values(state.openRequests).filter(
      (r) => r.scopeKind === 'main' || r.scopeKind === 'skill'
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

/**
 * Open a commit-after-send pass for one `Stop`/`PreCompact`/`StopFailure` hook fire: acquires the
 * per-session lock, loads state, derives in memory via {@link deriveMainEvents}, and returns the
 * events plus a `finalize` that commits only on an accepted send (see the module doc).
 *
 * On any failure — including a lock-wait timeout — releases whatever lock it holds and returns
 * an empty pass, so the caller still forwards the raw hook event with no `finalize` (existing
 * behaviour: the next hook resumes from the last saved offsets).
 */
export async function openMainTranscriptPass(
  sessionId: string,
  transcriptPath: string,
  trigger: MainTranscriptTrigger
): Promise<TranscriptPass> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    const events = await deriveMainEvents(state, sessionId, transcriptPath, trigger);
    return { events, finalize: finalizeOf(sessionId, state, release) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] main transcript pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
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
  const parsedLines: TranscriptLine[] = [];
  for (const line of rawLines) {
    try {
      parsedLines.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // Skip malformed lines rather than aborting the whole scan.
    }
  }

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
  for (const line of lines) {
    // Contract: for `scope_kind: 'agent'`, `scope_name` carries the agent type (never `''` unless
    // the type itself is unresolved) — same source as the `agent_type` field below.
    const parsed = parseUsageLine(line, 'agent', agentType, subagentFile.agentId, agentType);
    if (parsed) {
      const key = usageRequestKey(parsed);
      const existing = state.openRequests[key];
      state.openRequests[key] = existing ? mergeUsageRequest(existing, parsed) : parsed;
      touchedKeys.add(key);
    }
  }
  state.subagentOffsets[subagentFile.agentId] = nextOffset;

  const events: Record<string, unknown>[] = [];
  for (const key of touchedKeys) {
    events.push(buildUsageRequestEvent(sessionId, state.openRequests[key]));
  }

  // Cumulative usage for this agent — every scope_kind:'agent' record known for it so far,
  // not just the ones touched this pass (consistent with buildFullAccumulator's own
  // "recomputed from full state" framing for the sibling agent.session.summary event).
  const usageRequestsForAgent = Object.values(state.openRequests).filter(
    (r) => r.scopeKind === 'agent' && r.agentId === subagentFile.agentId
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
 * shape as {@link openMainTranscriptPass}, for {@link deriveSubagentEvents}.
 */
export async function openSubagentPass(sessionId: string, subagentFile: SubagentFile): Promise<TranscriptPass> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireParseStateLock(sessionId);
    const state = await loadParseState(sessionId);
    const events = await deriveSubagentEvents(state, sessionId, subagentFile);
    return { events, finalize: finalizeOf(sessionId, state, release) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] subagent transcript pass failed', ...sanitizeLogArgs({ sessionId, agentId: subagentFile.agentId, err: msg }));
    await release?.();
    return EMPTY_PASS;
  }
}

/**
 * Open a commit-after-send pass for one `SessionEnd` hook fire: the main transcript plus the
 * backstop scan over every subagent file discovered for this session (`findSubagentFiles()`),
 * all against **one** in-memory `state` under **one** lock acquisition (so there is exactly one
 * save at the end, instead of one per collector as a loop of separate passes would do).
 *
 * The main transcript is derived first, so `api_calls` (computed from `scopeKind: 'main' | 'skill'`
 * records) can never be inflated by a subagent's records. A subagent whose offset already
 * covers its file ({@link subagentAlreadyCovered}) is skipped — its own `SubagentStop` (or an
 * earlier backstop run) already reported it. Sharing one `state` across subagents loses the
 * per-collector isolation separate passes would give it, so each subagent derivation first
 * snapshots `state` and restores it if that one subagent throws — a failing subagent can never
 * leave `openRequests`/`subagentOffsets` half-mutated and committed, but it also never blocks the
 * other subagents or the main events already derived.
 */
export async function openSessionEndPass(
  sessionId: string,
  transcriptPath: string,
  cwd: string
): Promise<TranscriptPass> {
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

    return { events, finalize: finalizeOf(sessionId, state, release) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('[claude-code-otlp] SessionEnd pass failed', ...sanitizeLogArgs({ sessionId, err: msg }));
    await release?.();
    return EMPTY_PASS;
  }
}
