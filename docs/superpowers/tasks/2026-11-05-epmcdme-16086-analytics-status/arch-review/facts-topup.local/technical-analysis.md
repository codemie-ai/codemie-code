# Technical Research

**Task**: delivery_failed liveDelivery areCredentialsStale analytics_endpoint_mismatch
**Generated**: 2026-11-05
**Research path**: filesystem (top-up to `../../technical-analysis.md`; covers only the four names below)

---

## 1. Original Context

EPMCDME-16086 — analytics delivery health in `codemie proxy status` and restyled `codemie proxy analytics status` (spec at docs/superpowers/tasks/2026-11-05-epmcdme-16086-analytics-status/spec.md). Top-up research - record facts only, for the names the spec relies on that the analysis does not cover: delivery_failed, liveDelivery, areCredentialsStale, analytics_endpoint_mismatch. For each: where it is defined, what it does today on the path this task changes, and who consumes it.

---

## 2. Codebase Findings

All paths below are under `src/providers/plugins/sso/proxy/plugins/otlp-spool/` unless they say otherwise.

### Existing Implementations

**Purpose: tell whether analytics delivery is stuck on a failing request (spec rule 4, `delivery_failed`)**

- `'delivery_failed'` as a **token**: `session-project.ts:28-34` `DELIVERY_LOSS_REASONS = ['delivery_rejected','destination_unavailable','response_unverified','delivery_failed']`, type `DeliveryLossReason`. It is one of four. It is also part of `LossReason` (`session-project.ts:37-42`), so it can appear as `lastLoss.reason` after a range expires.
  - Producer: `deliveryFailureOf()` `delivery-state.ts:170-178`. Returns nothing for `ok`, `discarded`, `auth-expired`, `credentials_stale` and `not_sendable`. Maps `http_400/413/422` to `delivery_rejected`, a `detail`-bearing outcome to `destination_unavailable`, `response_malformed/too_large` to `response_unverified`, and everything else (5xx, network, `response_read_failed`) to `delivery_failed` with `detail = cause`.
  - It is stored as `SessionStatus.delivery[stream]: DeliveryFailure` (`session-status.ts:69`, interface `:124-135`: `reason, detail?, since, cursor, end, attempts, nextAt`). On-disk file: `statusFile(sessionId)` (`spool-paths.ts:57`). `parseDelivery` (`session-status.ts:196-217`) drops a record with `since==0`, `end<=cursor` or an unknown reason.
  - Written by `noteDeliveryFailure` (`delivery-state.ts:128-163`, via `recordUnacknowledged` `:181-194`, called from the forwarder). Trimmed or cleared by `advanceCursor` (`session-status.ts:337-349`), `deliveryGate` (`delivery-state.ts:96-120`), `expireDeliveryLocked` (`:34-44`, which moves the record into `lastLoss` at `heldRetentionMs`) and `expireCarriedAgeLocked` (`:80-85`).
  - The record survives a daemon restart, and nothing removes it while the daemon is stopped.
- `liveDelivery(sessionId, status, stream)` is at `delivery-state.ts:18-26`. It is **module-private (not exported)**. A record is "live" only when `rec.cursor === status.cursors[stream]` **and** the stream file's current size is `>= rec.end`. If `stat` fails, it returns `undefined`. It is async and does one `stat` per call. It does not check `nextAt` or `since`, so a record past retention that has not expired yet still counts as live.
  - Consumers: `deliveryGate` `:106` (a non-live record is deleted and the status rewritten, under the session lock) and `noteDeliveryFailure` `:139` (the previous live record keeps `since`, `end` and `attempts`). Both callers hold `withSessionLock`. No other caller exists.
- **Name collision:** `delivery_failed` is the spec's health reason (`spec.md:16,26`) **and** one of four `DeliveryLossReason` values. Spec rule 4 fires on "a live delivery-failure record", and that record may carry any of the four reasons.

