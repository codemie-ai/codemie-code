# EPMCDME-17068 — honest exit notices and a time-based retry budget for session analytics

## Why

At exit the CLI promises "Nothing is lost" for sessions it later drops. It reports drops only as a count, drops at a healthy start without sending, and marks delivered sessions dropped. The analysis traces this to `exit-notice.ts:16-57`, to `stale-session-reconciliation.ts:298-307,477-483,60`, and to two predicates that disagree (`hook/delivery.ts:91-127` vs `:144-170`). Scope: sync-API data on the CLI path and in Desktop delivery.

## Behaviour

**One owner.** A single module in `src/agents/core/session/` makes every delivery decision:
- it notes each outcome, which sets the clock and the real-attempt count;
- it decides when the budget is spent;
- it holds the only *undelivered* predicate, which `isDeliveryDone` also uses;
- it gives the earliest drop time;
- it takes a record out of the queue with `droppedAt` and a reason.

The following callers only report outcomes:
- `attemptRecord`;
- the stranded paths `finalizeRecord` and `closeExhaustedLocally` (`:385-399,441-446`);
- `hook/delivery.ts:49-56`;
- `closeGenerationLocked` (`hook.ts:1466-1473`) and `closeUnclosedLocally` (`hook.ts:1173-1177`);
- `DesktopSessionDelivery`, whose copy of the check at `:112-119` goes.

On `/clear`, a generation still undelivered when `GENERATION_CLOSE_BUDGET_MS` ends stays queued, under a name the start pass lists. It is not marked dropped. A stranded record is flushed unless the verdict says its budget is spent.

**One classifier.** `bounded-request.ts` gives each request one outcome. The client stores it on the line, and the attempt's signal records it. The outcomes:
- `auth`: a 401, or a 403 that means expired credentials (JSON or not). The data is kept until the user logs in again. The plan must verify what the sync API and the SSO proxy path return for expired credentials.
- `rejected`: a JSON 400 or 422. The line is dropped at once with reason `rejected by the server`.
- `outage`: no connection, 5xx, 429, a non-JSON 4xx, the proxy's JSON 502/504, or the request's own timeout or a reset after sending. Outage outcomes are given back as today, up to evidence retention.
- `counted`: a 2xx with `success:false`, or any other JSON 4xx (404, 408, 413…).

Only a `counted` outcome is a real attempt. A request is not an attempt when it never left, was aborted before sending, or was cut by the caller's deadline or abort (`stopReason` `deadline`/`aborted`). Retries inside one request count once.

**Budget.** The clock starts at the first failed outcome the owner is told of. A path that makes no request starts nothing. A record is dropped as `retry budget exhausted` only after a `counted` failure, and only when both hold: 24h have passed since the clock started, **and** there have been at least 3 real attempts. No drop is decided before a send. Evidence retention (90 days) stays the outer bound (`retention expired`). An env variable named by the plan overrides the 24h.

**Lines.** Lines have no budget of their own. A line's status is `pending | failed | synced | rejected`. A line is dropped only when it is rejected or when its record leaves the queue, and then it carries the record's reason. `syncAttempts` is diagnostic only. The 3-send caps are removed. Bounds:
- a line is sent at most once per start pass, exit, or timer run;
- a timer run uses its own signal and stops at its first failure that is not `ok`;
- deltas carry a stable id built from their record ids (payloads are already a PUT per id).

**Fields.**
- `deliveryFailingSince` (merge: earliest).
- `deliveryRealAttempts` (merge: larger). It is incremented before the send, so a crash spends it, and given back unless the outcome is `counted`.
- `droppedReason` travels with `droppedAt` (first set wins).

`deliveryAttempts` and `finalizeAttempts` are no longer read. Consumers: `mergeCompleted`, `restoreCounter` (`:358-370`), and Desktop `reopenCompleted`, which clears the new fields too (`DesktopTelemetryRuntime.ts:461-463`).

**Exit notice.** A lister returns entries and a formatter prints them:
- Own data pending: "retried at later `codemie` starts, not dropped before <clock + window>". When no clock has started, the time is now + window. The notice never says "Nothing is lost".
- Earlier sessions this run tried that are still queued: one line with their count and the earliest time any can be dropped.
- Dropped this run: own rejected data and earlier sessions, deduplicated by session id. Each is named `<agent> <8-char id> (started <d Mon HH:mm>)`, at most 3 then "and N more", with its reason and a pointer to `codemie doctor`.
- Delivered sessions get no line: silence at exit means delivered.

## Acceptance criteria

