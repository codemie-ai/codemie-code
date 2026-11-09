# EPMCDME-17054 Legacy /v1/metrics Work-Consent Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `anthropic-subscription` sessions publish to the older `POST /v1/metrics` path only when work consent holds for the folder and the new pipeline has not held/discarded the session.

**Architecture:** One gate module (`src/agents/core/session/legacy-metrics-gate.ts`) decides from the Session record. Consent is resolved once at SessionStart with the same identity connect-folder uses (`currentEvidenceIdentity()`, `hook-identity.ts:6`) and frozen on the record as `legacyMetricsConsent`. Every legacy sender asks `legacyMetricsVerdict(session)` at send time; it re-checks `consentHolds` and the evidence/spool hold signals. Senders: start metric, end metric, `MetricsSyncProcessor`. All `SessionSyncer` callers and reconciliation re-delivery pass through these three.

**Tech Stack:** TypeScript ESM, Vitest.

## Global Constraints

- Gated provider: `anthropic-subscription` only. `moonshot-subscription`, `ai-run-sso`, `jwt`, `litellm`, `bedrock`, `ollama` and `DesktopSessionMetrics` (claude-desktop) behave exactly as today.
- Fail closed. These all mean "no consent, do not publish": no project, an unreadable store, no credentials/owner, or a gated record with no frozen consent (for example one created by `ensure-session.ts` or an older build).
- ES modules, `.js` import extensions, `@/` alias, explicit return types, no `any`. Use `logger.debug` and never `console.log`. Logs carry reason codes only: no project, path, email or hash.
- Lazy dynamic imports inside hook helpers, following the pattern at `end-metric.ts:64`.
- No new `SyncStatus` value. Local analytics loaders stay untouched.
- Commit per task using the repository's existing convention (Conventional Commits, ticket EPMCDME-17054).
- Follow-up, not in this plan: `moonshot-subscription` (kimi) has the same leak, but consent is Claude-only (`analytics-command.ts:299`). Backend membership enforcement is a separate ticket.

## Acceptance criteria

- On `anthropic-subscription` with `project` set and no work consent for the cwd, SessionStart+SessionEnd send zero `POST /v1/metrics` requests, and the record gets `endMetricSkipped: 'no-work-consent'`.
- With consent connected for the cwd (same owner/backend/project), the start and end metrics and the deltas are still sent with `X-CodeMie-Project`.
- If consent is revoked between start and end, the end metric and the deltas are not sent (`endMetricSkipped: 'consent-revoked'`).
- If the new pipeline holds or discards the session (stop/notice marker, spool `holds`/`lastDiscard`/`stopIntent`), the end metric and the deltas are not sent (`endMetricSkipped: 'destination-held'`). The start metric may already have been sent; this is accepted.
- A gate-skipped session counts as delivered: `isDeliveryDone` returns true, reconciliation sets no `droppedAt`, and its deltas are not retried.
- `ai-run-sso` and the other CodeMie-routed providers behave as today (existing suites stay green).

---

### Task 1: RED regression test reproducing the leak

**Files:**
- Create: `src/cli/commands/__tests__/hook.legacy-metrics-gate.test.ts`. Copy the harness from `hook.session-delivery.test.ts`: per-test `CODEMIE_HOME` under `mkdtempSync`, stubbed `fetch`, and the `getStoredAnalyticsCredentials` stub at lines 46-49.

Test-first: yes — `processEvent` SessionStart then SessionEnd, with config `{agentName:'claude', provider:'anthropic-subscription', ssoUrl, syncApiUrl, project:'test321'}`, an empty work-consent store, and `cwd` = a temp git dir. Assert that no `fetch` call targets `<api>/v1/metrics`. Today it fails with 2 calls (`X-CodeMie-Project: test321`, status started/completed).

- [ ] Write the test. Also `vi.mock('@/agents/core/evidence/hook-identity.js')` so `currentEvidenceIdentity` resolves to `{api_identity:'api-x', owner_hash:'owner-x'}`; later tasks reuse that mock.
- [ ] Run `npx vitest run src/cli/commands/__tests__/hook.legacy-metrics-gate.test.ts`. Expected: FAIL, 2 metric calls. Record the output; this is the RED evidence.
- [ ] Do not commit yet. The test is committed with Task 3, once it is green.

### Task 2: Gate module, frozen Session field, marker probe

