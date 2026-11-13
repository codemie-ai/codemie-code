# Technical Research

**Task**: session delivery reconciliation exit-notice
**Generated**: 2026-11-12
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-17068 — [CLI Analytics] Session telemetry reported as both queued for retry and dropped during shutdown.

Ticket: During CodeMie CLI shutdown two conflicting warnings are shown: "CodeMie: this session's analytics are not delivered yet; they will be sent at the next codemie start. Nothing is lost." and "CodeMie: analytics of 1 session(s) could not be delivered and were dropped. Check the connection to CodeMie with `codemie doctor`." Expected: session analytics reliably persisted for retry on temporary auth/connectivity failures; permanently dropped telemetry explicitly identified and accurately reported; shutdown messages distinguish pending, queued, delivered and dropped sessions; never "Nothing is lost" for discarded telemetry. Regression tests wanted: delivery fails at shutdown → retried next start; pending and dropped coexist → each reported accurately; auth expires during delivery → queued telemetry not discarded; permanently dropped → no misleading "Nothing is lost".

Local reproduction (done, confirmed): fake sync API (CODEMIE_SYNC_API_URL → local server answering 400 JSON), SSO profile, 4 failing `codemie-claude -p` launches A–D + 1 healthy E. Log: A, B, C each logged "Nothing is lost" at exit; D logged both lines (pending = D itself, dropped = A); A dropped at D's start pass after attempts 1/3 (own exit), 2/3, 3/3; B dropped at E's (healthy) start pass without an attempt (counter already 3); C and D delivered their end metric at E but were still marked dropped (likely conversation payloads marked failed by the JSON 400 verdict); E reported "3 session(s) dropped". The same repro script will verify the fix.

Known root cause: src/agents/core/session/exit-notice.ts noticeDeliveryAtExit (PENDING_EXIT_NOTICE unconditional "Nothing is lost"; countDroppedSince counts all records dropped since start, count only, no identity); src/agents/core/session/stale-session-reconciliation.ts (MAX_ATTEMPTS = 3 counted per launch, first at own exit; beginAttempt marks exhausted before attempting so a healthy start drops without a try; markDroppedIfUndelivered; settleAttempt gives back 5xx/never-left/auth-rejected attempts within evidence retention). Also DesktopSessionDelivery.ts uses MAX_ATTEMPTS/markDroppedIfUndelivered; src/cli/commands/hook.ts and hook/delivery.ts call markDroppedIfUndelivered.

Decided scope (user): BOTH — (1) honest exit messages: no "Nothing is lost" promise, state remaining retries, name/identify dropped sessions and that they are earlier sessions, distinguish pending/dropped; (2) never drop at a start where delivery works without a final attempt; (3) a time-based failure budget instead of a pure per-launch count, so a short outage across several quick launches loses nothing. Scope is the sync-API data (end metric, metric deltas, conversation payloads); the OTLP CLI Analytics pipeline is unaffected.

Investigate: all callers/consumers of MAX_ATTEMPTS, deliveryAttempts/finalizeAttempts, droppedAt, markDroppedIfUndelivered, countDroppedSince; Session type fields; existing tests (src/agents/core/session/__tests__/stale-session-reconciliation.test.ts, src/cli/commands/__tests__/hook.session-delivery.test.ts, exit-notice tests); why C/D were marked dropped despite end metric sent; Desktop delivery parity; docs mentioning these messages.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose 1 — tell the user at exit what happened to analytics.**
- `noticeDeliveryAtExit` `src/agents/core/session/exit-notice.ts:52` — pending line when own `{id}.json` exists with `codemieUrl` (`:55`, no check of attempts left or of whether it will be dropped); dropped line with a count (`:56-57`). Logged via `logger.warn`, printed to stderr unless `silentMode`. Only caller: `BaseAgentAdapter.ts:821` (after `settleStartPass` `:808`, `onSessionEnd` `:810`, `finalizeOwnRecord` `:816`), `startedAt = processStartedAt()`.
- `PENDING_EXIT_NOTICE` `exit-notice.ts:39-40` — literal "Nothing is lost."; `droppedExitNotice(count)` `:42-45`.
- `countDroppedSince(since)` `exit-notice.ts:16-37` — scans every `*.json` in sessions dir with mtime >= since-2s (`MTIME_SLACK_MS` `:13`), counts `droppedAt >= since`. Includes `completed_*`, generation files and own record; returns count only, no ids, no reason, no distinction between earlier sessions and own.
- No other user-facing reader of `droppedAt` found (searched `droppedAt` in non-test `src/`): only exit-notice, `SessionStore.mergeCompleted` (`SessionStore.ts:52`) and Desktop reopen clearing it (`DesktopTelemetryRuntime.ts:461-463`).

