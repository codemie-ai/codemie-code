# Continued and reopened Claude Code sessions, second pass: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development inline (sdlc-light Stage 4). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close what PR #779 left open after Preview QA: (A) EPMCDME-16992 a continued session's `Started` must be its own start; (B) EPMCDME-16993 a prompt-less reopen must not stretch the session duration through Claude Code's own OTel records. Prove every scenario with an isolated live suite that produces evidence.

**Architecture:** Re-apply #779 (it was fully reverted by #787, main has no fix). Then (A) make summary ownership positional in `transcript/orchestrator.ts`, and (B) make the proxy-daemon forwarder hold the native OTel records of an idle reopened session until real activity shows up. A new live suite runs the built hook, the real daemon/forwarder and a fake backend under a temp `CODEMIE_HOME`.

**Tech Stack:** TypeScript (ESM, `.js` imports, `@/` alias), Vitest (`npx vitest run --project unit <path>`), Node >= 20, built `dist/` for the live suite.

**Spec:** `technical-analysis.md` and the Jira texts in this directory (`jira-16992.txt`, `jira-comments.txt`). Acceptance criteria are the QA comments of 2026-11-10 (16079089 for 16992, 16079046 and 16077824 for 16993).

## Global Constraints

- Fix is CLI-side only (`src/agents/plugins/claude-code-otlp/`, `src/providers/plugins/sso/proxy/plugins/otlp-spool/`); no backend change.
- OTel-only sessions are never forwarded (invariant in `completeness-gate.ts`); no new path may send OTel-only data.
- No data may be dropped from a session that has real activity. Records are held or released, never silently discarded for an active session.
- Do not weaken accepted decisions D-1..D-6 (moved into this task dir); do not touch `.codemie/codemie-cli.config.json` (user-staged, never commit it).
- Tests/commits/pushes run only because the user invoked this SDLC run; commit footer: `Generated with AI` + `Co-Authored-By: codemie-ai <codemie.ai@gmail.com>`; Conventional Commits with ticket `EPMCDME-16992` / `EPMCDME-16993`.
- Live suite must never touch the real `~/.codemie`, `~/.claude`, or the user's real daemon.

## Review Focus

1. A copied line without `uuid` (`queue-operation`, `file-history-snapshot`, `last-prompt`) before the first own line must not set `started_at` or `ended_at`.
2. A continuation whose own work is only `/exit`-style local lines must send no summary (not just "no surviving lines").
3. Native OTel records arriving before the `SessionStart(resume)` hook finishes (startup race) must still be held.
4. A reopened session that then gets a real prompt must have its held records released, and its duration/usage must be those of a normal active session.
5. A non-reopened session's OTel forwarding must be byte-identical to today (no regression for ordinary and `startup`/`clear` sessions).

---

### Task 1: Re-apply #779 on current main

**Files:** the 22 files of `ee791ac8` reverted (working tree already holds `git revert --no-commit ee791ac8`); move `docs/superpowers/tasks/2026-11-09-otlp-continued-and-reopened-sessions/accepted-decisions.md` to this task dir; leave other old review/task artifacts out.

