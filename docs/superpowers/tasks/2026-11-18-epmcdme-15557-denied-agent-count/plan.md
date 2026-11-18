# EPMCDME-15557 Exclude Denied Agent/Task Calls From Agent Counts — Implementation Plan

> **SUPERSEDED IN PART by commit `ece9dd1d` (2026-11-18, "count an Agent call only once its result has succeeded"). Read the shipped code and `CHANGELOG.md` for the current behavior.**
> - The "a call with no result yet (pending) is still counted" rule below was **reversed**: an `Agent`/`Task` call that has an `id` is counted only when its `tool_result` has arrived without `is_error`/`isError`. A pending call is not counted (a later denial could not be subtracted); an id-less `tool_use` still counts.
> - The API was renamed: the `failedToolUseIds` set is now `toolOutcomes: ReadonlyMap<string, ToolOutcome>` (`'ok' | 'failed'`), built by the new exported `collectToolOutcomes(messages)`. `collectFailedToolUseIds` is kept as a thin wrapper over it. `run-prompts.ts` takes `toolOutcomes` (required), and the OTLP orchestrator, `ClaudeSessionAdapter.extractMetrics` and `MetricsProcessor` pass `collectToolOutcomes(messages)`.
> - Where the text below says `failedToolUseIds`, "pending calls still count", `still counts an Agent call with no result yet`, or `collectFailedToolUseIds` is passed to a caller, read the rules above instead. The matching tests now assert that a pending call is NOT counted and that it is counted once a successful result is in the transcript.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A denied or errored `Agent`/`Task` tool call must not be counted in the `agents` map of `agent.session.summary` (nor in `agentInvocations` of the legacy metrics paths).

**Architecture:** The shared extractor `claude-named-invocations.ts` counts every `Agent`/`Task` `tool_use` without looking at its `tool_result`. Add an optional `failedToolUseIds` set to both extractors; the Agent/Task branch skips a call whose `tool_use.id` is in the set. A new exported helper `collectFailedToolUseIds` builds the set from the **full** message list, and every production caller passes it. `session-summary.ts` stays a pure pass-through mapper.

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes, `@/` alias, no `any`, explicit return types on exports), Vitest.

**Spec:** none (sdlc-light). Source of truth: Jira EPMCDME-15557 comments 2–3, and `technical-analysis.md` in this directory.

## Global Constraints

- Scope is **Agent/Task only**. `Skill` counting must not change (a denied `Skill` call is still counted; this is pinned by a test and left as a follow-up ticket).
- Failure signal is structural: `tool_result.is_error === true` **or** `tool_result.isError === true`, matched by `tool_use_id` to `tool_use.id`. No matching on denial text.
- A call with **no result yet** (pending) and a `tool_use` block **without an `id`** are still counted (`claude-run-baseline.test.ts:227` and the existing extractor tests rely on both).
- `extractNamedInvocations` and `extractOrderedNamedInvocations` must keep returning identical counts for identical input (existing parity test).
- `src/agents/plugins/claude-code-otlp/transcript/session-summary.ts` is not modified.
- Never stage `.codemie/codemie-cli.config.json` (it is staged by the user and unrelated): every commit uses explicit `git add <paths>`.
- Commits: Conventional Commits, scope `agents`, ticket in the subject, e.g. `fix(agents): skip denied Agent/Task calls in named-invocation counts (EPMCDME-15557)`. Pre-commit hooks run; never `--no-verify`.
- Residual risk to record in the handoff: no real transcript of a hook-denied `Agent` call exists in the repo, so "denial ⇒ `is_error: true`" is an assumption taken from the QA report (result text `QA-15557 deny`). The fixture in Task 1 encodes that shape.

## Review Focus

- A denied call whose `tool_result` arrives in a **later message** than the `tool_use` (always the case in real transcripts) → excluded. Owned by Task 1.
- The same `subagent_type` denied once and allowed once → counted exactly once. Owned by Task 1.
- Result flagged with camelCase `isError: true` instead of `is_error` → excluded. Owned by Task 1.
- Pending call (no result yet) and an id-less `tool_use` → still counted. Owned by Task 1 and Task 2.
- Live path passes only a **slice** of messages, so the denying `tool_result` can be outside it → still excluded because the set is built from the full list. Owned by Task 3.

---

### Task 1: Extractor skips failed Agent/Task calls