**Files:**
- Create: `src/agents/core/session/legacy-metrics-gate.ts`, `src/agents/core/session/__tests__/legacy-metrics-gate.test.ts`
- Modify: `src/agents/core/session/types.ts:150-210`. Add the field after `endMetricSkipped`.
- Modify: `src/agents/core/session/SessionStore.ts:49`. Add `legacyMetricsConsent: saving.legacyMetricsConsent ?? other.legacyMetricsConsent`.
- Modify: `src/agents/core/evidence/stop-marker.ts`. Add `hasMarker(key): Promise<boolean>`: true for any marker file, whether `stop:true` or a `stop:false` notice; false only on ENOENT; true on any other error (fail closed).

**Interfaces (Produces):**

```ts
// types.ts — Session
/** Work consent frozen at SessionStart for the legacy /v1/metrics gate (anthropic-subscription only). Hashes, no PII. */
legacyMetricsConsent?: { ref: string; apiIdentity: string; ownerHash: string };

// legacy-metrics-gate.ts
export type LegacyMetricsSkip = 'no-work-consent' | 'consent-revoked' | 'destination-held';
export const LEGACY_GATE_SKIPS: readonly LegacyMetricsSkip[];
export function isLegacyGateSkip(reason: string | undefined): boolean;
export function isLegacyGatedProvider(provider: string | undefined): boolean; // === ProviderName.ANTHROPIC_SUBSCRIPTION
/** SessionStart: undefined unless gated provider + identity + resolveConsent(...) all succeed. Never throws. */
export async function freezeLegacyMetricsConsent(
  provider: string | undefined, project: string | undefined, cwd: string
): Promise<Session['legacyMetricsConsent']>;
/** Send time. Never throws; any doubt => skip. */
export async function legacyMetricsVerdict(
  session: Pick<Session, 'provider' | 'project' | 'workingDirectory' | 'agentSessionId' | 'legacyMetricsConsent'>
): Promise<{ publish: true } | { publish: false; reason: LegacyMetricsSkip }>;
```

`legacyMetricsVerdict` checks, in this order:
1. Provider not gated: publish.
2. No frozen consent: `no-work-consent`.
3. `consentHolds(ref, {owner_hash, api_identity, project}, workingDirectory)` is false: `consent-revoked`.
4. `hasMarker(recordKey(apiIdentity, ownerHash, agentSessionId))`, or `readStatus(agentSessionId)` (`session-status.ts:302`) with non-empty `holds`, `lastDiscard` or `stopIntent`: `destination-held`.
5. Otherwise: publish.

Use lazy imports for the evidence and otlp-spool modules. Confirm `readStatus` is keyed by the native session id, as `record-store.ts` is; if it is keyed by the CodeMie id, pass that id instead.

Test-first: yes — `legacy-metrics-gate.test.ts`. Use a temp `CODEMIE_HOME=<tmp>/.codemie`, mock `hook-identity.js`, and set up consent with the real `connectFolder` / `disconnectFolder`. Cases:
- `ai-run-sso` and `moonshot-subscription`: publish.
- Gated, no consent: freeze returns undefined, verdict `no-work-consent`.
- Identity null or project empty: undefined.
- Connected: publish.
- Disconnected after freeze: `consent-revoked`.
- Reconnected (new `id`): `consent-revoked`.
- A notice marker written with `writeNotice(key,'hold_project_unavailable',sid)`: `destination-held`.
- A `writeStop` marker: `destination-held`.

- [ ] Write the tests and run them. They fail because the module is missing.
- [ ] Implement the field, the merge line, `hasMarker` and the gate.
- [ ] Run `npx vitest run src/agents/core/session/__tests__/legacy-metrics-gate.test.ts src/agents/core/evidence` and confirm everything passes.

### Task 3: Gate the start and end metrics

**Files:**
- Modify: `src/cli/commands/hook.ts:1007-1046` (SessionStart record creation). Set `legacyMetricsConsent: await freezeLegacyMetricsConsent(config.provider, config.project, event.cwd)`.
- Modify: `src/cli/commands/hook.ts:1215-1347` (`sendSessionStartMetrics`). Before cookies/send: if `legacyMetricsVerdict(session)` is not publish, log `logger.debug` with the reason and return (silent skip, matching the existing start-skip style).
- Modify: `src/cli/commands/hook/end-metric.ts:55-171`. After the idempotency check and before the send: if the verdict is not publish, call `markEndMetric(store, id, { endMetricSkipped: verdict.reason })` and return.
- Test: `hook.legacy-metrics-gate.test.ts` (from Task 1)

