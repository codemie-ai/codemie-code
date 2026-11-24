# Technical Research

**Task**: analytics metrics consent subscription
**Generated**: 2026-11-09
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-17054 (Bug, Major). [CLI Analytics] codemie-claude sessions without work consent still reach the older CLI analytics of the configured project, including projects the user does not belong to.
Precondition: codemie-code main incl. 9f910c36 (PR #766, explicit work consent EPMCDME-16849); codemie-claude with an anthropic-subscription profile, Claude Pro login; regular user, member of test321, not of klstarproj.
Description: The new CLI analytics pipeline handles these sessions correctly: without consent they are private to the owner, and without project membership they are held. The older analytics still get a record for the same session under the project named in the profile or folder config. No folder connection or project membership is needed. A project admin can then see repository, branch, user name and session duration of a private session. A regular user can also add rows to another project or another user's personal project. Cause: codemie-claude also sends session metrics to POST /v1/metrics, which skips the consent and destination decision. Backend stores X-CodeMie-Project as the metric's project with no membership/consent check.
Steps: set codeMieProject=test321 on anthropic-subscription profile, no connect-folder; run codemie-claude -p "reply OK" in a new git repo without .codemie; older cli-repositories/cli-summary/cli-users for test321 show the row. Also: connect-folder --project klstarproj (non-member) / another user's personal project → new pipeline holds (project_unavailable), older endpoints still get rows.
Expected: AC2 personal session from a non-connected folder not exposed via work-project lists/details/aggregates. Story: a globally configured work profile alone does not authorize publication from unrelated folders. AC3 personal analytics stay owner-only. A user cannot add analytics records to a project they are not a member of or another user's personal project.
Tests to add (ticket): Unit — a session without work consent sends no record to the older metrics path for a shared project; a held or discarded destination decision also stops the older metrics record. Integration — codemie-claude on personal subscription in non-connected folder leaves no row in older endpoints; non-member and foreign personal project leave no row.

CHOSEN APPROACH (user approved "option 1"): client-side gate in this repo. One shared decision function used by EVERY legacy /v1/metrics sender: hook SessionStart start metric (src/cli/commands/hook.ts sendSessionStartMetrics ~L1215), SessionEnd end metric (src/cli/commands/hook/end-metric.ts sendSessionEndMetrics), usage deltas MetricsSyncProcessor (src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts via SessionSyncer from hook/delivery.ts syncPendingDataToAPI, sso.session-sync.plugin.ts, codex/opencode/pi incremental sync, DesktopSessionDelivery), and stale-session reconciliation re-delivery (agents/core/session/stale-session-reconciliation.ts, send-path.ts recordHookConfig). For personally-funded sessions (provider anthropic-subscription; check moonshot-subscription and any other "analytics-only CodeMie auth" provider, see hook/processing-context.ts:51) send only when work consent resolves: agents/core/evidence/consent-store.ts resolveConsent({owner_hash, api_identity, project}, cwd) with ownerHash/apiIdentity from agents/core/evidence/api-identity.ts and the owner email from SSO credentials (see evidence/stamp.ts). Freeze the decision on the session record at SessionStart (like evidence freezes consent_ref) so start/end/deltas agree, and re-check consentHolds at send time (revocation). Also skip when the new pipeline's evidence/destination decision for the session is held/discarded (project_unavailable; see otlp-spool/session-status.ts, response.ts, forwarder.ts, agents/core/evidence/record-store.ts). Skipped end metrics should be marked endMetricSkipped (e.g. 'no-work-consent'); deltas must not stay pending forever. CodeMie-routed providers (ai-run-sso, jwt, litellm, bedrock…) unchanged. Backend membership check is OUT of scope (separate backend ticket).

Already reproduced on main: processEvent SessionStart+SessionEnd with config {agentName:'claude', provider:'anthropic-subscription', ssoUrl, syncApiUrl, project:'test321'} and empty consent store → two POST <api>/v1/metrics with X-CodeMie-Project: test321 (status started/completed). anthropic-subscription.template.ts:135-141 exports CODEMIE_URL/CODEMIE_SYNC_API_URL/CODEMIE_PROJECT; metrics-api-client.ts:174 sets X-CodeMie-Project; hook/config-value.ts syncApplies/configSendPathApiUrl only check URL presence.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A — "a session reaches a work project only with explicit work consent for this folder"**
- `resolveConsent(scope, cwd)` `src/agents/core/evidence/consent-store.ts:97` — returns the 16-hex `consentRef` of the entry whose owner_hash+api_identity+project (trim/lowercase) match and whose canonical folder contains `cwd`; empty project, missing/unreadable/unknown-version store → `undefined`. Never throws. Store: `~/.codemie/work-consent.json` (`consentStorePath`, v1).
- `consentHolds(ref, scope, cwd?)` `consent-store.ts:110` — revocation check: same scope AND same ref (ref changes on every reconnect via random `id`), optional folder coverage.
- Consumers: `stampEvidence` `src/agents/core/evidence/stamp.ts:142-145` (freezes `consent_ref` only when `funding_route` set and project present); `scopeViolation` `src/agents/core/evidence/session-scope.ts:25` (→ `consent_revoked`/`folder_changed`); `evidence-send.ts:55-60,128` (forwarder: writes stop `consent_revoked`; `consent = newContract && !!record.consent_ref`); `analytics-command.ts:313-342` (connect/disconnect).
- Identity: `apiIdentity(url)` / `ownerHash(email)` `src/agents/core/evidence/api-identity.ts:7,23`. `currentEvidenceIdentity()` `src/agents/core/evidence/hook-identity.ts:6` = `resolveHookCredentials()` (daemon state `syncCodeMieUrl || targetUrl`, `withVerifiedOwner`) → `{api_identity: apiIdentity(credentials.apiUrl), owner_hash}`; used by connect-folder (`analytics-command.ts:305`), so consent entries are keyed by the **credential's `apiUrl`**, not by the hook's `CODEMIE_SYNC_API_URL`.
- Email: `resolveEmailFromCredentials` `src/agents/core/identity-resolver.ts:39` (JWT `email`/`preferred_username` from `codemie_access_token` cookie, else `credentials.email` set by `withVerifiedOwner`).
- Distance: none of this is called by any legacy `/v1/metrics` sender (grep `consent|ownerHash|apiIdentity` in `hook.ts`, `hook/*.ts`, `metrics-*`, `send-path.ts`: no hits).

**Purpose B — "the new pipeline's destination decision (held/discarded/stopped) for the same session"**
- Evidence record `src/agents/core/evidence/record-store.ts:24-52`; key `recordKey(api_identity, owner_hash, session_id)` `:61`; `readRecord(key)` `:166`; `hasRecordForSession(sessionId)` `:179`; dir `evidenceDir()` (`~/.codemie/evidence` legacy or `analytics/state/evidence`). Fields include `funding_route`, `consent_ref`, `project`, `session_id` (Claude's native session id).
- Stop markers `src/agents/core/evidence/stop-marker.ts:16-21,84` — `isStopped(key)`; reasons incl. `consent_revoked`, `consent_missing`, `hold_project_unavailable`, `hold_personal_unsupported`, `hold_destination_unsupported`. Marker `stop:false` = notice of a recoverable hold, `stop:true` = final.
- Spool session status `src/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.ts:33-92,302` — `readStatus(sessionId)` keyed by session id; `holds` (reasons `session-project.ts:6-22`, e.g. `personal_not_forwardable`, `publication_stopped`), `lastDiscard`, `stopIntent`.
- Backend outcomes `response.ts:9-36`: `SendKind 'discarded'`, `HOLD_503_REASONS` incl. `project_unavailable`, `FINAL_422_REASONS` incl. `consent_personal_project`.
- Who writes it: only `claude-code-otlp` via `OtlpAgentAdapter.ts:180` → `stampEvidence`; `funding_route` from `claude-code-otlp.plugin.ts:130`. No evidence record exists for kimi/codex/opencode/pi/gemini sessions or when the Claude OTLP hooks are not installed.

**Purpose C — "which sessions are personally funded"**
- Providers with `authType: 'none'` and analytics-only CodeMie auth: `anthropic-subscription.template.ts:21,135-141`, `moonshot-subscription.template.ts:21,97-104` (both export `CODEMIE_URL`, `CODEMIE_SYNC_API_URL`, `CODEMIE_PROJECT`). Also listed in `AgentCLI.ts:365-367`, `models.ts:14` (`SUBSCRIPTION_SINGLE_MODEL_PROVIDERS`). `ProviderName.ANTHROPIC_SUBSCRIPTION` `providers/core/types.ts:53`; no constant/flag marks "personally funded" generically.
- `fundingRoute()` `src/agents/core/evidence/routing.ts:146` — new pipeline's per-session funding claim (`subscription` only when OAuth login pays and route proven non-CodeMie).
- Moonshot users: kimi (`kimi.plugin.ts:55`, uses `codemie hook` via `kimi.hook-config-injector.ts`), openwiki.

**Legacy `/v1/metrics` senders (the gated surface)**
- Start: `sendSessionStartMetrics` `src/cli/commands/hook.ts:1215-1347`, called from `handleSessionStart` `:244` right after `createSessionRecordOverUnclosed` `:242`. Has: config (agent, provider, ssoUrl, project, apiUrl), `event.cwd`, session record, cookies via `loadAnalyticsCookies` (`hook/analytics-cookies.ts:10`, header only — no email/apiUrl returned). Skips silently (no record field) on missing config/external origin/no cookies. On success `recordStartMetricSessionId`.
- End: `sendSessionEndMetrics` `src/cli/commands/hook/end-metric.ts:55-171`; idempotent via `endMetricSentAt`/`endMetricSkipped`; existing skip values `no-analytics-config`, `no-send-path`, `external-resume` written by `markEndMetric` `:10`. Uses `config.project`, `session.workingDirectory`.
- Deltas: `MetricsSyncProcessor.process` `metrics-sync-processor.ts:60-…`, `sendSessionMetric` at `:236`; reads `sessionMetadata` (Session) at `:132`; `ProcessingContext` has no provider/project field (`hook/processing-context.ts:57-69`); project comes from aggregated metric attributes. Run by `SessionSyncer` (`SessionSyncer.ts:52`) from: `hook/delivery.ts:156` (SessionEnd), `hook.ts:476` `performIncrementalSync` (Stop/SubagentStop/SessionEnd via adapter `processSession`), `sso.session-sync.plugin.ts:185` (proxy only — not started for `authType:'none'`, `BaseAgentAdapter.ts:1076`), `codex.incremental-sync.ts:126`, `opencode.incremental-sync.ts:133`, `pi.incremental-sync.ts:326`, `DesktopTelemetryRuntime.ts:62` (claude-desktop, provider default `ai-run-sso`, `proxy-daemon.ts:216-226`).
- Desktop lifecycle: `DesktopSessionMetrics.sendSessionStartMetric/sendSessionEndMetric` `src/telemetry/runtime/DesktopSessionMetrics.ts:69,104` — a further start/end sender not named in the task.
- Reconciliation: `stale-session-reconciliation.ts:417,455,601` → `processEvent`/`deliverSession` with `recordHookConfig(record, env, …)` `send-path.ts:48` (carries record's `provider`, `project`; launch's URLs/env). `hasCredentials` `:202` uses `endMetricCookieAuth`.
- Wire: `MetricsSender` / `metrics-api-client.ts:174` sets `X-CodeMie-Project` from `metric.attributes.project` when `rawProjectHeader` accepts it.

**Other touched code**
- `Session` `src/agents/core/session/types.ts:150-210` — has `provider`, `project`, `workingDirectory`, `codemieUrl`, `endMetricSkipped`, `startMetricSessionId`; no consent/decision field. Created in `hook.ts:1007-1046` and `ensure-session.ts:29-66` (codemie-code/opencode). `SessionStore` merge `SessionStore.ts:49` keeps `endMetricSkipped`.

### Decisions Already in the Code
- Consent is Claude-only: `assertClaudeOnly` `analytics-command.ts:299-301` ("Work-consent folders are only available for Claude Code analytics"). A moonshot/kimi session has no way to obtain a consent entry.
- Freeze-at-first-stamp convention: `consent_ref`, `funding_route`, `collection_generation` frozen once (`stamp.ts:142-146`, `record-store.ts:36-43`), re-validated with `consentHolds`/`scopeViolation` at send time. Reason recorded in comments ("a session that froze an earlier connection's reference is never authorized by the new one", `consent-store.ts:25-27`).
- Profile/workspace project "only proposes it, never grants consent" (`analytics-command.ts:318`).
- End-metric outcome convention: `endMetricSentAt` vs `endMetricSkipped:<reason>`; failure sets neither (retry). `isDeliveryDone` `delivery.ts:96-106` needs one of them set; deltas done when none `isDeltaSendCandidate` (`pending`, or `failed` with <3 attempts, `metrics-sync-processor.ts:29-35`). `hasUndeliveredData` `stale-session-reconciliation.ts:141-146` counts any `syncStatus !== 'synced'` as undelivered → `droppedAt`.
- Fail-closed rule in evidence code: unreadable store / doubt = no consent (`consent-store.ts:93-96`).
- `syncApplies` `config-value.ts:41` and `hasSendPath` `send-path.ts:22` decide by URL presence only; provider ignored except `ai-run-sso`.
- Data direction: the legacy path knows the CodeMie session id and native `agentSessionId`; evidence is keyed by `apiIdentity(credentials.apiUrl)` + owner hash + native session id. The hook's cookie loader returns a Cookie header, not the `SSOCredentials` (with `apiUrl`/email) needed for the key; `getStoredAnalyticsCredentials` (`codemie-auth-helpers.ts:269`) returns `{credentials: SSOCredentials, url}` and `withVerifiedOwner` (`credential-owner.ts:71`) attaches email.

### Task Statements Checked Against the Code
- "start metric hook.ts ~L1215" — holds (`hook.ts:1215`).
- "end metric end-metric.ts sendSessionEndMetrics" — holds (`end-metric.ts:55`).
- "deltas via SessionSyncer from delivery.ts, sso.session-sync.plugin.ts, codex/opencode/pi incremental sync, DesktopSessionDelivery" — holds; additionally `performIncrementalSync` `hook.ts:476` runs the adapter on every Stop. `sso.session-sync.plugin.ts` and Desktop runtime do not run for `authType:'none'` providers (`BaseAgentAdapter.ts:1076`; desktop is claude-desktop).
- "every legacy sender" list — incomplete: `DesktopSessionMetrics.ts:69,104` sends start/end metrics too (claude-desktop, ai-run-sso by default).
- "owner email from SSO credentials (see evidence/stamp.ts)" — holds via `resolveHookCredentials` (daemon state). Unverified that daemon state exists for every subscription hook run; the hook's own cookie path (`getStoredAnalyticsCredentials(ssoUrl)`) is a different lookup.
- "check moonshot-subscription" — holds as same pattern (`moonshot-subscription.template.ts:97-104`); consent cannot be granted for it (Claude-only) and no evidence record is written for kimi.
- "evidence record looked up by api identity + owner hash + agent session id" — holds (`record-store.ts:61`); exists only when claude-code-otlp stamped the session.
- "held/discarded: session-status.ts, response.ts, forwarder.ts, record-store.ts" — holds; durable per-key signal is `isStopped(key)` / stop marker files; holds live in `readStatus(sessionId).holds`; `project_unavailable` 503 surfaces as hold + notice marker `hold_project_unavailable` (`stop-marker.ts:19`).
- "Freeze the decision on the session record at SessionStart" — `Session` has no such field today (`types.ts:150-210`).
- "syncApplies/configSendPathApiUrl only check URL presence" — holds (`config-value.ts:37-49`).
- "metrics-api-client.ts:174 sets X-CodeMie-Project" — holds.
- "CodeMie-routed providers unchanged" — keeps `syncApplies` provider check (`ai-run-sso`) and all senders as-is for them.
- "Backend membership check out of scope" — keeps backend `/v1/metrics` project attribution (unverified, outside repo).

### Consumers of Changed Contracts
- `Session` shape: `SessionStore.ts:49` merge (field-by-field `??` merge — a new field needs adding there or it is lost on concurrent saves), `send-path.ts:48` `recordHookConfig`, `ensure-session.ts`, `hook.ts:1007`, analytics loaders reading session JSON (`cli/commands/analytics/data-loader.ts`).
- `endMetricSkipped` consumers: `end-metric.ts`, `delivery.ts:100`, `stale-session-reconciliation.ts:142`, `DesktopSessionMetrics.ts`, `DesktopTelemetryRuntime.ts` (2), `SessionStore.ts:49`.
- Delta `syncStatus` consumers (if a new terminal status is used): `metrics-sync-processor.ts` (8), `MetricsWriter.ts` (2), `stale-session-reconciliation.ts` (2, `!== 'synced'` = undelivered), local `codemie analytics` loaders `data-loader.ts`, `native-loader.ts`, `otel-loader.ts`, `SyncStatus` type `types.ts:73` / `metrics/types.ts:93`, all agent metrics processors.
- `HookProcessingConfig` (if extended): `config-value.ts:14` map, `recordHookConfig`, `processing-context.ts`.

### Architecture and Layers Affected
- CLI/hook layer: `hook.ts`, `hook/end-metric.ts`, `hook/delivery.ts`, `hook/config-value.ts`, `hook/processing-context.ts`.
- Core session layer: `agents/core/session/types.ts`, `SessionStore.ts`, `send-path.ts`, `stale-session-reconciliation.ts`.
- Core evidence layer: `consent-store.ts`, `api-identity.ts`, `hook-identity.ts`, `record-store.ts`, `stop-marker.ts`.
- Provider (sso) layer: `MetricsSyncProcessor`, `SessionSyncer`, `MetricsSender`; otlp-spool `session-status.ts` (read-only).

### Integration Points
- Backend `POST /v1/metrics` (`sso.http-client.ts:25`), `PUT /v1/conversations/{id}/history` (conversation sync in same `SessionSyncer`, no project header — `conversations/apiClient.ts:110`).
- Credential store (`codemie-auth-helpers.ts:269`), daemon state (`hook-credentials.ts:23`).
- Dependency direction: core/evidence ← cli/hook; evidence already imports `otlp-spool/spool-config.js` and `sweep.js` from providers (`record-store.ts:9`, `stamp.ts:151`).

### Patterns and Conventions
- Lazy dynamic imports inside hook helpers to avoid cycles (`end-metric.ts:64,104,123`; `send-path.ts:42`).
- "Never throws; doubt = no" helpers returning `undefined`/`false` (`resolveConsent`, `currentEvidenceIdentity`).
- Reason-coded skips, no PII in logs (`stamp.ts:105`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/integration/external-integrations.md:203-215` — Pipeline A (`/v1/metrics`) and session reconciliation rules (≤5 records, ≤3 attempts, rename `completed_*` only once delivered).
- `.ai-run/guides/security/security-practices.md:46` — `/v1/metrics` attribution headers set by `MetricsApiClient`.
- `.ai-run/guides/usage/project-config.md:143,222` — subscription providers use workspace identity only.
- No guide covers work consent or the evidence pipeline; `docs/ARCHITECTURE-OTLP-PLUGIN.md` covers the adapter pattern.

### Architectural Decisions
- PR #766 (9f910c36) introduced consent store, funding route, stop markers; touched `hook.session-delivery.test.ts` only for timing, not gating.
- Inline: `consent-store.ts:11-15` ("user-local, revocable, never in a repo, profile or workspace config").

### Derived Conventions
- Freeze once, re-check at send; fail closed; reason codes on records.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/__tests__/hook.session-delivery.test.ts` (3415 lines) — end-to-end processEvent/deliver/reconcile with real files under per-test `CODEMIE_HOME`, `fetch` stubbed; providers used: `ai-run-sso`, `litellm` only. Stubs `getStoredAnalyticsCredentials` → `{credentials:{cookies:{session:'abc'}}}` (no `apiUrl`, no email).
- `hook.analytics-wiring.test.ts` (280) — mocks `cookie-auth.js` and `sso/index.js` (MetricsSender).
- `metrics-upload-contract.test.ts` (464) — MetricsSender wire contract incl. headers.
- `metrics-sync-processor{,.stop,.merge}.test.ts`; `stale-session-reconciliation.test.ts` (1575, pipeline injected); `send-path.test.ts`; `consent-store.test.ts` (128); `analytics-consent-command.test.ts`; integration `tests/integration/session-syncer.test.ts`, `analytics-auth-gate.test.ts`.

### Testing Framework and Patterns
- Vitest; `vi.mock` before dynamic `await import(...)`; temp `CODEMIE_HOME` via `mkdtempSync`; consent tests set `CODEMIE_HOME=<tmp>/.codemie`; fake-clock helper `onFakeClock`.

### Coverage Gaps
- No test sends lifecycle/delta metrics with `anthropic-subscription` or `moonshot-subscription` provider.
- No test combining legacy senders with consent store or evidence stop markers.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_PROVIDER`, `CODEMIE_URL`, `CODEMIE_SYNC_API_URL`, `CODEMIE_PROJECT`, `CODEMIE_BASE_URL`, `CODEMIE_TARGET_API_URL` (`config-value.ts:14-27`, `send-path.ts:22`); `CODEMIE_SESSION_ID` (launch mode, `routing.ts:35`); `CODEMIE_PROJECT_BINDING` (`stamp.ts:96`); `CODEMIE_HOME` (paths).

### Configuration Files
- `~/.codemie/work-consent.json` (consent), `~/.codemie/sessions/{id}.json` (Session), evidence dir, otlp spool status files.

### Feature Flags and Deployment Concerns
- None found for legacy metrics gating.

---

## 6. Risk Indicators

- Identity mismatch: consent entries are keyed by `apiIdentity(credentials.apiUrl)` from daemon-state credentials (`hook-identity.ts`), while legacy senders resolve credentials by `ssoUrl` (`analytics-cookies.ts`) and post to `CODEMIE_SYNC_API_URL`; a different api identity string yields "no consent" even after connect (see Decisions).
- Moonshot/kimi: consent is Claude-only (`analytics-command.ts:299`) and kimi gets no evidence record; any consent-based gate on `moonshot-subscription` blocks all its legacy metrics permanently.
- Evidence record absent when claude-code-otlp hooks are not installed or stamping failed (`no_owner`, `no_credentials`) — the held/discarded check has nothing to read; record-key lookup needs native session id + owner email.
- Hold vs stop: `project_unavailable` is a recoverable hold (`stop:false` notice / `status.holds`), not a final stop; timing at SessionStart precedes any backend response, so the start metric cannot observe it.
- Pending deltas: `hasUndeliveredData` treats any non-`synced` delta as undelivered (`stale-session-reconciliation.ts:145`) and local analytics loaders read `syncStatus`; a new skip status or leaving deltas `pending` affects `isDeliveryDone`, `droppedAt` and rename.
- `SessionStore.ts:49` field-wise merge: a new Session field not added there can be dropped on concurrent save.
- Extra sender `DesktopSessionMetrics.ts:69,104` not in the task list.
- Test stubs lack `apiUrl`/email in credentials (`hook.session-delivery.test.ts:46-49`); existing tests never use subscription providers.
- `performIncrementalSync` (`hook.ts:476`) sends deltas on every Stop — gate must cover it, not only SessionEnd delivery.

---

## 7. Summary for Complexity Assessment

The change spans the CLI hook layer (`hook.ts` start metric, `hook/end-metric.ts`, `hook/delivery.ts`, `performIncrementalSync`), the core session layer (`Session` type, `SessionStore` merge, `send-path.ts` `recordHookConfig`, reconciliation's undelivered rules), the sso provider layer (`MetricsSyncProcessor`/`SessionSyncer`, used by six callers) and reads from the core evidence layer (`consent-store`, `api-identity`, `hook-identity`, `record-store`, `stop-marker`, otlp `session-status`). All building blocks exist; none are wired into legacy senders today.

Novelty is moderate: consent resolution, identity hashing, record keys and stop markers are reusable as-is, and the freeze-then-recheck convention is established. Open points are factual: which credential/api-identity the legacy path uses to match consent entries, how a kimi/moonshot session (no consent possible, no evidence record) is treated, and how skipped deltas leave the delivery queue without tripping `droppedAt`.

Test posture: large file-based integration-style suites exist for delivery (3.4k lines) and reconciliation (1.6k), plus consent-store and metrics contract tests, but none exercise subscription providers or the consent/evidence interaction; credential stubs lack `apiUrl`/email.

---

## 8. External References

None named by the task (all referenced paths are inside this repository).
