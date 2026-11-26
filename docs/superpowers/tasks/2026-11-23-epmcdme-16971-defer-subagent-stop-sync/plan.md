# EPMCDME-16971 Defer Stop/SubagentStop sync without a session record

**Goal:** A Stop or SubagentStop hook for a session with no record syncs nothing instead of failing with "Session metadata not found".

**Architecture:** `ensureOwnGeneration` returns `'deferred'` when no record exists. `handleStop` (hook.ts:736) and `handleSubagentStop` (hook.ts:752) already return early on `deferred`, so neither handler changes. Spec: requirements inline in the dispatch (EPMCDME-16971); research in `technical-analysis.md`.

**Conventions:** Commit per task using the repository's existing convention, with the message exactly `EPMCDME-16971: Capital sentence` and no trailing period. Commit locally only. Do not push or open an MR. Do not touch `.codemie/codemie-cli.config.json`. Comments in English, `.js` import extensions, `@/` alias, `logger.debug` rather than `console.log`.

## Negative constraints
- No waiting or blocking on a missing record: Task 1 returns at once, without locking.
- Do not rewrite the existing RED test `own-generation.missing-record.test.ts`: Task 1 only makes it pass.
- No config edits, no push: honored by every task.

### Task 1: Defer when no session record exists

**Files:**
- Modify: `src/cli/commands/hook/own-generation.ts:39-56,70-73`
- Test: `src/cli/commands/hook/__tests__/own-generation.missing-record.test.ts` (existing, untracked; keep as is)

- [ ] Run the RED test and confirm it fails with `own` instead of `deferred`.
- [ ] At line 56, split the check. When `!record`, call `logger.info` (the message says that no record exists for `sessionId`, so the event is deferred and nothing is written) and return `'deferred'`. Keep `if (!isOtherGeneration(record, event.session_id)) return 'own'` for the rest.
- [ ] Doc comment at ~39-46: `own` becomes "a record of this generation". `deferred` becomes "no record exists yet, or the lock is held by another process; tried once, never waited for". Reword the warn at ~70 so it no longer implies that a lock is always the cause. Keep the lock/write-failure case only, since a missing record is now handled earlier.
- [ ] Run the test and confirm it passes.

Test-first: yes — the existing `own-generation.missing-record.test.ts` expects `'deferred'` for a SubagentStop event with an empty `CODEMIE_HOME` and currently gets `'own'`.

### Task 2: Handler-level tests for a missing record

**Files:**
- Modify: `src/cli/commands/__tests__/hook-routing-contract.test.ts` (add next to the Stop/SubagentStop cases at ~345-407)

- [ ] Add `Stop with no session record → no sync and no active-duration accumulation`. Use a unique sessionId with no `writeActiveSession` call and `cleanupSession` first. Mock the agent as in the SubagentStop test at line 380. Call `processEvent`. Assert `processSession` was not called and `getSessionPath(sessionId)` does not exist.
- [ ] Add `SubagentStop with no session record → no sync`, built the same way. Assert `processSession` was not called and no record file was written.
- [ ] Run `npx vitest run src/cli/commands/__tests__/hook-routing-contract.test.ts src/cli/commands/hook/__tests__ src/agents/core/session/__tests__/stale-session-reconciliation.test.ts`. The existing Stop/SubagentStop tests write a record first, so they stay green. `stale-session-reconciliation.test.ts` has no Stop or SubagentStop no-record case. Fix any regression found there.

Test-first: yes — with the Task 1 change reverted, both new tests fail because `processSession` is called once.

### Task 3: Final verification

- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, then the full `npm test`. All must pass. Fix only what the change broke.

Test-first: no — verification only.
