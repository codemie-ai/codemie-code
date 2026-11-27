# Codex apply_patch metrics and active time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Codex sessions report apply_patch file operations per call and an `activeDurationMs` to v1/metrics.

**Architecture:** One shared module (`codex-apply-patch.ts`) owns parse, call/result pairing and recognition of apply_patch calls; `extractCodexMetrics` and `CodexMetricsProcessor` both use it. Active time is the sum of `task_started`/`task_complete` turns of the parent rollout, assigned once in `onSessionEnd`.

**Tech Stack:** TypeScript (ES modules, `.js` import extensions, `@/` alias), Vitest.

**Spec:** `docs/superpowers/tasks/2026-11-10-epmcdme-17102-codex-apply-patch-metrics/spec.md` (read with `technical-analysis.md` in the same folder).

Commit per task using the repository's existing convention: `fix(analytics): EPMCDME-17102 <subject>` (Conventional Commits, commitlint enforced). Touch only files named here. Leave the two untracked files under `docs/superpowers/tasks/2026-08-25-epmcdme-14355-subagent-model-override/` alone.

## Global Constraints

- Mapping: Add = `write`; Update = `edit`; Delete = `delete`; Update with `*** Move to:` = one `edit` under the NEW path, no delete for the old path. Lines = `+`/`-` lines per file.
- Result order per `call_id`: `patch_apply_end.success` -> `custom_tool_call_output` (non-zero `metadata.exit_code` or error text = failure) -> pending (no delta). Item `status` is never used.
- Failed call: `toolStatus {apply_patch:{success:0,failure:1}}`, no `fileOperations`. Delta keeps `recordId=call_id`, `tools {apply_patch:1}`.
- An apply_patch call of either item type (`custom_tool_call` or `function_call`) takes this path only, never the generic `function_call` delta.
- Dedupe by `call_id` runs BEFORE the patch is parsed.
- apply_patch calls with record timestamp before run start (`resolveRunWindow(...).startTime`) are not emitted. The generic `-Infinity` window for other tools stays.
- Not changed: `pickRollout`, cost readers, child loader depth, other tools' status, Claude/Pi duration.
- `activeDurationMs` is assigned (not added) on the session record, in `onSessionEnd` only, before the synthetic SessionEnd.

## Review Focus

- Resumed parent older than run start plus fresh child: parent edits counted, time from parent (Task 5, 6).
- Failed patch in both shapes (`success=false`, error output): no file ops (Task 4).
- Turn wholly before run start counts 0; open turn ends at last record of the turn (Task 6).
- In-flight tick at exit must not revert `activeDurationMs` (Task 7, 8).
- Same `call_id` re-processed on a later tick or pass counts once (Task 4).

---

### Task 1: Plan-time checks (read-only) and fixtures

**Files:**
- Create: `src/agents/plugins/codex/__tests__/fixtures/apply-patch-failures.jsonl` (inline-built records for both failure shapes)
- No source change.

Evidence rollouts live at `~/.codex/codemie/home/sessions/2026/11/10/` (READ ONLY; never copy their content into the repo beyond minimal synthetic records).

- [ ] **Step 1: Recheck line numbers** on the current checkout (local main == origin/main): `codex.metrics-processor.ts` (`:53-54`, `:65-70`, `:101-104`), `codex-metrics-extractor.ts` (`:27`, `:64`, `:125`), `codex.session.ts` (`:310`, `:333`), `codex.plugin.ts` (`:345-414`), `codex.incremental-sync.ts` (`:161`). Note any drift in the Task 8 commit body only.
- [ ] **Step 2: SR-001 nesting depth.** Scan the evidence rollouts for `session_meta` and spawn links; record whether grandchildren exist. Fallback: grandchildren stay a documented limit (spec section 3); no code change.
- [ ] **Step 3: Parent id.** Check whether a child `session_meta` carries a parent id, versus parent spawn links read by `loadLinkedSubagentRollouts` (`codex.session.ts:333`). Fallback when only spawn links exist: Task 5 resolves the parent by scanning sibling rollouts in the same day dir for a spawn link to the picked file; when neither exists, use the picked rollout and `logger.debug`.
- [ ] **Step 4: Resume shape.** Check whether a resumed rollout appends to the old file or creates a new file with copied items. Either way the Task 4 timestamp filter applies; record the result for Task 5's test shape.
- [ ] **Step 5: Failed-patch shape.** Grep evidence rollouts for `patch_apply_end` with `success:false` and for non-zero `metadata.exit_code` on an apply_patch output. If none exist, build synthetic records for both shapes in the fixture file (one call per shape plus one pending call with no result). Fallback: both shapes are treated as failure (Task 2 rule), so the fixture is enough.
- [ ] **Step 6: Tick cost.** Time `CodexSessionAdapter.parseSessionFile` plus `processSession` on the largest evidence rollout (a throwaway script in the scratchpad, not committed). Fallback if one tick exceeds the sync interval budget: Task 4 keeps dedupe-before-parse and Task 5 skips children already fully deduped.
- [ ] **Step 7: First-tick transcript.** Read `recordTranscriptCorrelation` use in `codex.incremental-sync.ts:97-100` and confirm `onSessionEnd` (`codex.plugin.ts:374`) overwrites it. Harmless if so; otherwise Task 8 notes it.
- [ ] **Step 8: Commit** the fixture file only.

