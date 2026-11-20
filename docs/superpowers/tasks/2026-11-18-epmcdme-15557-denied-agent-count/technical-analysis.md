# Technical Research

> **SUPERSEDED IN PART by commit `ece9dd1d` (2026-11-18, "count an Agent call only once its result has succeeded"). Read the shipped code and `CHANGELOG.md` for the current behavior.**
> - The "a call with no result yet (pending) is still counted" rule below was **reversed**: an `Agent`/`Task` call that has an `id` is counted only when its `tool_result` has arrived without `is_error`/`isError`. A pending call is not counted (a later denial could not be subtracted); an id-less `tool_use` still counts.
> - The API was renamed: the `failedToolUseIds` set is now `toolOutcomes: ReadonlyMap<string, ToolOutcome>` (`'ok' | 'failed'`), built by the new exported `collectToolOutcomes(messages)`. `collectFailedToolUseIds` is kept as a thin wrapper over it. `run-prompts.ts` takes `toolOutcomes` (required), and the OTLP orchestrator, `ClaudeSessionAdapter.extractMetrics` and `MetricsProcessor` pass `collectToolOutcomes(messages)`.
> - Follow-up from the second PR review: in the live `MetricsProcessor` path an `Agent`/`Task` call is counted by the run that **emits its assistant group** (`emittedGroupLines`, a required option of `collectRunPromptsAndInvocations`), not by the message slice. A group held back by an unresolved call while a later group is emitted lies behind the next run's slice and would otherwise lose its call permanently. Lines outside any group and the final pass's trailing lines still come from the slice. Pinned by two `claude-run-baseline.test.ts` tests and two `run-prompts.test.ts` tests.
> - This research is a record of the state before implementation. Its "Recommended minimum: ... leave pending calls with no result counted" and the `claude-run-baseline.test.ts:227` regression note describe the old design; that test is now named "counts a Task invocation once, in the run whose group resolves it (not while it is pending)" and still passes, because the live processor only counts groups whose `tool_use` blocks are all resolved.

**Task**: claude named invocations agent count session summary otlp transcript denied tool_result
**Generated**: 2026-11-18
**Research path**: filesystem (codegraph MCP tool unavailable in this environment)

---

## 1. Original Context

Jira EPMCDME-15557 — "[CLI Analytics] Denied Agent call appears as a dispatch and absorbs the rest of the turn's cost" (Bug, Major, parent epic EPMCDME-12917, status In Progress). This repo is the CodeMie CLI (codemie-code); the backend (codemie, Python) is a separate repo, so only CLI-side changes are in scope here, but document the backend interplay.

