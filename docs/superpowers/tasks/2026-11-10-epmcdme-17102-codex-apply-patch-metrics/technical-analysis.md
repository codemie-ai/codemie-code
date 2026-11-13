# Technical Research

**Task**: codex metrics MetricDelta fileOperations apply_patch custom_tool_call activeDurationMs SessionStore metrics-sync
**Generated**: 2026-11-10
**Research path**: filesystem (code read from `origin/main`; local checkout is 36 commits behind, no `.codegraph/`)

---

## 1. Original Context

Bug: for Codex sessions (codemie-codex, codex plugin) CodeMie CLI metrics sent to the platform (v1/metrics) have no file operations and no lines added/removed, and activeDurationMs is always 0. Evidence from session f864d4c9 (2026-11-10, EPMCDME-16756, CLI 0.16.6): Codex rollouts of this run hold 25 apply_patch calls (response_item payload type 'custom_tool_call', name apply_patch, with patch input); the session _metrics.jsonl has 358 deltas and zero apply_patch entries and zero fileOperations. CodexMetricsProcessor (src/agents/plugins/codex/session/processors/codex.metrics-processor.ts) collects only payload.type==='function_call' and never writes fileOperations, while extractCodexMetrics (codex-metrics-extractor.ts) already parses custom_tool_call apply_patch into fileOperations but only feeds ParsedSession.metrics. activeDurationMs: SessionStore.startActivityTracking is called only from hook-driven agents (UserPromptSubmit); Codex has no such hook, so SessionEnd accumulateActiveDuration adds 0.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A — per-call MetricDelta for Codex tool calls (feeds v1/metrics)**
- `CodexMetricsProcessor` — `src/agents/plugins/codex/session/processors/codex.metrics-processor.ts:28`. Registered in `codex.session.ts:67`. Rules: only `record.type==='response_item'` with `call_id` (`:60-70`); collects `function_call` into the call list and `function_call_output` into `outputs`; `custom_tool_call` / `custom_tool_call_output` are ignored. A call without an output gets no delta yet (`:80`). Delta = `recordId: call_id`, `tools:{name:1}`, `toolStatus` hard-coded `success:1, failure:0` (`:90`), `gitBranch`, `models`. No `fileOperations`, no `apiErrorMessage`. Dedupe by `recordId` against existing JSONL (`:53-54`). Write via `MetricsWriter.appendDeltas` with run window, `startTime:-Infinity` (`:103-104`, "ponytail" comment `:101`).
- Callers: `codex.plugin.ts:385` (`onSessionEnd`, before SessionEnd pipeline), `codex.incremental-sync.ts:103` (in-process timer, `CODEMIE_CODEX_SYNC_INTERVAL_MS`), `codex-acp.plugin.ts:73` inherits the same `onSessionEnd`.

**Purpose B — parse apply_patch into file operations / lines**
- `extractCodexMetrics` + private `fileOpsFromPatch` — `src/agents/plugins/codex/session/codex-metrics-extractor.ts:27,64`. Handles `custom_tool_call` with `name==='apply_patch'` and `input` (`:115`). Per `*** Add|Update|Delete File:` header one op; `+`/`-` lines counted per file, `linesModified = added+removed`. Mapping: **Delete → `delete`, Add and Update → `edit`** (`:44`). Status: `completed` or missing → success, else failure (`:120`). Session-wide aggregate, no per-call identity (no `call_id`, no timestamp kept).
- Consumer: `codex.session.ts:309` → `ParsedSession.metrics` → `src/cli/commands/analytics/native-loader.ts:431` (one synthetic `${sessionId}-native` delta for untracked sessions). Not read by `CodexMetricsProcessor`.
- Sibling implementations of the same purpose:
  - opencode `mapPatchFileType` — `opencode.metrics-processor.ts:43`: `add → write`, `update → edit`, `delete → delete`; per-delta `fileOperations` only on success (`:358-371`).
  - copilot-cli `copilot-cli.file-operations.ts:14,62-66`: added path → `write`, deleted → `delete`; delta built in `copilot-cli.metrics-processor.ts:103` by slicing `session.metrics.fileOperations` already emitted (`:164,177`).
  - pi `pi.metrics-processor.ts:405-425`: `fileOperations` on the tool-result delta, only when not failed.
  - Claude `claude.metrics-processor.ts:308-358`, kimi `:81-102`, gemini `:154-196`: per-turn delta carries `fileOperations`.
