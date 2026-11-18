# EPMCDME-17068 Exit Notice and Retry Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session analytics (sync-API data) survive outages and expired logins. Data is dropped only when the 24h + 3-real-attempt budget is spent or the server rejects it, and the exit notice reports pending, queued and dropped sessions honestly.

**Architecture:** One classifier in `bounded-request.ts` gives each request an outcome. One session-layer module, `delivery-budget.ts`, owns the verdict: clock, real attempts, budget, the undelivered predicate, earliest drop time, and leaving the queue with a reason. The reconciler, hooks, Desktop and the notice only report outcomes or read verdicts.

**Tech Stack:** TypeScript ESM (`.js` imports, `@/` alias), Vitest, `logger` (the exit notice keeps its stderr print).

**Spec:** `docs/superpowers/tasks/2026-11-12-epmcdme-17068-exit-notice-dropped-telemetry/spec.md`. The technical analysis sits in the same folder. Line refs below come from it.

## Global Constraints

- Budget: drop only after a `counted` failure, when `now - deliveryFailingSince >= window` AND `deliveryRealAttempts >= 3`. Window defaults to 24h and env `CODEMIE_DELIVERY_RETRY_WINDOW_MS` overrides it. Evidence retention (`evidenceRecordIdleDays()`, 90d) is the outer bound.
- Drop reasons, exact text: `rejected by the server`, `retry budget exhausted`, `retention expired`.
- No text anywhere says "Nothing is lost".
- Do not change any of these: `otlp-spool/` (only reading `evidenceRecordIdleDays` is allowed), `canDeliver`, `RECONCILE_PER_START = 5`, `EXIT_NETWORK_BUDGET_MS`, the backend. Do not add a `codemie doctor` listing.
- Local-by-design closes (other host, no host, legacy, Desktop daemon gone) are never marked dropped.
- `deliveryAttempts`/`finalizeAttempts` are no longer read by any decision.
- Implementers run no git. The pipeline commits per task using the repo's Conventional Commits convention.
- Tests: Vitest, temp `CODEMIE_HOME`, fake `fetch` with `respond()`, dynamic imports after mocks (`.ai-run/guides/testing/testing-patterns.md`). Run with `npx vitest run <file>`.

## Review Focus

- An on-disk record at `deliveryAttempts: 3` or `finalizeAttempts: 3`, or a payload with `syncAttempts: 3`, must be sent at the next healthy start. Owner: T6, test `old-cap records are sent`.
- A `/clear` followed by a crash before the next start: the generation must still be listed by `isLiveRecordFileName`. Owner: T7.
- Clock skew: if `deliveryFailingSince` is in the future, treat elapsed as 0 and never drop. Owner: T3, test `future clock never spends budget`.
- A session that appears as both a live and a `completed_*`/generation file is listed once in the notice. Owner: T9.
- A hanging server in proxy mode (JSON 504) and in direct mode (timeout) is `outage` and spends no real attempt. Owner: T2.

---

### Task 1: Find out what expired credentials look like (401 vs 403)

**Files:** read only `src/providers/plugins/sso/proxy/{proxy-errors.ts,sso.proxy.ts,plugins/session-rejection.ts,plugins/sso-session-expiry.plugin.ts,plugins/credential-refresh.ts}`, their `__tests__`, and the sync clients' auth handling.

Test-first: no — this task is an investigation. Its result becomes T2's fixtures.

- [ ] Find out what status and body the sync API (direct, `CODEMIE_SYNC_API_URL`) and the SSO proxy path return for expired credentials, and whether an expiry 403 can be told apart from other 403s by its body. Write the result, with file:line evidence, as the JSDoc of `isExpiredCredentialAnswer` in T2. If the code cannot tell them apart, every 403 is `auth`, and the JSDoc says so.

### Task 2: One request-outcome classifier

**Files:** Modify `src/providers/plugins/sso/session/bounded-request.ts:110-212`. Test `src/providers/plugins/sso/session/__tests__/bounded-request.test.ts` (create it if missing).

**Interfaces — Produces:**
```ts
export type RequestOutcome = 'ok' | 'auth' | 'rejected' | 'outage' | 'counted' | 'not-attempt';
export function classifyAnswer(status: number, bodyIsJson: boolean, success: boolean, body?: unknown): RequestOutcome;
export function classifyError(error: unknown, stopReason: SyncStopReason | undefined): RequestOutcome;
export function attemptOutcome(signal: AbortSignal): RequestOutcome | undefined; // worst noted: rejected > counted > auth > outage > not-attempt
```
`BoundedRequest.noteOutcome`/`noteAnswer` now return the `RequestOutcome` and record it on the caller's signal. Keep `attemptNotServed`, `failingServerAnswered` and `authWasRejected` as wrappers over the recorded outcomes until T6 removes their callers.