**Files:**
- Modify: `src/agents/plugins/claude/session/claude-named-invocations.ts` (`RawBlock` L30-35; `extractNamedInvocations` L72; `extractOrderedNamedInvocations` L82-85; Agent/Task branch L142-148)
- Test: `src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts`

**Interfaces:**
- Produces:
  - `export function collectFailedToolUseIds(messages: readonly unknown[]): Set<string>` — ids of every `tool_result` block (any message, any position) with `is_error === true || isError === true` and a string `tool_use_id`. Tolerates non-array content and malformed entries; never throws.
  - `export function extractNamedInvocations(messages: readonly unknown[], failedToolUseIds?: ReadonlySet<string>): NamedInvocationCounts`
  - `export function extractOrderedNamedInvocations(messages: readonly unknown[], forkedSlashPromptIds?: ReadonlySet<string>, failedToolUseIds?: ReadonlySet<string>): OrderedNamedInvocations`
- Behavior: an `Agent`/`Task` `tool_use` whose string `id` is in `failedToolUseIds` is not counted. Skill and command handling are unchanged.

Test-first: yes — with a denied `Agent` call (`tool_use` id `t1`, later `tool_result` `is_error: true`, content `QA-15557 deny`), `extractNamedInvocations(messages, collectFailedToolUseIds(messages)).agentInvocations` must equal `{}`; today it returns `{ Explore: 1 }` (and the import of `collectFailedToolUseIds` fails first).

- [ ] **Step 1: Write the failing tests** in `claude-named-invocations.test.ts`. Add two local builders next to the existing `toolUse` helper: `toolUseWithId(id: string, name: string, input: Record<string, unknown>)` returning an assistant message with a `tool_use` block carrying `id`, and `toolResultMsg(id: string, flag: { is_error?: boolean; isError?: boolean }, content = 'ok')` returning a `user` message with one `tool_result` block. New `describe('failed Agent/Task calls (EPMCDME-15557)')` with these tests (names are the contract):
  - `collectFailedToolUseIds collects is_error and isError results across messages` → ids with `is_error: true` and `isError: true` are in the set; `is_error: false`, a result with no flag, string content, and a null message are not; does not throw.
  - `skips a denied Agent call whose result arrives in a later message` → `[toolUseWithId('t1','Agent',{subagent_type:'Explore'}), toolResultMsg('t1',{is_error:true},'QA-15557 deny')]` gives `agentInvocations` equal to `{}`.
  - `skips a denied Task call the same way as Agent` → same with `name: 'Task'`.
  - `skips a call flagged with camelCase isError` → `{isError:true}` gives `{}`.
  - `counts the same subtype once when one call is denied and one allowed` → `t1` denied + `t2` ok, both `Explore` → `{ Explore: 1 }`.
  - `counts a pending call (no result) and a call without an id` → `[toolUseWithId('t1','Agent',{subagent_type:'Explore'}), toolUse('Agent',{subagent_type:'Plan'})]` with `new Set(['t9'])` gives `{ Explore: 1, Plan: 1 }`.
  - `does not change Skill counting` → a `Skill` call `t1` with `is_error` result is still `skillInvocations: { 'codemie:msgraph': 1 }` (pins the Agent/Task-only scope).
  - `ordered and unordered extractors agree when a failed set is passed` → both return equal `agentInvocations` for a mixed denied/allowed list.
