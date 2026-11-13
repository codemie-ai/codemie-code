DONE

# Task 2 report: one request-outcome classifier

## Changed paths
- C:/Users/Yauheni_Hil/repos/codemie-code/src/providers/plugins/sso/session/bounded-request.ts
- C:/Users/Yauheni_Hil/repos/codemie-code/src/providers/plugins/sso/session/__tests__/bounded-request.test.ts

## Proof
`npx vitest run src/providers/plugins/sso/session/__tests__/bounded-request.test.ts` -> EXIT=0, 53 passed (RED first: 32 failed, functions missing).
`npx vitest run src/providers/plugins/sso/session src/agents/core/session/__tests__/stale-session-reconciliation.test.ts` -> all pass except 2 pre-existing Windows EPERM symlink failures in stale-session-reconciliation.test.ts (`nextRecordStart ... through a symlink`), unrelated.
`npx tsc --noEmit -p .` clean; eslint on both files clean.

## Interfaces (exported from bounded-request.ts)
- `isExpiredCredentialAnswer(status, _bodyIsJson, _body?): boolean` (any 401/403, T1 JSDoc)
- `type RequestOutcome = 'ok' | 'auth' | 'rejected' | 'outage' | 'counted' | 'not-attempt'`
- `classifyAnswer(status, bodyIsJson, success, body?): RequestOutcome`
- `classifyError(error, stopReason): RequestOutcome` (stopReason set -> not-attempt, else outage)
- `attemptOutcome(signal): RequestOutcome | undefined` (worst recorded: rejected > counted > auth > outage > not-attempt; successes record nothing)
- `BoundedRequest.noteOutcome(error): RequestOutcome`, `noteAnswer(status, bodyIsJson, success, body?): RequestOutcome`; both record on the caller's signal.

## Notes
- classifyAnswer: success -> ok; 401/403 -> auth; 5xx/429/non-JSON 4xx -> outage; JSON 400/422 -> rejected; everything else (JSON other 4xx, 2xx not success, 3xx) -> counted.
- `attemptNotServed`, `failingServerAnswered`, `authWasRejected` and the old flag sets are untouched and still driven by the legacy logic in parallel (their old semantics differ: e.g. a timeout was "counted" there, is `outage` in the new classifier; a 403 resets attemptNotServed). T6 removes them.
- A request stopped via the caller's abort (already-aborted signal) always classifies as not-attempt, even for an error that is a refusal.
- Callers (apiClient.ts, metrics-api-client.ts) were not changed; they ignore the new return values until later tasks.