**Purpose: tell whether the daemon has stopped sending because the login was rejected (spec rule 1, `credentials_expired` via `/health`)**

- `areCredentialsStale()` is at `auth-state.ts:18`. It returns the module-level `let credentialsStale` (`:16`). The value lives **in daemon-process memory only**: no file, and lost on restart.
  - `markCredentialsStale()` `:20-27` warns once. Its only callers are in `forwarder.ts:466,477,485`, when `authExpired()` is true for the hooks, OTEL or OTEL-JSON streams (401/403/302 after one retry).
  - `clearCredentialsStale()` `:30-34` is called only by `otlp.plugin.ts:157` after `resolveFreshCredentials` succeeds.
- Readers today:
  - `forwarder.ts:124`: `send()` returns `{kind:'failed', reason:'credentials_stale'}` without a request.
  - `tick-processor.ts:179`: the endpoint is not resolved while stale.
  - `tick-processor.ts:189-193`: the tick returns early and only expires carried age.
  - `otlp.plugin.ts:144`: `refreshCredentialsIfStale` re-reads the credential store when stale, or on the periodic throttle.
- While stale: no delivery record is written (`credentials_stale` and `auth-expired` are excluded at `delivery-state.ts:171-173`), and no hold is set or cleared (the tick exits before `applySessionEvidenceLocked`). Data that already exists on disk, such as holds or delivery records, stays as it was. The rule is documented in `docs/ARCHITECTURE-OTLP-PLUGIN.md:324` ("Deliberate exclusion ... not bounded by this window").

**Purpose: tell whether data is held because the analytics URL does not match the login (spec rule 3, `endpoint_mismatch`)**

- `'analytics_endpoint_mismatch'` is in `HOLD_REASONS` at `session-project.ts:15`. It is persisted as `holds.session = {reason, since}` and validated by `parseHolds` (`session-status.ts:168-179`).
- Its only producer is `holdEndpointMismatch` (`tick-processor.ts:136-159`), reached from `processSessionTick` `:180` when `resolveAnalyticsEndpoint(credentials)` returns `null` (`classification.ts:131`).
  - `null` means the URL candidates from daemon state (`syncApiUrl` / `ensureApiBase(syncCodeMieUrl)`, else `targetUrl`/`url`) do not canonicalize to the credentials' `api_identity`. The comment at `classification.ts:129` also says "or stale daemon/credentials".
  - The hold is set only when `hasPendingData` (`:142`), keeps its first `since` (`:155`), and warns once when the reason changes (`:152-153`).
  - Past `heldRetentionMs()` it is cleared and recorded as `lastLoss.reason = 'analytics_endpoint_mismatch'` (`:148-150`, `holdOrLose` `session-project.ts:51-59`).
- It is cleared or replaced by the next non-stale tick with pending data, through `applySessionEvidenceLocked` (`tick-processor.ts:107-123`: another hold reason overwrites `reason` and keeps `since`; a send or loss calls `clearHold`).
- Readers of `holds.session`:
  - `session-project.ts:250` (any session hold means a `held` project policy).
  - `tick-processor.ts:82,108-109,146,152,181` (reprobe check for `organization_encoding_unsupported`).
  - `delivery-state.ts:62-63` (the carried-age loss reason uses the hold reason).
- Documented in `docs/ARCHITECTURE-OTLP-PLUGIN.md:313`.

**Other touched code:** none beyond the above.

### Decisions Already in the Code

