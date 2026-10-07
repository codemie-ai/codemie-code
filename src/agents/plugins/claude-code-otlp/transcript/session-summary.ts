/**
 * `agent.session.summary` builder.
 *
 * Unlike `agent.usage.request`/`agent.subagent.usage`, this event is a running aggregate over an
 * entire session. The orchestrator accumulates a {@link SessionSummaryAccumulator}, tracks
 * `TranscriptParseState.branchCounts` via {@link updateBranchCounts}, and runs
 * `extractNamedInvocations()` to produce the {@link NamedInvocationCounts} this builder consumes.
 * This module only derives the final event shape from those inputs — it never reads a transcript.
 *
 * `event_id`/`schema_version`/`client_version`/`codemie_cli_version` are stamped later,
 * daemon-side (`mapHookRecords()`); the output carries only an explicit `type`.
 *
 * Field-shape notes:
 * - `models_used` is the full `acc.models` count map, preserving counts `primary_model` discards.
 * - `tool_calls`/`tool_errors` are flattened from `acc.toolCalls`'s `{ calls, errors }` shape into
 *   two flat maps, matching `buildSubagentUsageEvent` (`./subagent-usage.ts`).
 * - `commands_in_order` is `Object.keys(named.commandInvocations)`. Upstream is a COUNT map, so no
 *   chronological order exists; the field name implies more than the data can deliver.
 * - `title` has no known source and is always an empty string, never fabricated.
 * - `api_calls` is omitted here: no input carries a request count. The orchestrator, which owns
 *   the full set of `agent.usage.request` records, merges it in afterward.
 */

import type { NamedInvocationCounts } from '@/agents/plugins/claude/session/claude-named-invocations.js';

export type { NamedInvocationCounts };

/** Running, mutable aggregate accumulated by the caller across one session's transcript. */
export interface SessionSummaryAccumulator {
  models: Record<string, number>;
  toolCalls: Record<string, { calls: number; errors: number }>;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: Set<string>;
  filesWritten: Set<string>;
  compactionCount: number;
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
 * On a tie, the first-encountered key (in `Object.entries()` iteration order) wins.
 */
function maxKey(counts: Record<string, number>): string {
  let best = '';
  let bestValue = -Infinity;

  for (const [key, value] of Object.entries(counts)) {
    if (value > bestValue) {
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

/** The branch with the highest count in `counts`, or `''` when empty. */
export function branchDominant(counts: Record<string, number>): string {
  return maxKey(counts);
}

/**
 * Build the `agent.session.summary` event payload.
 *
 * `endedAt` is included as `ended_at` only when `phase === 'final'`; for `phase === 'incremental'`
 * the key is omitted entirely (not merely `undefined`-valued).
 */
export function buildSessionSummaryEvent(
  sessionId: string,
  phase: 'incremental' | 'final',
  acc: SessionSummaryAccumulator,
  named: NamedInvocationCounts,
  branchCounts: Record<string, number>,
  startedAt: string,
  endedAt: string | undefined
): Record<string, unknown> {
  const toolCalls: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};
  for (const [tool, counts] of Object.entries(acc.toolCalls)) {
    toolCalls[tool] = counts.calls;
    toolErrors[tool] = counts.errors;
  }

  const event: Record<string, unknown> = {
    type: 'agent.session.summary',
    session_id: sessionId,
    phase,
    models_used: acc.models,
    primary_model: primaryModel(acc.models),
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    skills_used: named.skillInvocations,
    commands_in_order: Object.keys(named.commandInvocations),
    primary_command: maxKey(named.commandInvocations),
    lines_added: acc.linesAdded,
    lines_removed: acc.linesRemoved,
    files_changed: Array.from(acc.filesChanged),
    files_written: Array.from(acc.filesWritten),
    compaction_count: acc.compactionCount,
    branch_counts: branchCounts,
    branch_dominant: branchDominant(branchCounts),
    started_at: startedAt,
    title: '',
  };

  if (phase === 'final') {
    event.ended_at = endedAt;
  }

  return event;
}