Test-first: yes — table test: 401 any body → `auth`; T1's expiry 403, JSON and non-JSON → `auth`; JSON 400/422 → `rejected`; JSON 404/408/413 → `counted`; 2xx with `success:false` → `counted`; 5xx/429/non-JSON 4xx/JSON 502/504 → `outage`; ECONNREFUSED, own timeout, reset after send → `outage`; `stopReason` `deadline`/`aborted` → `not-attempt`; three in-request retries under one signal give one recorded outcome.

- [ ] Write the table test and run it (FAIL). Implement. Run it (PASS).

### Task 3: Delivery-budget owner and record fields

**Files:** Create `src/agents/core/session/delivery-budget.ts`. Modify `types.ts:193-212` and `SessionStore.ts:45-56`. Test `src/agents/core/session/__tests__/delivery-budget.test.ts` and `SessionStore.save.test.ts`.

**Interfaces — Produces:**
```ts
// types.ts Session additions
deliveryFailingSince?: number; deliveryRealAttempts?: number; droppedReason?: DropReason;
export type DropReason = 'rejected by the server' | 'retry budget exhausted' | 'retention expired';
// delivery-budget.ts
export function retryWindowMs(): number;                                   // env CODEMIE_DELIVERY_RETRY_WINDOW_MS, default 86_400_000
export function beginRealAttempt(s: Session): Session;                     // deliveryRealAttempts+1, saved before the send
export function noteOutcome(s: Session, o: RequestOutcome, now: number): Session; // starts clock on first non-ok; gives back the attempt unless 'counted'
export function budgetSpent(s: Session, lastOutcome: RequestOutcome, now: number): DropReason | undefined;
export function notDroppedBefore(s: Session, now: number): number;        // (deliveryFailingSince ?? now) + window
export function hasUndeliveredData(s: Session): Promise<boolean>;          // the only predicate; moved from stale-session-reconciliation.ts:144-162
export function leaveQueue(s: Session, reason: DropReason | undefined, now: number): Promise<void>; // sets droppedAt+droppedReason only when undelivered and reason given, then renames
```
`hasUndeliveredData` counts `rejected` lines as not undelivered and ignores `syncAttempts`. Keep the legacy-withheld and gate-skipped exceptions from EPMCDME-17054. When `noteOutcome` gets a `rejected` outcome, it sets `droppedAt`/`droppedReason: 'rejected by the server'` on the record (first set wins), so the notice can report the drop. The record stays queued while other lines are undelivered. `mergeCompleted` takes the earliest `deliveryFailingSince` and the larger `deliveryRealAttempts`, and `droppedReason` travels with the first `droppedAt`.

Test-first: yes — `budgetSpent` returns undefined at 23h with 5 counted attempts, and at 25h with 2. It returns `retry budget exhausted` at 25h with 3 attempts after `counted`, but not after an `outage`. It returns `retention expired` past `evidenceRecordIdleDays`. `future clock never spends budget`. The env override at 1000 ms is honoured. A `rejected` outcome stamps the reason. A merge keeps the earliest clock and the reason paired with `droppedAt`.

- [ ] Write the tests and run them (FAIL). Implement, then re-export `hasUndeliveredData` from the old location only if a caller outside the session layer needs it. Run them (PASS).

### Task 4: Line model — no caps, a `rejected` status, one send per pass

**Files:** Modify `src/agents/core/session/types.ts:76` (`SyncStatus` gains `'rejected'`), `conversations/{types.ts,payload-queue.ts:11-32,syncProcessor.ts:367-397,apiClient.ts:185-209}` and `metrics/metrics-sync-processor.ts:31-37,270-295`. Tests are next to each file.

**Interfaces — Consumes:** T2's `RequestOutcome`. **Produces:** `CONVERSATION_SYNC_STATUS.REJECTED`. `apiClient` results carry `outcome: RequestOutcome`.

Remove `MAX_CONVERSATION_SYNC_ATTEMPTS` and `MAX_SYNC_ATTEMPTS`. A line whose outcome is `rejected` gets status `rejected` and is never resent. `syncAttempts` is diagnostic only. Each processor sends a given line at most once per call.