- Other source in the rollout: `event_msg` `patch_apply_end` (fixture `rollout-2026-05-11T11-26-55-…jsonl`) carries `call_id`, `success`, and `changes{<abs path>:{type:'update'|…, unified_diff}}`. Not read anywhere in `src` (grep `patch_apply_end`: no hits outside fixtures). `custom_tool_call_output` carries `metadata.exit_code` / `duration_seconds`.

**Purpose C — active duration of a session**
- `SessionStore.startActivityTracking` / `accumulateActiveDuration` — `src/agents/core/session/SessionStore.ts:389,417`. Accumulate adds 0 when `activityStartedAt` is unset (`:426`).
- Callers of start: only `hook.ts:636` (`UserPromptSubmit` handler). Accumulate: `hook.ts:381` (SessionEnd, no `endTimeFromActivity`), `hook.ts:411` (with), `hook.ts:723` (Stop).
- Codex `onSessionEnd` sends a synthetic `SessionEnd` event (`codex.plugin.ts:399-409`) with no `endTimeFromActivity`, so path `hook.ts:381` runs; no Codex code calls `startActivityTracking`.
- pi `saveActiveDurationMs` — `pi.metrics-processor.ts:655-675`: `activityEnd - activityStart` from in-window entry timestamps (`noteActivity`, `:264-266`), bounds merged with JSONL deltas (`:722-729`), written straight to session record via `SessionStore.saveSession`. Doc comment `:645-653`: Pi never fires UserPromptSubmit; value is wall clock incl. idle, deliberately different from Claude's.
- Codex rollout data in reach: `event_msg` `task_started` / `task_complete` with shared `turn_id` (fixture: 2 pairs) and per-record `timestamp`; `ParsedSession.recordTimes` already set (`codex.session.ts:318`).
- Sender: `end-metric.ts:155` `session.activeDurationMs || undefined` → `metrics-api-client.ts:546` omits `active_duration_ms` when undefined. So Codex sends no field rather than 0.

**Other touched code**
- `metrics-aggregator.ts:188-196` (sso): `write→filesCreated`, `edit→filesModified`, `delete→filesDeleted`, sums `linesAdded/Removed`.
- `MetricDelta.fileOperations` — `src/agents/core/metrics/types.ts:68`.
- `CodexResponseItem` — `codex-message-types.ts:56-62`: no `input`/`status` fields (extractor uses its own `ResponseItemPayload`, `:12-20`).

### Decisions Already in the Code
- Codex delta identity is `call_id` (`codex.metrics-processor.ts:84`), dedupe is per `recordId`; reprocessing is idempotent by design (`:11-12`).
- Delta written only once the call's output exists (`:79-80`), so status is final.
- Tool status for Codex deltas is always success (`:90`); the extractor marks failures. No reason recorded.
- Run window lower bound disabled for Codex (`:101-104`), reason recorded in comment.
- Pi chose "first-to-last record wall clock" for active duration because no idle signal exists (`pi.metrics-processor.ts:645-653`).
- Codex extractor maps Add File → `edit`; opencode and copilot map add → `write`. No reason recorded for the difference.
- Extractor is session-aggregate; per-call deltas need per-call data — the extractor stores no `call_id` per op.

### Task Statements Checked Against the Code
- "CodexMetricsProcessor collects only payload.type==='function_call' and never writes fileOperations" — holds (`:65-70`, `:84-93`).
- "extractCodexMetrics already parses custom_tool_call apply_patch into fileOperations but only feeds ParsedSession.metrics" — holds; its only consumer is `native-loader.ts:431`.
- "zero apply_patch entries" — consistent: `custom_tool_call` never enters the call list. Older test `codex.metrics-processor.test.ts:160` uses `apply_patch` as a `function_call`, a shape the fixture rollout does not show.
- "startActivityTracking is called only from hook-driven agents (UserPromptSubmit)" — holds (`hook.ts:636` only).
- "SessionEnd accumulateActiveDuration adds 0" — holds (`SessionStore.ts:426`); the end metric then omits the field (`end-metric.ts:155`), it does not send 0. Session 358-delta evidence is outside the repo — unverified here.

