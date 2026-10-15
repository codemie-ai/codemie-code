# Technical Research

**Task**: claude-code-otlp session-signals lines-added
**Generated**: 2026-10-15
**Research path**: filesystem (codegraph MCP tool not available in this environment; confirmed via probe before falling back)

---

## 1. Original Context

EPMCDME-15967 — [CLI Analytics] Lines from a Write tool call are not counted: session net lines is 0 after creating a file.

Bug report (verbatim):
---
Precondition
Environment: CodeMie Preview (codemie-preview.lab.epam.com), API 2.49.0-SNAPSHOT.176
Platform: macOS 26.6.2 (arm64), Node v24.1.0
CodeMie CLI / proxy daemon: 0.15.8 (local build of codemie-code main @ e0f79aa, includes PR #609); daemon profile epm-cdme-preview, provider ai-run-sso, clientType claude-code-otlp
Agent type: Claude Code 2.1.287, started as plain claude (not codemie-claude), connected with codemie proxy connect --claude-code-otlp
Storage: PostgreSQL

Description
agent.session.summary does not add the lines of a Write tool call to lines_added. A session that created a 5-line file and then edited one line reports lines_added=1, lines_removed=1, so CLI Analytics shows Net lines = 0 instead of +5.

Steps to reproduce
1. Start a fresh Claude Code session (connected to Preview via claude-code-otlp).
2. Prompt: "write a small hello world typescript file in the root" (Write creates hello.ts, 5 lines).
3. Prompt: "now edit this file to make console log to have current year" (one Edit, one line replaced).
4. Run /compact (final summary is emitted), wait for the rollup refresh.
5. Open CLI Analytics -> Sessions and check NET LINES, or GET /v1/analytics/cli-analytics/sessions/{trace_id}.

Actual result
Session 5702e943-f031-4dbe-aa41-894680974386:
- Transcript: Write hello.ts (content = 5 lines), Edit hello.ts (1 line).
- Spool record agent.session.summary (is_final=true): lines_added=1, lines_removed=1, files_written=1, files_edited=1, files_changed=1.
- API: net_lines=0 (sessions list and detail); Overview/Repositories: lines_added=0, lines_removed=0 for the repository in the same window.

Expected result
lines_added=6 (5 from Write + 1 from Edit), lines_removed=1, net lines = +5.

Notes
- The spec for sub-stage 1.1 says lines_added/removed are always 0 (known limitation); the code now computes them (only for Edit), so the spec is outdated and Write is the missing case.
- Files created through Bash (heredoc, scripts) are not visible at all — out of scope for this ticket, would need a git snapshot from sub-stage 1.2.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts` — defines the buggy `collectEditLineStats` (lines 83-112) plus private helpers `countPatchLines` (L54-67) and `countContentLines` (L70-74). Pure, no I/O, no imports besides local types.
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts` — sole production caller of `collectEditLineStats`, invoked at line 275 inside `buildFullAccumulator` (L202-293, called on every Stop/PreCompact/SessionEnd/StopFailure hook pass — always recomputed from byte 0, no incremental state for this field). Also independently computes `files_written`/`files_edited`/`files_changed` via a separate pass (Pass 3, L248-270) over `tool_use` inputs — that counter is unaffected by this bug and already correctly reflects the Write (hence `files_written=1` in the bug report while `lines_added` stays wrong).
- `src/agents/plugins/claude-code-otlp/transcript/session-summary.ts` — `buildSessionSummaryEvent` maps `acc.linesAdded`/`acc.linesRemoved` straight onto the wire event's `lines_added`/`lines_removed` fields (L141-142), no further transform. There is no `net_lines` field in this contract — "net lines" is a derived/display-side concept (`lines_added - lines_removed`), computed outside this repo.
- `src/agents/plugins/claude/session/claude-file-operation.ts` — a different, independently-maintained implementation for the legacy `claude` plugin's `extractClaudeFileOperation` (L71-91). It branches on `toolName === 'Write'` vs. `toolName === 'Edit' && Array.isArray(structuredPatch)` — i.e. it discriminates on the known tool name first, not on field presence — so it does **not** share this bug. This is a useful "correct pattern" reference for the fix.

### Verified bug (independently confirmed by two threads reading the live file)

Exact code, `session-signals.ts` lines 83-112 (quoted, confirmed verbatim):

```ts
export function collectEditLineStats(lines: readonly SignalLine[]): EditLineStats {
  ...
  for (const line of lines) {
    const result = line.toolUseResult;
    if (!result || typeof result !== 'object') continue;
    const { structuredPatch, type, content } = result as { ... };

    let added: number | null = null;
    let removed = 0;
    if (Array.isArray(structuredPatch)) {               // L98 — wins first, even for []
      const counts = countPatchLines(structuredPatch);
      added = counts.added;
      removed = counts.removed;
    } else if (type === 'create' && typeof content === 'string') {  // L102 — never reached when structuredPatch is []
      added = countContentLines(content);
    }
    if (added === null) continue;
    ...
  }
  ...
}
```

A real Write `toolUseResult` carries **both** `type: 'create'` and `structuredPatch: []` simultaneously (confirmed in two independent fixture files — see Section 4). Since `Array.isArray([])` is `true`, the first branch always wins, computing `{added: 0, removed: 0}` from the empty patch array, and the `else if (type === 'create' ...)` branch — which would correctly call `countContentLines(content)` — is never reached. `added=0` is not `null`, so the loop does not `continue`; it records a confirmed `+0/-0` for the Write instead of leaving the value unmeasured or counting the real content lines. This is a pure branch-ordering bug, not a missing-case bug: the `else if` logic to handle Write already exists and is correct in isolation, it's simply unreachable whenever `structuredPatch` is present (even empty).

`EditLineStats = { linesAdded: number | null; linesRemoved: number | null }`. `countPatchLines` counts `+`/`-` prefixed lines inside `hunk.lines`, tolerating malformed hunks. `countContentLines` does `content.split('\n').length` minus 1 if content ends in `\n` (so a trailing newline isn't double-counted); returns 0 for empty content.

### Architecture and Layers Affected

- **Transcript parsing / signal-extraction layer** — `session-signals.ts`, pure functions over parsed JSONL lines. This is where the fix belongs.
- **Orchestration / aggregation layer** — `orchestrator.ts`'s `buildFullAccumulator`, which calls `collectEditLineStats` and feeds the result into the summary accumulator. No change needed here beyond re-verifying the call site contract.
- **Event-shape / contract-building layer** — `session-summary.ts`'s `buildSessionSummaryEvent`, which passes `linesAdded`/`linesRemoved` through unchanged onto the `agent.session.summary` event. No change needed here.
- **Legacy / parallel plugin layer** — `src/agents/plugins/claude/session/claude-file-operation.ts` (+ `claude.metrics-processor.ts`) — a structurally similar but independently-maintained line-count computation for the older `claude` plugin. Does not share code with `claude-code-otlp` and does not exhibit this bug; not in scope for the fix but relevant as a correct-pattern reference and for review consistency.
- **CLI analytics/report layer** (`src/cli/commands/analytics/aggregator.ts`, `otel-loader.ts`, `data-loader.ts`, `report/*`) — a separate `linesAdded`/`linesRemoved`/`netLinesChanged` universe fed by per-agent `fileOperations[]`, not by `agent.session.summary`. Unrelated data path, shares only field-naming convention. Not affected by this bug and not part of the fix.

### Integration Points

- `orchestrator.ts` → `session-signals.ts` (imports `collectEditLineStats`, `countTurns`, `collectCompactions`, `collectClientVersions`, `latestTitle`).
- `orchestrator.ts` → `session-summary.ts` (imports `buildSessionSummaryEvent`, `updateBranchCounts`, types).
- `session-summary.ts` → `session-signals.ts` (imports only the `Compaction` type — no runtime coupling to the buggy function).
- `orchestrator.ts` → `src/agents/plugins/claude/session/claude-named-invocations.js` (cross-plugin dependency: `claude-code-otlp` reuses the legacy `claude` plugin's named-invocation extraction logic — unrelated to this bug, but shows the two plugins are not fully isolated).
- `session-signals.ts` has no outgoing dependencies — pure, self-contained module.
- Downstream pipeline for the emitted event: `claude-code-otlp` plugin → OTLP spool (`src/providers/plugins/sso/proxy/plugins/otlp-spool/`) → forwarded to `/v1/analytics/cli-analytics/event-hooks` (confirmed in `sso.http-client.ts:27-30` and `otlp-spool/__tests__/forwarder.test.ts:103`) → external analytics backend (not in this repo). The `/v1/analytics/cli-analytics/sessions/{trace_id}` endpoint referenced in the bug report, and the Overview/Repositories rollups, live entirely outside this repository.
- A separate, unrelated metrics pipeline exists in this repo: `src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.ts` (L266-267), `metrics-api-client.ts` (L145-146), `metrics-sync-processor.ts` (L161-162), `metrics-types.ts` (L106-107) aggregate and forward `total_lines_added`/`total_lines_removed` — but these are sourced from the legacy `claude` plugin's live `MetricsProcessor`/`claude-file-operation.ts`, **not** from `claude-code-otlp`'s `agent.session.summary` event. No in-repo code was found reading `agent.session.summary.lines_added`/`lines_removed` besides its own producer and tests — strongly suggesting the only consumer of this specific field is the externally-hosted OTLP ingestion/analytics backend.

### Patterns and Conventions

- **"Null means unmeasured, 0 means measured-but-zero" convention**: `linesAdded`/`linesRemoved` start at `null` and only become numbers once some result was actually counted (documented in `EditLineStats` and `SessionSummaryAccumulator.linesAdded` doc comments). The bug produces a measured `0` (wrong) rather than leaving the value `null`, which is strictly worse than "unmeasured" because it presents as a confirmed real zero to downstream consumers.
- **Full recompute on every pass**: `buildFullAccumulator` recomputes everything from byte 0 on every Stop/PreCompact/SessionEnd/StopFailure hook (no incremental state for line counts), so the bug reproduces identically and deterministically on every pass of a given transcript, not intermittently.
- **Deliberate "applied result, not proposed input" design**: line counts intentionally come from `toolUseResult` (the applied/actual result) rather than `tool_use.input` (the proposed edit), since an edit could have failed. This design intent is sound and should be preserved by the fix.
- **Field-presence-based discrimination (root cause pattern)**: `collectEditLineStats` infers "what kind of result is this" by checking which optional fields are present/shaped a certain way (`Array.isArray(structuredPatch)`, `type === 'create'`), rather than using a definitive tool-name discriminator. `claude-file-operation.ts` (legacy `claude` plugin) uses the more robust pattern — branch on `toolName` first — and does not share this bug. This is the structural root cause: nothing in `session-signals.ts` enforces that `structuredPatch` and `type: 'create'` are mutually exclusive, and in reality they are not.
- **Defensive "never throws, skip malformed data" pattern** used uniformly across the transcript module (malformed JSON lines, malformed hunks, missing timestamps all degrade gracefully) — this did not catch the bug because `structuredPatch: []` is not malformed data, it is a valid empty array that happens to be semantically wrong to prioritize.
- No `ToolUseResult` interface/type exists anywhere in the repo — `SignalLine.toolUseResult` is typed as bare `unknown`, and each use site infers the shape ad hoc inline. There is no single source of truth describing which tools produce which combination of `type`/`structuredPatch`/`content`, which is itself a contributing risk factor for this class of bug recurring.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` (lines ~281-283, 341) mentions the `OtlpAgentAdapter` pattern and names `claude-code-otlp` as the reference implementation, but defers all adapter/event/line-counting detail to `docs/ARCHITECTURE-OTLP-PLUGIN.md`. No mention of session signals, line counting, or `structuredPatch`.
- No other `.ai-run/guides/` file (architecture, development-practices, security-practices, testing-patterns, standards/*, project-config, project, quality-gates) mentions `lines_added`/`lines_removed`/`session-signals`/`claude-code-otlp` — grepped, no hits.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` contains no mention of `lines`, `sub-stage`, `session.summary`, or `structuredPatch` anywhere (confirmed via full-file grep) — it is not stale with respect to this bug, but it also does not document this known limitation at all, which is itself a documentation gap.
- Earlier "reference implementation" phrasing found in `docs/superpowers/tasks/2026-06-23-codex-analytics-report/technical-analysis.md:79` refers to a **different** agent (`claude`, via `claude.session.ts` + `claude-named-invocations.ts`), not `claude-code-otlp` — worth flagging in case any earlier task description's "reference implementation" claim conflated the two plugins.

### Architectural Decisions

- **Primary "known limitation" source, matches the bug report's quote exactly**: `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/spec.md:128-129` ("EPMCDME-15301 sub-stage 1.1 — expanded fields and new usage events (OTLP analytics pipeline)"):
  > "Known limitations, accepted as-is for this sub-stage: `lines_added`/`lines_removed` (`agent.session.summary`) always emit `0`. An `Edit`/`Write` tool_use's `input` carries the *proposed* edit, not a diff stat, so no reliable added/removed line count can be derived from it without re-implementing diffing — out of scope for this sub-stage."
  This spec predates the current (Edit-only, buggy-for-Write) implementation and is now outdated, exactly as the bug report states.
- **Code-review decision trail for the same limitation**: `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/code-review-final.json`, finding `CR-005` (~lines 97-109, file ref `orchestrator.ts:111`): title "lines_added/lines_removed never computed"; resolution: "Decision taken: amend spec.md rather than implement diff-based line counting... No code change — behavior (always 0) is unchanged, now a disclosed limitation instead of an undisclosed gap." The current partial (Edit-only) computation was implemented **after** this decision and was never reconciled back into the spec — this is exactly the staleness the bug report flags.
- **Design-note doc comment at the call site**, `orchestrator.ts:192-198`: states line counts come from `toolUseResult.structuredPatch` for edits, or a `create` result's `content` for new files, implicitly assuming these are mutually exclusive. This assumption is false for real Write results and is the documented root-cause assumption behind the bug.
- **Design-note doc comment at the implementation**, `session-signals.ts:76-81` (directly above the buggy code): "`toolUseResult.structuredPatch` for edits, and `toolUseResult.type === 'create'` plus the file `content` for new files." Same false mutual-exclusivity assumption.
- A related but distinct metrics spec, `docs/superpowers/specs/2026-08-12-codemie-pi-metrics-design.md:62-63`, already models Write (content lines) and Edit (diff `+` lines) as separate sourcing paths for `total_lines_added`/`total_lines_removed` in a different pipeline — useful cross-reference for the correct conceptual fix shape, though it is not the same code path.

### Derived Conventions

- Known/accepted limitations are documented per-task under an "Open risks" → "Known limitations, accepted as-is for this sub-stage" heading in `spec.md`, rather than left silently undocumented (see CR-005 precedent). This bug's fix should include updating that stale heading or filing a follow-up note, since the spec explicitly claims a limitation that the current code only partially (and incorrectly) addresses.
- Code-review findings requiring a product/spec decision (not a pure code fix) are tracked as `"kind": "decision"` entries with `triage: "decision_needed"` and a `resolution` field explaining the trade-off chosen, in `code-review-final.json`.
- Doc comments at the top of transcript-signal functions explicitly enumerate "Known limitations" / sourcing caveats inline — intended to stay in sync with the task spec's "Open risks" section. Currently out of sync (code evolved past both the spec and its own doc comments without updating either).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts` — unit tests for `collectEditLineStats` (and `countTurns`, `collectCompactions`, `collectClientVersions`, `latestTitle`). Seven `collectEditLineStats`-related cases (L27-85):
  1. L28-37 — null for both counts when no result reports a diff.
  2. L39-44 — counts +/- lines of a `structuredPatch`, ignoring context lines (uses a `patchResult(...)` helper producing `{ structuredPatch: [{ lines: [...] }] }`, **no `type` field at all**).
  3. L46-52 — sums every hunk across multiple results (same `patchResult` shape).
  4. L54-59 — reports `0` (not `null`) when a measured diff changed nothing on one side (same `patchResult` shape).
  5. **L61-70 — "counts the lines of a created file..."** — fixture: `{ type: 'create', content }`, confirmed via direct read to have **no `structuredPatch` field at all**:
     ```ts
     const create = (content: string): SignalLine => ({
       type: 'user',
       toolUseResult: { type: 'create', content },
     });
     ```
  6. L72-76 — "skips a result of type create that has no string content" — `{ type: 'create' }`, also no `structuredPatch`.
  7. L78-84 — tolerates malformed hunks (`{ structuredPatch: [null, {}, { lines: 'nope' }, { lines: [1, '+ok'] }] }`), no `type` field.
  
  **No test in this file ever constructs a `toolUseResult` with both `type: 'create'` AND `structuredPatch` (empty or otherwise) set simultaneously** — this is exactly the real-world shape that triggers the bug, and it is completely untested. No test for `MultiEdit` or `NotebookEdit` exists either; the implementation itself has no `toolName`-based branching at all.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` — integration tests for `buildFullAccumulator`'s summary output. The `editResult` fixture (L326-329) only models an Edit-shaped result (`structuredPatch` with real hunks); there is no Write-shaped fixture (`type: 'create'` + `structuredPatch: []` + `content`) anywhere in this file. **No regression test currently exists for this bug.**
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-summary.test.ts` — unit tests for `buildSessionSummaryEvent`'s `lines_added`/`lines_removed` passthrough; takes `acc.linesAdded`/`acc.linesRemoved` as given inputs, does not exercise `collectEditLineStats` and would not catch this bug.
- `tests/integration/session/metrics-processor.test.ts` — integration test over a **different** pipeline (`claude-file-operation.ts`, legacy `claude` plugin), asserting `fileOperations[].linesAdded`/`linesRemoved` using fixture `tests/integration/session/fixtures/claude/-tmp-private/4c2ddfdc-b619-4525-8d03-1950fb1b0257.jsonl`. Assertions at L274 (`expect(writeOp?.linesAdded).toBeGreaterThan(0)`) and L293 pass today because this is a structurally correct, independent implementation — they do not cover and would not fail for the `claude-code-otlp` bug.
- `tests/integration/session/fixtures/session-196820da.jsonl` and three siblings (`session-3fe1b6bc.jsonl`, `session-624a4a58.jsonl`, `session-9eda1058.jsonl`) are real Claude session fixtures, documented in `fixtures/README.md`, but **not referenced by any `.ts` test file anywhere in the repo** (confirmed via grep) — currently orphaned/unused despite being documented and despite containing the exact bug-triggering real-world shape.

### Real fixture shape (independently confirmed, two sources)

`tests/integration/session/fixtures/session-196820da.jsonl`, line 231, the `toolUseResult` for a Write-tool result:
```json
{
  "type": "create",
  "filePath": "/Users/user/repo/specs/session-lifecycle-detection.md",
  "content": "# Session Lifecycle Detection Specification\n...",
  "structuredPatch": [],
  "originalFile": null
}
```
Identical shape (`type: 'create'`, `structuredPatch: []`, `originalFile: null`) found independently in `tests/integration/session/fixtures/claude/-tmp-private/4c2ddfdc-b619-4525-8d03-1950fb1b0257.jsonl`, line 8. This confirms the bug report's claim precisely and rules out the possibility that the empty `structuredPatch` was a fixture artifact rather than real Claude Code behavior.

No `Edit`, `MultiEdit`, or `NotebookEdit` `toolUseResult` with a `type` field was found in any available fixture — Edit results in these fixtures carry `structuredPatch` without any `type: 'create'`/`'update'` discriminator. No sample `NotebookEdit`/`MultiEdit` `toolUseResult` payload exists anywhere in the repo (only `tool_use` *input* shapes were found, e.g. `orchestrator.test.ts:644-645`, which test `files_edited`/`files_changed` counting, not line stats) — so it cannot be confirmed or ruled out from this repo's fixtures whether those tool types ever carry a `type` field alongside `structuredPatch`. See Risk Indicators.

### Testing Framework and Patterns

- Vitest `^4.1.5` (plus `@vitest/ui ^4.1.5`); scripts run `vitest run --project unit|cli|agent`.
- `session-signals.test.ts` constructs fixtures inline via small local factory/helper closures (`patchResult(...)`, `boundary(...)`, inline `create(...)`) — no shared fixture library; everything hand-built per test, grouped by `describe`/`it` per exported function.
- Integration tests (`metrics-processor.test.ts` etc.) use a "golden session file" pattern: real `.jsonl` captures copied via `copyFileSync` into a temp working dir, then the actual processor is run and assertions made on resulting deltas — a distinct pattern from the inline-object style used in the unit test file.

### Coverage Gaps

- No test constructs a `toolUseResult` with both `type: 'create'` and a `structuredPatch` array (empty or otherwise) simultaneously — the exact real-world shape that triggers the bug.
- No test for `MultiEdit` tool results in `session-signals.test.ts` (and the implementation has no tool-name-based branching at all to distinguish Edit/MultiEdit/Write/NotebookEdit).
- No test for `NotebookEdit` tool results.
- No integration-level test asserts `agent.session.summary`'s `lines_added`/`lines_removed` against a real captured Write-tool fixture — `session-196820da.jsonl`, which has the exact bug-triggering shape, sits completely unused despite being referenced in `fixtures/README.md`.
- No regression test exists in `orchestrator.test.ts` for a Write-shaped `editResult` fixture.

---

## 5. Configuration and Environment

### Environment Variables

Only two env vars are referenced anywhere under `src/agents/plugins/claude-code-otlp/`, neither related to line counting:
- `CLAUDE_CODE_ENTRYPOINT` — read in `claude-code-otlp.plugin.ts:66` for plugin metadata (how Claude Code was launched).
- `CODEMIE_HOME` — only set/deleted in tests (`parse-state.test.ts`, `orchestrator.test.ts`), used for transcript state resolution.

### Configuration Files

- `src/agents/plugins/claude-code-otlp/claude-code-otlp.constants.ts` only defines `CLAUDE_CODE_OTLP_AGENT_NAME = 'claude-code-otlp'` — no line-counting or summary-emission config/flags.
- No plugin-local `package.json`, no feature-flag file, no `config.example.json` entries for OTLP/line counting. Line-counting behavior is pure, non-configurable code logic.

### Feature Flags and Deployment Concerns

- No feature flags related to session-signals/line-counting/summary emission were found.
- The plugin has no separate package/build — it compiles into the main CLI's `dist/` tree, confirmed by locating `dist/agents/plugins/claude-code-otlp` and `dist/cli/commands/proxy/connectors/claude-code-otlp.*`. A fix ships as part of a normal CLI release (current version `0.15.8`), no independent plugin publish step.
- No `CHANGELOG.md` entries specific to `claude-code-otlp` exist; a fix note would go into the main CHANGELOG.
- Because line counts feed a cross-service pipeline (plugin → OTLP spool/event-hooks → external analytics backend), fixing the branch order in `session-signals.ts` does not retroactively correct previously-emitted/stored miscounts already persisted in the externally-hosted analytics backend — that remediation (if desired) is out of scope for this repo.
- The analytics endpoints that exist in-repo are only the upload side (`CLI_ANALYTICS_EVENT_HOOKS`, `CLI_ANALYTICS_METRICS`, `CLI_ANALYTICS_LOGS`, `CLI_ANALYTICS_TRACES` in `src/providers/plugins/sso/sso.http-client.ts:27-30`). The `/v1/analytics/cli-analytics/sessions/{trace_id}` endpoint and the Overview/Repositories/"net lines" rollup UI referenced in the bug report are not present in this repo — they live in a separate, not-locally-available analytics backend service.

---

## 6. Risk Indicators

- **No regression test exists for the exact bug shape**: the real-world `{ type: 'create', structuredPatch: [], content }` co-occurrence is untested in `session-signals.test.ts` and `orchestrator.test.ts`. Any fix must add this case explicitly, or it can silently regress again.
- **Structural root cause, not just a missing case**: `collectEditLineStats` discriminates "what tool produced this result" by field *presence/shape* (`Array.isArray(structuredPatch)`, `type === 'create'`) rather than by tool identity. The doc comments above both `orchestrator.ts:192-198` and `session-signals.ts:76-81` explicitly (and incorrectly) assume `structuredPatch` and `type: 'create'` are mutually exclusive. This means the fix should be ordering/robustness-based (e.g., check `type === 'create'` first, or treat a non-empty `structuredPatch` as authoritative over an empty one, or require tool-name context) rather than a narrow one-line reorder that could leave the same class of bug latent for a different future field combination.
- **No `ToolUseResult` type definition exists anywhere in the repo** — `SignalLine.toolUseResult` is typed as bare `unknown`; shapes are inferred ad hoc at each use site. There is no single source of truth for which tool produces which field combination, raising the risk that a fix based only on currently-observed fixtures may miss an edge case for a tool type without an available sample (see next point).
- **NotebookEdit / MultiEdit payload shape is unverified**: no fixture or test anywhere in the repo contains a real `toolUseResult` sample for `NotebookEdit` or `MultiEdit` with a `type` field. It cannot be confirmed from this repo whether those tools could ever emit a `type` value that would interact with this branch logic. Currently the `else if` only checks `type === 'create'` (Write-specific), so no *currently manifesting* instance of this pattern was found for those tool types — but this is an unverified absence, not a verified safety guarantee. A future addition of a new tool-result `type` value could reintroduce a similar silent-miscount risk if the branch-ordering approach isn't made more robust.
- **"Null means unmeasured, 0 means measured" convention is violated by the bug**: the bug produces a confident `0` rather than `null`, which is strictly more misleading than "unmeasured" to any downstream consumer, since it looks like a verified true zero rather than a gap.
- **Stale spec and doc comments**: `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/spec.md:128-129` still states `lines_added`/`lines_removed` "always emit 0" as an accepted limitation (per CR-005's explicit "no code change" decision), but the code was later changed to compute them for Edit without updating this spec or the two doc comments that assume mutual exclusivity. The fix PR should include a spec/doc-comment update to avoid repeating this staleness.
- **Downstream consumer is entirely outside this repo**: no in-repo code reads `agent.session.summary.lines_added`/`lines_removed` besides its own producer and tests. The actual CLI Analytics UI, `/v1/analytics/cli-analytics/sessions/{trace_id}` endpoint, and Overview/Repositories rollups referenced in the bug report are server-side and not locally verifiable — this analysis cannot confirm end-to-end correctness beyond the emitted event payload; a full fix verification would need coordination with that backend/team, or at minimum relies on trusting the documented event contract.
- **Fix will not retroactively correct historical data**: previously-emitted miscounts in the (external) analytics backend are not corrected by a code fix here — if backfill/correction is desired, that is explicitly out of scope for this repo per the bug report's own framing ("out of scope for this ticket").
- **Related but out-of-scope limitation explicitly noted in the ticket**: files created via Bash (heredoc, scripts) are invisible to this entire line-counting mechanism; the bug report explicitly scopes this out ("would need a git snapshot from sub-stage 1.2"). The fix for this ticket should not attempt to address that.
- **Orphaned test fixtures**: `tests/integration/session/fixtures/session-196820da.jsonl` (and 3 siblings) contain the exact real-world bug-triggering shape but are documented in `fixtures/README.md` and yet wired into zero tests — a good target to wire into a new regression test rather than inventing a synthetic fixture from scratch.
- **Empty prior-task directories found nearby**: `docs/superpowers/tasks/2026-10-02-epmcdme-15423-claude-code-otlp-project-scope/` and `docs/superpowers/tasks/2026-10-06-rejected-write-counted-as-files-written/` exist but are empty — the latter's name suggests a previously attempted/rejected related fix about Write-tool counting; no artifacts remain to confirm details, but its existence suggests this area has had at least one prior unsuccessful attempt at a related fix. Worth a quick git-log check before implementing, in case of a known-rejected approach.
- **codegraph MCP tool unavailable in this environment** — this analysis relied entirely on the filesystem fallback path (Explore agents using Glob/Grep/Read); no semantic/call-graph verification beyond grep-based call-site enumeration was possible. Call-site completeness for `collectEditLineStats`/`countPatchLines`/`countContentLines` was manually grepped and cross-checked by two independent threads with consistent results (only `orchestrator.ts:275` and the test file call it in production/test code; the two helpers are module-private), so confidence remains high despite the tooling gap.

---

## 7. Summary for Complexity Assessment

This task touches a single architectural layer in a focused way: the transcript parsing / signal-extraction layer (`src/agents/plugins/claude-code-otlp/transcript/session-signals.ts`), specifically the `collectEditLineStats` function (lines 83-112). The root cause is a branch-ordering bug — `Array.isArray(structuredPatch)` is checked before `type === 'create'`, and because real Write-tool results carry both an empty `structuredPatch` array and `type: 'create'` simultaneously, the Write-specific branch is permanently unreachable. There is exactly one production call site (`orchestrator.ts:275`, inside `buildFullAccumulator`) and two private helper functions with no other callers anywhere in the repo — the blast radius of a code fix is extremely narrow (likely 1 file for the core fix). The downstream event contract (`session-summary.ts`) requires no change, since it only passes the computed values through.

Technical novelty is low: the fix follows an existing, better pattern already present elsewhere in the codebase (`claude-file-operation.ts` in the legacy `claude` plugin discriminates by `toolName` first rather than by field shape) — this is a bug fix following an established correct pattern, not new architecture. However, the fix should be designed robustly (not just reordering two conditions) given that no `ToolUseResult` type exists to enforce field-combination invariants, and given that NotebookEdit/MultiEdit payload shapes are unverified in this repo (an absence of evidence, not evidence of absence) — this raises the complexity slightly above a trivial one-line change if the fix is meant to be durable against future tool-result shapes rather than narrowly Write-specific.

Test coverage posture is a clear gap: the existing unit tests for the `'create'` case in `session-signals.test.ts` (lines 61-70, 72-76) omit `structuredPatch` entirely from their fixtures, which is precisely why the bug was never caught, and no integration test exercises this exact real-world shape despite real fixtures (`session-196820da.jsonl` and the `metrics-processor.test.ts` fixture) already containing it. The task will require: (1) adding at least one unit test case to `session-signals.test.ts` with both `type: 'create'` and `structuredPatch: []` set, (2) likely a Write-shaped fixture addition to `orchestrator.test.ts`'s integration-style tests, and (3) a spec/doc-comment reconciliation (the EPMCDME-15301 sub-stage 1.1 spec and two doc comments at the implementation/call sites assume a false mutual-exclusivity that should be corrected alongside the code fix). Key risk factors for complexity scoring: narrow code change but a documentation/spec debt to pay down, an unverified edge case for NotebookEdit/MultiEdit, and a downstream consumer (the analytics backend) that is entirely outside this repo and therefore not verifiable end-to-end from here.
