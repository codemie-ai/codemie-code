# Technical Research

**Task**: analytics otlp session-env transcript-orchestrator claude-code-hooks
**Generated**: 2026-10-19
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-16120: "[CLI Analytics] agent.session.env from PreCompact and SessionEnd has empty effort/permission_mode and overwrites the last good snapshot"

Since EPMCDME-16064 the env check runs inside the PreCompact and SessionEnd passes. Claude Code's PreCompact and SessionEnd payloads carry neither `effort` nor `permission_mode`. `envCheckInput()` turns the missing values into `''`, and `computeSessionEnvUpdate()` (transcript/orchestrator.ts) builds the candidate as `{ ...last, ...volatile }` with empty strings for effort and permission_mode. The empty strings overwrite the known values, so an `agent.session.env` with empty effort/permission_mode is sent and stored as the new baseline.

The effect was hidden before EPMCDME-16064 because the env pass nearly always lost the parse-state lock.

Steps to reproduce:
1. Start claude with CODEMIE_DEBUG=true in a git repo (connected via claude-code-otlp).
2. Send "reply ok", press Shift+Tab to switch to accept edits, send "reply ok".
3. Run /compact, then send "reply ok".
4. /exit.
5. Read the `agent.session.env` records in `~/.codemie/proxy/otlp-spool/SESSION_ID.hooks.ndjson` (field hookEvent), with timestamps and the effort/permission_mode fields.

Expected result:
- A hook whose payload doesn't carry effort or permission_mode keeps the last known values.
- No `agent.session.env` is sent for PreCompact or SessionEnd when nothing actually changed.
- The last `agent.session.env` of a session has the real effort and permission mode.

Actual result: PreCompact and SessionEnd send agent.session.env with empty effort/permission_mode, overwriting the last good snapshot. The server's latest env for every session ends up with empty effort and permission_mode.

Suggested fix (from ticket notes): when the firing hook carries no effort/permission_mode, leave the stored value (only override with non-empty values) — the EPMCDME-16065 merge already does this elsewhere. The empty candidates would then equal the snapshot, so PreCompact and SessionEnd would send no env event at all.

