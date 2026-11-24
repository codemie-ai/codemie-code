# Technical Research

**Task**: session summary turns count metrics slash-command claude_code.interaction agent.session.summary
**Generated**: 2026-11-16
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15582 regression (reported 15 Nov 2026 in Jira comment by Auto EPMD-EDP AIAssistant, and confirmed by Anzhalika Staliarova on 16 Nov 2026): The original fix for EPMCDME-15582 (merged, QA-passed 21 Oct 2026 on branch EPMCDME-15582_turns-exclude-local-commands, commit 44efb71c7 'Count a slash command as a turn only when it calls the model') corrected backend turn counting in the analytics rollups (ClickHouse mv_turns_daily and PostgreSQL turns_daily) so that local slash commands with no correlated claude_code.llm_request span are excluded from Turns. However, a regression was found in THIS repo's own client-side session summary: the plugin's 'agent.session.summary' event sends a 'turns' field that still counts every local slash command, including ones that make no model call. Example from QA session 6e25f567-58ad-4a5b-9d0d-6c1d1a3a2f60: 1 typed prompt followed by /context, /sdlc-factory:sdlc-status, /codemie-humanizer, /compact, /cost (recorded as /usage), /init → plugin sent turns:7, but expected ~5 because /context and /usage make no model call and should not count, while /compact, the two skill-invoked slash commands, and /init do call the model and should count. Need to find and fix where 'agent.session.summary' (or similarly named session summary / metrics emission) computes its 'turns' count in this codebase (likely under src/agents/ or a metrics/cost module, possibly shared with or analogous to the vocabulary.py SENTINEL_EXACT classification used server-side — but that file may live in a different (backend) repo, not this one, so look for the equivalent client-side command/sentinel classification here, e.g. related to session metrics, OTLP hook event processing, claude-code-otlp plugin, or opencode-metrics). Also check EPMCDME-17201 context: a related issue where skills invoked as slash commands are misclassified as 'commands' instead of counting as model-calling turns - this suggests the client-side classification of 'is this slash command a model call or not' may need to recognize that some slash commands (skills) DO invoke the model while plain local commands (/context, /usage, /exit, /model related ones) do not.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts:168-177` — `countTurns(lines: readonly SignalLine[]): number`, the exact function that computes the buggy `turns` count. It iterates parsed transcript lines and keeps lines where `isGenuineUserTurn(line)` is true (user role, not meta/sidechain/compact-summary, has text) AND the text does not start with a `SELF_WRITTEN_PREFIXES` entry (`[Request interrupted by user`, `<local-command-stdout>`, `<local-command-stderr>`, `<local-command-caveat>`, `<bash-stdout>`, `<bash-stderr>`, `<bash-input>`, lines 113-121) AND does not start with an `AUTO_PROMPT_PREFIXES` entry (`<task-notification>`, `<agent-message`, line 124). **It never excludes the slash-command invocation line itself** (the `<command-name>…</command-name><command-message>…` wrapper, or bare `/name` text) — this is the regression. Every slash command, model-calling or not, increments `turns`.
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:505` — calls `acc.turns = countTurns(parsedLines)`, wiring the buggy function into the `SessionSummaryAccumulator`.
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:354-364` — `isLocalCommandTurn(parsed): boolean`, an **already-existing but unused-for-turns** classifier that matches `/^\s*<(command-name|command-message|local-command-)/` against a user line's text. This correctly detects "this line is a slash-command wrapper" but is too broad to use as-is for the fix — it would also exclude `/compact` and skill-invoked commands that DO call the model, which must still count per the ticket.
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:370-373` — `isOwnActivityLine()`, uses `isLocalCommandTurn` plus self-written checks, but only feeds `hasOwnLines` (line 521) and a continuation check (line 699) — never `acc.turns`.
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:336-351` — `findSkillInvocation()`, a single-line mirror of Skill tool_use detection (the repo's convention of duplicating a narrow slice of shared logic locally when only one line/name is needed).
- `src/agents/plugins/claude-code-otlp/transcript/session-summary.ts:148` — `buildSessionSummaryEvent()` reads `turns: acc.turns` straight from the accumulator with no re-derivation or filtering; this is a pure mapping layer, not where the fix belongs.
- `src/agents/plugins/claude/session/claude-named-invocations.ts` — `extractOrderedNamedInvocations()` / `extractNamedInvocations()` / `scanCommands()`: the single source of truth for Skill tool_use blocks, Agent/Task tool_use blocks, and slash-command text. Populates `commandInvocations`/`commandsInOrder`/`skillInvocations`/`agentInvocations`. Requires the `<command-message>` sibling tag alongside `<command-name>` to count a real invocation (avoids false positives from prose). Has a separate `forkedSlashPromptIds` path (lines 114-122) for skill-invoked slash commands run as a plain `/name` line with no wrapper — directly relevant to EPMCDME-17201. **All slash commands land in one undifferentiated list — no boolean/flag distinguishes a skill-backed command (model-calling) from a plain local command (non-model-calling).**
- `src/agents/plugins/claude-code-otlp/event-fields/command-fields.ts` — `resolveCommandFields()`, a separate, simpler heuristic for `UserPromptSubmit` hook payloads (`command_name` field). Documents explicitly that true built-ins like `/model` never reach `UserPromptSubmit` at all (only reach the transcript), and that `agent.skill.dispatch` is the authoritative signal for whether a slash command actually dispatched to a skill (i.e., called the model) — rather than re-deriving this from transcript heuristics.
- `src/agents/plugins/claude-code-otlp/transcript/fork-skill.ts` — resolves whether a slash-invoked line was actually a forked skill (`Skill` tool_use / `.forked-skill.marker.json`) — the existing mechanism distinguishing a plain local command from a model-calling skill invocation.
- Unrelated "turns" concepts that must NOT be conflated with this fix: `src/cli/commands/analytics/aggregator.ts` (`MetricDelta.isTurn`/`countTurns` — CLI-side metrics rollup pipeline) and `*.conversations-processor.ts` files (`isTurnContinuation` — conversation-sync continuation pipeline). Neither feeds the `agent.session.summary` OTLP event.

### Architecture and Layers Affected

- **Transcript parsing/signal-extraction layer** — `transcript/session-signals.ts`, `transcript/parse-state.ts`: pure functions over parsed JSONL lines, no I/O. This is where the fix most naturally belongs.
- **Orchestration layer** — `transcript/orchestrator.ts`: owns `SessionSummaryAccumulator`, drives the full-session recompute on Stop/SessionEnd from scratch (not incremental; only `branchCounts` persists incrementally via `TranscriptParseState`), decides what "counts" as real activity. Already has a related-but-not-reused classifier (`isLocalCommandTurn`).
- **Event-building layer** — `transcript/session-summary.ts`: pure mapping from accumulator + named invocations into the final `agent.session.summary` object; no business logic of its own.
- **Named-invocation/shared classification layer** — `claude/session/claude-named-invocations.ts`: shared by the live MetricsProcessor and the session-adapter's reparse path; single source of truth for skill/agent/command name extraction.
- **Downstream, not implicated** — OTLP spool/forwarder layer (`src/providers/plugins/sso/proxy/plugins/otlp-spool/*`): forwards the already-built summary event; not involved in turns computation.
- Per `docs/ARCHITECTURE-OTLP-PLUGIN.md`, the dispatch pattern mandates a flat if-chain per event name in `evaluate()`, no `switch` — this fix stays entirely inside the pure-function signal layer and does not touch adapter dispatch.

### Integration Points

- `orchestrator.ts` → `session-signals.ts` (imports `countTurns`, `isGenuineUserTurn`, etc.)
- `orchestrator.ts` → `claude-named-invocations.ts` (imports `extractOrderedNamedInvocations`)
- `orchestrator.ts` → `session-summary.ts` (builds accumulator consumed by `buildSessionSummaryEvent()`)
- `session-summary.ts` → `session-signals.ts` (type-only import of `Compaction`) and `synthetic-model.ts` (`isSyntheticModel`)
- One-directional: nothing imports back from `session-summary.ts` into `orchestrator.ts`; `orchestrator.ts` sits at the top of this subtree.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` notes the Cowork event producer (`transcript/continuation.ts`) reuses the same two pure tests (`isGenuineUserTurn`/`isSelfWrittenUserText`) to pick transcript lines for `agent.prompt.submit` — any change to these shared functions must stay consistent with (or deliberately and visibly diverge from) that Cowork reuse.
- No env vars, feature flags, config files, or deployment manifests govern this logic — turn/command classification is unconditional, pure, in-process transcript parsing. No CI/wire-format changes are implicated.

### Patterns and Conventions

- "Own activity" vs "turn" are two separate, inconsistent concepts living in the same subsystem: `isOwnActivityLine`/`isLocalCommandTurn` (orchestrator.ts) already correctly exclude local-command lines for idle/continuation purposes, but `countTurns` (session-signals.ts), which actually produces the `turns` field, was never wired to reuse that exclusion. This is the structural root cause of the regression.
- Slash-command detection requires the `<command-message>` sibling tag alongside `<command-name>` to avoid false positives from prose; the same prefix test is duplicated (slightly differently) between `claude-named-invocations.ts` and `orchestrator.ts`'s `isLocalCommandTurn`.
- Accumulator pattern: `orchestrator.ts` recomputes the whole `SessionSummaryAccumulator` from scratch on every Stop/SessionEnd by re-scanning `parsedLines` (not incremental).
- Pure-function/no-I/O separation is a hard, explicitly documented convention in `session-signals.ts` and `session-summary.ts` ("no I/O" / "never reads a transcript" top-of-file comments) — any fix should preserve this.
- `command_name` resolution in `command-fields.ts` is purely syntactic and explicitly defers to `agent.skill.dispatch` as the authoritative signal for whether a slash command actually dispatched to a skill — this is the natural signal to consult for "did this slash command call the model," rather than re-deriving it purely from transcript text heuristics.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `docs/ARCHITECTURE-OTLP-PLUGIN.md` (371 lines, living doc) — the authoritative reference for the `OtlpAgentAdapter` pattern used by `claude-code-otlp`. Directly describes `session-signals.ts`'s `countTurns`/`isGenuineUserTurn`/`isSelfWrittenUserText` as "the one rule of a user turn," and documents that the Cowork producer reuses the same two tests. Also documents `command-fields.ts`'s `resolveCommandFields` and its explicit deferral to `agent.skill.dispatch` for skill-backed commands, and `fork-skill.ts`'s role resolving forked-skill slash invocations — the exact seam relevant to EPMCDME-17201.
- `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/integration/external-integrations.md`, `.ai-run/guides/integration/exposed-api.md` exist but do not mention turns/session-summary specifically; `docs/ARCHITECTURE-OTLP-PLUGIN.md` is the authoritative doc for this domain per `AGENTS.md`'s own cross-reference.

### Architectural Decisions

- `CHANGELOG.md:35` — records the prior, already-shipped client-side fix in this exact area: turn count no longer includes self-written lines (interrupted request, local/`!` command output, the `!` command itself) or automatic prompts (finished background task, agent message). This landed the current `SELF_WRITTEN_PREFIXES`/`AUTO_PROMPT_PREFIXES` exclusions but explicitly did **not** exclude slash commands that never call the model — i.e., today's bug was already a known boundary of that earlier fix, not touched by it.
- `CHANGELOG.md:100` — "Forked skills and slash commands are recognised in analytics" — the fork-skill/command_name machinery that EPMCDME-17201 builds on.
- No ADR or prior task/spec folder exists for EPMCDME-15582 or "turns-exclude-local-commands" under `docs/superpowers/tasks/` or `docs/superpowers/specs/` in this repo; no file mentions EPMCDME-15582 or EPMCDME-17201 by ticket ID except this task's own `.state.json`. Confirms the backend `vocabulary.py`/`SENTINEL_EXACT` classification lives in a different (backend) repo — no `*sentinel*` or `*vocabulary*` file exists client-side.

### Derived Conventions

- The client-side analogue of the backend's "count a slash command as a turn only when it calls the model" must distinguish a transcript line that is `/command` text with no subsequent assistant/model response (pure local command: `/context`, `/usage`/`/cost`, `/exit`, `/model`) from one that triggered a real model turn (`/compact`) or a skill dispatch (`/sdlc-factory:sdlc-status`, `/codemie-humanizer`, `/init`) — EPMCDME-17201 is explicitly about not misclassifying the latter as plain local commands.
- No existing file encodes a hardcoded denylist of known model-free local commands analogous to the backend's `SENTINEL_EXACT`. A fix needs to either (a) introduce such a list/constant client-side, or (b) correlate the command line with whether a model-calling signal (Skill tool_use, assistant response, `agent.skill.dispatch`) follows it — mirroring the backend's span-correlation approach instead of a static list.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts` — unit tests for `countTurns()`/`isGenuineUserTurn()`. The `describe('countTurns', …)` block (lines 141-201) includes a test named "counts typed, pasted and command prompts, not lines Claude Code writes itself or auto prompts" (lines 181-200) that **asserts a `<command-name>/plan</command-name>` line counts as a turn** (expected total = 4). This encodes today's buggy behavior and will need to change as part of the fix.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` — integration-style tests over the full `buildFullAccumulator`/`mainEvents` pipeline.
  - Lines 772-820, `'derives lines, turns, commands, compactions, versions, title and branch from the transcript'`: builds `userLine('hello')` + 3 `commandText()` lines (`/commit`, `/plan`, `/plan`) and asserts `summary.turns === 4` (every slash command counts). Needs updating/splitting once local vs. model-invoking commands are distinguished.
  - Lines 822-831, `'counts typed prompts as turns, not an interrupt line or a task notification'` — only covers self-written/auto-prompt exclusions, not local-command exclusion.
  - Lines ~3601-3650 and 3986 — turns counting across continued/resumed sessions (uuid-copy exclusion); unrelated to the local-vs-model-invoking distinction.
  - `commandText(name)` test helper (lines 407-409) generates a generic command block with no way to mark "this one called the model" — the fixture helper itself will need extending for regression tests.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-summary.test.ts` — only tests that `event.turns` passes through `acc.turns` verbatim (lines 383-402); no turn-counting logic of its own, but a good post-fix sanity-check target.
- No test anywhere under the top-level `tests/` integration directory references `'agent.session.summary'` by name (zero grep hits) — turns/session-summary coverage exists only as unit/integration-lite tests colocated under `src/agents/plugins/claude-code-otlp/transcript/__tests__/`.

### Testing Framework and Patterns

- Vitest `^4.1.5` (per `package.json`), run via `vitest run --project unit|cli|agent`; `test:coverage` uses `vitest run --project unit --coverage`.
- Unit tests colocated in `__tests__/` next to source files; top-level `tests/` reserved for integration/CLI/live/helper suites.
- Plain-object/local factory functions used as lightweight inline fixtures (`user(...)`, `patchResult(...)`, `boundary(...)`, `commandText(name)`) rather than static fixture files for this domain (unlike `tests/integration/session/fixtures/claude/*.jsonl` used elsewhere for conversation/metrics processors).
- `orchestrator.test.ts` writes real transcript fixture files to disk via `writeTranscript(name, lines)` and drives the full `mainEvents(sessionId, transcriptPath, hookName)` pipeline end-to-end, then filters for `agent.session.summary`/`agent.usage.request` events.
- `emptyAccumulator()`/`emptyNamed()` factory helpers in `session-summary.test.ts` build minimal valid objects, mutated per test.

### Coverage Gaps

- No test anywhere currently verifies the correct EPMCDME-15582 client-side behavior (local-only slash command excluded from `turns`); existing tests assert the opposite.
- No test verifies that `/compact`, skill-invoked slash commands, or `/init` still count as turns under a corrected implementation.
- `commandText()` helper has no variant for "local command with no model call" vs. "model-invoking command" — needs extending to write the regression tests.
- No integration-level (`tests/integration/`) coverage exists for client-side `agent.session.summary` turns computation at all.
- No existing test pattern correlates a command line with "has a following `agent.usage.request`/model response" — whichever signal the fix uses will need new test scaffolding.

---

## 5. Configuration and Environment

### Environment Variables

- None relevant. `process.env` reads in this plugin area are infra/auth related only (`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `CLAUDE_CODE_ENTRYPOINT`, `CODEMIE_HOME`, `CODEMIE_SESSION_ID`) — unrelated to turn/command counting.

### Configuration Files

- None govern turns/command classification. The relevant files are pure TS logic, not config: `session-signals.ts` (counting logic), `orchestrator.ts` (wiring), `session-summary.ts` (event assembly), `claude-named-invocations.ts` (command/skill classification), `command-fields.ts` (UserPromptSubmit heuristic).

### Feature Flags and Deployment Concerns

- None found. Turn counting and command classification are unconditional pure-function logic with no runtime switch. No OTLP wire-format change, no CI/manifest change implicated — the fix is confined to TS logic plus its colocated tests (`session-signals.test.ts`, `orchestrator.test.ts`, `session-summary.test.ts`).

---

## 6. Risk Indicators

- Core fix location is clear and narrow (`countTurns` in `session-signals.ts`), but the correct exclusion predicate is NOT a simple reuse of the existing `isLocalCommandTurn` — that helper is too broad (would also exclude `/compact` and skill-invoked commands that must still count), so new, more precise classification logic must be designed, not just wired in.
- No existing client-side signal cleanly answers "did this slash command invoke the model" at the point `countTurns` runs — `claude-named-invocations.ts`'s command list is undifferentiated, and the two realistic signal sources (a static denylist of known non-model commands, or correlating with a following Skill tool_use/`agent.usage.request`/`agent.skill.dispatch`) each carry design tradeoffs the fix must choose between.
- EPMCDME-17201 (skill-invoked slash commands misclassified) is explicitly coupled to this fix in the ticket — the chosen classification approach must simultaneously satisfy both tickets, which raises scope ambiguity (is this a single combined fix, or does 17201 need separate follow-up work in `claude-named-invocations.ts`/`fork-skill.ts`?).
- Existing tests encode the buggy behavior as expected behavior (`session-signals.test.ts` and `orchestrator.test.ts` both assert slash commands always count) — the fix requires deliberately changing asserted expectations in at least two test files, not just adding new tests; regression risk if any other caller depends on current `countTurns` semantics.
- Zero integration-level (`tests/integration/`) coverage exists for `agent.session.summary` turns at all — the only safety net is the colocated unit/integration-lite tests under `src/agents/plugins/claude-code-otlp/transcript/__tests__/`.
- The backend's classification vocabulary (`SENTINEL_EXACT`) explicitly lives in a different repo and was not found here — the client-side equivalent must be built fresh with no existing reference list to copy, raising risk of behavioral drift between backend rollup counts and client-side `agent.session.summary` counts if the two classifications diverge (e.g., new local commands added to Claude Code in the future need to be added in two places/repos).
- `orchestrator.ts` recomputes accumulators from scratch on every Stop/SessionEnd by re-scanning all `parsedLines` — any new classification logic added to this hot path should remain a pure, allocation-light function to avoid performance regression on long sessions.

---

## 7. Summary for Complexity Assessment

This is a narrowly-scoped but logic-subtle bug fix confined to a single architectural layer: the pure, I/O-free transcript-signal-extraction layer in `src/agents/plugins/claude-code-otlp/transcript/`. The primary production change is in one function, `countTurns()` in `session-signals.ts` (lines 168-177), with a secondary question of whether to extract/share a new classification predicate with (or instead of) the existing `isLocalCommandTurn()` in `orchestrator.ts`. No config, env vars, feature flags, or deployment artifacts are involved, and no cross-service or cross-repo change is required for the client side — the backend rollup fix (a separate repo) is already shipped and QA-passed; only this repo's `agent.session.summary` event needs correction. Estimated change surface is small in file count (1-2 source files touched) but the logic itself requires careful design: the fix cannot simply reuse `isLocalCommandTurn` because it is overly broad and would wrongly exclude `/compact` and skill-invoked commands.

Technical novelty is moderate: there is no existing client-side equivalent of the backend's `SENTINEL_EXACT` vocabulary to copy, so the implementer must choose between a static denylist of known non-model-calling commands (mirroring the backend's apparent approach, simpler but requires manual upkeep as Claude Code evolves) or a correlation-based approach (checking for a following Skill tool_use / `agent.usage.request` / deferring to `agent.skill.dispatch`, more robust but a larger logic change touching the orchestrator's line-scanning). This design decision is the main source of complexity and should be resolved explicitly before implementation, as it also determines how cleanly EPMCDME-17201 (skill-invoked slash commands misclassified) can be addressed in the same change.

Test coverage posture is mixed-to-negative: there is reasonable existing unit/integration-lite coverage of `countTurns` and the full summary-building pipeline, but every existing test currently asserts the buggy behavior as correct, meaning the fix requires modifying existing assertions (regression risk) in addition to adding new ones for the previously untested local-vs-model-invoking distinction. There is zero top-level integration-suite coverage for this event at all. Key risk factors for complexity scoring: (1) the classification-signal design choice described above, (2) the coupling to EPMCDME-17201's scope, and (3) the need to update pre-existing test expectations rather than purely add net-new tests.