**Purpose 2 — keep undelivered sync-API data queued and retry it.**
- Queue = file name: live `{id}.json` (completed) is undelivered; `renameSessionFiles` `session-generation.ts:192` moves it to `completed_*` (leaves the queue).
- Record-level budget `MAX_ATTEMPTS = 3` `stale-session-reconciliation.ts:60`, fields `deliveryAttempts` / `finalizeAttempts` (`types.ts:208,210`).
- `beginAttempt` `:298-307` — saves counter+1 before the attempt; `exhausted = before >= 3`, computed before any request.
- `attemptRecord` `:461-498` — when `exhausted` and `undelivered`: `markDroppedIfUndelivered` + rename, no send (`:477-483`); else `deliverSession` (`:485-486`). Stranded/legacy go to `finalizeRecord` `:437-458` (exhausted → synthetic end without flush, `closeExhaustedLocally` `:385-399` on throw).
- `finalizeOwnRecord` `:628-655` — own completed `{id}.json` at exit goes through the same `attemptRecord(kind:'undelivered')` (`:643-650`), so the own exit spends attempt 1/3.
- `reconcileOtherSessions` `:577-608` — every wrapper start, ≤ `RECONCILE_PER_START = 5` (`:52`) newest first; `classifyRecord` `:245-266` lists `undelivered` only when `canDeliver` (same host, send path, credentials not marked invalid).
- `settleAttempt` `:327-342` — gives the counter back on: auth rejected (always); never-left or failing-server (5xx/429/non-JSON 4xx) — the latter only `withinEvidenceRetention` (`:351-355`, `evidenceRecordIdleDays()` days); legacy destination wait; abort before send. A JSON 4xx (non-401), timeout, reset after send, 2xx-not-success, or deadline expiry stays counted.
- Per-line caps, separate from the record budget: metric deltas `MAX_SYNC_ATTEMPTS = 3` + `isDeltaSendCandidate` `metrics-sync-processor.ts:31-37`; conversation payloads `MAX_CONVERSATION_SYNC_ATTEMPTS = 3` + `isSendCandidate` `payload-queue.ts:12,28-32`. `applyPayloadOutcome` `syncProcessor.ts:367-397` increments `syncAttempts` on every send, success or failure; no give-back rule applies to these counters.
- Desktop parity: `DesktopSessionDelivery.deliverLocked` `src/telemetry/runtime/DesktopSessionDelivery.ts:99-128` — same `MAX_ATTEMPTS` check before sending (`:112-119`: `>= 3` → mark dropped + rename without sending), counter+1 then `settleAttempt` (`:125`). Called from `finalizeLocked` `:74` and re-delivery passes (`DesktopTelemetryRuntime`).
- No time-based budget for these records found (searched attempt/retention constants). The nearest time rule: `withinEvidenceRetention` (90 days default, only for give-back) and the OTLP spool's `deliveryGate` / `expireDeliveryLocked` retention bound (`otlp-spool/delivery-state.ts:34-44,110`), which is in the out-of-scope OTLP pipeline.

**Purpose 3 — mark data that leaves the queue unsent.**
- `markDroppedIfUndelivered` `stale-session-reconciliation.ts:165-170` — writes `droppedAt` when `hasUndeliveredData` `:144-162` is true: end metric neither sent nor skipped; or (matched record) any delta `syncStatus !== 'synced'` (unless legacy-withheld); or any payload `pending`/`failed` without a `success` of the same id. **Ignores `syncAttempts`.**
- `markTranscriptUnsent` `:426-431` — copilot-cli exhausted close sets `droppedAt`.
- Callers (every one sets the timestamp the notice counts): `attemptRecord` `:478`; `closeExhaustedLocally` `:391`; `deliverSessionRecord` `hook/delivery.ts:51` (when `isDeliveryDone`); `closeUnclosedLocally` `hook.ts:1174`; `closeGenerationLocked` `hook.ts:1471` (`/clear`); `DesktopSessionDelivery.ts:116`.

