DONE_WITH_CONCERNS

## Changed paths
- src/cli/commands/hook/delivery.ts (isDeliveryDone = !hasUndeliveredData; hasNoPendingData deleted; deliverSessionRecord reports outcome via beginRealAttempt/noteOutcome/budgetSpent/leaveQueue when the caller does not hold the reconcile lock)
- src/cli/commands/hook.ts (closeUnclosedLocally and closeGenerationLocked use markIfBudgetSpent; new setGenerationAside; markDroppedIfUndelivered no longer used here)
- src/agents/core/session/session-generation.ts (new `requeueSetUnderNewId(sessionId, bounds?)`)
- src/agents/core/session/stale-session-reconciliation.ts (only `attemptResult` now exported; isLiveRecordFileName unchanged)
- src/cli/commands/__tests__/hook.session-delivery.test.ts

## Tests
`npx vitest run src/cli/commands/__tests__/hook.session-delivery.test.ts` -> 174 passed. RED seen first (5 failures for the expected reasons: /clear 503 marked and moved to completed_, no clock/attempt noted on SessionEnd).
Wider: `npx vitest run src/agents/core/session src/telemetry/runtime src/cli/commands` + `src/agents/plugins`: only the known unrelated failures (git-client sshCommand, copilot-managed-report x2) plus the "holds the lock 12 s" generation test, which fails under load and passes alone (same as T6 reported).
`npx tsc --noEmit -p .` clean; eslint clean on changed files.

## Design
- An undelivered /clear generation of this launch, budget not spent, stays queued by being RE-KEYED under a fresh uuid: `<newuuid>.json` + sidecars, record.sessionId rewritten. That is exactly what `isLiveRecordFileName` lists, so a crash before the next start still leaves it listed (review focus). The new json is written first, the old removed last, under the set locks and the new id's reconcile lock; a failed sidecar move rolls back. A kill mid-move can at worst duplicate an end metric, never lose a line.
- Not ours (other host / no send path) or budget already spent (`budgetSpent(rec,'counted')`): moves to `completed_<id>-<gen>` as before; spent ones are marked via `leaveQueue(..., async () => true)`.
- closeUnclosedLocally marks only when the budget is already spent.
- SessionEnd hook delivery uses its own child signal and `attemptResult`; with holdsReconcileLock the caller (start pass, /clear close) reports. Budget-spent records leave the queue marked via `leaveQueue`.

## Concerns / notes for later tasks
- `markDroppedIfUndelivered` bridge in delivery-budget.ts is still used by `DesktopSessionDelivery.ts:153` (T8); remove it there.
- Records with `deliveryRealAttempts` bumped in `beginAttempt` are saved only when sync applies; no signal means a local controller is used.
- The /clear close does not itself note an outcome (no clock started there); the next start pass does.
- Exit notice (T9) will see re-keyed generations as ordinary live records.
