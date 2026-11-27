# EPMCDME-17102 — Codex apply_patch metrics and active time — Spec

Story: `story.md` (12 AC, decisions D1-D6 settled). Size M. Repo: codemie-code, branch EPMCDME-17102.
Facts below cite `technical-analysis.md` (TA) or lines read on `origin/main`.

## Problem

- `CodexMetricsProcessor` writes deltas for `function_call` only (`codex.metrics-processor.ts:65-70`). `apply_patch` is a `custom_tool_call`, so it never reaches `v1/metrics` (TA 2).
- The patch parser `fileOpsFromPatch` (`codex-metrics-extractor.ts:27,64`) feeds only `ParsedSession.metrics`; it has no call id, maps Add to `edit`, and takes call status as result (TA 2B).
- Codex fires no prompt-submit hook, so `activeDurationMs` stays 0 and the end metric omits it (`hook.ts:636`, `SessionStore.ts:426`, `end-metric.ts:155`).

Known facts of the existing code: the processor reads only `session.messages` of ONE rollout (`:56`); neither Codex processor reads `ParsedSession.subagents`; `processSession` runs once per incremental tick (it may be given a child rollout) and once in `onSessionEnd`. `pickRollout` (`codex.correlation.ts:103-110`) prefers a rollout that started after the run start, so a fresh child can win over an older resumed parent.

## Design

### 1. One shared apply_patch module (D3, AR-2)

- New module in `src/agents/plugins/codex/session/` (for example `codex-apply-patch.ts`). It owns the whole apply_patch rule, so no caller has its own copy:
  - parse: patch text in, file operations out (path, type, linesAdded, linesRemoved);
  - pairing: per `call_id`, the result (section 2);
  - recognition: a call is an apply_patch call when its tool name is `apply_patch`, whatever the item type (`custom_tool_call` or `function_call`).
- Mapping: Add = `write`; Update = `edit`; Delete = `delete`; Update with `*** Move to:` = `edit` under the NEW path (no delete for the old path). Line counts as today (`+`/`-` lines per file).
- `extractCodexMetrics` and `CodexMetricsProcessor` both call it. The private `fileOpsFromPatch` is removed. Consequence: native analytics now report new files as `write` (`native-loader.ts:431`); the existing extractor tests are updated.
- An apply_patch call of either item type goes through this path only. It must not also produce the generic `function_call` delta (one tool, one record).

### 2. Per-call result (AC 6, 7)

Per `call_id`, in order:
1. `event_msg` `patch_apply_end` with the same `call_id`: `success` true or false.
2. else the `custom_tool_call_output` of the call: failure on a non-zero `metadata.exit_code` or an error text; success otherwise.
3. else pending: no delta yet (as for `function_call`, `:79-80`). An interrupted patch that never gets a result is never counted.

The call item `status` is never used. A failed call: `toolStatus {apply_patch: {success:0, failure:1}}`, no `fileOperations`. A successful call: `fileOperations` from the parse, `toolStatus` success. The delta keeps `recordId = call_id`, `tools {apply_patch: 1}`, branch and model as in the existing delta. Dedupe by `call_id` runs BEFORE the patch is parsed. The extractor uses the same pairing, so local summary and synced records report the same operations (AC 3).

### 3. Which rollout is the session (D4, AC 2, AR-1)

Cause: one picked rollout stands for the whole session, and after a resume that rollout can be a fresh child.