**Why C and D were marked dropped with their end metric sent** (code path, not reproduced here): `isDeliveryDone` `hook/delivery.ts:91-103` → `hasNoPendingData` `:109-127` treats a payload/delta past its 3-send cap as no longer pending, so delivery counts as "done"; `delivery.ts:49-51` then calls `markDroppedIfUndelivered`, whose `hasUndeliveredData` still counts that `failed` payload → `droppedAt`. The JSON 400 answers are application rejections (counted), each send adding 1 to the payload's `syncAttempts`. Whether three sends happened before E (e.g. SessionEnd hook sync plus exit delivery per launch) is unverified; the repro log's payload `syncAttempts` values would settle it.

Other touched code:
- `Session` fields `endMetricSentAt`/`endMetricSkipped`/`deliveryAttempts`/`finalizeAttempts`/`droppedAt` `src/agents/core/session/types.ts:193-212`.
- `SessionStore.mergeCompleted` `SessionStore.ts:52-54` — merges `droppedAt` (first set wins) and attempts (larger wins).

### Decisions Already in the Code
- Attempts counted per launch (one per start pass / own exit), not per time — `beginAttempt` `:298`. Alternative: time window. Reason: none found beyond comment `:54-59`.
- Counter saved before the attempt so a crash spends it (`stale-session-reconciliation.ts:13-14` header). A consequence: exhaustion is decided before the request, so a reachable server at that start is never tried.
- Give-back for unserved/5xx attempts bounded by evidence retention (`settleAttempt` `:332`, doc `docs/ANALYTICS-REPORT.md:52`), so such records eventually drop.
- JSON 4xx other than 401 = application rejection, counted (`settleAttempt` doc `:321-323`). The repro's fake server answers exactly this, so it is not an outage by the code's rules.
- Per-line caps (3) live in the sync processors and are independent of `deliveryAttempts`.
- Local-by-design closes are never marked dropped (other host, no host, legacy, desktop-daemon-gone) — `closeExhaustedLocally` `:390`, `hook.ts:1451`.
- Notice is anchored on `processStartedAt()` time, not on ids handled by this launch.
- Data direction: `droppedAt` is stored per record file as a timestamp only; the notice needs per-launch identity and kind (own vs earlier, pending vs dropped). Today identity is only recoverable by rescanning file names; no reason field is stored.

### Task Statements Checked Against the Code
- "PENDING_EXIT_NOTICE unconditional 'Nothing is lost'" — holds (`exit-notice.ts:55`).
- "countDroppedSince counts all records dropped since start, count only" — holds (`:16-37`); also counts the own record and generation files.
- "MAX_ATTEMPTS = 3 counted per launch, first at own exit" — holds (`finalizeOwnRecord:643-650` → `attemptRecord`).
- "beginAttempt marks exhausted before attempting so a healthy start drops without a try" — holds (`:304`, `:477-483`).
- "settleAttempt gives back 5xx/never-left/auth-rejected within evidence retention" — partly: auth-rejected is given back regardless of retention; only failing-server answers are retention-bound (`:329-335`).
- "DesktopSessionDelivery uses MAX_ATTEMPTS/markDroppedIfUndelivered" — holds (`:112-119`), with its own copy of the exhausted check.
- "hook.ts and hook/delivery.ts call markDroppedIfUndelivered" — holds (`hook.ts:1174,1471`, `delivery.ts:51`).
- "C/D likely marked dropped by conversation payloads failed by JSON 400" — consistent with the code path above; the exact send count is unverified.
- "time-based failure budget instead of per-launch count" — keeps in place the per-line caps (`MAX_SYNC_ATTEMPTS`, `MAX_CONVERSATION_SYNC_ATTEMPTS`) unless they are also addressed; those alone produced C/D's drop.
- "OTLP pipeline unaffected" — holds: none of these symbols are imported by `otlp-spool/` except `evidenceRecordIdleDays` being read from there (`stale-session-reconciliation.ts:34`).