Test-first: yes — Task 1's test turns green. Add these cases to the same file:
- (a) `connectFolder` for the cwd before SessionStart: start and end both POSTed with `X-CodeMie-Project: test321`.
- (b) Connected at start, `disconnectFolder` before SessionEnd: only start POSTed, record `endMetricSkipped === 'consent-revoked'`.
- (c) Connected, plus a notice marker for the record key before SessionEnd: end not POSTed, `'destination-held'`.
- (d) Same flow with `provider:'ai-run-sso'` and no consent: both POSTed (unchanged).
- Task 1 case: also assert `endMetricSkipped === 'no-work-consent'`.

- [ ] Write cases a–d and run them. b and c fail and a may pass. Task 1 is still red.
- [ ] Implement the three edits.
- [ ] Run `npx vitest run src/cli/commands/__tests__/hook.legacy-metrics-gate.test.ts src/cli/commands/__tests__/hook.session-delivery.test.ts src/cli/commands/__tests__/hook.analytics-wiring.test.ts` and confirm all pass. Commit, including the Task 1 test.

### Task 4: Gate the usage deltas; a gate skip counts as delivered

**Files:**
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts:60-…`. Once `sessionMetadata` is loaded (`:132`) and before any `sendSessionMetric` (`:236`): if the verdict is not publish, return success with message `legacy metrics withheld: <reason>`. Leave the deltas untouched: no status change, no attempt increment. This one place covers `delivery.ts:156`, `performIncrementalSync` (`hook.ts:476`), the codex/opencode/pi incremental sync and the proxy plugin.
- Modify: `src/cli/commands/hook/delivery.ts:91-120`. In `isDeliveryDone`, when `isLegacyGateSkip(record.endMetricSkipped)`, skip the delta check in `hasNoPendingData` but keep the conversation-payload check. To do this, pass a flag into `hasNoPendingData`.
- Modify: `src/agents/core/session/stale-session-reconciliation.ts:141-146`. Same rule: with `isLegacyGateSkip(record.endMetricSkipped)`, ignore deltas whose status is not `synced`, and still check conversations.
- Test: `metrics-sync-processor.test.ts`, `hook.legacy-metrics-gate.test.ts`, `stale-session-reconciliation.test.ts`

Test-first: yes — four tests:
- (a) Processor: session `{provider:'anthropic-subscription', project, no legacyMetricsConsent}` with 2 pending deltas makes zero `sendSessionMetric` calls; the deltas stay `pending`, `syncAttempts` 0, and the result is success.
- (b) Same with consent connected: the deltas are sent.
- (c) Hook flow without consent and with transcript deltas (`correlation` matched): no `/v1/metrics` at Stop or SessionEnd, and `isDeliveryDone(sessionId, config)` is true.
- (d) Reconciliation: a completed record with `endMetricSkipped:'no-work-consent'` and pending deltas leaves the queue without `droppedAt`. A record with `endMetricSkipped:'no-analytics-config'` and pending deltas keeps today's behavior.

- [ ] Write tests a–d and run them. a, c and d fail.
- [ ] Implement the three edits.
- [ ] Run `npx vitest run src/providers/plugins/sso/session src/cli/commands/__tests__ src/agents/core/session` and confirm all pass.

---

## Negative-constraint pass

- "moonshot / CodeMie-routed providers unchanged": `isLegacyGatedProvider` matches only `anthropic-subscription` (Task 2). Task 2 covers moonshot and ai-run-sso in the gate tests, and Task 3(d) covers ai-run-sso in the hook flow. No task touches `syncApplies` or `hasSendPath`.
- "DesktopSessionMetrics unchanged": no task modifies `DesktopSessionMetrics.ts` (its provider defaults to `ai-run-sso`).
- "Skipped deltas must not stay pending forever / no false droppedAt": Task 4. Delivery and reconciliation treat a gate skip as delivered, so the deltas are not retried or dropped. Their local `syncStatus` is kept, and the loaders are untouched.
- "Local analytics loaders must keep working": no new `SyncStatus`; no loader edits.
- "No secrets in logs": the gate logs reason codes only (Global Constraints). The frozen field holds hashes only.
- "No console.log / no any": Global Constraints.
- "Membership enforcement out of scope": no backend or membership task. The start-metric leak under a later hold is accepted (Acceptance criteria).
