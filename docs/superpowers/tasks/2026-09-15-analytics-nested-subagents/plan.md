# Nested Claude Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. The SDLC caller selects execution mode.

**Goal:** Reconcile Claude traces, elapsed timing and estimated costs from one captured transcript family.
**Architecture:** Flat additive contracts link traces through exact metadata. One owned-usage ledger feeds all totals; overlapping inclusive values are not summed.
**Tech Stack:** TypeScript, Vitest, embedded JavaScript/HTML; no new dependencies.

Commit per task using repository conventions. Paths are repository-relative; within a task, prepend its Directory to file targets and test commands. Requirements: spec.md; evidence: session-reconciliation.json and reproduction-notes.md. Use sanitized fixtures. Run each named Test-first file with npx vitest run before implementation (FAIL) and afterward (PASS). Stage 7 owns QA and browser proof.

### Task 1: Preserve Claude family relationship evidence

**Modify:** src/agents/core/session/BaseSessionAdapter.ts:37-48; src/agents/plugins/claude/claude.session.ts:179-290,372-430.
**Create test:** src/agents/plugins/claude/session/__tests__/claude-session-family.test.ts.

Test-first: yes — flat root/child/grandchild metadata retains parentAgentId, spawnDepth and toolUseId; damaged metadata does not discard readable usage or protocol rows.

- [ ] Add temporary JSONL/meta fixtures for nested relationships, duplicate UUIDs, missing/malformed metadata and a damaged sibling.
- [ ] Add optional typed parent/depth/background-request evidence to parsed subagents and preserve it during discovery/parsing. Keep lifecycle rows, per-file degradation and metadata-free compatibility.

### Task 2: Share one capture and include descendant activity

**Directory:** src/cli/commands/analytics/
**Modify:** data-loader.ts:107-122; native-loader.ts:349-414,558-582,697-755; cost/cost-enricher.ts:90-108.
**Tests:** __tests__/native-loader.test.ts; cost/__tests__/cost-enricher.test.ts.

Test-first: yes — a parser returning newer data on its second call is called once across discovery/enrichment, and parallel descendants extend root activity by envelope rather than summed durations.

- [ ] Add growing-input, descendant-after-root and empty/corrupt capture cases.
- [ ] Carry an optional internal parsed-family capture/time on RawSessionData. Reuse discovery captures; capture tracked native logs once. Apply family bounds before aggregation, preserving root context/non-Claude behavior. Never export raw messages.
- [ ] Re-run named tests plus src/cli/commands/analytics/__tests__/native-loader-pi.test.ts.

### Task 3: Extract complete hierarchy and authoritative lifecycle

**Directory:** src/cli/commands/analytics/cost/
**Modify:** types.ts:37-74; dispatch-extractor.ts:1-110.
**Create:** claude-trace.ts (relationship/lifecycle normalization).
**Test:** __tests__/dispatch-extractor.test.ts.

Test-first: yes — nested sidechain calls, repeated names, 80 steps and async/task-ID-only completion yield stable traces; incomplete descendants stay incomplete.

- [ ] Replace old cap/sidechain assertions; add conflict/cycle/missing-link, replay, failure and quoted-notification cases. Assert 1,424 ms acknowledgement and 412,438 ms completion remain distinct; end_turn alone never completes async work.
- [ ] Index exact tool ownership and metadata/structured agent IDs. Add optional id, parentId, agentId, ownerAgentId, depth, relationshipStatus. Keep conflicting/missing links unresolved; guard cycles. Scan every owner including sidechain rows; remove native truncation, preserving Codex/OTEL.
- [ ] Add optional acknowledgedAt, observedEnd, completedAt, elapsedMs and status (completed/failed/incomplete/unknown). Keep legacy durationMs; elapsedMs uses authoritative completion or incomplete observed subtree activity. Correlate top-level protocol notifications by tool/task ID; dedupe copies, use first authoritative event, reject quoted text.

### Task 4: Allocate own and inclusive session-owned usage