- Being "stale" is in-memory daemon state, chosen over a file (`auth-state.ts:6-16`). It resets to `false` on every daemon start. No reason is recorded. The only out-of-process view is whatever the daemon exposes.
- Liveness of a delivery record is computed against the current cursor and file size, not trusted from the stored record (`delivery-state.ts:17-26`). Stale records are cleaned up lazily, only by the forwarder's gate, so a non-live record can sit on disk until the next gate pass.
- The two auth failure modes (`credentials_stale`, `auth-expired`) are deliberately not delivery failures and get no record or clock (`delivery-state.ts:165-173`; `ARCHITECTURE-OTLP-PLUGIN.md:324`).
- An endpoint-mismatch hold is session-scoped, set only with pending data, and its first-hold `since` is kept across reason changes (`tick-processor.ts:131-159`).
- The session status is written only by daemon code. Nothing under `src/cli/` imports `session-status.js`, `delivery-state.js` or `auth-state.js` (searched with grep, tests excluded). The only CLI-side test that touches this area is `src/cli/commands/proxy/__tests__/analytics-destination.test.ts`, which imports `resolveAnalyticsEndpoint`.
- Status reads in the daemon go through `readStatus` (`session-status.ts:292-299`). It never throws (`null` on any error) and normalizes the file. Locked writers use `withSessionLock`, which is not reentrant (`session-status.ts:309-310`).

### Task Statements Checked Against the Code

- "`liveDelivery`, `delivery-state.ts:18`" **holds** as the location. It is **not exported** and is async with a `stat` per call (`delivery-state.ts:18`).
- "a stream has a live delivery-failure record" (rule 4, reason `delivery_failed`) **holds**: the records are in `status.delivery[stream]`. Their `reason` is any of four `DeliveryLossReason` values, not only `delivery_failed` (`session-project.ts:28-33`).
- "`areCredentialsStale()` (`auth-state.ts:18`)" **holds**. The value is daemon-memory only, so it can only reach the CLI through the daemon (`auth-state.ts:16`).
- "`holds.session.reason === 'analytics_endpoint_mismatch'` (... `tick-processor.ts:136`)" **holds** (`tick-processor.ts:136-159`, `session-project.ts:15`). "a session with pending data" matches the producer's own gate (`:142`).
- "No other hold reason affects health" **keeps in place** the 12 other `HOLD_REASONS` (`session-project.ts:6-20`) as non-health signals. Their consumers are `session-project.ts:250` and `tick-processor.ts` (above).
- AC4 "ignores a delivery record that fails the forwarder's liveness check" **holds** with the current rule: cursor equality plus file size `>= end` (`delivery-state.ts:20-22`).

### Consumers of Changed Contracts

- `areCredentialsStale` (spec: read for `/health`): consumers are `forwarder.ts:124`, `tick-processor.ts:179,189`, `otlp.plugin.ts:144`, plus test mocks in `otlp.plugin.*.test.ts`, `tick-processor.test.ts:37`, `owner-pending-retention.test.ts:31`, `delivery-retention.test.ts:30`, `project-interleave.test.ts:40` and `src/agents/core/evidence/__tests__/owner-pending.test.ts:58`. A read-only extra consumer does not change what they get.
- `liveDelivery`: consumers are `delivery-state.ts:106,139` only.
- `DELIVERY_LOSS_REASONS` / `HOLD_REASONS`: consumers are `session-status.ts:174,184,204` (parsers) and `LOSS_REASONS`.
- `/health` handlers: `sso.proxy.ts:291` and `src/cli/commands/proxy/awaiting-login-listener.ts:65`. These were covered by the base analysis and not re-read here.

### Architecture and Layers Affected

- Provider/proxy plugin layer (daemon): `otlp-spool/` modules above.
- CLI layer: `src/cli/commands/proxy/`, which does not currently read any of these four.

### Integration Points

- Daemon to on-disk spool: `spoolRoot()` (`spool-paths.ts:9`) and `statusFile()` (`:57`).
- `resolveAnalyticsEndpoint` reads the daemon state through `cli/commands/proxy/daemon-manager.js` `readState` (`classification.ts:132`).

### Patterns and Conventions