- Rule: patches and turns are taken from the PARENT rollout of the run plus its direct children, whichever file the tick or the final pass picked. The processor builds its call list from the parent messages and the direct children's messages. All go under the parent CodeMie session id; the same `call_id` on any tick or pass counts once (dedupe by `recordId`, `:53-54`).
- The parent is named explicitly: if the picked rollout is a child, the parent is the rollout whose spawn links (as read by `loadLinkedSubagentRollouts`, `codex.session.ts:310-371`) point to it, or the parent id in the child's `session_meta` if it carries one. Plan-time check: which of the two exists. If no parent is found, fall back to the picked rollout and log it at debug level.
- Scope is kept to this change: `pickRollout` and the cost readers of other owners (token totals) are NOT changed. Grandchildren (child of a child) are not read; this is a documented limit.
- A test pins the case: an older parent rollout (resumed) and a fresh child; edits of the parent are counted and active time comes from the parent.
- Inference, not verified: child calls reach deltas today only by accident of which rollout a tick picks. Plan-time check on the evidence run or a two-rollout fixture.

### 4. Resume and re-sync (D5, AC 8, AR-3)

- Re-sync inside one CodeMie session: dedupe by `call_id` against the metrics JSONL.
- A resumed run is a NEW CodeMie session over a rollout that may hold earlier calls; its JSONL is empty, so `call_id` dedupe does not help. Rule: an apply_patch call whose own record timestamp is before the run start is not emitted. Run start is `resolveRunWindow(...).startTime`.
- The processor today uses `-Infinity` as window start for lack of per-call times (`:101-104`). That stays for other `function_call` tools. The filter is therefore applied to apply_patch calls only. Known gap, named: after a resume, older shell and other tool calls are still counted. This is the existing behavior and a follow-up ticket, not part of this change.
- Plan-time check: whether `codex resume` appends to the same rollout or creates a new one with a copy of earlier items. The timestamp filter covers both.

### 5. Active duration (Part 2, AR-4)

- Source: `event_msg` `task_started` / `task_complete` pairs by `turn_id`, record `timestamp` (TA 2C), from the parent rollout only (section 3). Direct-child turns run inside the parent turn and do not add. Background sub-agent work after the parent turn ends is not counted.
- Per turn: start = `task_started` time, end = `task_complete` time. A turn with no `task_complete` (interrupted, or open at session end) ends at the last record time of that turn (last record before the next `task_started` or the end of file). Start is clipped up to the run start; end is clipped down to the session end time. Each turn counts `max(0, end - start)`, so a turn wholly before the run start counts 0. Idle gaps between turns are not counted. Zero turns: nothing is written.
- Value: sum of turn lengths, never above the wall-clock span.
- Data path: `processSession` returns an aggregate, not turns. The writer therefore reads the parent rollout itself: a function in the Codex plugin (`computeActiveDuration(parentRolloutPath, runStart, sessionEnd)`) that scans the file for turn events. Session end time is the time `onSessionEnd` runs.
- Writer: it assigns `activeDurationMs` on the session record (assignment, not addition) through `SessionStore`, in `onSessionEnd` only, after `processSession` and BEFORE the synthetic SessionEnd event (`codex.plugin.ts:385-409`). Incremental ticks do not write it.
- Tick race: `stopCodexIncrementalSync` is changed to await a tick that is running, and the final pass and the assignment run only after it. `saveSession` overwrites the whole record, so the writer reads the record, sets the field and saves it after the last tick has ended. A test with an interleaved tick pins this.
- Stranded runs (CLI killed; the session ends through the synthetic end where no Codex code runs) get no `activeDurationMs`: the end metric omits it, as today. Named limit, not solved here.
- No double count: Codex never calls `startActivityTracking`, so `accumulateActiveDuration` at SessionEnd adds 0 (`SessionStore.ts:426`) and keeps the stored value. A test pins the full end-to-end order.
- Absent in the end metric when 0 (`end-metric.ts:155`): unchanged.
- Meaning across agents: Claude counts by prompt tracking, Pi by first-to-last wall clock, Codex as the sum of turns. Pi and Claude stay as they are.

## Acceptance criteria