**Directory:** src/cli/commands/analytics/cost/
**Modify:** usage-readers.ts:71-190; cost-enricher.ts:199-291,310-397; types.ts.
**Tests:** __tests__/usage-readers.test.ts; __tests__/cost-enricher.test.ts.

Test-first: yes — concurrent root/child/grandchild allocations reconcile, cross-session replay cannot reappear in traces, and skills cannot absorb unrelated descendant spend.

- [ ] Fixture mixed models/TTL, progressive duplicates, null keys, replay, unlinked children and overlapping skills. Assert one own allocation per accepted record, session = root-own + disjoint top-level inclusive + unlinked, and matching series/model totals.
- [ ] Preserve canonical ownership during progressive dedup. Allocate only accepted session records, reusing Task 3's index with cycle guards. Keep tokens/costUSD as own; add inclusiveTokens/inclusiveCostUSD, attribution status/scope and root-own/unlinked SessionCost summaries. Expose ambiguous ownership.
- [ ] Limit skill/command estimates to owner/evidenced scope; mark estimates or unavailable values. Use identical rates with no pre-display rounding. Assert tight reconciliation and unchanged non-Claude results.

### Task 5: Correct verified model rates and cache TTL pricing

**Modify/tests:** src/utils/pricing.json:20-35; src/utils/__tests__/pricing.test.ts:85-92; src/cli/commands/analytics/cost/__tests__/cost-calculator.test.ts.

Test-first: yes — Sonnet 5 rates are 2/10/0.2/2.5/4 and explicit Opus 5 rates are 5/25/0.5/6.25/10; mixed-TTL cache creation counts the one-hour subset once.

- [ ] Add all five-rate, normalized-alias and mixed-TTL assertions.
- [ ] Correct only these entries and source/date note using approved official evidence. Preserve normalization/fallback policy and unrelated models. Historical expected total is $35.73558280: root-own $18.47146730 plus top-level inclusive $17.26411550.

### Task 6: Project consistent additive HTML and JSON data

**Directory:** src/cli/commands/analytics/
**Modify:** report/types.ts:13-61; report/payload-builder.ts:80-121; cost/types.ts.
**Tests:** report/__tests__/payload-builder.test.ts; report/__tests__/report-generator.test.ts.

Test-first: yes — HTML/JSON retain complete hierarchy/lifecycle/allocations/bounds and compatible legacy/authoritative records.

- [ ] Add duplicate-name/80-step payload cases asserting complete counts, period bounds, root/unlinked summaries, totals/series reconciliation and no raw transcript bodies.
- [ ] Project optional fields and snapshot metadata without changing existing semantics. Identify native API-equivalent estimates separately from authoritative source costs. Use complete dispatches for visible invocation counts; preserve old-data fallbacks and single-session export fields. Run green, including src/cli/commands/analytics/report/__tests__/session-report.test.ts.

### Task 7: Render inspectable ancestry and honest details

**Directory:** src/cli/commands/analytics/report/
**Modify:** client/app.js:951-1168,1236-1314; template.html:164-250.

Test-first: no — Stage 7 owns browser interaction proof; Tasks 3/6 cover complete trace data and compatible projections.

- [ ] Render indented ancestry/unresolved steps, full counts and stable-ID selection; progressive rendering must leave every step reachable. Precompute name counts. Scale bars/details to captured bounds using elapsedMs/observedEnd with legacy durationMs fallback. Show lifecycle/timing evidence, own/inclusive costs/tokens, root/unlinked totals, attribution uncertainty and inclusive overlap. Label native API-equivalent estimates separately from authoritative costs. Preserve escaping, keyboard access, legacy data and JSON export. Return ui_touched: true.

## Negative-constraint check

Tasks 1-3 preserve source logs/execution/ingestion; 3/4 infer no parents, completion or exact skill cost from timing; 4-6 add no billing/subscription allocation. All preserve additive contracts/dependencies and exclude private bodies. Stage 7 owns historical/live/browser proof and private visualization outputs. No task duplicates QA, review or artifact commits.