**Interfaces:** Produces `resolveInheritedUuids(path, sessionId)` (`continuation.ts`), `isReopenedIdle(state)`, `state.reopened`/`reopenActive`/`inheritedUuids` in `TranscriptParseState` (all exactly as in #779).

- [ ] **Step 1:** Unstage `docs/superpowers/reviews/2026-11-09-pr779-run6/` and the old `docs/superpowers/tasks/2026-11-09-otlp-continued-and-reopened-sessions/` (keep a copy of `accepted-decisions.md` in this task dir); keep `src/` and `docs/ARCHITECTURE-OTLP-PLUGIN.md`.
- [ ] **Step 2:** `npx tsc --noEmit` and `npx vitest run --project unit src/agents/plugins/claude-code-otlp` → all pass (the auto-merged `configuredWins` line in `claude-code-otlp.plugin.ts` must still compile and its tests pass).
- [ ] **Step 3:** Commit `fix(analytics): re-apply skipping copied and no-activity claude session history (EPMCDME-16992, EPMCDME-16993)`.

### Task 2: Isolated live suite, baseline repro of both gaps (RED)

**Files:** Create `tests/live/claude-code-otlp-sessions/` with `lib/env.mjs` (temp `CODEMIE_HOME`, temp project dir, temp `~/.claude` equivalent via `HOME`/`USERPROFILE`), `lib/fake-backend.mjs` (HTTP server recording every POST body with arrival time, accepts analytics + otlp routes), `lib/transcripts.mjs` (builders: ordinary session, continuation copy with `continued-in` record and no-uuid copied lines, reopen), `lib/otlp-records.mjs` (native record builders for `hook_registered`, `plugin_loaded`, `managed_settings_resolved`, `mcp_server_connection`, `hook_execution_start/complete`, `user_prompt`, `api_request`, `tool_result`), `scenarios/*.mjs`, `run.mjs` (runs all, writes `evidence/<scenario>.json` + `report.md`), `README.md`. Exclude the directory from vitest if its include globs would pick it up.

**Interfaces:** Produces `runScenario({name, steps}) → {events, otlpForwarded, startedAt, endedAt, durationMs}` where `events` are the backend-received hook events (type, timestamp, session id) and `otlpForwarded` the forwarded native records with timestamps. Scenarios: S1 ordinary session; S2 continuation without own work; S3 continuation with own work; S4 continuation with no-uuid copied lines and `/exit` own lines; S5 reopen idle (`resume`, no prompt) with native startup records; S6 reopen followed by a real prompt; S7 `startup` and `clear` sources; S8 parent record lands late; S9 compaction/env change while idle; S10 two reopens.

- [ ] **Step 1:** Discover how to start the real proxy daemon isolated (`src/cli/commands/proxy/daemon-manager.ts`, `bin/proxy-daemon.js`) under a temp `CODEMIE_HOME` against the fake backend; if it cannot be isolated, run `forwarder`/`tick-processor` in-process from `dist` against a temp spool dir and say so in the README.
- [ ] **Step 2:** Capture the real Claude Code startup records: run the installed `claude` (2.1.319) with `CLAUDE_CODE_ENABLE_TELEMETRY=1` and OTLP env pointing at the fake backend, `claude --resume <fixture-session>` in a temp project, exit without a prompt (use a PTY helper if needed); save the received record names/attributes as `fixtures/native-startup-records.json`. If it cannot be driven non-interactively, build the records by hand from QA's list and mark the fixture `synthetic`.
- [ ] **Step 3:** Implement the scenarios against the built baseline (`npm run build`, run from `dist`).
- [ ] **Step 4:** Run: expect S2/S3/S4 `startedAt` equal to a copied timestamp for S4 (A reproduced) and S5 native records forwarded with `endedAt` = reopen time (B reproduced). Record the actual outcome as evidence; if S4 does not reproduce, extend the builder until the QA symptom reproduces before changing code. Expected: S1, S2, S3, S6–S10 hook-side values already as #779.
- [ ] **Step 5:** Commit `test(analytics): add isolated live suite for continued and reopened sessions (EPMCDME-16992, EPMCDME-16993)`.

### Task 3: Continued session start/end are the session's own (EPMCDME-16992)

**Files:** Modify `transcript/orchestrator.ts` (`buildFullAccumulator` ~L376-481, `hasOwnLines`, summary block ~L683-692); Test `transcript/__tests__/orchestrator.test.ts`.

**Interfaces:** Consumes `inherited: Set<string>`. Produces: `buildFullAccumulator` returns `startedAt`/`endedAt` computed only from lines that are not copies, where a line is a copy if its uuid is inherited, or it has no uuid and lies before the last line whose uuid is inherited; `hasOwnLines` becomes true only when an own line is a non-synthetic assistant line or a genuine user turn (the `ownActivity` predicate of `deriveMainEvents`).

- [ ] **Step 1:** Failing tests: (a) 'continued session summary starts at its first own line, not at a copied line without uuid' (copied `queue-operation` with timestamp T0, copies with uuids, own assistant line T5 → `started_at === T5`); (b) 'continuation whose only own lines are local commands sends no summary'; (c) 'continuation clamps started_at to sessionStartedAt when set'.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement positional ownership and the `ownActivity`-based `hasOwnLines`; when `inherited.size > 0` and `state.sessionStartedAt` is set, `startedAt = max(startedAt, sessionStartedAt)`.
- [ ] **Step 4:** Run the orchestrator/continuation tests → PASS; ordinary-session summary tests unchanged.
- [ ] **Step 5:** Live: re-run S2, S3, S4 → `startedAt` is the continuation's own start, usage 0 for S2/S4. Commit `fix(analytics): start a continued session at its own first line (EPMCDME-16992)`.

### Task 4: Hold native OTel records of an idle reopened session (EPMCDME-16993)

**Files:** Create `src/providers/plugins/sso/proxy/plugins/otlp-spool/reopen-hold.ts`; Modify `otlp-spool/forwarder.ts` (`forwardOtelJsonStream` ~L494-534), `transcript/parse-state.ts` (read-only accessor); Test `otlp-spool/__tests__/reopen-hold.test.ts` and forwarder test.

**Interfaces:**
- `readReopenState(sessionId: string): Promise<{ reopened: boolean; reopenActive: boolean } | null>` in `parse-state.ts`: read-only, no lock, `null` when the file is missing or unreadable.
- `splitHeld(request: OtlpJsonRequest, state): { release: OtlpJsonRequest | null; held: boolean }` in `reopen-hold.ts`: when the session is reopened and not active, the request is held unless it contains an activity record (`event.name` in `api_request`, `api_error`, `tool_result`, `tool_decision`); a request with an activity record releases everything held before it for that session. `user_prompt`, hook/plugin/mcp/settings records are never activity.
- Held records stay in the spool (cursor not advanced), so a later release or the existing sweep decides their fate; a session that ends without activity is swept as OTel-only data is today (never sent).

- [ ] **Step 1:** Failing tests: 'holds startup records of an idle reopened session'; 'releases held records when an api_request arrives'; 'does not hold anything for a session that is not reopened' (byte-identical forwarding); 'forwards when the state file is missing' (fail open to today's behavior); 'a held batch without a session id is still held back by the existing proof'.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `readReopenState`, `splitHeld`, and call it per NDJSON line before the POST in `forwardOtelJsonStream`; the not-reopened path must not change bytes or ordering.
- [ ] **Step 4:** Run → PASS. Live: S5 → no native record forwarded, backend session end unchanged; S6 → held records released with the first `api_request`, duration equals a normal active session; S1/S7 unchanged (fixtures diffed against the Task 2 baseline).
- [ ] **Step 5:** Race check from the live capture: if native startup records reach the forwarder before the `SessionStart(resume)` hook has written `reopened` (compare arrival times in the evidence), add a short hold of the first batch of any session whose parse state does not exist yet or is older than the daemon's first sight of the session, bounded by `hooksOnlyWaitTicks()`; re-run S5 to prove it. If records never arrive before the flag in 20 live runs, record that in the evidence and add no grace.
- [ ] **Step 6:** Commit `fix(analytics): hold native otel records of an idle reopened claude session (EPMCDME-16993)`.

### Task 5: Full live validation, docs, gates

**Files:** `docs/ARCHITECTURE-OTLP-PLUGIN.md` (note the forwarder hold and the positional ownership), `accepted-decisions.md` (carry D-1..D-6, add the decisions made here), `tests/live/.../evidence/`.

- [ ] **Step 1:** Run the whole live suite on (a) a clean build of `origin/main` (baseline) and (b) the branch; commit `report.md` with a baseline-vs-branch table per scenario (events by type, usage totals, `startedAt`, `endedAt`, durations, forwarded native records).
- [ ] **Step 2:** `npm run lint`, `npx tsc --noEmit`, `npx vitest run --project unit src/agents/plugins/claude-code-otlp src/providers/plugins/sso/proxy/plugins/otlp-spool` → all green.
- [ ] **Step 3:** Commit `docs(analytics): document ownership and reopen hold, add live evidence (EPMCDME-16992, EPMCDME-16993)`.

## Clarification assumptions

The two root causes are inferences from code reading (16992 start from uncovered no-uuid lines; 16993 delivery path past the completeness gate, probably through the leftover hooks spool of the original run). Task 2 must reproduce both before Tasks 3 and 4 change code.
