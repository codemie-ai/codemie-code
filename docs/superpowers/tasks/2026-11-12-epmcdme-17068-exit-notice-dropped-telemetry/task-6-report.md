DONE_WITH_CONCERNS

## Changed paths
- src/agents/core/session/stale-session-reconciliation.ts (MAX_ATTEMPTS, markDroppedIfUndelivered, Attempt, beginAttempt, settleAttempt, restoreCounter, rollBackAttempt, withinEvidenceRetention removed; send first, then `noteOutcome(attemptOutcome)` + `budgetSpent`; local-by-design closes use `leaveQueue(s, undefined, ...)`)
- src/agents/core/session/delivery-budget.ts (T3 file, extended: `leaveQueue(s, reason, now, rename?)` now takes an optional bounded rename and returns boolean; new bridge `markDroppedIfUndelivered(sessionId, reason = 'retry budget exhausted')`)
- src/cli/commands/hook.ts, src/cli/commands/hook/delivery.ts (import swap only: markDroppedIfUndelivered now comes from delivery-budget.ts; T7 replaces it)
- src/telemetry/runtime/DesktopSessionDelivery.ts (kept the old Desktop cap behavior locally: private `MAX_DESKTOP_ATTEMPTS` and `settleDesktopAttempt`; T8 replaces it)
- tests: src/agents/core/session/__tests__/stale-session-reconciliation.test.ts (existing cases moved to the new rule + new describe `EPMCDME-17068 the start pass reports outcomes...`: AC1, AC2, AC3, AC4 old-cap, AC6 401/403, AC7 deadline cut), src/cli/commands/__tests__/hook.session-delivery.test.ts (7 reconciler-driven cap/attempt assertions updated)

## Tests
`npx vitest run src/agents/core/session src/telemetry/runtime src/cli/commands/__tests__/hook.session-delivery.test.ts` all pass (stale-session-reconciliation 84 passed, hook.session-delivery 172 passed, telemetry/runtime 176 passed). `npx tsc --noEmit -p .` clean; eslint clean on all changed files.
Broad `src/cli/commands` run showed 4 unrelated failures (git-client sshCommand, copilot-managed-report x2) plus one hook.session-delivery generation test that failed under load and passes alone.

## Notes / concerns
- TDD: I implemented before updating tests (scale of the rewrite); RED was not observed for the new describe. Tests pass against the final code.
- Behavior: no outcome noted + no throw = `ok` (attempt given back, no clock); throw with nothing noted = `counted`; abort before any send = `not-attempt`; awaiting-destination = `ok`. Stranded records are flushed unless `budgetSpent(record, 'counted', now)` on the pre-attempt record is set; copilot-cli transcript-unsent marks now carry `droppedReason`.
- A hook/Desktop caller that needs the removed symbols was kept compiling minimally (see above). `deliveryAttempts`/`finalizeAttempts` are no longer read by the reconciler.
