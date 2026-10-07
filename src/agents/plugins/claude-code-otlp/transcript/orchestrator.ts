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

import { readFile } from 'node:fs/promises';
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

function emptyAccumulator(): SessionSummaryAccumulator {
  return {
    models: {},
    toolCalls: {},
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: new Set<string>(),
    filesWritten: new Set<string>(),
    compactionCount: 0,
  };
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
 * - `linesAdded`/`linesRemoved` default to 0 — an `Edit`/`Write` tool_use's `input` carries the
 *   *proposed* edit, not a diff stat, so no reliable added/removed line count can be derived from
 *   it without re-implementing diffing.
 * - `compactionCount` defaults to 0 — no verified in-transcript signal was found (`PreCompact` is
 *   a hook event, not a transcript line).
 */
async function buildFullAccumulator(
  transcriptPath: string
): Promise<{ acc: SessionSummaryAccumulator; named: NamedInvocationCounts; startedAt: string }> {
  const acc = emptyAccumulator();

  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf-8');
  } catch {
    return { acc, named: extractNamedInvocations([]), startedAt: '' };
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

  // Pass 2: models (reusing parseUsageLine's own model-resolution logic).
  for (const line of rawLines) {
    const parsedUsage = parseUsageLine(line, 'main', '', '');
    if (parsedUsage) {
      acc.models[parsedUsage.model] = (acc.models[parsedUsage.model] ?? 0) + 1;
    }
  }

  // Pass 3: tool calls/errors, files changed/written (Edit/Write tool_use payloads).
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
        if (item.name === 'Edit') acc.filesChanged.add(filePath);
      }
    }
  }

  const named = extractNamedInvocations(parsedLines);
  const startedAt = parsedLines.length > 0 ? String(parsedLines[0].timestamp ?? '') : '';

  return { acc, named, startedAt };
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
        const { acc, named, startedAt } = await buildFullAccumulator(transcriptPath);
        acc.compactionCount = state.compactionCount;
        const phase = trigger === 'SessionEnd' ? 'final' : 'incremental';
        const endedAt = trigger === 'SessionEnd' ? new Date().toISOString() : undefined;
        const summaryEvent = buildSessionSummaryEvent(
          sessionId,
          phase,
          acc,
          named,
          state.branchCounts,
          startedAt,
          endedAt
        );
        // Not yet carried by any input to buildSessionSummaryEvent (session-summary.ts's own
        // docstring defers it to this caller) — this is the full set of agent.usage.request
        // records derived for this session so far, main- and agent-scoped alike.
        summaryEvent.api_calls = Object.keys(state.openRequests).length;
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
  skillsInvoked: Record<string, number>;
  startedAt: string;
  durationMs: number;
}

/**
 * Recompute one subagent transcript's tool-call/tool-error/skill-invocation aggregates and
 * timing span from byte 0 of its own file (the subagent-transcript analogue of
 * {@link buildFullAccumulator}'s "recompute fresh each time" approach — `TranscriptParseState`
 * has no persisted field for any of these either).
 *
 * - `toolCalls`/`toolErrors` reuse {@link collectErrorToolUseIds} for the same `tool_use_id` →
 *   `tool_result.is_error` correlation {@link buildFullAccumulator} uses, but tally into two
 *   parallel `Record<string, number>` maps (not the combined `{calls, errors}` shape
 *   `SessionSummaryAccumulator` uses) to match {@link buildSubagentUsageEvent}'s own
 *   `tool_calls`/`tool_errors` parameter shapes.
 * - `skillsInvoked` is `extractNamedInvocations(parsedLines).skillInvocations`, taken verbatim.
 * - `startedAt` is the first parsed line's `timestamp`, or `''` when the file is empty/unreadable.
 * - `durationMs` is `Date.parse(lastLine.timestamp) - Date.parse(firstLine.timestamp)`, guarded by
 *   `Number.isFinite` (covers a missing/unparseable timestamp on either end, and a single-line
 *   file) so it is never `NaN` — falls back to `0`.
 *
 * Never throws: a missing/unreadable file or an empty file both resolve to the emptiest
 * defensible result; a malformed individual line is skipped rather than aborting the whole scan.
 */
async function scanSubagentTranscript(filePath: string): Promise<SubagentScanResult> {
  const empty: SubagentScanResult = {
    toolCalls: {},
    toolErrors: {},
    skillsInvoked: {},
    startedAt: '',
    durationMs: 0,
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

  const named = extractNamedInvocations(parsedLines);
  const startedAt = String(parsedLines[0].timestamp ?? '');
  const lastTimestamp = String(parsedLines[parsedLines.length - 1].timestamp ?? '');
  const diff = Date.parse(lastTimestamp) - Date.parse(startedAt);
  const durationMs = Number.isFinite(diff) ? Math.max(0, diff) : 0;

  return { toolCalls, toolErrors, skillsInvoked: named.skillInvocations, startedAt, durationMs };
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
 * - Unconditionally also returns exactly one `agent.subagent.usage` event summarizing this
 *   agent's *cumulative* usage (every `scopeKind: 'agent'` record in `state.openRequests` for
 *   this `agentId`, not just the ones touched this pass) plus a fresh full-file
 *   tool-call/error/skill/timing scan (see {@link scanSubagentTranscript}) — this is deliberate:
 *   the `SessionEnd` backstop's whole purpose is to guarantee every subagent gets at least one
 *   `agent.subagent.usage` event even when its own `SubagentStop` hook never fired, so a
 *   re-run with nothing new since the last pass still returns one (summarizing unchanged
 *   cumulative state), rather than being skipped.
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

      const { toolCalls, toolErrors, skillsInvoked, startedAt, durationMs } =
        await scanSubagentTranscript(subagentFile.filePath);

      const subagentEvent = buildSubagentUsageEvent(
        sessionId,
        subagentFile,
        usageRequestsForAgent,
        toolCalls,
        toolErrors,
        skillsInvoked,
        startedAt,
        durationMs
      );
      events.push(subagentEvent);

      await saveParseState(sessionId, state);
      return events;
    });
  } catch {
    // Swallow everything — never throw into processOtlpEvent.
    return [];
  }
}
