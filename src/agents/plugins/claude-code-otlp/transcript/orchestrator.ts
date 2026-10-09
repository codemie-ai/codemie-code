/**
 * Main-transcript trigger orchestration for the `Stop`, `PreCompact`, `SessionEnd`, and
 * `StopFailure` hook events.
 *
 * Each hook fire is a fresh CLI process, so this module reloads persisted parse state
 * (`./parse-state.js`), reads only the transcript lines appended since the last
 * persisted `mainOffset` (`./transcript-reader.js`), derives/merges
 * `agent.usage.request` records for those new lines (`./usage-request.js`), persists
 * state back, and RETURNS one JSON string per completed request plus (on `Stop`/`SessionEnd`)
 * one `agent.session.summary` event (`Stop`/`SessionEnd` only) — it never forwards anything to
 * the spool itself. The caller
 * (the plugin's `processOtlpEvent`, via its per-event handlers) owns forwarding, so there is
 * exactly one place in the whole analytics pipeline that writes to the spool.
 *
 * Never throws: every path is wrapped so a read/parse failure degrades to an empty result rather
 * than interrupting the hook that triggered it (`processOtlpEvent` must never block or fail on
 * this).
 */

import { readFile, stat } from 'node:fs/promises';
import { loadParseState, saveParseState, withParseStateLock } from './parse-state.js';
import { readNewLines } from './transcript-reader.js';
import { parseUsageLine, mergeUsageRequest, buildUsageRequestEvent } from './usage-request.js';
import {
  updateBranchCounts,
  buildSessionSummaryEvent,
  type SessionSummaryAccumulator,
  type NamedInvocationCounts,
} from './session-summary.js';
import { extractNamedInvocations } from '@/agents/plugins/claude/session/claude-named-invocations.js';
import { type SubagentFile, buildSubagentUsageEvent } from './subagent-usage.js';

// Re-exported so callers (e.g. claude-code-otlp.plugin.ts) can import both `SubagentFile` and
// `collectSubagentTranscriptEvents` from this one module.
export type { SubagentFile };

export type MainTranscriptTrigger = 'Stop' | 'PreCompact' | 'SessionEnd' | 'StopFailure';

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  isError?: boolean;
  input?: { file_path?: unknown; path?: unknown };
}

interface TranscriptLine {
  timestamp?: string;
  gitBranch?: string;
  message?: { content?: unknown };
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
    compactionCount: 0,
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
 * - Lines added/removed are not computed — an `Edit`/`Write` tool_use's `input` carries the
 *   *proposed* edit, not a diff stat — so the event builder sends them as `null`, never `0`.
 * - `compactionCount` defaults to 0 — no verified in-transcript signal was found (`PreCompact` is
 *   a hook event, not a transcript line).
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
    return { acc, named: extractNamedInvocations([]), startedAt: '', endedAt: '' };
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
  // `${requestId}::${model}` key `state.openRequests` uses before counting.
  const modelByRequestKey = new Map<string, string>();
  for (const line of rawLines) {
    const parsedUsage = parseUsageLine(line, 'main', '', '');
    if (parsedUsage) {
      modelByRequestKey.set(`${parsedUsage.requestId}::${parsedUsage.model}`, parsedUsage.model);
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

      const filePath = item.input?.file_path ?? item.input?.path;
      if (typeof filePath === 'string' && filePath) {
        if (item.name === 'Write') acc.filesWritten.add(filePath);
        if (item.name === 'Edit') acc.filesEdited.add(filePath);
      }
    }
  }

  const named = extractNamedInvocations(parsedLines);
  // Real transcripts interleave non-message lines (file-history-snapshot, cost-state, ...)
  // without a `timestamp`, including at index 0/length-1 — so the first/last *timestamped*
  // line is used, not literally the first/last line.
  const startedAt = firstTimestamp(parsedLines);
  const endedAt = firstTimestamp([...parsedLines].reverse());

  return { acc, named, startedAt, endedAt };
}

/**
 * Collect the spool-bound events for one `Stop`/`PreCompact`/`SessionEnd`/`StopFailure` hook fire.
 *
 * - Loads persisted state, reads only the lines appended since `state.mainOffset`.
 * - Derives/merges `agent.usage.request` records for those new lines into `state.openRequests`,
 *   keyed by `${requestId}::${model}` (matching `parse-state.ts`'s documented key shape), and
 *   updates `state.branchCounts` from every new line's `gitBranch` (regardless of whether that
 *   line carried usage).
 * - Returns one `agent.usage.request` JSON string per request key touched by this pass.
 * - On `Stop`/`SessionEnd` only, also returns exactly one `agent.session.summary` event
 *   (`phase: 'incremental'` on `Stop`, `'final'` on `SessionEnd`) built from a fresh full-file
 *   recompute (see {@link buildFullAccumulator}). `PreCompact`/`StopFailure` never return a
 *   summary.
 * - Persists state back to disk.
 *
 * Never forwards anything itself — the caller is responsible for sending the returned events to
 * the spool (exactly one place in the pipeline does that).
 *
 * Scoping: no reliable transcript signal marks a *main*-transcript turn entering/exiting a
 * "skill context", so every main-transcript usage record is scoped `scopeKind: 'main'`,
 * `scopeName: ''`. `state.activeSkill` is deliberately neither read nor written.
 *
 * Swallows every error internally — never throws into `processOtlpEvent`.
 */