Related: EPMCDME-16064 (exposed it), EPMCDME-16065 (same symptom; startup env is also still empty there — this merge's "preserve what it finds" pattern is the one to replicate).

---

## 2. Codebase Findings

### Critical environment note

**The code this ticket describes does not exist on the currently checked-out branch.** `HEAD` of `EPMCDME-16120` is identical to `origin/main` (`b124a091`), which has no `agent.session.env`, no `session-env-fields.ts`, and no `computeSessionEnvUpdate`/`envCheckInput` at all (`grep -rn "session.env|permission_mode" src/agents/plugins/claude-code-otlp` on `HEAD` returns nothing except a type declaration). The full feature (EPMCDME-16064/16065's work) lives only on the local/fork branch **`EPMCDME-16065`** (`git log --oneline EPMCDME-16065` — 27 commits not in `HEAD`, tip `05316f13`). All findings below were read via `git show EPMCDME-16065:<path>`, not from the working tree. Any implementation for EPMCDME-16120 must branch from (or be rebased onto) `EPMCDME-16065`, not from current `main`/`HEAD` — building on `HEAD` would re-implement the whole env-check feature rather than fixing its bug.

### Existing Implementations (on `EPMCDME-16065`)

- `src/agents/plugins/claude-code-otlp/event-fields/session-env-fields.ts`
  - `SessionEnvFields` — full `agent.session.env` shape including `effort`, `permission_mode`.
  - `VolatileSessionEnvFields` / `resolveVolatileSessionEnvFields(effort, permissionMode)` — cheap (no-I/O) subset: `effort`, `permission_mode`, `os`, `arch`, `node_version`, `timezone`, `hostname_hash`. Takes `effort`/`permissionMode` verbatim from its caller and returns them unchanged.
  - `resolveSessionEnvFields(cwd, configuredModel, permissionMode)` — full recompute (reads settings/plugins/MCP config from disk).
  - `sessionEnvFieldsEqual(a, b)` — explicit field-by-field diff (not `JSON.stringify`).
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts`
  - `SessionEnvCheckInput { effort, permissionMode, full? }` / `SessionEnvCheckResult`.
  - **`computeSessionEnvUpdate(state, input)`** (around line 614) — the function named in the ticket. Two branches:
    - `input.full` set (ConfigChange/PostModelSwitch): `candidate = { ...resolved, effort: input.effort, permission_mode: input.permissionMode }`.
    - **Cheap path (the bug)**: `const volatile = await resolveVolatileSessionEnvFields(input.effort, input.permissionMode); candidate = { ...last!, ...volatile };` — `volatile.effort`/`volatile.permission_mode` are exactly `input.effort`/`input.permissionMode` passed straight through, so when those are `''` (PreCompact/SessionEnd payloads never carry them) the spread overwrites `last.effort`/`last.permission_mode` with `''`. Then `sessionEnvFieldsEqual` sees a genuine diff against `last`, so a changed (and wrong) snapshot is persisted and sent.
  - `openSessionEnvCheckPass`, `openMainTranscriptPass(sessionId, transcriptPath, trigger, envCheck?)`, `openSessionEndPass(..., envCheck?)`, `openSubagentPass(..., envCheck?)` — each folds `computeSessionEnvUpdate` into its own already-held parse-state lock when `envCheck` is supplied, appending `buildSessionEnvEvent()` to the pass's events only when the result is non-null.
  - `openSessionStartPass` (around line 544) — **already implements the "preserve what it finds" pattern** the ticket wants replicated: `effort: last.effort` (always carried forward — `SessionStart`'s payload never has it) and `permission_mode: sessionEnvFields.permission_mode || last.permission_mode` (fresh non-empty value wins, else falls back). This is the reference pattern for the fix.
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`
  - `envCheckInput(hookInput)` (module-level helper, ~line 398): `{ effort: hookInput.effort?.level ?? '', permissionMode: hookInput.permission_mode ?? '' }` — builds the cheap, no-I/O input from whatever the firing hook's own payload carries.
  - `onStopEvent`, `onPreCompactEvent`, `onStopFailureEvent`, `onSessionEndEvent`, `onSubagentStop` (via `openSubagentPass`) all call `envCheckInput(hookInput)` and pass it through to their respective `open*Pass` calls.
  - `onSessionStart` calls `resolveSessionEnvFields` directly and `openSessionStartPass`.
  - `onPostModelSwitch`/`onConfigChange` call `openSessionEnvCheckPass` directly with `full: { cwd, configuredModel? }` — not subject to this bug (always pass `full`).
- `src/agents/plugins/claude-code-otlp/claude-agent-sdk-hooks.d.ts` — `BaseHookInput.effort?.level` / `.permission_mode?` documented (line ~159) as "Present for hooks that fire within a tool-use context (PreToolUse, PostToolUse, Stop, SubagentStop, etc.)... absent for session-lifecycle hooks" — confirms PreCompact/SessionEnd structurally allow the field but Claude Code never populates it there.
- `src/agents/plugins/claude-code-otlp/transcript/parse-state.ts` — `TranscriptParseState.lastSessionEnvFields: SessionEnvFields | null`, the persisted baseline `computeSessionEnvUpdate` diffs against and mutates.

### Architecture and Layers Affected

- **Hook/event layer**: `claude-code-otlp.plugin.ts` (`OtlpAgentAdapter` subclass) — per-event handlers and the `envCheckInput()` helper that extracts raw hook payload values.
- **Orchestration/state layer**: `transcript/orchestrator.ts` — `computeSessionEnvUpdate` (the function to fix) and its callers (`openMainTranscriptPass`, `openSessionEndPass`, `openSubagentPass`, `openSessionEnvCheckPass`), all operating on the shared, lock-held `TranscriptParseState`.
- **Field-resolution layer**: `event-fields/session-env-fields.ts` — `resolveVolatileSessionEnvFields` is a pure pass-through of its arguments for `effort`/`permission_mode`; no I/O. Fixing at the `resolveVolatileSessionEnvFields` call site vs. inside `computeSessionEnvUpdate` itself are the two plausible locations — both are in this layer boundary.

### Integration Points

- Spool/forward pipeline: `buildSessionEnvEvent(sessionId, fields)` → pass's `events[]` → `OtlpAgentAdapter.processOtlpEvent` → proxy daemon spool (`~/.codemie/proxy/otlp-spool/SESSION_ID.hooks.ndjson`) → `otlp-spool/forwarder.ts` → analytics API, per `agent.session.env` contract (`hookEvent` field, `effort`, `permission_mode` among its fields).
- No external service clients are touched by this fix — it is pure in-memory merge logic plus the existing persisted parse-state file.

### Patterns and Conventions

- **Commit-after-send**: every `open*Pass` returns `{ events, finalize }`; `finalize(accepted)` only persists `state` (via `saveParseState`) on an accepted send — relevant because a fix must not persist a wrong/overwritten `lastSessionEnvFields` even transiently before a send succeeds (it already doesn't, since `computeSessionEnvUpdate` only mutates the in-memory `state`, and `finalize` governs persistence).
- **"Preserve what it finds" merge** — already established in `openSessionStartPass`: never let an absent/empty payload field blank out a known value; prefer the fresh non-empty value, else keep the baseline. This is the exact pattern the ticket asks to replicate inside `computeSessionEnvUpdate`'s cheap path.
- **Field-by-field equality**, not `JSON.stringify` (`sessionEnvFieldsEqual`) — the fix must produce a `candidate` that equals `last` bit-for-bit when nothing real changed, so this equality check naturally suppresses the no-op send once effort/permission_mode no longer get blanked.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `docs/ARCHITECTURE-OTLP-PLUGIN.md` (present only on `EPMCDME-16065`, not on `HEAD`) documents the whole env-check design, including:
  - `transcript/orchestrator.ts`'s row: explicitly describes `openSessionStartPass`'s merge rule ("`effort` always carries forward... `permission_mode`/`configured_model` prefer the fresh payload's non-empty value...") — i.e., this doc already states the pattern as intentional for `SessionStart`, but does not extend it to the cheap re-check path used by Stop/PreCompact/StopFailure/SessionEnd/SubagentStop.
  - `claude-code-otlp.plugin.ts`'s row: documents `envCheckInput()` as "the cheap (no-I/O) `{ effort, permissionMode }` pair from a hook's own payload."
- `.ai-run/guides/integration/external-integrations.md` (present on `HEAD`) covers the general `OtlpAgentAdapter` pattern at a high level (`codemie hook --agent <adapter-name>`), not env-check specifics — defers to `ARCHITECTURE-OTLP-PLUGIN.md`.
- No `.ai-run/guides/` P0 guide is specific to this bug; `architecture.md`/`external-integrations.md` are the applicable category per `AGENTS.md`'s task classifier (`otel`/`hook`/`telemetry` keywords).

### Architectural Decisions

- The commit history on `EPMCDME-16065` itself documents the evolution: `91d1b5ba` (enrich session.start), `d55d8714`/`dccf0506`/`179111e6` (add + re-emit `agent.session.env`), `f5026ccd`/`35d14456` (merge SessionStart's env fields — the precedent fix for the same class of bug at `SessionStart`), `58dd6e0e` ("perform env-check in the same already-held lock" — the fold-in design). No ADR document found; the directive/decision journals under `docs/local_docs/` (per `CLAUDE.local.md`) contain no entries matching 16064/16065/16120 (checked, none found) — rationale lives only in commit messages and inline doc comments.

### Derived Conventions

- Field resolvers return `''`/empty defaults on failure, never throw (`session-env-fields.ts` module doc, `ARCHITECTURE-OTLP-PLUGIN.md` line 75).
- Hook payload is always spread/merged, never blindly trusted for lifecycle-absent fields — exactly the gap this ticket closes for the cheap env-check path.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` (on `EPMCDME-16065`) has an extensive `describe` block around `openSessionEnvCheckPass`/`computeSessionEnvUpdate` (~lines 1280–1500) plus a second block "envCheck fold-in — single lock acquisition" (~line 1507+) covering `openMainTranscriptPass`/`openSubagentPass` with `envCheck`.
- Relevant existing cases: `openSessionStartPass`'s own merge-on-resume tests (~1315–1380, confirming the already-correct SessionStart behavior this ticket wants mirrored), the "cheap path: merges a changed effort onto the baseline" test (~1402), and "cheap path: finalize(false) leaves the baseline untouched" (~1424).
- `src/agents/plugins/claude-code-otlp/event-fields/__tests__/session-env-fields.test.ts` covers `resolveVolatileSessionEnvFields`/`resolveSessionEnvFields`/`sessionEnvFieldsEqual` directly.

### Testing Framework and Patterns

- Vitest, per `.ai-run/guides/testing/testing-patterns.md` and project convention; dynamic-import mocking of `resolveVolatileSessionEnvFieldsMock`/`resolveSessionEnvFieldsMock` is already set up in `orchestrator.test.ts`.

### Coverage Gaps

- **No existing test passes an empty `effort`/`permissionMode` into the cheap path (`computeSessionEnvUpdate` without `full`) against a baseline that has real, non-empty values.** Every existing "cheap path" test supplies a non-empty `effort`/`permissionMode` in the check input (`'high'`, or the fixture's own `permission_mode`). This is exactly the ticket's reproduction scenario (PreCompact/SessionEnd calling with `effort: '', permissionMode: ''`) and is the gap the fix's regression test must close.
- No test asserts that PreCompact/SessionEnd send **no** `agent.session.env` event when effort/permission_mode are the only candidate inputs and nothing else changed (the ticket's second expected-result bullet).

---

## 5. Configuration and Environment

### Environment Variables

- None specific to this bug; `session-env-fields.ts` reads `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` for the (unaffected) `full` path, not relevant to the cheap-path merge bug.

### Configuration Files

- `~/.codemie/proxy/otlp-spool/SESSION_ID.hooks.ndjson` is the observable artifact named in the repro steps — not a config file to edit, but the verification point.
- Persisted parse state (`TranscriptParseState`, including `lastSessionEnvFields`) lives under the CLI's own state directory via `parse-state.ts` (`saveParseState`/`loadParseState`), not a user-facing config file.

### Feature Flags and Deployment Concerns

- None found. This is a pure logic fix inside an existing, already-shipped-on-branch code path; no flags gate `agent.session.env` emission.

---

## 6. Risk Indicators

- **Branch mismatch is the dominant risk**: the ticket's described code exists only on `EPMCDME-16065`, not on `main`/`HEAD`/the current `EPMCDME-16120` checkout. Any plan/spec must explicitly state the fix branches from `EPMCDME-16065` (or a rebase of it), or the implementation will either fail to find the described functions or end up re-adding the whole feature. This should be confirmed with the user/owner before implementation starts.
- Speculative: the most faithful fix mirrors `openSessionStartPass`'s existing merge (`effort: last.effort` always carried forward, since no cheap-path hook populates it; `permission_mode: input.permissionMode || last.permission_mode`) inside `computeSessionEnvUpdate`'s `else` branch (or inside `resolveVolatileSessionEnvFields`'s caller) — but the exact call site (guard inside `computeSessionEnvUpdate` vs. changing what `resolveVolatileSessionEnvFields` is given) is a design decision, not something Section 2 asserts as required.
- Speculative: because `sessionEnvFieldsEqual` does a field-by-field compare, once effort/permission_mode no longer get blanked, the "no event sent when nothing changed" expected result in the ticket should follow automatically from existing logic — but this depends on no other volatile field (`os`/`arch`/`node_version`/`timezone`/`hostname_hash`) spuriously differing between the cheap recompute and the baseline, which is outside this ticket's scope to verify beyond what existing tests already cover.
- Coverage gap (Section 4) means the regression this ticket targets was never exercised by a test — any fix needs new test cases with empty `effort`/`permissionMode` cheap-path inputs against a non-empty baseline, both for the PreCompact/SessionEnd/SubagentStop-style fold-in callers and for `computeSessionEnvUpdate` directly.
- No ADR/decision journal documents why the cheap path was written as a blind spread in the first place (likely an oversight parallel to the `SessionStart` bug `f5026ccd`/`35d14456` already fixed once) — "no rationale found," not a deliberate decision to work around.

---

## 7. Summary for Complexity Assessment

The fix touches one function, `computeSessionEnvUpdate` in `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts`, inside the `OtlpAgentAdapter`/hook-orchestration layer, on branch `EPMCDME-16065` (not current `HEAD`/main). The bug is a straightforward merge-precedence error: the cheap (no-I/O) env-recheck path spreads a hook payload's raw `effort`/`permission_mode` (empty for PreCompact/SessionEnd) directly onto the persisted baseline instead of preferring the baseline when the payload's value is empty — the exact pattern already correctly implemented one function away, in `openSessionStartPass`. Change surface is small (1 production function, plus new/adjusted test cases in the adjacent `orchestrator.test.ts`), and the reference pattern to replicate is already in the same file, reducing novelty risk substantially.

The primary risk is not the fix's logic but the environment: the ticket's described code does not exist on the checked-out branch at all — it lives only on the unmerged `EPMCDME-16065` branch (27 commits ahead of `main`, not an ancestor of `HEAD`). This must be resolved (confirm the base branch with the user) before any spec/plan proceeds, since building against `main` would require re-implementing the entire env-check feature rather than a 1-function bug fix. Test coverage posture is otherwise good — the orchestrator test file already has an extensive `describe` suite for this exact code path, just missing the empty-payload-against-known-baseline case this ticket exists to cover, which keeps the testing lift small once the branch question is settled.

---

## 8. External References

None named by the task. The ticket body itself names two related ticket IDs (EPMCDME-16064, EPMCDME-16065) as context, not as a path/URL to a source-of-truth document; no directive/decision journal, external file, or URL was pointed to for sourcing. (The branch `EPMCDME-16065` was located and read as part of ordinary codebase research in Section 2, since `envCheckInput`/`computeSessionEnvUpdate` named in the ticket were not found on `HEAD` — this is reported there, not as a Step 0 external reference.)
