# EPMCDME-16086 Analytics delivery health — Implementation Plan

**Goal:** `proxy status` and `proxy analytics status` report OTLP delivery health separately from daemon health, per `spec.md`.
**Conventions:** ES modules, `.js` import extensions, `@/` alias, no `any`, explicit return types on exports, `logger` outside CLI output. No git operations in any task; the user commits.
**Order:** tasks are sequential; each builds on the previous.

## Task 1: Daemon `/health` reports `analytics.credentials`

**Files:** `src/providers/plugins/sso/proxy/plugins/types.ts:85`, `.../plugins/otlp.plugin.ts:57`, `.../proxy/sso.proxy.ts:291-299`, `src/cli/commands/proxy/awaiting-login-listener.ts:65-73`, test `src/cli/commands/proxy/__tests__/awaiting-login-listener.test.ts` plus an `otlp.plugin` test next to `otlp.plugin.credentials-refresh.test.ts`.

- In `types.ts` add the exported `AnalyticsHealthReply` type (new) and an optional `ProxyInterceptor.healthStatus?(): AnalyticsHealthReply`.
- `OtlpInterceptor` implements it from `areCredentialsStale()` (`'stale'` / `'ok'`).
- `sso.proxy.ts` `/health` adds `analytics` from the first interceptor that returns a report and omits it when none does. Existing fields are unchanged and `sso.proxy.ts` gains no import from `otlp-spool/`.
- The awaiting-login listener adds `analytics: { credentials: 'stale' }`.

```ts
export interface AnalyticsHealthReply { credentials: 'ok' | 'stale' }
```

Test-first: yes — `OtlpInterceptor.healthStatus()` returns `stale` after `markCredentialsStale()` and `ok` after clear; the awaiting-login `/health` body contains `analytics.credentials === 'stale'` with `status/port/pid` unchanged.

## Task 2: `checkProxyHealth` exposes `analytics`

**Files:** `src/cli/commands/proxy/health-check.ts:21-26,60-84`, test `__tests__/health-check.test.ts`.

- Add optional `analytics?: AnalyticsHealthReply` to `ProxyHealthResult` and optional `expectedPid?: number` to `ProxyHealthOptions`.
- One exported `parseAnalyticsReply(body, expectedPid)` reads the shallow reply body (inside the existing try, same deadline) and accepts the field only when `body.pid === expectedPid` and `credentials` is exactly `'ok'` or `'stale'`; anything else leaves it unset. Other consumers (`watcher.ts`, `connect-orchestrator.ts`) do not pass `expectedPid` and get today's result.

Test-first: yes — a reply with a matching pid and `stale` yields `analytics.credentials === 'stale'`; mismatched pid, `null`, a number, or `credentials: 'x'` yields no `analytics`; a body that is not JSON does not change `healthy/code`.

## Task 3: Spool delivery summary

**Files:** `src/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-state.ts:18` (export `liveDelivery`), new `otlp-spool/delivery-summary.ts`, new test `otlp-spool/__tests__/delivery-summary.test.ts`.

- New `summarizeSpoolDelivery(): Promise<{ pendingBytes: number; mismatchHeld: boolean; sendFailed: boolean }>`, never throws. For every id from `listSessionIds()` (concurrency bounded, e.g. 16 at a time): `readStatus` + `readSpoolState`; `pendingBytes` = Σ(size − cursor); `mismatchHeld` when the session has pending data and `holds.session.reason === 'analytics_endpoint_mismatch'`; `sendFailed` when any stream in `status.delivery` passes `liveDelivery`. A session whose status is unreadable counts its stream file sizes as pending and sets no flags.

Test-first: yes — fixtures in a temp `CODEMIE_HOME`: pending bytes summed across streams and sessions; mismatch hold with and without pending data; a live delivery record vs. one with a moved cursor or a file shorter than `end`; any other hold reason sets neither flag; corrupt status file counts as pending.

## Task 4: Delivery-health collector

**Files:** `src/providers/plugins/sso/sso.auth-gate.ts:51-67` (export `isOlderThan`, add read-only `applicableAuthMarker(source, candidateUrls)` built from `getAnalyticsAuthStatus`, `markerAppliesToProfile`, `getLastSignInAt`; it never clears the marker), new `src/cli/commands/proxy/delivery-health.ts`, new test `__tests__/delivery-health.test.ts`.

- Exports `DeliveryHealth` (exactly the spec shape), `DeliveryReason`, and `DELIVERY_REASONS: Record<DeliveryReason, { label: string; run?: string }>`, which drives labels and remedies in both commands so a missing code fails to compile (AC6). `send_failed` has no `run`: `proxy status` then prints `codemie proxy analytics status`, `analytics status` prints no `Run:` line.
- `collectDeliveryHealth(state: DaemonState, reply?: AnalyticsHealthReply): Promise<DeliveryHealth>` makes no request. Precedence: stale reply, `applicableAuthMarker` (source and candidate URLs from `state.provider/targetUrl/syncApiUrl/syncCodeMieUrl`), `mismatchHeld`, `sendFailed`; none matching gives `healthy` when `reply` is present, else `unknown`. Whole body in try/catch, falling back to `{ status: 'unknown', pendingBytes: 0 }`.
- Also export `formatDeliveryLines(health | null)` returning the shared `Delivery:` headline, `Pending:` and `Run:` lines used by Task 6, so the wording lives once.

