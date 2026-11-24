# omp analytics parity — implementation plan

Source of truth: `OH_MY_PI_ANALYTICS_PLAN.md` (repo root, untracked — **never commit it**). Each task cites its Step; follow that Step's text exactly, so this plan does not repeat it.
Research: `technical-analysis.md` (anchors verified; Sessions "Net lines" is at `app.js:1079`, not 1069).

Commit per task using the repository's existing convention. Each task MUST leave `npm run typecheck && npm run lint` green.
**Before Task 1:** capture the Step 0 baseline (`npm run build`, then HTML → `/tmp/omp-parity/before.html`, JSON → `/tmp/omp-parity/before/`) on unmodified code.
Out of scope: `claude-haiku-5-5` pricing, deleted Claude transcripts, Claude sub-agent edits, managed-path children.

## Acceptance criteria
- `npm run typecheck && npm run lint && npm run build` pass.
- After-report: ≥100 omp sessions with `filesChanged > 0`; omp Σ`netLines` > 0 with non-empty `languages`.
- omp Σ`tokens.input` and Σ`costUSD` strictly higher than before (child + `model_usage` spend included).
- ≥50 omp sessions with `dispatches`; ≥1 omp agent dispatch with `tokens.total > 0`; omp sessions with `rootOwnTokens` = priced omp sessions, and `rootOwnTokens.total ≤ tokens.total`.
- `sessionSource === 'Pure chat'` count < 512; new framework labels appear.
- Claude Σ`netLines`, Σ`filesChanged`, Σ`costUSD`, and dispatch counts are identical before and after.
- Path hygiene, applied to `sessions[]` in the exported `{meta, sessions}` JSON (not `projects/branches`): no omp `files[].filePath` is a URI, contains `/.omp/agent/sessions/`, or ends in a line selector.
- The omp session modal shows "Commands — / not recorded".

## Tasks

### T1 — Link omp child transcripts (Step 1)
Files: `src/agents/plugins/pi/pi.session.ts:204-242`.
Rewrite `loadSubagentRuns` to walk `runsRoot` recursively. Keep the Pi `<a>/<b>/session.jsonl` rule first, without a header check. For other files, require a header and take `agentId`, `spawnDepth`, and `parentAgentId` from the rel path. Never set `toolUseId`. Update the doc comment. If real children fail `readSessionHeader`, apply the Step "Assumptions" fallback (first non-`title` record has `type === 'session'`).
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T2 — Pi usage ownership + `model_usage` (Step 2)
Files: `src/cli/commands/analytics/cost/usage-readers.ts:700-719,792-841`.
Replace the `allMessageArrays` loop with an owner list. Forked continuations are owned by `parsed.sessionId`; runs are owned by `sub.agentId`. Set `ownerAgentId` on every record. Add the `model_usage` branch without touching `currentModel`. Add `model?: string` to `PiUsageEntry` and update the doc comment.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T3 — Move shared Pi entry helpers (Step 3)
Files: `native-loader.ts:489-517`, `pi.types.ts`, `pi.session.ts`.
Move `piLineTimestamp` → `pi.types.ts` `piEntryTimestamp(entry: unknown)` and make it null-safe. Move `piConversationLines` → `pi.session.ts` `piConversationEntries(parsed)`, next to `piForkedContinuations`. Import both into `native-loader.ts` with `as PiSessionLine[]` casts, then delete the originals. Behaviour does not change.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T4 — Multi-op omp file extractor + managed cutover (Steps 4 + 5, one task so the build never breaks)
Files: `src/agents/plugins/pi/session/pi-file-operations.ts:9-109`; `pi.metrics-processor.ts:32,41,222,409,670-673`.
Replace `extractPiFileOperation` and `extractPath` with `PiFileOperationContext` and `extractPiFileOperations` (signature exactly as in Step 4). Add the `URI_SCHEME`, `SELECTOR_SUFFIX`, and `GLOB_CHARS` constants, the 5-stage `normalizePath`, and the per-tool rules for edit/write/read/ls/grep/glob/find. Add `glob` to `TOOL_TYPE_MAP` and keep `countPiDiffLines` unchanged. Update the module comment. Cut the processor over: the new import, the `PiFileOperation` alias, the `fileOpContext` from `session.metadata.projectPath`, the call at L409 without `.filter`, and the wrapper signature.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T5 — Timestamped Pi invocations (Step 6)
Files: `src/agents/plugins/pi/session/pi-named-invocations.ts:295-343`.
Add `PiInvocation` and `listPiInvocations`, which keeps the current loop and pushes items carrying `piEntryTimestamp`; agent items also carry `toolCallId`. Rebuild `extractPiNamedInvocations` as a count over the list. Add `sumPiNamedInvocations`. Detections are unchanged.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T6 — Native omp synthesis of files and child invocations (Step 7)
Files: `src/cli/commands/analytics/native-loader.ts:576-614`.
Add a private `piFileOperations`, modelled on `piToolStats`: it handles only successful, matched results. In `synthesizePiRawSession`:
- collect `PI_SUBAGENT_RUN` children and build `fileOpContext` (`cwd`, plus `sessionDir = dirname(descriptor.filePath)`);
- flat-map the file ops and sum the invocations over `[lines, ...children]`;
- spread `fileOperations` before `...parsed.metrics`;
- update the comment.