export async function collectMainTranscriptEvents(
  sessionId: string,
  transcriptPath: string,
  trigger: MainTranscriptTrigger
): Promise<Record<string, unknown>[]> {
  try {
    // Both the load and the save happen inside the lock so a concurrent hook process for the
    // same session can never read a state this pass is about to overwrite.
    return await withParseStateLock(sessionId, async () => {
      const state = await loadParseState(sessionId);
      const { lines, nextOffset } = await readNewLines(transcriptPath, state.mainOffset);

      const touchedKeys = new Set<string>();
      for (const line of lines) {
        let rawGitBranch = '';
        try {
          rawGitBranch = (JSON.parse(line) as { gitBranch?: string })?.gitBranch ?? '';
        } catch {
          // Malformed line: still attempt usage parsing below (which has its own try/catch), but
          // there is no branch to record from it.
        }
        if (rawGitBranch) {
          updateBranchCounts(state.branchCounts, rawGitBranch);
        }

        const parsed = parseUsageLine(line, 'main', '', '');
        if (parsed) {
          const key = `${parsed.requestId}::${parsed.model}`;
          const existing = state.openRequests[key];
          state.openRequests[key] = existing ? mergeUsageRequest(existing, parsed) : parsed;
          touchedKeys.add(key);
        }
      }
      state.mainOffset = nextOffset;

      if (trigger === 'PreCompact') {
        state.compactionCount += 1;
      }

      const events: Record<string, unknown>[] = [];
      for (const key of touchedKeys) {
        events.push(buildUsageRequestEvent(sessionId, state.openRequests[key]));
      }

      if (trigger === 'Stop' || trigger === 'SessionEnd') {
        const { acc, named, startedAt, endedAt } = await buildFullAccumulator(transcriptPath);
        acc.compactionCount = state.compactionCount;
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
        // Main-thread requests only — the contract's api_calls excludes subagent requests.
        summaryEvent.api_calls = Object.values(state.openRequests).filter(
          (r) => r.scopeKind === 'main'
        ).length;
        events.push(summaryEvent);
      }

      await saveParseState(sessionId, state);
      return events;
    });
  } catch {
    // Swallow everything — never throw into processOtlpEvent.
    return [];
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
 * Whether the `SessionEnd` backstop still needs to (re)process `subagentFile`.
 *
 * False when a prior pass (that subagent's own `SubagentStop`, or an earlier backstop run)
 * already advanced its persisted offset to the file's current size — nothing was appended since,
 * so re-scanning would only resend the same cumulative `agent.subagent.usage` event as a
 * duplicate. True whenever that cannot be established (never-seen agent, growth since the last
 * offset, or a state/file read failure) — an extra pass is strictly better than silently dropping
 * one.
 */
export async function subagentNeedsBackstop(sessionId: string, subagentFile: SubagentFile): Promise<boolean> {
  try {
    const state = await loadParseState(sessionId);
    const offset = state.subagentOffsets[subagentFile.agentId];
    if (offset === undefined) {
      return true;
    }
    const info = await stat(subagentFile.filePath);
    return info.size !== offset;
  } catch {
    return true;
  }
}

/**
 * Collect the spool-bound events for one `SubagentStop` hook fire, or for one subagent file
 * discovered by the `SessionEnd` backstop scan (`findSubagentFiles()`).
 *
 * - Loads persisted state, reads only the lines appended since
 *   `state.subagentOffsets[subagentFile.agentId]` (defaulting to 0 for a never-before-seen
 *   agent).
 * - Derives/merges `agent.usage.request` records for those new lines into `state.openRequests`,
 *   scoped `scopeKind: 'agent'`, keyed by `${requestId}::${model}` — same merge/key convention
 *   `collectMainTranscriptEvents` uses for the main transcript.
 * - Returns one `agent.usage.request` JSON string per request key touched by *this* pass (no new
 *   lines means no new events — a no-op reparse returns nothing at this layer).
 * - Also returns one `agent.subagent.usage` event summarizing this agent's *cumulative* usage
 *   (every `scopeKind: 'agent'` record in `state.openRequests` for this `agentId`, not just the
 *   ones touched this pass) plus a fresh full-file tool-call/error/result/skill/timing scan (see
 *   {@link scanSubagentTranscript}) — unless that scan reports `isEmpty` (the file is missing or
 *   has no parseable lines), in which case no `agent.subagent.usage` event is returned at all:
 *   a subagent with no transcript content has nothing real to summarize, so one is never
 *   fabricated with all-zero fields. A re-run with nothing new since the last pass (but a
 *   non-empty file) still returns the event, summarizing unchanged cumulative state, rather than
 *   being skipped — callers that only want to re-run when something changed should check
 *   {@link subagentNeedsBackstop} first.
 * - Persists the updated `subagentOffsets[subagentFile.agentId]` (and `openRequests`) back to
 *   disk.
 *
 * Never forwards anything itself — the caller is responsible for sending the returned events to
 * the spool (exactly one place in the pipeline does that).
 *
 * Swallows every error internally — never throws into `processOtlpEvent`.
 */
export async function collectSubagentTranscriptEvents(
  sessionId: string,
  subagentFile: SubagentFile
): Promise<Record<string, unknown>[]> {
  try {
    // Load/mutate/save inside the lock — same rationale as collectMainTranscriptEvents: a sibling
    // SubagentStop for another subagent in this same session must never read state this pass is
    // about to overwrite.
    return await withParseStateLock(sessionId, async () => {
      const state = await loadParseState(sessionId);
      const fromOffset = state.subagentOffsets[subagentFile.agentId] ?? 0;
      const { lines, nextOffset } = await readNewLines(subagentFile.filePath, fromOffset);

      const touchedKeys = new Set<string>();
      for (const line of lines) {
        const parsed = parseUsageLine(line, 'agent', '', subagentFile.agentId);
        if (parsed) {
          const key = `${parsed.requestId}::${parsed.model}`;
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

      await saveParseState(sessionId, state);
      return events;
    });
  } catch {
    // Swallow everything — never throw into processOtlpEvent.
    return [];
  }
}