### Consumers of Changed Contracts
- Codex `_metrics.jsonl` deltas → `metrics-sync-processor.ts:101-126` (debug), `metrics-aggregator.ts:188` (v1/metrics), `cli/commands/analytics/aggregator.ts:271-557` (local analytics). All read `fileOperations[].type/linesAdded/linesRemoved`; new fields would be consumed without change.
- `extractCodexMetrics` / `ParsedSessionMetrics` → `codex.session.ts:309`, `native-loader.ts:431`, `codex.analytics-extractors.test.ts:31`. Changing its return shape or the Add→edit mapping changes native analytics.
- `session.activeDurationMs` → `end-metric.ts:155`, `DesktopSessionMetrics.ts:142`. Codex shares `processEvent` SessionEnd with all hook agents (`hook.ts:378`).

### Architecture and Layers Affected
- Agent plugin / session processor: `CodexMetricsProcessor`, `codex-metrics-extractor.ts`, `codex.session.ts`.
- Agent lifecycle: `codex.plugin.ts onSessionEnd`, `codex.incremental-sync.ts`.
- Core session store: `SessionStore` activity fields.
- SSO metrics sync: `metrics-aggregator.ts`, `end-metric.ts` (read-only consumers).

### Integration Points
- Codex rollout JSONL `~/.codex/sessions/YYYY/MM/DD/` (external format, codex CLI version-dependent).
- `MetricsWriter` (`providers/plugins/sso/session/processors/metrics/MetricsWriter.js`), `resolveRunWindow` (`core/session/run-window.js`).
- `processEvent` SessionEnd (`cli/commands/hook.ts`) → `sendSessionEndMetrics` → v1/metrics.

### Patterns and Conventions
- `SessionProcessor` (`name`, `priority`, `shouldProcess`, `process`) registered via `registerProcessor`.
- Deltas typed `Omit<MetricDelta,'syncStatus'|'syncAttempts'>`; optional fields spread conditionally (`...(x.length>0 && {fileOperations:x})`).
- Dynamic `await import()` for MetricsWriter / SessionStore inside processors.
- Non-blocking failure handling with `logger.debug/warn`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` present (architecture, development, integration, testing, standards, quality-gates.md). `docs/superpowers/specs/2026-08-12-codemie-pi-metrics-design.md` and plan cover Pi active-duration approach; `docs/superpowers/specs/2026-05-12-codex-conversations-sync-design.md` covers Codex conversations, not metrics.

### Architectural Decisions
Recorded inline: pi `saveActiveDurationMs` doc comment (`pi.metrics-processor.ts:642-654`); Codex window "ponytail" (`codex.metrics-processor.ts:101`); hook `finalizeSession` doc (`hook.ts:370-377`).

### Derived Conventions
Per-call delta with `fileOperations` only on successful calls (pi, opencode). Patch add → `write` in opencode/copilot.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/codex/__tests__/codex.metrics-processor.test.ts` — per-call_id deltas, dedupe, no-output skip, window, gitBranch fallback. Inline record arrays, temp `CODEMIE_HOME`.
- `codex.analytics-extractors.test.ts:31` — `extractCodexMetrics` tool counts on `tests/integration/session/fixtures/codex/turn-spawn-skill.jsonl`; no apply_patch assertion.
- `codex.incremental-sync.test.ts`, `codex.plugin.lifecycle.test.ts` — timer and onSessionEnd.
- Fixture with 3 real `custom_tool_call` apply_patch + `patch_apply_end`: `src/agents/plugins/codex/__tests__/fixtures/rollout-2026-05-11T11-26-55-019e1625-789d-76c0-80ab-3724b5ddb799.jsonl`.
- `pi.metrics-processor.test.ts` covers pi active duration (reuse reference).