Turns, tools, timestamps, and models stay parent-only.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T7 — Framework detector bundles (Step 8)
Files: `report/session-source-detector.ts:49-76`; `report/__tests__/session-source-detector.test.ts:67`.
Update the L67 assertion first, to the 11-name order. Then rename the constant to `SDLC_FACTORY_NAMES` and extend it with the Step 8 lists, including the `sdlc-local:` and `sdlc-local/` prefixes. Add the secops, matt-pocock-skills, caveman, ponytail, codemie-skills, and herdr detectors in the Step 8 table order, with the exact name lists and exclusions. This is the only test change in the plan.
Test-first: yes — detector order assertion fails until SESSION_SOURCE_DETECTORS reordered

### T8 — Pi dispatch extractor + hook (Step 9.1–9.2)
Files: new `src/agents/plugins/pi/session/pi-dispatch-extractor.ts`; `cost/dispatch-extractor.ts:136-145`.
Create `extractPiDispatchEvents(parsed): DispatchEventRaw[]`, modelled on `codex-dispatch-extractor.ts`. It produces:
- skill events with a 0 duration;
- agent events from `details.progress[]`, timed by child bounds and keyed by `_taskId`;
- one call/result-timed event per invocation when there is no progress.

Sort the events and cap them at `MAX_DISPATCHES`. In `extractDispatchResult`, after the codex line, add `if (isPiFamilyAgent(agent)) return { events: extractPiDispatchEvents(parsed), complete: false };`.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T9 — Pi dispatch cost keying + usage allocation (Step 9.3–9.4)
Files: `cost/cost-enricher.ts:478-548,685-699`; new `cost/pi-dispatch-allocation.ts`.
- In `enrichDispatchCosts`, Pi subs key by `agentId` (runs only) and dispatches by `_taskId`.
- Set `usageAgent` to `'pi'` for Pi.
- Count Pi tools with `extractPiToolCalls` on assistant entries.
- Create `allocatePiUsage`, which uses `priceAllocation` to fill `rootOwn*` and `unlinked*` (owners are linked through the first `agentId` segment), and call it after `enrichDispatchCosts` for Pi-family agents.

Depends on T1, T2, T5, and T8.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

### T10 — Commands "not recorded" for omp + changelog (Step 10)
Files: `src/cli/commands/analytics/report/client/app.js:33,1587`; `CHANGELOG.md` (Unreleased).
Add `COMMANDS_NOT_RECORDED = { omp: true }` next to `AGENT_LABELS`. In the session modal's Commands row, show `'—'` with the sub-label `'not recorded'` for omp. Add one Unreleased changelog entry covering omp child spend, file metrics, dispatch Timeline/allocation, and the framework bundles.
Test-first: no — requirements forbid new tests; verified by typecheck/lint/build and before/after report comparison

## Negative-constraint pass
| Constraint | Honored by |
|---|---|
| No new tests, except the detector-order assertion | T7 is the only test edit; every other task has `Test-first: no` |
| Turns and tool calls stay parent-only (not counted from children) | T6 leaves `piToolStats` and `countPiTurns` on fork-family lines only |
| Do not update `currentModel` on `model_usage` | T2 |
| Do not drop the omp child header requirement | T1 (the fallback is still header-based) |
| Children are never double-listed as sessions | T1 does not touch `discoverSessions` |
| Generic skill names excluded from bundles (code-review, memory, product-owner, tdd, pr, security-review, …) | T7 |
| Do not reuse Claude ownership for Pi allocation | T9 adds a separate `pi-dispatch-allocation.ts` |
| Claude path untouched | Every Pi branch in T8 and T9 is behind `isPiFamilyAgent` |
| No managed-path children; no `claude-haiku-5-5` price row | T4 passes only `cwd`; there is no pricing task |
| Never commit `OH_MY_PI_ANALYTICS_PLAN.md` | Header |
