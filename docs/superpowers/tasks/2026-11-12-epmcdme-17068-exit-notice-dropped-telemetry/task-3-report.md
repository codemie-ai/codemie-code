DONE

## Changed paths
- src/agents/core/session/delivery-budget.ts (new)
- src/agents/core/session/types.ts
- src/agents/core/session/SessionStore.ts
- src/agents/core/session/stale-session-reconciliation.ts
- src/agents/core/session/__tests__/delivery-budget.test.ts (new)
- src/agents/core/session/__tests__/SessionStore.save.test.ts

## Tests
`npx vitest run src/agents/core/session/__tests__/delivery-budget.test.ts src/agents/core/session/__tests__/SessionStore src/agents/core/session/__tests__/stale-session-reconciliation`
Result: 128 passed, 2 failed (the 2 known Windows EPERM symlink failures in stale-session-reconciliation.test.ts, nextRecordStart), 7 skipped.
RED seen first for delivery-budget.test.ts (22/22 failed, module missing). The SessionStore merge test was added after the types/mergeCompleted edit, so it was not seen failing.
`npx tsc --noEmit -p .` clean. eslint clean on the changed files.

## Interfaces for later tasks
- types.ts: `SyncStatus` now includes `'rejected'`; `export type DropReason`; `Session.droppedReason`, `deliveryFailingSince`, `deliveryRealAttempts`.
- delivery-budget.ts exports: `retryWindowMs()`, `beginRealAttempt(s)`, `noteOutcome(s, o, now)`, `budgetSpent(s, lastOutcome, now)`, `notDroppedBefore(s, now)`, `hasUndeliveredData(s)`, `leaveQueue(s, reason, now)`.
- `noteOutcome`: 'ok' does not start the clock and gives the attempt back; any other non-'counted' outcome starts the clock (first wins) and gives the attempt back (floor 0); 'counted' keeps it. 'rejected' stamps droppedAt/droppedReason 'rejected by the server' (first wins).
- `budgetSpent`: retention check first (endTime ?? startTime older than evidenceRecordIdleDays, any last outcome) returns 'retention expired'. Otherwise only after 'counted', elapsed = max(0, now - failingSince) >= window and attempts >= 3.
- `leaveQueue(s, reason, now)` uses the passed record (not a re-read of the live file); saves droppedAt/droppedReason only when reason is given and data is undelivered (an earlier droppedAt/droppedReason is kept), then `renameSessionFiles(sessionId)` with no bounds/deadline/signal. T6 callers that need a deadline or abort signal around the rename must call `renameSessionFiles` themselves or extend `leaveQueue`.
- `mergeCompleted`: earliest deliveryFailingSince, larger deliveryRealAttempts, droppedReason follows saving.droppedAt when set, else the other copy's.

## Notes
- stale-session-reconciliation.ts: its private `hasUndeliveredData` was removed and replaced by an import from delivery-budget.ts. `markDroppedIfUndelivered` is unchanged (it still sets only droppedAt, no reason), for T6 to replace. Unused imports removed.
- `hasUndeliveredData` compares metric `syncStatus` to the string 'rejected' (T4 adds the conversation constant). Conversation payloads already exclude non-pending/failed statuses. Log prefix changed from `[reconcile]` to `[delivery]` for the moved code.
- No concerns.