### Testing Framework and Patterns
Vitest; `vi.mock` of logger/security; `vi.resetModules` + dynamic import; temp dir as `CODEMIE_HOME` with a stub `sessions/<id>.json`.

### Coverage Gaps
- No test of `fileOpsFromPatch` (Add/Update/Delete, line counts).
- No test for `custom_tool_call` in `CodexMetricsProcessor`.
- No test of Codex `activeDurationMs`.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_SESSION_ID`, `CODEMIE_CODEX_STARTED_AT` (`codex.plugin.ts:362`), `CODEMIE_CODEX_SYNC_ENABLED`, `CODEMIE_CODEX_SYNC_INTERVAL_MS` (`codex.incremental-sync.ts:57,66`), `CODEMIE_HOME` (tests).

### Configuration Files
`metricsConfig.excludeErrorsFromTools` (used by pi `:402`; not by Codex).

### Feature Flags and Deployment Concerns
`CODEMIE_CODEX_SYNC_ENABLED=false` disables incremental sync; final pass still runs at `onSessionEnd`.

---

## 6. Risk Indicators

- Two parsers for one purpose: `extractCodexMetrics` (aggregate) and `CodexMetricsProcessor` (per call) — see Existing Implementations B. A fix in one leaves the other diverging.
- Add File → `edit` in `codex-metrics-extractor.ts:44` vs `write` in opencode/copilot; reusing it as is reports created files as modified (`metrics-aggregator.ts:190-191`).
- `custom_tool_call_output` not collected in `outputs` (`codex.metrics-processor.ts:67`); a custom call would be skipped by the "no output" rule (`:80`) unless that also changes.
- Dedupe key is `call_id`: already-synced sessions have no apply_patch delta, so reprocessing adds new deltas only (no double count), but past sessions are not backfilled on the platform.
- Codex rollout shape is external and version-dependent (apply_patch as `custom_tool_call` freeform vs `function_call`, `codex-models.ts:34` `apply_patch_tool_type: 'freeform'`).
- Active duration: Codex shares SessionEnd path `hook.ts:381` with hook agents; `accumulateActiveDuration` adds to the stored value, so a value written by a processor (pi style) plus later hook accumulation could double count if both run.
- `toolStatus` always success for Codex deltas (`:90`) — failed patches would still emit lines.
- `patch_apply_end` (with `success` and `changes`) is an unused alternate source; behaviour across Codex versions not verified.

---

## 7. Summary for Complexity Assessment

The bug sits in the Codex agent plugin layer: `CodexMetricsProcessor` (per-call deltas that reach v1/metrics) reads only `function_call` records and never emits `fileOperations`, while the apply_patch parser in `codex-metrics-extractor.ts` exists but feeds only native analytics. Active duration for Codex has no writer: `startActivityTracking` is reached only from the `UserPromptSubmit` hook, which Codex never fires; the end metric then omits `active_duration_ms`. Pi solves the same gap in its metrics processor by deriving wall-clock span from record timestamps and saving it to the session record (`pi.metrics-processor.ts:655`). Rollouts carry `task_started`/`task_complete` per turn and per-record timestamps.

Surface is small and local: the Codex processor, the extractor (parsing helper is private, aggregate, and maps Add→edit unlike siblings), possibly `codex.session.ts`; consumers (`metrics-aggregator.ts`, analytics aggregator, end-metric) need no change to read new fields. No new pattern: per-call `fileOperations` and processor-written `activeDurationMs` both exist in pi/opencode/copilot.

Tests: Vitest unit tests exist for the processor and extractor, plus a real rollout fixture with apply_patch, but nothing covers patch parsing, custom tool calls, or Codex active duration. Risks: two diverging parsers, Add/write mapping, `custom_tool_call_output` pairing, double counting with SessionEnd accumulation, external rollout format drift.

---

## 8. External References

Evidence from session f864d4c9 (rollouts and `_metrics.jsonl` under the user's home) — named as evidence, not as a path; not read. Counts (25 apply_patch, 358 deltas) are unverified here. Repo fixture `rollout-2026-05-11T11-26-55-…jsonl` confirms the `custom_tool_call` / `custom_tool_call_output` / `patch_apply_end` shapes.