Test-first: yes — a payload with `syncAttempts: 7, status: failed` is still a send candidate. A JSON 400 marks the line `rejected` and a JSON 404 marks it `failed`. One `sync()` call never PUTs the same payloadId twice.

- [ ] Write the tests and run them (FAIL). Implement. Run them (PASS).

### Task 5: Bounded timer runs and stable delta id

**Files:** Modify `src/providers/plugins/sso/proxy/plugins/sso.session-sync.plugin.ts:208-279`, the metrics processor send path and `MetricsWriter.ts:80`. Tests are in the existing plugin and processor tests.

Each timer tick creates its own `AbortController`, passes its signal down, and stops the run at the first outcome that is not `ok`. Every delta carries `deltaId` = a stable hash of its sorted record ids, created once at write time and sent unchanged on every resend.

Test-first: yes — against a 503 server one tick sends exactly one request and then stops. A resent delta carries the same `deltaId` as its first send.

- [ ] Write the tests and run them (FAIL). Implement. Run them (PASS).

### Task 6: Reconciler reports outcomes to the owner

**Files:** Modify `src/agents/core/session/stale-session-reconciliation.ts`: `beginAttempt:298-307`, `settleAttempt:327-355`, `restoreCounter:358-370`, `closeExhaustedLocally:385-399`, `markTranscriptUnsent:426-431`, `finalizeRecord:437-458`, `attemptRecord:461-498`, `finalizeOwnRecord:628-655`. Also `MAX_ATTEMPTS:60` and `markDroppedIfUndelivered:165-170` are removed. Test `__tests__/stale-session-reconciliation.test.ts`.

**Interfaces — Consumes:** T2 `attemptOutcome`, T3 `beginRealAttempt`, `noteOutcome`, `budgetSpent` and `leaveQueue`.

Every path sends first, then calls `noteOutcome` with `attemptOutcome(signal)`, then `budgetSpent`. Nothing is decided before the send. A stranded record is flushed unless `budgetSpent` says its budget is spent. When the auth marker is set, `classifyRecord` makes no request, so no clock starts. Local-by-design closes call `leaveQueue(s, undefined)`.

Test-first: yes — the cases are: 4 launches of 503 then a healthy start → 0 dropped and 5 delivered (AC1); `old-cap records are sent` (AC4); 25h with 2 counted attempts → kept, the 3rd counted → dropped (AC3); 401 and expiry-403 → no real attempt and still queued (AC6); a send cut by the deadline → `deliveryRealAttempts` unchanged (AC7); a >24h 503 outage with 3 starts, using the override → kept (AC2). Update the existing assertions at `:498-584,:1190-1207` to the new rule.

- [ ] Write the tests and run them (FAIL). Implement. Run them (PASS).

### Task 7: Hook paths and `/clear`

**Files:** Modify `src/cli/commands/hook/delivery.ts:49-56,91-127`, `src/cli/commands/hook.ts:332,1173-1177,1434,1466-1473` and `session-generation.ts:192`/`isLiveRecordFileName` (`stale-session-reconciliation.ts:67-73`). Test `src/cli/commands/__tests__/hook.session-delivery.test.ts`.

`isDeliveryDone` becomes `!(await hasUndeliveredData(s))`, and `hasNoPendingData` is deleted. The SessionEnd hook delivery at `hook.ts:332` reports its outcome through `noteOutcome`. If a `/clear` generation is still undelivered when `GENERATION_CLOSE_BUDGET_MS` ends, it stays under a name the start pass lists and is not marked. `closeUnclosedLocally` goes through `budgetSpent`/`leaveQueue`.

Test-first: yes — the cases are: a `/clear` during a 503 → previous generation unmarked, and the next healthy start delivers it (AC8); end metric sent plus one payload at `syncAttempts: 3` that later succeeds → never `droppedAt` (AC12, the C/D path). Update the tests at `:1362-1380,:1587-1960,:2262-2284`.

- [ ] Write the tests and run them (FAIL). Implement. Run them (PASS).

### Task 8: Desktop parity

**Files:** Modify `src/telemetry/runtime/DesktopSessionDelivery.ts:11,99-128,215-216` and `DesktopTelemetryRuntime.ts:461-463`. Tests `DesktopTelemetryRuntime.test.ts:1881-1914` and `DesktopTelemetryRuntime.start.test.ts:286-467`.

Delete the copied check at `:112-119`. `deliverLocked` and the live re-delivery passes use `beginRealAttempt`/`noteOutcome`/`budgetSpent`/`leaveQueue`, and live passes count real attempts. `reopenCompleted` also clears `deliveryFailingSince`, `deliveryRealAttempts` and `droppedReason`.