### Consumers of Changed Contracts
- `MAX_ATTEMPTS`: `beginAttempt`, `closeExhaustedLocally:395-397`, `finalizeRecord:442`, `attemptRecord:480-485` log lines, `DesktopSessionDelivery.ts:11,113`. Tests: `stale-session-reconciliation.test.ts` (e.g. `:503`, `:1190` loop over 1..3), `hook.session-delivery.test.ts` (`:1587-1669`, `:2970`, `:2987`), `DesktopTelemetryRuntime.test.ts:1881-1899`, `DesktopTelemetryRuntime.start.test.ts:328-334`.
- `deliveryAttempts`/`finalizeAttempts`: above plus `SessionStore.ts:53-54`, `DesktopTelemetryRuntime.ts:461-462`, `SessionStore.save.test.ts`.
- `droppedAt`: `exit-notice.ts:30-31`, `SessionStore.ts:52`, `DesktopTelemetryRuntime.ts:463`; ~40 test assertions across the files above.
- `markDroppedIfUndelivered`: 6 call sites listed in Purpose 3.
- `noticeDeliveryAtExit`: `BaseAgentAdapter.ts:821`; tests `hook.session-delivery.test.ts:2926-3018,3490`, `stale-session-reconciliation.test.ts:539`, `BaseAgentAdapter.signals.test.ts`.
- Message text: `hook.session-delivery.test.ts:2927-2928` (literal constants), `docs/ANALYTICS-REPORT.md:52-56`.
- `isSendCandidate`/`isDeltaSendCandidate`: `hook/delivery.ts:113-121`, `syncProcessor.ts`, `metrics-sync-processor.ts`.

### Architecture and Layers Affected
- Agent core / session layer: `src/agents/core/session/` (exit-notice, stale-session-reconciliation, types, SessionStore).
- CLI hook delivery: `src/cli/commands/hook/delivery.ts`, `src/cli/commands/hook.ts`.
- Provider sync processors: `src/providers/plugins/sso/session/processors/{conversations,metrics}/`.
- Telemetry runtime (Desktop daemon): `src/telemetry/runtime/DesktopSessionDelivery.ts`.
- Wrapper lifecycle: `BaseAgentAdapter.ts` exit step `:804-825`.

### Integration Points
- Sync API (`CODEMIE_SYNC_API_URL` / proxy) — end metric (`hook/end-metric.ts`), deltas, conversation PUT `/v1/conversations/{id}/history` (`apiClient.ts:102`).
- Outcome signals from `bounded-request.ts` (`authWasRejected`, `attemptNotServed`, `failingServerAnswered`, `awaitingDestination`, `sendWasAttempted`) feed `settleAttempt`.
- Analytics auth marker `getAnalyticsAuthStatus` (`analytics-auth-status.ts`) gates `canDeliver`.