Original report (Klim Starykau): An Agent tool call that was denied and never started is shown as a real agent dispatch in CLI Analytics (timeline row 'agent · Explore', duration 0, absorbing the rest of the turn's cost; Agents=2, Agent subtypes lists Explore:1). Evidence: the OTLP spool .hooks.ndjson has PreToolUse Agent (Explore) but no SubagentStart / PostToolUse / SubagentStop. Backend root cause: reader.py get_session_detail_dispatches builds a row for every tool span with a subagent_type. Suggested fix: require an execution span or SubagentStart before creating an agent dispatch (or flag as not started with zero cost), and exclude non-started dispatches from agent_count and Agent subtypes.

Comment 1 (Klim, 26 Oct 2026): Verification PASSED on main @ 6c9e6bc9 (CLI 0.16.0) for claude, codemie-claude, Claude desktop app — denied Explore/claude-code-guide calls (PreToolUse only, no SubagentStart/PostToolUse/SubagentStop) have no Timeline row, not counted in agent_count, cost stays in the main thread. Not covered: original trigger (auto-mode classifier returning no verdict); used hook denial and "No" at the permission prompt instead.

Comment 2 (QA bot, 17 Nov 2026): Verification FAILED on production, CLI 0.16.9 (Claude Code 2.1.323), backend 2.68.0. Session 77b4eb92-71a9-4820-83de-d8a20f9bc670: Agent (Explore) call denied by a project PreToolUse hook, no other agent ran. Timeline row absent (OK) but session agent_count = 1.

Comment 3 (QA bot, 17 Nov 2026): Repro: project .claude/settings.json PreToolUse hook matcher "Agent|Task" returning permissionDecision deny; `codemie-claude --allowedTools "Read Agent" -p "Use the Agent tool to launch an Explore subagent ..."`. Transcript has exactly 1 Agent tool_use (subagent_type Explore) with result "QA-15557 deny"; no SubagentStart/SubagentStop. Expected agent_count 0. Actual: no Timeline row (OK), cost not absorbed (OK), Agent subtypes = [] (OK), but session agent_count = 1. Root cause per QA: CLI `src/agents/plugins/claude/session/claude-named-invocations.ts`, `extractOrderedNamedInvocations` (~L105-109 in dist) increments agentInvocations for every Agent/Task tool_use with input.subagent_type without checking its tool_result (denied/error). `claude-code-otlp transcript/session-summary.ts` sends it as `agent.session.summary.agents`. Backend: reader.py (~L3081-3108) computes agent_count = greatest(tool_facts_daily.agent_count + hook fallback, _SUMMARY_MAP_TOTAL(agents)); the rollup side already excludes non-executed calls (rollups.py, executed_agent_call_span), so the summary-map total (1) wins. Fix options: CLI counts only Agent calls whose tool_result is not denied/error, or backend stops letting the summary map override the executed-span count. Note: the QA bot did not re-read the delivered agent.session.summary record, so the value 1 is inferred, not directly observed.

Task for this repo: determine exactly where the CLI computes the agent count/summary map sent in agent.session.summary (claude-named-invocations.ts, claude-code-otlp session-summary.ts, any other consumers incl. other agents/platform adapters e.g. Claude desktop/cowork, copilot) and how a denied/errored/rejected Agent|Task tool_use can be identified from the transcript's tool_result (is_error, content text, user rejection markers, hook denial text). Identify all callers/consumers of extractOrderedNamedInvocations and the shape of its output, existing tests, and how a "started" agent call can be distinguished (e.g. tool_result present and not is_error, toolUseResult with agentId, sidechain/subagent transcript presence). Also check whether the same flaw affects other named invocations counted there (skills, slash commands, MCP, etc.) and whether Task vs Agent tool names are both handled.

---

## 2. Codebase Findings

### Existing Implementations

All paths relative to repo root. Line numbers are from the research pass and may drift.

- `src/agents/plugins/claude/session/claude-named-invocations.ts` (L1-159) — single source of truth for skill / agent / command name counts.
  - Signatures: `extractNamedInvocations(messages: readonly unknown[]): NamedInvocationCounts` (L72); `extractOrderedNamedInvocations(messages, forkedSlashPromptIds?: ReadonlySet<string>): OrderedNamedInvocations` (L82-85); `plainSlashCommandName(content)` (L51).
  - Output shape (L19-28): `NamedInvocationCounts { skillInvocations, agentInvocations, commandInvocations: Record<string, number> }`; `OrderedNamedInvocations` adds `commandsInOrder: string[]`. `extractNamedInvocations` just drops `commandsInOrder`.
  - `RawBlock` (L30-35) has only `type`, `name`, `input.{skill, subagent_type}`, `text`. It has no `id` and no `tool_use_id`.
  - Counting is a single stateless pass over `content[]` of each message (L137-155). THE FLAW is at ~L147: an `Agent` or `Task` `tool_use` with a non-empty string `input.subagent_type` does `bump(agentInvocations, subtype)` unconditionally. `tool_result` blocks are never read, and `tool_use.id` is never read.
  - `Agent` (this CLI) and `Task` (standard Claude Code) are treated identically. Calls with no `subagent_type` (general-purpose) are deliberately ignored.
- `src/agents/plugins/claude-code-otlp/transcript/session-summary.ts` (L108-163) — `buildSessionSummaryEvent` is a pure mapper that never reads a transcript. L145 is `agents: named.agentInvocations`, a pass-through with no filtering. A fix does not belong here (precedent: EPMCDME-15582 fixed the extractors and accumulator, not the mapper).
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts` — builds the summary input.
  - L253-293: `ContentBlock`, `TranscriptLine`, and the module-private `collectErrorToolUseIds(parsedLines): Set<string>`, which returns `tool_use_id`s where `is_error === true || isError === true`.
  - L399-524: `buildFullAccumulator`. L499 is `extractOrderedNamedInvocations(parsedLines, slashPromptIds)`, once per Stop/SessionEnd, over the whole main transcript. `parsedLines` is `keepFirstByUuid(allLines.filter(isCountedTranscriptLine))`, so tool_results are available at this call site. L447 and L469-491 already use `collectErrorToolUseIds` for `toolCalls[name].errors`.
  - L746-775: Stop/SessionEnd summary build; `buildSessionSummaryEvent` is called at ~L759.
  - L1375-1442: `scanSubagentTranscript`. L1426 calls `extractNamedInvocations(parsedLines)` and uses only `skillInvocations` (for `agent.subagent.usage`'s `skillsInvoked`). Agents are not used there.
- `src/agents/plugins/claude-code-otlp/transcript/fork-skill.ts` (L99-190, L438-445) — already has "did this Agent/Task launch" logic.
  - `failedToolUseIds` (filled when `block.is_error === true`, L184; comment at L106: "tool_use_ids whose result is an error or denial: no launch happened").
  - `resultAgentIdByToolUseId` from `resultAgentId(line, block)` (L139): `line.toolUseResult.agentId`, else a JSON text result's `agentId`.
  - An Agent/Task call with a result `agentId` is "started"; with no agentId and not in `failedToolUseIds` it is "open" (may still start a child).
  - It imports `plainSlashCommandName` from the extractor (L41).
- `src/agents/plugins/claude-code-otlp/event-fields/tool-fields.ts` (L61-80, `resolveForkAgentFields`) — already treats denied/failed Agent calls as a known case: `fork_agent_id` is omitted and `Task` is never stamped.
- `src/agents/plugins/claude/session/processors/run-prompts.ts` (L25-70, `collectRunPromptsAndInvocations`) — L47 calls `extractNamedInvocations([...runLines, ...trailingLines])` on a SLICE of messages.
- `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts` (L195-394) — live MetricsProcessor. Builds `toolResultsMap` (L215-242, `is_error` only), defers groups with an unresolved tool_use (`processDelta` L287-303), and at L375/L386-388 attaches `skillInvocations/agentInvocations/commandInvocations` to the first `MetricDelta` (`core/metrics/types.ts:68`).
- `src/agents/plugins/claude/claude.session.ts` (L329-400, `extractMetrics`) — L336-351 builds `toolResultsMap` and `toolUseResultMap` (`is_error` or `isError`). L390 calls `extractNamedInvocations(messages)` over the full message list. Also invoked from `src/telemetry/clients/claude-desktop/claude-desktop.parser.ts:115-134`.
- `src/cli/commands/analytics/cost/dispatch-extractor.ts` (L57-71, `completeTool`) — the richest existing "failed / async / started" classification, pairing by `tool_use_id`:
  - `failed = block.is_error || block.isError || block.status==='failed' || ack?.is_error || ack?.isError || ack?.status==='failed'`, with `ack = row.toolUseResult`.
  - `async = ack.isAsync || ack.status==='async_launched'` gives `status:'incomplete'`; carries `ack.agentId`. Types in `claude-native.ts:9-34`.
- `src/telemetry/runtime/cowork/cowork-events.ts` (L128-179) — pairs via `state.openTools[id]`; emits `agent.tool.error` on `is_error`/`isError`; reads `toolUseResult.agentId` and `status === 'async_launched'`.

Transcript shapes (from code and fixtures):
- Assistant line: `{type:'assistant', uuid, promptId?, message:{role:'assistant', content:[{type:'tool_use', id, name, input}]}}`.
- User result line: `{type:'user', toolUseResult?, message:{role:'user', content:[{type:'tool_result', tool_use_id, is_error?, content: string | [{type:'text', text}]}]}}`.
- Started synchronous Agent: `toolUseResult:{status:'completed', agentId, agentType, content:[...], totalDurationMs, ...}` (fixtures `event-fields/__tests__/fixtures/foreground-agent-result.json`, `fork-skill.test.ts:198`). Background Agent: `status:'async_launched'` plus `agentId`.
- Subagent transcripts live at `<session>/subagents/agent-<id>.jsonl` with a `.meta.json` carrying `toolUseId`, `agentType`, `spawnDepth`, `requestShape`. A denied call has none.

### Denied / errored / rejected detection signals

- Structural signal only: `tool_result.is_error === true` (or camelCase `isError`), matched by `tool_use_id` to `tool_use.id`. This is the established repo convention (orchestrator, fork-skill, claude.session, dispatch-extractor, cowork).
- NO code in `src` matches denial text ("doesn't want to proceed", "Permission to use", "PreToolUse:... hook"). Verified by grep. Text matching is unneeded precedent-wise, and the EPMCDME-15582 lesson was to move from name/text lists to Claude Code's own structural signal.
- UNVERIFIED: that a hook-denied Agent call produces `is_error: true`. No repo fixture contains a real hook-deny result. The QA report only gives content "QA-15557 deny". Confirm against the real transcript of session 77b4eb92-71a9-4820-83de-d8a20f9bc670 or a fresh repro. If `is_error` is absent for hook denials, the fix must also use the positive "started" signal (below).
- Positive "started" signals: `toolUseResult.agentId` present (fork-skill's rule); `toolUseResult.status` of `completed` or `async_launched`; presence of `subagents/agent-*.jsonl` with meta `toolUseId`. A denied call has no `agentId` and may have only a string result.
- Hook-side: `claude-code-otlp.plugin.test.ts:793-799` has a PostToolUse with `tool_response: {status:'denied'}` and no agentId, which is not stamped.

### Architecture and Layers Affected

- Plugin / session layer: `src/agents/plugins/claude/` (extractor, `claude.session.ts`, metrics-processor, run-prompts) — shared by the `claude` and `claude-acp` plugins and by Claude Desktop (`claude-desktop.parser.ts`).
- OTLP transcript layer: `src/agents/plugins/claude-code-otlp/transcript/` (`orchestrator.ts`, `session-summary.ts`, `fork-skill.ts`) — the only producer of `agent.session.summary.agents`.
- Telemetry runtime: `src/telemetry/runtime/cowork/` (Claude Desktop Cowork) reuses the Claude Code orchestrator (`CoworkEventProducer.ts:5-6`); `cowork-events.ts:348` only masks `branch_dominant` on the summary. A fix in the extractor or orchestrator therefore covers Cowork too.
- External / backend (out of repo): codemie Python `reader.py` consumes the summary.
- Layering stays `CLI -> Registry -> Plugin`. The extractor is a pure function over `unknown[]` and layer-neutral.

### Integration Points

- Callers of the extractor (production):
  1. `orchestrator.ts:499` — `extractOrderedNamedInvocations`, full main transcript; feeds `agent.session.summary` (`agents`, `skills`, `commands`) and `acc.commandsInOrder`. (The L418 call with `[]` is just the empty fallback.)
  2. `orchestrator.ts:1426` — `extractNamedInvocations`; only `.skillInvocations` used (`agent.subagent.usage`).
  3. `run-prompts.ts:47` via `claude.metrics-processor.ts:375` — live per-run SLICE; feeds legacy `MetricDelta` metrics sync.
  4. `claude.session.ts:390` — `extractMetrics` over the full message list; also used by `claude-desktop.parser.ts:134`.
  - Type-only imports of `NamedInvocationCounts`: `session-summary.ts:19`, `codex/session/codex-named-invocations.ts:13`, `pi/session/pi-named-invocations.ts:32`. `fork-skill.ts:41` imports `plainSlashCommandName`.
- Other agents' `agentInvocations` use their own logic and are not on the Claude path: Codex (`codex-named-invocations.ts:87-122`), Kimi (`kimi.metrics-processor.ts:346-370`), Pi (`pi-named-invocations.ts`). Copilot (`copilot-cli-otlp.usage.ts:9`, `otlp-spool/copilot-usage-enrichment.ts:35`) emits `agent.session.summary` with no `agents` / `agentInvocations` field, so it is not affected.
- Hook events: `SubagentStop` is listed in `core/types.ts:653`. There is no SubagentStart-based agent counting. The summary count is purely transcript-derived.
- Backend (not in this repo): `reader.py` ~L3081-3108 computes `agent_count = greatest(tool_facts_daily.agent_count + hook fallback, _SUMMARY_MAP_TOTAL(agents))`. `rollups.py` already excludes non-executed calls (`executed_agent_call_span`). The summary-map total therefore overrides the correct 0. The backend takes the LATEST summary by timestamp (`rollups.py:1044-1051`, per `docs/superpowers/tasks/2026-10-28-epmcdme-16154-subagent-output-tokens/backend-plan.md`). The backend source is unavailable here, so this is taken from the ticket. A backend-side hardening (summary map must not raise count above executed-span count) is a separate ticket and out of scope.

### Same flaw in other named invocations

- Skills (`claude-named-invocations.ts` ~L139-141): the `Skill` tool_use is counted with no result check, so a denied or errored `Skill` call is over-counted into `skills` (`agent.session.summary.skills`, `skillInvocations`). Same root cause. Recommend fixing in the same change, or at least documenting it. Note the spec for 15301 says `skills` comes from `extractNamedInvocations().skillInvocations`.
- Slash commands: counted from user text wrappers (`<command-message>`), not tool_use, so no tool_result exists. Not affected.
- MCP / other tools: not part of named invocations. They are only in `acc.toolCalls[name]` (`orchestrator.ts:469-491`), which already correlates errors (`calls` counted for every tool_use, `errors` only for `is_error` ones).
- Task vs Agent: both handled identically in the extractor (pinned by `claude-named-invocations.test.ts:36`). `fork-skill` and `tool-fields` also handle both. A fix must apply to both names.

### Patterns and Conventions

- Error correlation convention: `is_error === true || isError === true` matched by `tool_use_id`, with a pre-pass to collect ids (orchestrator Pass 1, `collectErrorToolUseIds`; fork-skill `failedToolUseIds`; claude.session `toolResultsMap`).
- Extractors are pure, never throw, and skip malformed fields.
- ESM with `.js` import suffixes, `@/` alias, explicit return types on exports, no `any`.
- `session-summary.ts` stays a pure mapper. Fixes go in the extractors or accumulator.
- Design options for the fix (for the planner, not a decision):
  - A. Add `id?: string` to `RawBlock` and an optional `failedToolUseIds?: ReadonlySet<string>` parameter to `extractOrderedNamedInvocations` / `extractNamedInvocations`. The extractor skips Agent/Task/Skill tool_uses whose `id` is in the set. Callers pass the set: the orchestrator reuses `collectErrorToolUseIds` (export it or move it to a shared helper); `claude.session.ts` and the metrics-processor build it from their existing maps. Blocks with no `id` stay counted (existing tests rely on this).
  - B. Compute the error set inside the extractor via a pre-pass over the same message array. This is the simplest, but it is wrong for sliced inputs (`run-prompts.ts`), where the result may be outside the slice.
  - C. Count only "started" calls, requiring a positive signal (`toolUseResult.agentId` or `status` in `completed` / `async_launched`) as in fork-skill. This is stricter and robust against a hook denial without `is_error`, but riskier. A call with no result yet (pending / in flight) must still count, as `claude-run-baseline.test.ts:227` requires. It also needs care for Claude versions that do not write `toolUseResult.agentId`.
  - Recommended minimum: skip only calls whose result is a known error or denial, and leave pending calls with no result counted. Add the positive-signal check only if the repro shows hook denial arrives without `is_error`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/` exists; relevant: `architecture/architecture.md` (plugin 5-layer), `development/development-practices.md` (logger.debug, no console.log), `standards/code-quality.md` (ESLint zero warnings, JSDoc on exports, comment the why), `testing/testing-patterns.md` (Vitest, co-located `__tests__`), `quality-gates.md`, `project.md`, `standards/git-workflow.md`. Security, integration, usage and the other guides were not read in this pass.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md`: no section on how `agents` / `skills` counts are built. Relevant lines: ~98 (`buildEvent`), ~203 (event-fields table: `fork_agent_id` exists only for a Skill/Agent call whose uncut result names the agent, and "`Task` is never stamped"), ~205 (event-id scheme), ~240 (fork-skill: Agent/Task/Skill calls without a result stay "pending"), ~241 (`session-signals.ts`, `countTurns`).
- Spec/plan for the summary contract: `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/spec.md:83`, `plan.md:227`.
- Nothing in `docs/` or `openwiki/` mentions EPMCDME-15557. `openwiki/` has no page on named-invocation counting.
- The task folder `docs/superpowers/tasks/2026-11-18-epmcdme-15557-denied-agent-count/` only had `.state.json` (flow `sdlc-light`, branch `fix/EPMCDME-15557-denied-agent-count`). No spec or plan existed before this file.

### Architectural Decisions

- No ADR covers the summary fields (stated in the 15582 analysis).
- Recorded behavior: only calls with a `subagent_type` count; both `Agent` and `Task` count (extractor header comment L9-11, tests L36 and L52); a single shared extractor feeds both the live MetricsProcessor and the session adapter parse path, so any fix must stay consistent across them.
- Precedent: EPMCDME-15582 (PR #824, commit de6bbf50) replaced a name denylist with Claude Code's own structural signal (`<local-command-caveat>`). The analogue here is the `tool_result` error flag, not denial-text matching. Its task folder `docs/superpowers/tasks/2026-11-16-session-summary-turns-regression/` is the best artifact-layout template. Its notes say analytics logic "fails silently" and that review caught a real edge case.

### Derived Conventions

- Jira-prefixed branch and Conventional Commits: `fix(agents): ... (EPMCDME-15557)`.
- `CHANGELOG.md` has an `[Unreleased]` section (Added, Changed) and no Fixed entry yet. Add `### Fixed` in user-facing language.
- Update `docs/ARCHITECTURE-OTLP-PLUGIN.md` when `agents` counting behavior changes (15582 did this).
- Quality gates in order: `npm run license-check`, `npm run lint` (`--max-warnings=0`), `npm run typecheck`, `npm run build`, `npx vitest run --project unit`, `npx vitest run --project cli`. Per AGENTS.md, tests are written or run only on explicit user request.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts` (188 lines): the primary file. Its `toolUse(name, input)` helper (L9-11) emits blocks WITHOUT `id`.
  - `describe('extractNamedInvocations')`: skill extraction; Agent and Task both counted (L36-50); no `subagent_type` ignored (L52-58); malformed input; command wrappers.
  - `describe('extractOrderedNamedInvocations')` (L117-185): ordering, skill-backed slash command counted both ways, and a parity test, "returns the same counts as extractNamedInvocations", which any fix must keep green.
  - No `tool_result`, no `is_error`, and no denied content anywhere in this file.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-summary.test.ts` (463 lines): `it('derives skills and agents from a constructed NamedInvocationCounts')` (L202) checks the pass-through with `agentInvocations: {Explore: 2}`. It does not exercise extraction.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` (~4000 lines): end-to-end hook-pass tests via `openMainTranscriptPass` / `mainEvents(...)`.
  - `describe('openMainTranscriptPass — tool-call accumulation')` (L1151, ~L1155-1195) builds `toolLine` and `resultLine` with `is_error` true and false. It is the best model for an end-to-end regression.
  - L3225-3247: a Skill `tool_result` with `is_error: true, content: 'denied'`, about fork deferral, not counts.
  - There is no assertion on `summary.agents` anywhere in this file.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/fork-skill.test.ts`: helpers `toolUse(id,name,input)`, `toolResult(id,toolUseResult,content)`, `j()`; L205-239 covers "a failed or denied launch started nothing"; L439/L445 call the ordered extractor, for commands only.
- `src/agents/plugins/claude/__tests__/claude-run-baseline.test.ts`: L227 "counts a pending Task invocation once, in the run that emits it" (`agentInvocations` `{X: 1}`). It pins that a pending call with no result must still count. Helpers `toolTurn`, `userMsg`, `runPendingThenResolved`.
- `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-names.test.ts`: live path; L156 Task test; helpers `makeToolUseMsg`, `makeToolResultMsg(toolId, isError=false)`. This is the best home for a denied-Task live-path case.
- `src/agents/plugins/claude/__tests__/ClaudeSessionAdapter.test.ts` L202-204: `tool_result` with `isError` true and false (adapter parse path).
- Fixtures in `claude-code-otlp/transcript/__tests__/fixtures/` (`transcript-subagent-direct.jsonl`, `transcript-usage*.jsonl`) and `event-fields/__tests__/fixtures/foreground-agent-*.json`. Most tests build lines inline. `tests/integration/` has no coverage of named invocations or `agent.session.summary`.
- SubagentStart/Stop tests cover hook plumbing only (`subagent-fields.test.ts`, `hook.session-delivery.test.ts`, `hook-routing-contract.test.ts`, `claude-code-otlp.plugin.test.ts`, `hook-input-type-guards.test.ts`).

### Testing Framework and Patterns

- Vitest `^4.1.5`; `vitest.config.ts` has three projects: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**`, excluding `agent-*`), `agent` (real network).
- Single file: `npx vitest run --project unit <path>`, plus `-t "<name>"` to filter.
- Conventions: co-located `__tests__/`; imports with `.js`; `vi.restoreAllMocks()` in `afterEach`; temp dirs via `mkdtempSync(join(tmpdir(), ...))`; tests that touch `CODEMIE_HOME` mock the logger and use a temp `CODEMIE_HOME`. Pure extractor and summary tests need no mocks.
- Id-correlated tests use `{type:'tool_use', id:'tool-1', name, input}` paired with `{type:'tool_result', tool_use_id:'tool-1', content:'...', is_error:true}`.

### Coverage Gaps

- No test anywhere has a `tool_result` with `is_error: true` for an `Agent` or `Task` call, so the reported bug has no coverage. The only `is_error` + 'denied' fixture is for a Skill (`orchestrator.test.ts:3234`).
- `claude-named-invocations.test.ts` has no `tool_use.id` and no `tool_result` at all, so its helpers need extending.
- Untested: `isError` camelCase versus `is_error` on the Agent path; array-of-text result content; a result arriving in a different message or order than its call; a denied call mixed with allowed ones; the same `subagent_type` denied once and allowed once (expect 1); Task and Agent parity under denial; a denied Skill.
- Nothing asserts `agent.session.summary.agents` through the orchestrator (`openMainTranscriptPass`).
- Neither the live path (`claude.metrics-processor.ts`) nor the adapter path (`claude.session.ts`) has a denied-agent test.
- Hook denial without `is_error`: no fixture.

---

## 5. Configuration and Environment

### Environment Variables

- None gate the `agents`, `skills` or `commands` summary fields, `buildSessionSummaryEvent`, or named-invocations. No env change is needed.
- Adjacent: `CODEMIE_ANALYTICS_PROJECT_FILTER` (allowlist of projects the claude-code-otlp hooks forward; read from `~/.claude/settings.json` `env`, `claude-code-otlp.allowlist.ts:32`; written by `codemie proxy connect --claude-code-otlp`); `CODEMIE_HOME` (state dir: parse-state, logs, spool; redirected to a temp dir in tests); `CODEMIE_SESSION_ID`; `CODEMIE_CONV_SYNC_DISABLED=1` (disables conversation sync, not the summary); `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR` (context and evidence fields only); spool tuning `CODEMIE_EVIDENCE_RECORD_IDLE_DAYS` (90) and `CODEMIE_EVIDENCE_RECORD_MAX_FILES` (20000) in `otlp-spool/spool-config.ts`.

### Configuration Files

- `~/.claude/settings.json` — hooks and OTel env written by `codemie proxy connect --claude-code-otlp`, plus the project filter. A user's project `.claude/settings.json` PreToolUse hook is what produces the denial in the repro.
- `commitlint.config.cjs` — Conventional Commits.
- `vitest.config.ts` — test projects.

### Feature Flags and Deployment Concerns

- No feature flags are involved.
- Payload schema: `agent.session.summary` is built in `session-summary.ts` `buildSessionSummaryEvent` (L108-163). It carries `skills`, `agents`, `commands`, `primary_command`, `tools`, `tool_calls`, `tool_errors`, `tool_results`, `turns`, and more. `agents` is a map of `subagent_type` to count. `schema_version = 2` is stamped by `src/agents/core/OtlpAgentAdapter.ts:58,343`. A value correction does not change the shape, so no `schema_version` bump should be needed.
- Dedup / re-send: the summary `event_id` is a deterministic natural key from phase plus `ended_at` (`claude-code-otlp.event-id.ts`, `buildClaudeEventId`; `docs/ARCHITECTURE-OTLP-PLUGIN.md:205`). A corrected `agents` value reaches the backend only on a new final or incremental summary. A session already stored with the same phase and `ended_at` may not be rewritten, so historical over-counts persist unless re-sent or fixed backend-side.
- Rollout: hooks run in short-lived CLI processes, so the summary is built at hook time. The fix applies only after the user upgrades the CLI (0.16.10 is current). The proxy daemon forwarder is long-lived, and an older-CLI proxy is replaced by `codemie proxy connect/start/restart` or a Claude hook. `dist/` is git-ignored (stale until `npm run build`). Release is a separate step (`codemie-release` skill).

---

## 6. Risk Indicators

- Shared extractor blast radius: `extractOrderedNamedInvocations` / `extractNamedInvocations` feed the OTLP summary, the live MetricsProcessor / legacy metrics sync (`claude`, `claude-acp`), `extractMetrics`, and Claude Desktop (`claude-desktop.parser.ts`). Cowork is covered via the shared orchestrator. A signature or semantic change affects all of them.
- Sliced input on the live path: `run-prompts.ts:47` passes a slice of messages, so the matching `tool_result` may be outside the slice (or not yet written). A naive in-extractor pre-pass would miss it. The error-id set must be built from full-session maps (`toolResultsMap`, already built at `claude.metrics-processor.ts:215-227`), or the live path must be consciously left with its current behavior.
- Regression risk with pending calls: `claude-run-baseline.test.ts:227` requires a call with no result yet to still count exactly once. The fix must skip only calls with a known error or denial result, never calls with no result.
- Existing extractor tests use `tool_use` blocks with no `id`. Requirements that blocks with no `id` still count (or the tests need ids added). The parity test between the two extractors must stay green.
- UNVERIFIED core assumption: that a hook-denied Agent call yields `tool_result.is_error: true`. No repo fixture has a real hook denial, and the QA bot did not read the delivered summary record (the value 1 is inferred). Confirm with the real transcript or a fresh repro before relying on `is_error` alone. There is a fallback to a positive "started" check (`toolUseResult.agentId`, `status`), but that carries compatibility risk across Claude Code versions.
- The user-rejection path ("No" at the permission prompt) may produce a different marker, such as an `is_error` result with "The user doesn't want to proceed", or a rejection `toolUseResult`/interrupt shape. This is unverified and untested. Klim's comment 1 reported the backend-side checks passed for it, but the CLI summary map was apparently not re-checked.
- The same flaw exists for `Skill` tool_use counting (`skills` over-counted). The fix scope must decide whether to include it, since it changes `skills` analytics too.
- Historical data: previously sent summaries with denied agents are not corrected, because the event_id is immutable per phase and `ended_at`. Backend dedup behavior is not visible here.
- Backend dependence: the CLI fix makes `_SUMMARY_MAP_TOTAL(agents)` correct, but the backend `greatest(...)` design still lets any over-count in the summary map override the executed-span count. Older CLI versions in the field keep sending wrong values. A backend hardening ticket is advisable and is out of scope here.
- Test debt: there is no end-to-end assertion on `summary.agents`, no denied-Agent coverage on any of the three consumer paths, and no real hook-denial fixture.
- Silent failure: analytics logic fails silently (per the 15582 notes), so a wrong skip would under-count without any error. Cover it with explicit mixed denied/allowed cases.
- The codegraph MCP tool was unavailable, so the filesystem fallback was used. Line numbers come from subagent reads and should be re-verified before editing.

---

## 7. Summary for Complexity Assessment

The defect is a single, well-localized logic gap: `extractOrderedNamedInvocations` (and its sibling `extractNamedInvocations`) in `src/agents/plugins/claude/session/claude-named-invocations.ts` counts `Agent`/`Task` `tool_use` blocks without reading the matching `tool_result`. The only producer of `agent.session.summary.agents` is the claude-code-otlp orchestrator (`orchestrator.ts:499` into `session-summary.ts:145`), where the full transcript and an existing error-id helper (`collectErrorToolUseIds`) are already at hand. The layers touched are the plugin/session layer and the OTLP transcript layer. Cowork, Claude Desktop, and the `claude`/`claude-acp` live metrics path share the extractor. Copilot, Codex, Kimi and Pi are unaffected. Expected change surface is small to medium: the extractor plus its type, the 3-4 call sites (orchestrator, claude.session, run-prompts / metrics-processor), perhaps a shared exported helper, a CHANGELOG entry, and a short ARCHITECTURE-OTLP-PLUGIN.md note. That is roughly 4-7 source files, plus tests in 3-4 files.

Technical novelty is low. Error correlation by `tool_use_id` with `is_error`/`isError` is an established pattern in at least five places in the repo, and 15582 is a close precedent for fixing a shared extractor. The real design question is not novelty but scope and safety. First, how to give the extractor an error-id set without breaking the sliced live path (`run-prompts.ts`) or the pending-call invariant (`claude-run-baseline.test.ts:227`). Second, whether to apply the same fix to `Skill`. Third, whether `is_error` alone is a sufficient denial signal. That last point is unverified, because no real hook-deny transcript exists in the repo, and it could require a positive "started" check (`toolUseResult.agentId`) as in `fork-skill.ts`.

Test posture is mixed. The extractor, the summary mapper, and the live processors are well covered for their happy paths, and the repo has rich helpers (id-correlated builders, orchestrator end-to-end harness). There is zero coverage of denied or errored Agent/Task results, and no end-to-end assertion on `summary.agents`, so the bug is uncovered on all three consumer paths. The fix is cheap to test, but the extractor test helpers need `id` and `tool_result` builders. Complexity drivers are the shared-extractor blast radius, silent analytics failure modes, the unverified denial signal, and the cross-repo backend interplay (`greatest(...)` in `reader.py`, immutable event_id, old CLI versions in the field). The CLI-side change itself is moderate rather than large. Per AGENTS.md, tests are written or run only on explicit user request, so QA planning should treat test authoring as a user-gated step.