- Reason tokens are `as const` arrays with derived union types (`session-project.ts`).
- Statuses are normalized on read; the reader never throws.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` §7.5 (`:298-319`, hold reasons table) and §7.6 (`:321-326`, finite delivery and the auth exclusion).

### Architectural Decisions
- Auth failures suspend all attempts without a clock (`ARCHITECTURE-OTLP-PLUGIN.md:324`).

### Derived Conventions
- See Decisions above.

---

## 4. Testing Landscape

### Existing Coverage
- `__tests__/auth-state.test.ts`: mark and clear of the stale flag.
- `__tests__/forwarder.test.ts:210-255,452-468,669,1059`: `markCredentialsStale` on 401/403/302, and the flag stays clear on other outcomes.
- `__tests__/delivery-retention.test.ts:111-307`: `noteDeliveryFailure`, expiry, the `'stale'` return, and the outcome-to-reason table (`:266`).
- `__tests__/tick-processor.test.ts:630`: the `analytics_endpoint_mismatch` hold is set.

### Testing Framework and Patterns
- Vitest. `auth-state.js` is replaced with `vi.mock` in most spool tests, and the real module is loaded with dynamic `import()` in the forwarder and auth-state tests.

### Coverage Gaps
- No test exercises `liveDelivery` directly; it is covered only through `deliveryGate` and `noteDeliveryFailure`.
- No test covers a CLI-side reader of the session status, because none exists.

---

## 5. Configuration and Environment

### Environment Variables
- `OTLP_HELD_RETENTION_MINUTES` (default 1440) sets `heldRetentionMs()`, which bounds both the endpoint hold and the delivery record (`ARCHITECTURE-OTLP-PLUGIN.md:300,324`).

### Configuration Files
- None specific.

### Feature Flags and Deployment Concerns
- None found.

---

## 6. Risk Indicators

- `liveDelivery` is private and async; it needs `stat` and runs under the forwarder's session lock (`delivery-state.ts:18`). Speculative: reusing it from the CLI collector means exporting it or duplicating its rule.
- A `delivery_failed` name collision exists: the health reason and the `DeliveryLossReason` token have the same name, but rule 4 matches records of all four loss reasons (`session-project.ts:28-33`).
- `credentialsStale` is in-memory only and resets to `false` on each daemon restart (`auth-state.ts:16`). After a restart, `/health` reports `ok` until the next rejected send.
- While credentials are stale, the tick exits before touching holds (`tick-processor.ts:189-193`). An existing `analytics_endpoint_mismatch` hold or delivery record stays on disk unchanged, so several rules can apply at once.
- Delivery records and holds stay on disk after the daemon stops. Non-live records are cleaned up lazily, only by `deliveryGate` (`delivery-state.ts:105-111`).
- A record past `heldRetentionMs` that has not been expired yet still passes `liveDelivery` (no `since` check, `delivery-state.ts:18-26`).
- `resolveAnalyticsEndpoint` returning `null` also covers "stale daemon/credentials" (`classification.ts:129`). The hold reason does not tell that case apart from a true URL mismatch.

---

## 7. Summary for Complexity Assessment

The four names are all daemon-side, in `otlp-spool/`. `delivery_failed` is one of four `DeliveryLossReason` tokens, stored per stream in the on-disk session status under `delivery[stream]`. `liveDelivery` is a private async helper in `delivery-state.ts:18`: a record counts as live when its cursor equals the stream cursor and the stream file is at least `end` bytes long. `areCredentialsStale` reads an in-memory daemon flag that the forwarder sets on 401/403/302 and the OTLP plugin clears after a successful credential re-read. `analytics_endpoint_mismatch` is a session hold written only by `holdEndpointMismatch` (`tick-processor.ts:136`) when the resolved analytics endpoint is `null` and pending data exists.

Today nothing under `src/cli/` reads the session status, the delivery records or the stale flag. Every current consumer is daemon code that holds the session lock. The facts the spec rests on hold. Three points need attention: `liveDelivery` is not exported, the stale flag has no on-disk form, and live records can carry reasons other than `delivery_failed`.

Tests cover the producers: auth-state, forwarder, delivery-retention and tick-processor. `liveDelivery` has no direct test, and there is no CLI-side reader with tests.

---

## 8. External References

None named by the task (the spec is in this repository and was read).