1. A 503 over at least 4 launches within 24h, each attempting, then a healthy start: nothing is dropped. The healthy start delivers up to `RECONCILE_PER_START` records, and later starts deliver the rest.
2. An `outage` longer than 24h with 3+ starts during it drops nothing, whether it is a 503 or a server that hangs in direct mode (timeout or reset after send). Its data is delivered after recovery.
3. A record past 24h with fewer than 3 real attempts is not dropped. It is dropped only after the `counted` failure that brings it to 3.
4. A healthy start sends every record it reconciles before any drop, including records at the old caps (`deliveryAttempts`/`finalizeAttempts: 3`).
5. A JSON 400 or 422 drops the line at once with reason `rejected by the server`. A JSON 404 or 408 does not.
6. Credentials that expire during delivery leave the queued data in place and spend no real attempt, whether the server answers 401 or 403 (JSON or not). It is delivered after re-login.
7. A send cut by the exit deadline spends no real attempt.
8. A `/clear` during a 503 outage keeps the previous generation queued and unmarked, and the next healthy start delivers it.
9. No notice says "Nothing is lost". The pending line's date is clock + window (now + window when no clock has started).
10. Earlier sessions tried this run that are still queued get one line with their count and earliest drop time.
11. Pending data and an earlier drop in the same run are shown on separate lines. A dropped session is named by agent, 8-char id and start time, deduplicated. More than 3 are shown as 3 plus "and N more". A run whose data was all delivered prints no delivery line.
12. A record whose data was all delivered is never marked dropped. "Done" and "undelivered" come from one predicate.
13. During an outage, a timer run stops at its first failure, and no line is sent twice in one pass.
14. Desktop delivery, live re-delivery passes included, applies the same verdict, reasons and timing.
15. The repro `~/repro-17068.mjs` in 503 mode, 4 launches then a healthy one, drops nothing and delivers everything, without shortening `CODEMIE_EVIDENCE_RECORD_IDLE_DAYS`. In json400 mode each rejection is reported as a drop at its launch. Neither mode prints "Nothing is lost".
16. Regression tests cover the ticket's four scenarios, the repro sequence, `/clear` during an outage, an expired-auth 403, and an outage longer than 24h (via the override).
17. `docs/ANALYTICS-REPORT.md:52-56` and `external-integrations.md:213` describe the new rule and the new texts.

## Non-goals

- The OTLP pipeline (`otlp-spool/`) is not changed — user.
- No change to `canDeliver`, gating or `RECONCILE_PER_START = 5`.
- No `codemie doctor` listing of dropped sessions.
- Local-by-design closes (other host, no host, legacy, Desktop daemon gone) are still never marked dropped.
- No change to `EXIT_NETWORK_BUDGET_MS`.
- No backend change.

## Open risks

- Open question for the metrics backend owner: does the metrics API deduplicate a delta resent with the same stable id? If it does not, a delta whose answer came late can be counted twice.
- A record stuck in an outage is kept up to the 90-day retention, as today.

## Decisions

- Retry budget of 24 hours from the first failed attempt AND at least 3 real attempts, over a pure time window or a pure count; answers how long data is retried — user.
- No minimum spacing between real attempts, and no drop before 24 hours whatever the count, over spacing the attempts out; answers whether 3 tries in the first hour suffice — user.
- JSON 4xx (non-401) is a final rejection dropped right away with reason "rejected by the server", over treating it as an outage; answers how JSON 4xx counts against the budget — user.
- Only JSON 400/422 are final and other JSON 4xx are `counted` attempts, over every JSON 4xx being final. This narrows the bullet above. Answers which 4xx is the application's verdict — user, answers AR-3.
- A 403 meaning expired credentials (JSON or not) is `auth`, over `counted` or `rejected`; the plan verifies what the sync API and SSO proxy return. Answers how expiry mid-delivery keeps data — user.
- Verification uses repro mode 503 for the outage path and json400 for immediate honest drops, over a single json400 run; answers which repro mode verifies the fix — user.
- Per-line 3-send caps are removed and lines follow the record's budget and 4xx rule, over keeping the caps and reporting capped lines as dropped; answers how the delivered-yet-dropped inconsistency is fixed — user.
- One send per line per pass, timer runs that stop at the first failure, and a stable delta id, over unbounded resends; answers how resends are bounded — user, answers AR-5.
- Dropped sessions are named `<agent> <short id> (started <time>)`, at most 3 then "and N more", over a count only or names without ids; answers how the notice identifies drops — user.
- Delivered sessions get no exit line, over an explicit delivered line. Silence means delivered: a line on every normal exit would be noise, and only the pending, queued and dropped states need attention. Answers how "delivered" is distinguished — user.
- A timeout or reset after the send is `outage`, as in proxy mode, over counting it. A hang never drops data. Answers how a hanging server counts — user.
- An 8-char short id, over 6; answers how the id matches the analytics report.
- Records under the old counters start the new clock at their first new-rule attempt, over carrying the old `deliveryAttempts` into the new count; answers how on-disk records migrate — accepted by the user, may be overruled at the gate.
- A new `deliveryRealAttempts` field, over reusing `deliveryAttempts`; answers how migrated records are told apart.
- Outage answers (5xx, 429, non-JSON 4xx, proxy 502/504) never count, over counting them; answers which failures spend an attempt.
- Caller-deadline or abort cuts are not attempts, over counting them; answers whether slow exits spend budget.
- The clock starts at the first failure of any kind, over the first real attempt; answers when the 24 hours begin.
- 90-day retention stays the outer bound, over no limit; answers what ends retries that never reach 3.
- One session-layer owner of the verdict, over patching six sites; answers who decides that a record leaves the queue.
- An undelivered `/clear` generation stays queued, over leaving the queue; answers what `/clear` does during an outage.
- Desktop live re-delivery counts real attempts, over never counting; answers whether Desktop follows the rule.
- One classifier and a terminal `rejected` line status, over per-processor parsing; answers how line and record verdicts agree.
- Earlier queued sessions get a count line, over no line; answers how "queued" is shown.
- The notice shows the earliest drop time, over a fixed date; answers what "until when" can promise.
- The drop reason is stored on the record and the notice scans the sessions dir, over an in-process list; answers how hook-made drops reach the notice.
- An env override for the 24-hour window, over hard-coding it; answers how the over-24h case is verified.
