/**
 * `agent.session.summary` builder.
 *
 * The orchestrator accumulates a {@link SessionSummaryAccumulator}, tracks
 * `TranscriptParseState.branchCounts` via {@link updateBranchCounts}, and runs
 * `extractNamedInvocations()` to produce the {@link NamedInvocationCounts} this builder consumes.
 * This module only derives the final event shape from those inputs — it never reads a transcript.
 *
 * `event_id`, `schema_version`, `client_version` and `codemie_cli_version` are no longer stamped
 * daemon-side; the adapter base class stamps them at hook time (`client_version` via
 * `resolveAgentFields`). The output carries only an explicit `type`.
 *
 * `api_calls` is omitted here: no input carries a request count. The orchestrator, which owns
 * the full set of `agent.usage.request` records, merges it in afterward.
 *
 * `title` is the transcript's latest `ai-title` (`''` when it has none), never fabricated.
 */

import type { NamedInvocationCounts } from '@/agents/plugins/claude/session/claude-named-invocations.js';
import type { Compaction } from './session-signals.js';

export type { NamedInvocationCounts };

/** Running, mutable aggregate accumulated by the caller across one session's transcript. */
export interface SessionSummaryAccumulator {
  models: Record<string, number>;
  toolCalls: Record<string, { calls: number; errors: number }>;
  toolResults: number;
  filesEdited: Set<string>;
  filesWritten: Set<string>;
  /** `null` until an edit result reports a diff — unknown is never sent as `0`. */
  linesAdded: number | null;
  linesRemoved: number | null;
  turns: number;
  compactions: Compaction[];
  clientVersions: string[];
  /** Slash commands in call order, repeats kept, no leading slash. */
  commandsInOrder: string[];
  title: string;
  /** Branch of the last transcript line that carries one. */
  lastGitBranch: string;
}

/**
 * Bump `counts[branch]` by 1, mutating `counts` in place (this is the caller-maintained
 * `TranscriptParseState.branchCounts` map from `./parse-state.ts`).
 *
 * A falsy/empty `branch` is skipped — an unknown/missing branch shouldn't pollute the
 * dominant-branch calculation ({@link branchDominant}).
 */
export function updateBranchCounts(counts: Record<string, number>, branch: string): void {
  if (!branch) {
    return;
  }
  counts[branch] = (counts[branch] ?? 0) + 1;
}

/**
 * Return the key with the highest value in `counts`, or `''` when `counts` is empty.
 * On a tie, the first-encountered key (in `Object.entries()` iteration order) wins, or the
 * last-encountered one when `tieToLater` is set.
 */
function maxKey(counts: Record<string, number>, tieToLater = false): string {
  let best = '';
  let bestValue = -Infinity;

  for (const [key, value] of Object.entries(counts)) {
    if (tieToLater ? value >= bestValue : value > bestValue) {
      best = key;
      bestValue = value;
    }
  }

  return best;
}

/** The model with the highest count in `models`, or `''` when empty. */
export function primaryModel(models: Record<string, number>): string {
  return maxKey(models);
}

/** The branch with the highest count in `counts` (a tie goes to the later one), or `''` when empty. */
export function branchDominant(counts: Record<string, number>): string {
  return maxKey(counts, true);
}

/** Distinct normalised models, primary first, per the contract's `models` field. */
function modelsArray(models: Record<string, number>): string[] {
  const primary = primaryModel(models);
  const rest = Object.keys(models).filter((model) => model !== primary);
  return primary ? [primary, ...rest] : rest;
}

/**
 * Build the `agent.session.summary` event payload.
 *
 * `startedAt`/`endedAt` are the transcript's own first/last line timestamps (never a hook's
 * invocation time); `duration_ms` is `null`, not `0`, whenever either is missing or unparseable.
 */
export function buildSessionSummaryEvent(
  sessionId: string,
  phase: 'incremental' | 'final',
  acc: SessionSummaryAccumulator,
  named: NamedInvocationCounts,
  branchCounts: Record<string, number>,
  startedAt: string,
  endedAt: string
): Record<string, unknown> {
  const diff = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
  const durationMs = Number.isFinite(diff) && diff >= 0 ? diff : null;

  const filesChanged = new Set<string>([...acc.filesEdited, ...acc.filesWritten]);
  const toolTotals = Object.values(acc.toolCalls).reduce(
    (totals, t) => ({ calls: totals.calls + t.calls, errors: totals.errors + t.errors }),
    { calls: 0, errors: 0 }
  );
  const compactionPreTokens = acc.compactions.reduce((sum, c) => sum + (c.pre_tokens ?? 0), 0);

  return {
    type: 'agent.session.summary',
    session_id: sessionId,
    // The envelope `timestamp` the forwarder reads to decide which summary is latest
    // (`summary_ts`) — the contract's own value for it, same as `ended_at`. Left unset when
    // unknown so the forwarder's existing spool-time fallback applies instead of fabricating one.
    timestamp: endedAt || undefined,
    is_final: phase === 'final',
    started_at: startedAt,
    ended_at: endedAt || null,
    duration_ms: durationMs,
    models: modelsArray(acc.models),
    primary_model: primaryModel(acc.models),
    tool_calls: toolTotals.calls,
    tool_errors: toolTotals.errors,
    tool_results: acc.toolResults,
    tools: acc.toolCalls,
    skills: named.skillInvocations,
    agents: named.agentInvocations,
    commands: acc.commandsInOrder,
    primary_command: acc.commandsInOrder[0] ?? '',
    turns: acc.turns,
    lines_added: acc.linesAdded,
    lines_removed: acc.linesRemoved,
    files_changed: filesChanged.size,
    files_written: acc.filesWritten.size,
    files_edited: acc.filesEdited.size,
    compaction_count: acc.compactions.length,
    compaction_pre_tokens: compactionPreTokens,
    compactions: acc.compactions,
    branch_counts: branchCounts,
    branch_dominant: branchDominant(branchCounts),
    git_branch: acc.lastGitBranch,
    client_versions: acc.clientVersions,
    title: acc.title,
  };
}