Test-first: no — research and fixture; no production behavior changes.

### Task 2: Shared apply_patch module

**Files:**
- Create: `src/agents/plugins/codex/session/codex-apply-patch.ts`
- Test: `src/agents/plugins/codex/__tests__/codex-apply-patch.test.ts`

**Interfaces:**
- Produces (exact):
  - `export function parseApplyPatch(patch: string): FileOperation[]` (path, type `write|edit|delete`, `linesAdded`, `linesRemoved`; moves = one `edit` on the new path). Reuse the existing `FileOperation` type already used by the extractor.
  - `export interface ApplyPatchCall { callId: string; timestamp?: string; ok: boolean; fileOperations: FileOperation[] }`
  - `export function collectApplyPatchCalls(records: CodexRolloutRecord[]): ApplyPatchCall[]` — recognizes tool name `apply_patch` on `custom_tool_call` or `function_call` (patch text from `input` or JSON `arguments`), pairs results by the Global Constraints order, omits pending calls, parses lazily via an optional `skip: Set<string>` second parameter (calls in `skip` are not parsed and not returned).
  - `export function isApplyPatchItem(item: { type?: string; name?: string }): boolean`

- [ ] **Step 1: Write failing tests** (inline records): add -> `write` with line count; update -> `edit`; delete -> `delete`; move -> single `edit` on new path; multi-file patch; `patch_apply_end.success=false` -> `ok:false`; `custom_tool_call_output` with `metadata.exit_code: 1` and with error text -> `ok:false`; output exit 0 -> `ok:true`; call with only `status:'completed'` and no result -> omitted; `function_call` named apply_patch recognized; `skip` set respected. Add one test on the real fixture `rollout-2026-05-11T11-26-55-*.jsonl` (3 calls, all `ok:true`, update paths `edit`).
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/codex/__tests__/codex-apply-patch.test.ts`; expected FAIL (module missing).
- [ ] **Step 3: Implement** by moving the body of `fileOpsFromPatch` (`codex-metrics-extractor.ts:27`) into `parseApplyPatch` with the new mapping and move handling; implement pairing per the signatures.
- [ ] **Step 4: Run** the same test; expected PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — `collectApplyPatchCalls` returns `ok:false` for a `patch_apply_end.success=false` call and `write` for an Add File patch.

### Task 3: Extractor uses the shared module

**Files:**
- Modify: `src/agents/plugins/codex/session/codex-metrics-extractor.ts:27-64,115-125` (delete private `fileOpsFromPatch`; apply_patch branch calls `collectApplyPatchCalls`, counts only `ok` calls' operations; tool count unchanged)
- Test: `src/agents/plugins/codex/__tests__/codex.analytics-extractors.test.ts` (update any Add = `edit` expectation; check plan-time item 5), new case in a new `codex-metrics-extractor.test.ts` if no fitting file exists.

- [ ] **Step 1: Write failing tests**: extractor on the real fixture yields `edit` ops with expected line sums; a synthesized Add File yields `write`; a failed patch yields no ops. Add the AC 5 analytics test: a session with one `write` and one `edit` aggregates to `filesCreated 1`, `filesModified 1` through the path used by `native-loader.ts:431` (use the existing aggregator test style in `metrics-aggregator`/native-loader tests).
- [ ] **Step 2: Run** the touched tests; expect FAIL.
- [ ] **Step 3: Implement** the refactor.
- [ ] **Step 4: Run** `npx vitest run src/agents/plugins/codex` ; expect PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — extractor reports an Add File as `write` (currently `edit`).

### Task 4: Processor emits apply_patch deltas

**Files:**
- Modify: `src/agents/plugins/codex/session/processors/codex.metrics-processor.ts:56-110` (skip apply_patch items in the generic `function_call` loop via `isApplyPatchItem`; after the loop, call `collectApplyPatchCalls(records, existingCallIds)`; build one delta per call; filter by run start; `toolStatus` and `fileOperations` per Global Constraints; compute `resolveRunWindow` before the filter and reuse it for `appendDeltas`)
- Test: `src/agents/plugins/codex/__tests__/codex.metrics-processor.test.ts` (existing test at `:160` uses apply_patch as `function_call`: update to the new expectation, one delta with `tools.apply_patch` and file ops)

- [ ] **Step 1: Write failing tests** (inline records, temp `CODEMIE_HOME` as existing): add/update/move/delete deltas with `fileOperations`; failed (both fixture shapes from Task 1) -> `failure:1`, no `fileOperations`; pending -> none; second `process` call with same records writes nothing new; call timestamped before run start not emitted while a `function_call` shell in the same records still is; apply_patch of `function_call` type yields exactly one delta. AC 3 test: ops from `extractCodexMetrics` equal the concatenated delta ops over the same records.
- [ ] **Step 2: Run** the processor test file; expect FAIL.
- [ ] **Step 3: Implement.** Keep the `ponytail` window comment; extend it to say apply_patch calls are filtered per own timestamp.
- [ ] **Step 4: Run** the codex test directory; expect PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — a `custom_tool_call` apply_patch with `patch_apply_end.success=true` produces a delta with `fileOperations` and one with `success=false` produces none.

### Task 5: Read parent and direct children

**Files:**
- Modify: `src/agents/plugins/codex/session/processors/codex.metrics-processor.ts` (build the record list from `parentRecords` plus `session.subagents` records), `src/agents/plugins/codex/codex.session.ts:310-371` (expose parent resolution per Task 1 step 3 outcome; fall back to the picked rollout with `logger.debug`)
- Test: `src/agents/plugins/codex/__tests__/codex.metrics-processor.test.ts`

**Interfaces:**
- Consumes: `collectApplyPatchCalls` (Task 2). Produces: processor counts calls from parent and direct children under the parent CodeMie session id; helper `resolveParentRollout(pickedPath: string): Promise<string>` in `codex.session.ts` (name fixed here for Task 6).

- [ ] **Step 1: Write failing tests**: parent plus child with patches in each -> both counted once across two passes; older (resumed) parent plus fresh child picked -> parent edits counted; no parent found -> picked rollout used. Build two-rollout fixtures inline in a temp dir.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the codex tests; expect PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — a fresh child rollout picked over an older parent still yields the parent's apply_patch deltas.

### Task 6: `computeActiveDuration`

**Files:**
- Create: `src/agents/plugins/codex/codex.active-duration.ts`
- Test: `src/agents/plugins/codex/__tests__/codex.active-duration.test.ts`

**Interfaces:**
- Produces: `export async function computeActiveDuration(parentRolloutPath: string, runStart: number, sessionEnd: number): Promise<number>` (ms; 0 means nothing to write). Scans the file line by line for `event_msg` `task_started`/`task_complete` by `turn_id`.

Rules (spec section 5): per turn `max(0, min(end, sessionEnd) - max(start, runStart))`; a turn without `task_complete` ends at the last record before the next `task_started` or EOF; idle gaps not counted; result capped at `sessionEnd - runStart`; unparsable lines skipped.

- [ ] **Step 1: Write failing tests** (inline JSONL in temp files): two completed turns with idle gap; interrupted turn; open turn at EOF; no turns -> 0; run-start clip; turn wholly before run start -> 0; real fixture (2 turns) returns sum of its two turn lengths with `runStart=0`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — two turns 60 s and 30 s apart by a 1 h idle gap return 90000.

### Task 7: Stop awaits an in-flight tick

**Files:**
- Modify: `src/agents/plugins/codex/codex.incremental-sync.ts:68-70,146-148,161-170` (store the running tick promise per session; `stopCodexIncrementalSync(sessionId): Promise<void>` clears the timer, then awaits that promise)
- Modify callers: `codex.plugin.ts:355` (`await`); grep other callers of `stopCodexIncrementalSync` and tests that mock it.
- Test: `src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts`

- [ ] **Step 1: Write failing test**: with a tick blocked on a deferred promise, `stopCodexIncrementalSync` does not resolve until the tick finishes.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** incremental-sync and plugin lifecycle tests; expect PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — stop resolves only after an in-flight tick resolves.

### Task 8: Write `activeDurationMs` in `onSessionEnd`

**Files:**
- Modify: `src/agents/plugins/codex/codex.plugin.ts:355-396` (after `processSession`, before the synthetic SessionEnd: parent = `resolveParentRollout(rollout.filePath)`, `value = computeActiveDuration(parent, startedAt, Date.now())`; when `value > 0`, load the record via `SessionStore`, assign `activeDurationMs`, `saveSession`; failures are non-blocking `logger.warn`)
- Test: `src/agents/plugins/codex/__tests__/codex.plugin.lifecycle.test.ts`

- [ ] **Step 1: Write failing tests**: after `onSessionEnd` the stored record has `activeDurationMs` equal to the computed value; zero turns writes nothing; interleaved tick (blocked tick that saves the record) cannot revert the value (stop awaited first); end-to-end order: write happens before `processEvent(SessionEnd)` and `accumulateActiveDuration` leaves the value unchanged.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/agents/plugins/codex tests` for codex-related files; expect PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — a rollout with one 45 s turn yields a stored `activeDurationMs` of 45000 before SessionEnd runs.