Test-first: yes — on a live re-delivery pass, a counted failure at 25h with 3 attempts drops the record with `retry budget exhausted`, and a 503 never drops it. A reopen clears all three new fields (AC14).

- [ ] Write the tests and run them (FAIL). Implement. Run them (PASS).

### Task 9: Exit-notice lister, formatter and docs

**Files:** Modify `src/agents/core/session/exit-notice.ts` (rewrite), `src/agents/core/BaseAgentAdapter.ts:821`, `docs/ANALYTICS-REPORT.md:52-56`, `.ai-run/guides/integration/external-integrations.md:213,319` and `docs/ARCHITECTURE-PROXY.md:173`. Tests `hook.session-delivery.test.ts:2926-3018,3490` and `stale-session-reconciliation.test.ts:539`.

**Interfaces — Produces:**
```ts
export interface ExitDeliveryEntry { kind: 'pending' | 'queued' | 'dropped'; sessionId: string; agent: string; startTime: number; notDroppedBefore?: number; reason?: DropReason }
export function listExitDelivery(ownSessionId: string, since: number, now: number): Promise<ExitDeliveryEntry[]>;
export function formatExitDelivery(entries: ExitDeliveryEntry[]): string[];
```
The lister scans the sessions dir. It dedupes by `sessionId`, keeping the newest generation's `startTime`. "Dropped" means `droppedAt >= since`, and it covers own and earlier sessions. "Earlier" means `sessionId !== ownSessionId`, and "queued" means tried since `since` and still live. The id shown is the CodeMie session id cut to 8 characters. Lines, with dates formatted `d Mon HH:mm` in local time:
- `CodeMie: this session's analytics are not delivered yet; they will be retried at later \`codemie\` starts and are not dropped before <date>.`
- `CodeMie: analytics of <n> earlier session(s) are still queued for retry; none is dropped before <earliest date>.`
- `CodeMie: analytics of these sessions were dropped: <agent> <id8> (started <date>) — <reason>; … and <N> more. Check the connection to CodeMie with \`codemie doctor\`.` This line lists at most 3 sessions.
When all data was delivered, the formatter returns no lines. Update the docs to describe the budget, the reasons and these texts.

Test-first: yes — pending and an earlier drop appear on separate lines. The pending date equals clock + window, or now + window when there is no clock (AC9). With 5 drops, 3 are named plus "and 2 more". A session with live and `completed_` files is listed once. Queued sessions get one count line (AC10). A delivered run prints nothing (AC11). No output contains "Nothing is lost".

- [ ] Write the tests and run them (FAIL). Implement. Update the docs. Run them (PASS).

### Task 10: Ticket regression scenarios

**Files:** Test `src/cli/commands/__tests__/hook.session-delivery.test.ts` (new `describe('EPMCDME-17068 regressions')`).

Test-first: no — these scenarios pin the behaviour T6-T9 deliver and pass once those tasks land. They cover AC16: delivery fails at exit → retried at the next start; pending and dropped in one run are each reported accurately; auth expires mid-delivery (401 and 403) → nothing is discarded; a permanent drop → no "Nothing is lost"; the repro sequence A-D failing 503 then a healthy E delivers everything; json400 → the rejection is reported as a drop at its own launch; `/clear` during an outage; a >24h outage via `CODEMIE_DELIVERY_RETRY_WINDOW_MS`.

- [ ] Write the scenarios and run the file (PASS).

### Task 11: Update the repro script (outside the repo)

**Files:** Modify `~/repro-17068.mjs`. A source copy is at `C:/Users/YAUHEN~1/AppData/Local/Temp/claude/e8d9244ce0b31da0/256d68ba-9985-4515-bba5-484582978e68/scratchpad/repro-17068.mjs`.

Test-first: no — this is a manual verification tool and the user runs it.

- [ ] Make these changes: 503 mode no longer sets `CODEMIE_EVIDENCE_RECORD_IDLE_DAYS`; add a `--window-ms` option that sets `CODEMIE_DELIVERY_RETRY_WINDOW_MS`; judge the verdict from the `[exit]` log lines, because the notices print only to a TTY; add a `hang` mode, where the server never answers, which asserts nothing is dropped; and fail when any log line contains "Nothing is lost". Print the run commands in PowerShell syntax, for example `node $HOME\repro-17068.mjs --mode 503`.