- [ ] **Step 2: Run to verify failure:** `npx vitest run --project unit src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts` — Expected: FAIL (`collectFailedToolUseIds` is not exported / denied calls are counted).
- [ ] **Step 3: Implement** in `claude-named-invocations.ts`: add `id?: unknown` to `RawBlock` and a `tool_use_id`/`is_error`/`isError` typed view for the helper; implement `collectFailedToolUseIds` (single pass over message `content` arrays); add the optional parameter to both signatures (the unordered one forwards `undefined` for `forkedSlashPromptIds`); in the Agent/Task branch, skip the bump when `typeof item.id === 'string' && failedToolUseIds?.has(item.id)`. Update the file header comment to state that failed Agent/Task calls are not counted and why (a denied call never started).
- [ ] **Step 4: Run to verify pass** (same command). Expected: all tests in the file PASS, including the pre-existing parity test.
- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/claude/session/claude-named-invocations.ts src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts
git commit -m "fix(agents): skip denied Agent/Task calls in named-invocation counts (EPMCDME-15557)"
```

---

### Task 2: OTLP `agent.session.summary.agents` excludes denied calls

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts` (`collectErrorToolUseIds` L277; `buildFullAccumulator` L499)
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` (inside `describe('openMainTranscriptPass — tool-call accumulation')`, ~L1151)

**Interfaces:**
- Consumes: `collectFailedToolUseIds` from Task 1 (`@/agents/plugins/claude/session/claude-named-invocations.js`, same module already imported at L62-63).
- Produces: `buildFullAccumulator` passes its existing `errorByToolUseId` set as the third argument of `extractOrderedNamedInvocations(parsedLines, slashPromptIds, errorByToolUseId)`. The private `collectErrorToolUseIds` body becomes `return collectFailedToolUseIds(parsedLines);` so the error rule lives in one place (its two callers, L447 and L1409, are unchanged).

Test-first: yes — a transcript with one denied `Agent` call (`Explore`, `is_error: true`, content `QA-15557 deny`) and nothing else must yield `summary.agents` equal to `{}` on the Stop summary; today it is `{ Explore: 1 }`.

- [ ] **Step 1: Write the failing tests** using the existing `writeTranscript`, `mainEvents(sessionId, transcriptPath, 'Stop')` and `parseAll` helpers and the line shape of the neighbouring tests (assistant line with `tool_use`, user line with `tool_result`):
  - `excludes a denied Agent call from summary.agents` → one denied `Explore` call → `summary?.agents` equals `{}`; also assert `tool_errors` is 1 and `tool_calls` is 1 (the call still shows as a tool error, only the agent count changes).
  - `counts only the allowed call when a denied and an allowed Agent run in one session` → denied `Explore` + allowed `Plan` (the allowed one also has a non-error result) → `{ Plan: 1 }`.
  - `still counts an Agent call with no result yet` → one `Explore` `tool_use`, no result line → `{ Explore: 1 }`.
- [ ] **Step 2: Run to verify failure:** `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts -t "Agent call"` — Expected: the denied-call tests FAIL, the pending test PASSES.
- [ ] **Step 3: Implement** the two edits above in `orchestrator.ts` (import `collectFailedToolUseIds`; pass `errorByToolUseId` at the L499 call; delegate `collectErrorToolUseIds`). Do not touch `scanSubagentTranscript`'s `extractNamedInvocations(parsedLines)` call (it uses only `skillInvocations`).
- [ ] **Step 4: Run to verify pass:** `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts src/agents/plugins/claude-code-otlp/transcript/__tests__/session-summary.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts
git commit -m "fix(agents): exclude denied Agent calls from the session summary agents map (EPMCDME-15557)"
```

---

### Task 3: Session adapter and live metrics path exclude denied calls

**Files:**
- Modify: `src/agents/plugins/claude/claude.session.ts` (`extractMetrics` L390)
- Modify: `src/agents/plugins/claude/session/processors/run-prompts.ts` (`collectRunPromptsAndInvocations` options + L47)
- Modify: `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts` (call at ~L375)
- Test: `src/agents/plugins/claude/__tests__/ClaudeSessionAdapter.test.ts`, `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-names.test.ts`, and `src/agents/plugins/claude/session/processors/__tests__/run-prompts.test.ts` (create if absent)

**Interfaces:**
- Consumes: `collectFailedToolUseIds` and the new optional parameter from Task 1.
- Produces:
  - `extractMetrics` calls `extractNamedInvocations(messages, collectFailedToolUseIds(messages))`. Claude Desktop's parser reaches this path through `extractMetrics`, so it needs no change.
  - `collectRunPromptsAndInvocations` options object gains `failedToolUseIds: ReadonlySet<string>` (required, so no caller can forget it); it is forwarded to `extractNamedInvocations([...runLines, ...trailingLines], failedToolUseIds)`.
  - `claude.metrics-processor.ts` computes `collectFailedToolUseIds(messages)` once from the **full** `messages` array and passes it in the options object.

Test-first: yes — (a) `new ClaudeSessionAdapter(ClaudePluginMetadata).extractMetrics(messages)` for a denied `Task` call must not contain `agentInvocations`; (b) `MetricsProcessor` fed a denied `Task` plus an allowed one must write `agentInvocations` equal to `{ Explore: 1 }`; (c) `collectRunPromptsAndInvocations` with the denying result outside the slice must return `named.agentInvocations` equal to `{}`. All three fail today.

- [ ] **Step 1: Write the failing tests:**
  - `ClaudeSessionAdapter.test.ts` — `extractMetrics omits agentInvocations for a denied Task call`: messages `[assistant tool_use Task/Explore id 'tool-1', user tool_result tool_use_id 'tool-1' is_error true]` (reuse the file's existing `ClaudeMessage` construction style around L202) → `result.agentInvocations` is `undefined`; a second case with a second allowed `Task` of subtype `Plan` → `{ Plan: 1 }`.
  - `claude.metrics-processor-names.test.ts` — `does not count a denied Task call` using `makeToolUseMsg('t6','Task',{subagent_type:'Explore'})` + `makeToolResultMsg('t6', true)` → `deltas[0].agentInvocations` is `undefined`; and `counts the same subtype once when one Task is denied and one allowed` with `t7` (denied) and `t8` (ok) → `{ Explore: 1 }`.
  - `run-prompts.test.ts` — `excludes a denied Agent call whose result is outside the processed slice`: `messages = [assistantToolUse(id 'tool-1', Task/Explore), userToolResult('tool-1', is_error true)]`, call `collectRunPromptsAndInvocations(messages, new Map(), { sessionId:'s', processedIds:new Set(), attachedUserPrompts:new Set(), lastProcessedMsgIndex:-1, lastEmittedIndex:0, emittedDeltas:true, finalPass:false, namedOnly:true, failedToolUseIds:new Set(['tool-1']) })` → `named.agentInvocations` equals `{}`; and the same call with `failedToolUseIds: new Set()` returns `{ Explore: 1 }` (proves the slice really excludes the result).
- [ ] **Step 2: Run to verify failure:** `npx vitest run --project unit src/agents/plugins/claude/__tests__/ClaudeSessionAdapter.test.ts src/agents/plugins/claude/session/processors/__tests__` — Expected: the new tests FAIL (the `run-prompts` one also fails type-check on the new option until Step 3).
- [ ] **Step 3: Implement** the three source edits listed under Interfaces.
- [ ] **Step 4: Run to verify pass:** `npx vitest run --project unit src/agents/plugins/claude` — Expected: PASS, including `claude-run-baseline.test.ts` (pending Task still counted once).
- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/claude/claude.session.ts src/agents/plugins/claude/session/processors/run-prompts.ts src/agents/plugins/claude/session/processors/claude.metrics-processor.ts src/agents/plugins/claude/__tests__/ClaudeSessionAdapter.test.ts src/agents/plugins/claude/session/processors/__tests__
git commit -m "fix(agents): exclude denied Agent/Task calls on the live and session-adapter paths (EPMCDME-15557)"
```