### Patterns and Conventions
- Every finalization/delivery under `{id}.reconcile.lock` (`reconcileLockPath` `:82`), re-checked under the lock.
- Atomic record writes via `SessionStore.saveSession`; `completed_*` merge rules in `mergeCompleted`.
- Pipeline injection for tests: `HookPipeline` (`:91-104`).
- Exit network work shares one `EXIT_NETWORK_BUDGET_MS` deadline (`start-pass.ts`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/integration/external-integrations.md:213` — reconciliation summary: "≤ 5 records per start, ≤ 3 attempts each".
- `.ai-run/guides/integration/external-integrations.md:319` — stranded sessions troubleshooting row.
- `docs/ANALYTICS-REPORT.md:52-56` — defines undelivered/dropped session, attempt counting rules and both exit-notice texts verbatim.
- `docs/ARCHITECTURE-PROXY.md:173` mentions the same terms.

### Architectural Decisions
- No ADR found. Prior task docs: `docs/superpowers/tasks/2026-11-09-epmcdme-17054-...` (gate-skipped deltas must not set `droppedAt`), `2026-10-31-epmcdme-16546-...` (notes "droppedAt is informational").

### Derived Conventions
- Prose comments state counting rules next to the code (`:54-59`, `:315-326`); docs mirror them in ANALYTICS-REPORT.md.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/__tests__/hook.session-delivery.test.ts` — exit notice block `:2926-3018` (pending on 503, no line without host, capped record → one dropped line, payload `failed` vs `pending/success` dropped decision, dropped before start not counted); attempt counting `:1587-1960`; `/clear` drops `:1362-1380`, `:2262-2284`.
- `src/agents/core/session/__tests__/stale-session-reconciliation.test.ts` — exhausted/unmarked cases `:498-584`, attempts loop `:1190-1207`, legacy gate `:1661-1693`, notice `:539`.
- `src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts:1881-1914`, `DesktopTelemetryRuntime.start.test.ts:286-467` — Desktop attempt cap and give-back.
- `src/agents/core/__tests__/BaseAgentAdapter.signals.test.ts` — exit step ordering.

### Testing Framework and Patterns
- Vitest; temp `CODEMIE_HOME` sessions dir; `respond = () => new Response(...)` fake fetch; `writeRecord`/`readRecord`/`writeDeltas` helpers; `vi.spyOn(console,'error')` for stderr; dynamic imports after mocks.

### Coverage Gaps
- No test of several consecutive failing launches then a healthy one (the repro sequence).
- No test asserting a healthy start delivers a record at its counter limit.
- No test of a record whose end metric was sent but a payload hit its per-line cap (the C/D path through `delivery.ts:51`), other than the capped-record case `:2983-3005`.
- No test that the pending line and dropped line refer to distinct sessions.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_SYNC_API_URL` — send path (used by the repro).
- `CODEMIE_EVIDENCE_RECORD_IDLE_DAYS` — retention for give-back (`evidenceRecordIdleDays`, default 90).
- `CODEMIE_EXIT_DEADLINE_MS` (`EXIT_DEADLINE_ENV` `:79`) — exit budget for in-process hooks.
- `CODEMIE_CONV_SYNC_DISABLED` — skips conversation sync.

### Configuration Files
- None specific; constants in code (`MAX_ATTEMPTS`, `RECONCILE_PER_START`, `MAX_SYNC_ATTEMPTS`, `MAX_CONVERSATION_SYNC_ATTEMPTS`, `LEGACY_IDLE_MS`).

### Feature Flags and Deployment Concerns
- No flags. Records on users' disks already carry `deliveryAttempts` up to 3 and payload `syncAttempts`; any changed rule applies to those existing files at next start.

---

## 6. Risk Indicators

- Three independent 3-strike counters (record `deliveryAttempts`, delta `syncAttempts`, payload `syncAttempts`); the per-line ones alone dropped C/D. See Task Statements.
- `hasUndeliveredData` and `hasNoPendingData` disagree by design on capped lines (`stale-session-reconciliation.ts:144` vs `delivery.ts:109`) — the root of "delivered yet dropped".
- JSON 4xx is a counted rejection; the repro's 400 is not an outage under current rules, so the time-budget goal interacts with how 4xx is classified.
- Desktop delivery duplicates the exhausted check (`DesktopSessionDelivery.ts:112-119`) instead of using `beginAttempt`.
- `countDroppedSince` relies on mtime and wall clock; identity of dropped sessions is not stored anywhere.
- ~65 test assertions reference attempts/`droppedAt`/notice text; literal message constants in tests and `docs/ANALYTICS-REPORT.md:55-56`, guide `external-integrations.md:213` ("≤ 3 attempts").
- Speculative: a time-based budget needs a first-failure timestamp per record (and possibly per line); `SessionStore.mergeCompleted` would then need a merge rule for it.
- Speculative: existing records already at `deliveryAttempts: 3` would be dropped at the next start under unchanged `beginAttempt`, before any new rule applies.

---

## 7. Summary for Complexity Assessment

The change spans the agent-core session layer (`exit-notice.ts`, `stale-session-reconciliation.ts`, `types.ts`, possibly `SessionStore.mergeCompleted`), the CLI hook delivery path (`hook/delivery.ts`, `hook.ts` at two `markDroppedIfUndelivered` sites), the SSO sync processors' per-line caps (`metrics-sync-processor.ts`, `payload-queue.ts`/`syncProcessor.ts`), and the Desktop daemon (`DesktopSessionDelivery.ts`), with the single notice call in `BaseAgentAdapter.ts:821`. Roughly 6–9 source files plus docs (`ANALYTICS-REPORT.md`, `external-integrations.md`).

Novelty is moderate: retry/give-back machinery (`settleAttempt`, bounded-request signals, reconcile locks) exists and is reusable, but there is no time-based budget for sync-API records today and no stored identity/reason for drops. The C/D symptom comes from a second mechanism — per-line 3-send caps plus `hasUndeliveredData` ignoring them — which the record-level budget does not cover.

Test coverage is dense (hook.session-delivery, stale-session-reconciliation, Desktop runtime tests) but asserts current counts and literal message texts, so many tests will move; the repro sequence (consecutive failing launches, then healthy) has no test. Key risks: three interacting counters, existing on-disk records at the cap, Desktop parity, and JSON 4xx classification versus the "short outage loses nothing" goal.

---

## 8. External References

None named by the task.