Same 12 as `story.md`. Mapping to tests (TDD, in the plan):
- AC 1, 4, 6, 7: processor tests with inline records (add, update, move, delete, failed, pending; both item types) and a fixture for the failure shape.
- AC 2, 8: parent + child test; older parent + fresh child test; repeated `process` call; run-start filter.
- AC 3: one test compares `extractCodexMetrics` and processor operations over the same records.
- AC 5: analytics test on a synthesized session with a `write` and an `edit`.
- AC 9-12: active-duration tests (completed, interrupted, open, idle gap, no turns, run-start clip including a turn wholly before run start; tick race).

## Decisions

- Add File maps to `write` over keeping `edit` — the other agents' mapping, story AC 4.
- Moved file is one `edit` under its new path over a delete plus a write — story AC 1 says "under its new path".
- Patch result from `patch_apply_end`, then the output, over the call `status` — Codex writes "completed" before the patch is applied.
- Failed patch emits a failed tool call without `fileOperations` over lines marked failed — as pi and opencode (TA 3).
- One shared module owns parse, pairing and recognition over sharing only the parse — one rule for apply_patch of either item type (AR-2).
- Processor reads the parent and its direct children, with the parent named explicitly, over relying on which rollout a tick picks — deterministic counting under the parent session (AR-1).
- Parent named in this change over fixing `pickRollout` and the loader for all readers — does not shift other owners' token totals; grandchildren stay a limit (AR-1, plan B).
- Calls before run start are filtered by their own record timestamp, for apply_patch only, over a new per-session marker or changing the `function_call` window — the other tool calls keep the existing gap, named as a follow-up (AR-3).
- `activeDurationMs` assigned once in `onSessionEnd` from the parent rollout re-read, after awaiting the last tick, over accumulating per tick — idempotent; open turns are not partial (AR-4).
- Stranded runs get no active time over a second write path in the synthetic end — no Codex code runs there (AR-4).
- Turns come from the parent rollout only over summing sub-agent turns — sub-agent turns are inside the parent turn.
- Backfill of old sessions out of scope; one issue with two parts; flow and PR route — D1, D2, D6 — user.

## Non-goals

- Backfill of sessions synced before the fix.
- Token usage per call.
- Branch attribution after a branch switch (issue #648).
- Retry of `failed` metric records after a 503.
- Backend, UI, SDK, harness changes. The platform already reads `fileOperations` and `active_duration_ms`; the SDK/harness do not mirror this field.
- Changing the generic `function_call` path for tools other than apply_patch: its `-Infinity` window, its always-success status, and its resume over-count.
- Changing `pickRollout`, the child loader depth, or the cost readers; grandchild rollouts.
- Counting an interrupted apply_patch that has no result.
- Per-call file operations for other `custom_tool_call` tools.
- Active time for stranded runs; time of background sub-agents after the parent turn ends.
- Changing how Claude or Pi compute active duration.

## Plan-time checks (open, no product decision)

1. The failure shape of a rejected patch: `patch_apply_end.success=false` vs error output. No failed patch exists in the sample rollouts (`rollout-2026-05-11T11-26-55-...jsonl` has only successes). The plan builds a fixture for both shapes.
2. Whether `codex resume` appends to the same rollout (section 4).
3. How child-rollout calls reach deltas on `origin/main` (section 3, inference only); whether a child `session_meta` carries a parent id.
4. The local checkout is behind `origin/main` (TA header): start from a rebase or `origin/main`; recheck all line numbers.
5. Other native-analytics tests that rely on Add = `edit` (`codex.analytics-extractors.test.ts`).
6. Tick cost: measure the tick time on the f864d4c9 rollouts after the processor reads children and dedupes before parsing.
7. The first tick may record a child rollout as the transcript until `onSessionEnd` overwrites it; confirm it is harmless.

## Risks

- Codex rollout format is external and version-dependent (`codex-models.ts:34`): `apply_patch` may be a `function_call` in other versions; the shared module recognizes both.
- A resumed run whose patches are not clipped by timestamps would count old edits; covered by the run-start rule and its test.
- Grandchild sub-agent edits are missed (documented limit).
