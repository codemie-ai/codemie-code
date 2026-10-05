/**
 * `agent.session.summary` builder.
 *
 * Unlike `agent.usage.request`/`agent.subagent.usage`, this event is a running, mutable
 * aggregate over an entire session, not a one-shot derivation from a single transcript line
 * or file. The caller (a later task — the transcript-reader orchestrator) is responsible for
 * accumulating a {@link SessionSummaryAccumulator} across the session's parsed transcript lines
 * and tool-use/tool-result payloads, tracking `TranscriptParseState.branchCounts` via
 * {@link updateBranchCounts} as `git_branch` changes per record, and running
 * `extractNamedInvocations()` (`@/agents/plugins/claude/session/claude-named-invocations.js`)
 * against the session's messages to get the {@link NamedInvocationCounts} this module's builder
 * consumes. This module only aggregates/derives the final event shape from already-computed
 * inputs — it never reads a transcript file or calls `extractNamedInvocations()` itself.
 *
 * `event_id`/`schema_version` are stamped later, daemon-side (see Task 1) — this builder's output
 * carries only an explicit `type` field.
 *
 * Field-shape rulings (see spec.md's `agent.session.summary` section and this task's own plan
 * entry for the full reasoning):
 * - `models_used` is emitted as the full `acc.models` count map (not just a list of names) —
 *   preserves count information `primary_model` alone would discard, consistent with how
 *   `tool_calls`/`tool_errors`-style maps are emitted elsewhere in this stage.
 * - `tool_calls`/`tool_errors` are flattened from `acc.toolCalls`'s combined
 *   `{ calls, errors }`-per-tool shape into two separate flat `Record<string, number>` maps,
 *   matching `buildSubagentUsageEvent`'s (`./subagent-usage.ts`) already-established
 *   `tool_calls`/`tool_errors` output convention for the sibling `agent.subagent.usage` event.
 * - `commands_in_order` is derived as `Object.keys(named.commandInvocations)` — the distinct
 *   command names in whatever iteration order the object naturally has. `commandInvocations` is
 *   a COUNT map, not an ordered sequence, so no true chronological invocation order is available
 *   anywhere in `NamedInvocationCounts`; this is a genuine mismatch between this field's name
 *   (which implies ordering) and the upstream data shape. Documented here rather than silently
 *   papered over with a fabricated ordering.
 * - `title` has no identified source anywhere in this codebase or the external data-model doc
 *   (per spec.md's Open risks) — always emitted as a literal empty string, never fabricated.
 * - `api_calls` (count of `agent.usage.request` records this session) is intentionally OMITTED
 *   from this builder's output: the plan's `buildSessionSummaryEvent` signature has no parameter
 *   for it, and neither `acc` nor any other input here carries a request count. It is left for
 *   the orchestrator (a later task) to merge in afterward, since only that caller has visibility
 *   into the full set of `agent.usage.request` records it has derived/forwarded this session.
 * - `client_version`/`codemie_cli_version` are common fields stamped later via
 *   `mapHookRecords()` (see Tasks 1-3) — not this builder's responsibility either.
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
