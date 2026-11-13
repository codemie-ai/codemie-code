DONE

## Changed paths
- src/cli/commands/__tests__/hook.session-delivery.test.ts (new `describe('EPMCDME-17068 regressions')`, 9 tests)

## Test command
`npx vitest run src/cli/commands/__tests__/hook.session-delivery.test.ts` -> EXIT=0, 188 passed. `npx tsc --noEmit -p .` clean; eslint clean.

## Scenarios
Exit failure retried at next start; pending + dropped in one run; 401 and 403 mid-delivery keep a spent record; permanent drop has no "Nothing is lost"; repro (4x 503 then healthy delivers all); json400 reported at its own launch; /clear during outage; outage beyond CODEMIE_DELIVERY_RETRY_WINDOW_MS (50 ms) drops nothing, a counted failure then drops.

## Notes
- No production code changed.
- Observation: `finalizeOwnRecord`'s active-record branch (processEvent with holdsReconcileLock) reports no outcome, so a json400 on the end metric there stamps no drop at that exit. The json400 and 503 launch scenarios therefore end through the SessionEnd hook (as the real agent does), then the exit notice. Not changed; flag for review if the fallback path should report too.
- The repro test sets a 150 s timeout (each failing launch takes ~6 s of retries).