---

### Task 4: Docs, changelog and quality gates

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`, add a `### Fixed` section after its `### Changed`)
- Modify: `docs/ARCHITECTURE-OTLP-PLUGIN.md` (the paragraph or table row that describes the session-summary `agents`/`skills` fields; if none exists, one sentence in the claude-code-otlp transcript section)

Test-first: no — documentation only; verified by the quality gates below.

- [ ] **Step 1: CHANGELOG** — one user-facing line under `### Fixed`: sessions where Claude Code denied or failed an `Agent`/`Task` call no longer show that agent in the session's agent count (EPMCDME-15557). Mention that `Skill` counting is unchanged.
- [ ] **Step 2: ARCHITECTURE-OTLP-PLUGIN.md** — state that `agent.session.summary.agents` counts only `Agent`/`Task` calls whose `tool_result` is not an error (`is_error`/`isError`); denied, rejected and failed launches are excluded; pending calls count; the rule lives in `collectFailedToolUseIds` in `claude-named-invocations.ts`.
- [ ] **Step 3: Run the quality gates in order and stop at the first failure:**
  `npm run license-check`, `npm run lint` (zero warnings), `npm run typecheck`, `npm run build`, `npx vitest run --project unit`, `npx vitest run --project cli`. Expected: all exit 0.
- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/ARCHITECTURE-OTLP-PLUGIN.md
git commit -m "docs: note denied Agent/Task calls are excluded from agent counts (EPMCDME-15557)"
```

---

## Out of scope (record in handoff)

- Backend `reader.py` `agent_count = greatest(..., _SUMMARY_MAP_TOTAL(agents))` still lets any over-counting summary override the executed-span count; older CLI versions keep sending wrong values. Needs a backend ticket.
- Denied/errored `Skill` calls are still over-counted in `skills`. Needs its own ticket.
- Summaries already delivered with a denied agent are not rewritten (`event_id` is deterministic per phase and `ended_at`).
