# EPMCDME-16154 Subagent Output Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** claude-code-otlp emits `agent.usage.request` / `agent.subagent.usage` whose `output_tokens` sum (main + subagents) equals the OTel `api_request` total, and a backend handoff doc.

**Architecture:** Fix is confined to `src/agents/plugins/claude-code-otlp/transcript/`. Backend aggregation is not in this repo; Task 4 only documents it.

**Spec:** `technical-analysis.md` and the ticket text (no spec.md).

Commit per task using the repository's existing convention. Repo policy: tests are written/run only on explicit user request; Test-first lines below apply once the user asks. Follow `.ai-run/guides/testing/testing-patterns.md` (Vitest, `.js` imports, `@/` alias).

## Hypotheses (status)

- H1 VERIFIED by code: `mergeUsageRequest` (`usage-request.ts:156-187`) max-merges `outputTokens`; rows are never summed. Correct only if some row carries the final count.
- H2 VERIFIED by code: main and subagent rows share `state.openRequests` keyed `${requestId||messageId}::${model}` without `agentId` (`orchestrator.ts:354,612`); same key in two transcripts collapses to one record. Whether real transcripts repeat ids across files is UNVERIFIED.
- H3 VERIFIED by code, effect UNVERIFIED: `readNewLines` returns only newline-terminated lines and advances the offset; rows flushed after the last pass are read only if a later hook fires (`openSessionEndPass` skips files with `offset == size`).
- H4 NEEDS REAL TRANSCRIPT: direct-API rows carry placeholder/partial `output_tokens` that is never updated. Existing `fixtures/transcript-usage-direct.jsonl` has only complete duplicates (87, 87), so it does not model this.
- H5 BACKEND (unverifiable here): session total is not the sum of all scopes.

## Task 1: Repro fixtures and characterization test

**Files:** Create `transcript/__tests__/fixtures/transcript-subagent-direct.jsonl` (main + `subagents/agent-*.jsonl` pair, synthetic, ids anonymized); Test: `transcript/__tests__/orchestrator.test.ts`.

Test-first: yes — a session with a main row `req_A` (output 40, then 40) and a background subagent whose rows repeat one `message.id` with output 1, 1, 300 and one id shared with the main file; asserts the summed `output_tokens` over emitted `agent.usage.request` events equals 340 + main, and no subagent event exceeds the session sum.

- [ ] Build fixture shapes for H2 (shared id across files), H3 (final row without trailing newline until a second append), H4 (partial rows).
- [ ] Write the test; run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`; record which hypotheses fail.

## Task 2: Diagnose against a real transcript

Test-first: no — one step. Take a real plain-`claude` transcript of session type 42b807fc (main `.jsonl` + `subagents/agent-*.jsonl`), run the passes via a scratch script (scratchpad, not committed) and sum `outputTokens` per request key, per file, and compare with the OTel `api_request` total; write the verdict on H2/H3/H4 at the top of Task 3 notes. If the transcript itself underreports (H4 with no later final row), stop and return to the user: a transcript-derived total cannot meet the criterion.

## Task 3: Fix derivation (scoped by Task 2 verdict)

**Files:** Modify `transcript/usage-request.ts:141-187`, `transcript/orchestrator.ts:354,612,~660-700`; Test: `usage-request.test.ts`, `orchestrator.test.ts`.

Test-first: yes — the Task 1 test passes plus `claude -p` fixtures (`transcript-usage.jsonl`, `msg_pair_1` 50 then 120) still yield 120.

- [ ] If H2: include scope `agentId` in `usageRequestKey` (or prefix subagent keys) so main and subagent records never merge; keep persisted state backward-compatible (`parse-state.ts:47`).
- [ ] If H4: change `mergeUsageRequest` output rule only as the real transcript requires (reference: `isMoreCompleteUsageRecord` in `src/cli/commands/analytics/cost/usage-readers.ts`).
- [ ] If H3: make `openSessionEndPass` re-read subagent files whose size exceeds the saved offset or add a final read for files finished after `SessionEnd`; do not loop or block the hook.
- [ ] Run the transcript test folder; expected PASS, existing tests unchanged.

## Task 4: Write backend handoff `backend-plan.md`

**Files:** Create `<task_dir>/backend-plan.md`.

Test-first: no — one step. Document: events emitted (`agent.usage.request` fields incl. `request_id`, `message_id`, `output_tokens`, `scope_kind`, `scope_name`, `agent_id`, `agent_type`; `agent.subagent.usage` `usage[]`; `agent.session.summary` has no token fields; replays re-emit merged records so dedupe by `(session_id, request_id||message_id, model)` taking max); required backend rule (session `output_tokens` = sum over distinct requests across main + subagent scopes; subagent total = its `agent_id` rows; subagent <= session); H5 and suspected places (Preview session/agent aggregation, scope overwrite on key collision); acceptance checks (the three ticket criteria with the 1,283/2,701 and 2,448/8,828 examples); the Task 2 verdict. No backend code.

## Negative constraints pass

- "Backend code is not in this repo; do not plan backend changes": honored by Task 4 (doc only); no other task touches backend.
- "`claude -p` and `codemie-claude` must stay correct": Task 3 test keeps the max-merge fixture.
- "Tests only on explicit request": noted in the header; Test-first lines are conditional.