Test-first: yes — each reason alone; precedence when several apply; marker older than the last sign-in or for another profile URL is ignored; no reply gives `unknown`; reply `ok` with nothing else gives `healthy`; a throwing dependency yields `unknown`.

## Task 5: `codemie proxy status` Analytics line

**Files:** `src/cli/commands/proxy/index.ts:215-322`, new `src/cli/commands/proxy/analytics-connectors.ts`, tests `__tests__/index.test.ts:809-1030`, `__tests__/daemon-status-contract.test.ts:228-252`.

- `analytics-connectors.ts` exports one `ANALYTICS_CONNECTORS` table `{ id, collect, format, isActive }` for Claude Code, Copilot CLI and Copilot Chat (`isActive` = connected: `hasClaudeCodeOtlpHooks()` / `readCopilotConnectorScope(id)` enabled, whatever the collection preference). Task 6 reuses `collect/format`.
- In the `status` action pass `expectedPid: state.pid` to `checkProxyHealth`, then call `collectDeliveryHealth(state, health.analytics)`. Show the line only when any connector `isActive`; the stopped path at `:217-224` is untouched.
- Text, after the `Uptime:` line and before the existing OTLP `Warning:`: `Analytics: healthy` (green), `Analytics: unhealthy (<label>)` (yellow) plus `  Run: <run>` tip (`run ?? 'codemie proxy analytics status'`), or `Analytics: unknown (restart the proxy to enable all checks)` (dim) plus `  Run: codemie proxy restart`. `--json` adds `analytics: DeliveryHealth` under the same visibility rule.
- Update `index.test.ts` and `daemon-status-contract.test.ts`: existing `console.log` expectations stay byte-identical when no connector is active; add cases for the three line variants, the tips, JSON `analytics`, and stopped output unchanged.

Test-first: yes — healthy with an active connector prints the green line; stale reply prints `unhealthy (...)` and `Run: codemie profile login`; no `analytics` in the reply prints the dim `unknown` line; no connector hides line and JSON key even with pending bytes; stopped daemon output equals today's.

## Task 6: Restyle `codemie proxy analytics status`

**Files:** `src/cli/commands/proxy/analytics-status.ts:72-106,149-184`, `analytics-hints.ts:14-78,117-125`, `analytics-command.ts:257-268`, tests `__tests__/analytics-status.test.ts:143-170`, `analytics-command.test.ts:169-192,393-421`, `analytics-advice.test.ts:176-273`.

- `analytics-hints.ts`: split `NotTrackedAdvice.nextStep` into `command?: string` (a single runnable command, e.g. `codemie proxy analytics include "<path>"`) and `action?: string` (prose such as "fix or delete it" or "run this inside that project: …"); `reportEffectiveState` in `analytics-command.ts` prints whichever is set, so its output does not change. The corrupt-preferences advice becomes part of the not-tracked reason text, not a `Run:` line.
- `analytics-status.ts`: one shared renderer for both formatters. Headline `Hooks: installed|not installed` (Claude) or `Connected: yes|no` (Copilot) with a green/yellow value, then 2-space-indented, aligned `Scope:`, `Tracked:` (list only for project scope), `Collection:`, `Excluded:`, `Current:` lines; at most one `  Run:` line (`codemie proxy connect --<id>` when not connected, else the advice `command`); the corrupt-preferences error as a yellow line; no `Hint:`. `unaffectedChannels(...)` follows as a plain dim sentence with no label or indent. Collected objects and their types are unchanged.
- `showStatus` assembles: Delivery section first, only when any connector `isActive` (otherwise no section and `delivery: null`) (`checkStatus()`; running daemon gives `checkProxyHealth({ expectedPid })` then `collectDeliveryHealth`; stopped gives `Delivery: proxy not running` and `delivery: null`), then the connector section, then the dim sentence, for the default and every connector flag. `--json` prints the collected object plus `delivery`.
- Rewrite the exact-string expectations in the three test files to the new layout; JSON assertions keep the existing keys and gain `delivery`.

Test-first: yes — for Claude and each Copilot connector: the Delivery section prints first when a connector is active and is omitted (`"delivery": null`) when none is; `Delivery: proxy not running` and `"delivery": null` when stopped; at most one `Run:` and no `Hint:`; the unaffected sentence has no label and no indent; `--json` equals the old object plus `delivery`.

## Task 7: Docs and tip

**Files:** `docs/COMMANDS.md:1675`, `src/utils/tips.json:238-243`.

- `COMMANDS.md`: describe the Delivery section plus `delivery` JSON key on the `analytics status` row (`:1675`) only. The `proxy status` section and the README commands (`:655,670,760`) are unchanged.
- `tips.json`: extend the proxy status tip message with analytics delivery health; keep its `commands` list.

Test-first: no — documentation and copy only.

## Negative-constraint pass

- No new on-disk state file or `DaemonState` change (Tasks 1-4 use `/health`, the spool and the existing marker only); `applicableAuthMarker` never clears the marker.
- Stopped-daemon `proxy status` unchanged (Task 5); `--json` of `analytics status` keeps its shape and only adds `delivery` (Task 6).
- No `Hint:` line, at most one `Run:` (Task 6); session-sync backlog, trends, last-success time, per-tool split and held/dropped lines are not implemented.
