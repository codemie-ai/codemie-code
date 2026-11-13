DONE

## Changed paths
- src/telemetry/runtime/DesktopSessionDelivery.ts (MAX_DESKTOP_ATTEMPTS, settleDesktopAttempt, withinEvidenceRetention, copied cap check removed; deliverLocked always makes one real attempt: beginRealAttempt, send, attemptResult, new private reportOutcome using noteOutcome/budgetSpent/leaveQueue; sendRecord returns whether a send threw; `countAttempt` option removed so live passes count too; rejected credentials (authWasRejected) map to 'auth')
- src/telemetry/runtime/DesktopTelemetryRuntime.ts (reopenCompleted also clears droppedReason, deliveryFailingSince, deliveryRealAttempts)
- src/agents/core/session/delivery-budget.ts (bridge markDroppedIfUndelivered removed, no callers left; unused imports dropped)
- src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts (new describe: 25h + 3 attempts counted failure drops with 'retry budget exhausted'; <3 attempts keeps and counts; 503 never drops; reopen clears the 3 fields; old cap tests moved to the budget rule)
- src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.start.test.ts (deliveryAttempts assertions moved to deliveryRealAttempts; timeouts are outage now so they give the attempt back; counted failures use 'not-success')

## Tests
RED seen first (3 failures). Final: `npx vitest run src/telemetry/runtime src/agents/core/session src/cli/commands/__tests__/hook.session-delivery.test.ts` -> EXIT=0, 547 passed, 7 skipped. `npx tsc --noEmit -p .` clean; eslint clean on src/telemetry/runtime and delivery-budget.ts.

## Notes
- An 'outage'/'auth'/'not-attempt' outcome leaves deliveryRealAttempts at 0 (field present), not absent.
- Desktop maps authWasRejected(signal) to 'auth' before attemptResult, because an SSO login page on 200 is otherwise classified 'counted' by the clients.
