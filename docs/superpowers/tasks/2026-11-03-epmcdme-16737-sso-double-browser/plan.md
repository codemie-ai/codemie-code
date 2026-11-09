# EPMCDME-16737 One SSO expiry opens exactly one browser - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** A single SSO expiry opens one browser: a finished sign-in is noticed by the refresher, requests/uploads built from superseded cookies are not read as a new expiry, a stale marker no longer blocks the gate, and the post-success cooldown no longer tells the user to run `codemie profile login`.

**Architecture:** One lock reader (`getLastSignInAt`) and one neutral session-layer module (`session/cookie-auth.ts`: header builder, deadline reader, superseded check, per-site helpers) feed the refresher, the expiry plugin, the gate and every metrics sender. Nothing in the proxy layer is imported by the session layer.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, `@/` alias in shared code), Vitest. No `any`; `logger.debug`, never log cookies.

**Spec:** `spec.md` in this directory (authoritative; section "item N" / "ACn" below refer to it). Analysis: `technical-analysis.md`. Commit per task using the repository's existing convention (the caller decides when; do not commit, push or branch unasked).

## Global Constraints

- The two red tests must go green: `src/providers/plugins/sso/proxy/plugins/__tests__/credential-refresh.test.ts` (Task 4), `src/providers/plugins/sso/__tests__/sso.detached-login.test.ts:106` (Task 7).
- `cookie-auth.ts` imports nothing from the proxy layer and nothing from `codemie-auth-helpers` at load time (`readAnalyticsCookieAuth` imports it lazily). `credential-refresh.ts` imports nothing from `codemie-auth-helpers.js` except the store read (the red test mocks it with one export).
- Both `ProcessingContext` declarations (`sso/session/BaseProcessor.ts:15`, `agents/core/session/BaseProcessor.ts:15`) stay field-for-field identical for `credentialsSuperseded`.
- Minimal edits in the 401 region of `sso-session-expiry.plugin.ts` (PR #720 overlaps): old inline block (~`:110-118`) untouched.
- Comments say what/why only: no ticket/PR numbers, no doc paths. Never log cookie headers.
- Unchanged: `COOLDOWN_MS`, `LOCK_MAX_AGE_MS`, `CREDENTIAL_REFRESH_INTERVAL_MS`, marker-edge bypass, `markAnalyticsAuthInvalid`, OTLP forwarder, `cooldown` text, all `wait.status` texts, API-key guards (`sso.auth-gate.ts:115`, expiry JWT guard).
- Tests that mock `sso.detached-login.js` with a fixed export list and build a real `CredentialRefresher` need `getLastSignInAt` in that list (grep for them in Tasks 4, 6, 9).

## Review Focus

- A store read that never answers (locked keychain): ends after `STORE_READ_DEADLINE_MS` as null, slot freed, no pile-up while the abandoned read is unsettled (T2, T4).
- Real revoke where the store holds an entry the builder drops: header strings still equal, so it is not "superseded" (T5).
- Several requests right after a sign-in: one store read, all get the new cookies (T4).
- Marker of another profile, or API-key profile: gate never clears it (T6).
- 302 body drain rejects: still a 401, no throw (T5).

## Negative-constraint pass

Honored: no replay via `tools.retry` (T5); no marker clearing on proxied success - only the gate clears a marker it proved older (T6); marker util untouched (T6 calls the existing clear); no per-profile keying (T1 ignores `source`); no change to cooldown constants or OTLP forwarder (no task touches them); no default `credentialsSuperseded` that reads a store inside `MetricsApiClient`/`MetricsSender` - only the `async () => false` constructor default (T8); no check where the caller passed cookies in (T10); no same-pass retry of a superseded send (T8); `profile login` and the 401 body shape untouched (T5 helper only, T7 text only).

## Files

Create: `src/providers/plugins/sso/session/cookie-auth.ts` and test `session/__tests__/cookie-auth.test.ts`; `metrics-api-client` test if none exists.
Modify: `sso.detached-login.ts`, `proxy/plugins/credential-refresh.ts`, `sso-session-expiry.plugin.ts`, `sso-auth.plugin.ts`, `sso.session-sync.plugin.ts`, `sso.auth-gate.ts`, `session/BaseProcessor.ts` (x2 copies), `metrics-types.ts`, `metrics-api-client.ts`, `metrics-sync-processor.ts`, `cli/commands/hook.ts`, `telemetry/runtime/DesktopTelemetryRuntime.ts`, codex/pi/opencode `*.incremental-sync.ts`, plus their existing tests.

---

### Task 1: `getLastSignInAt` lock reader

**Files:** Modify `src/providers/plugins/sso/sso.detached-login.ts` (next to private `readLock`, ~`:43`); Test `sso/__tests__/sso.detached-login.test.ts`.

**Interfaces:** Produces `export async function getLastSignInAt(source: PlatformUrlSource): Promise<number | null>` (type-only import of `PlatformUrlSource` from `codemie-auth-helpers`). Returns the lock's `succeededAt`, else null; never throws; ignores `source` (lock is global). Comment: "`succeededAt` of the lock record as it stands; null while a newer attempt holds the lock or after it failed".

- [ ] **Step 1: Failing tests** `getLastSignInAt`: lock with `succeededAt` returns it; no lock, lock without `succeededAt`, failed lock, unreadable/corrupt lock all return null.
- [ ] **Step 2:** Run `npx vitest run src/providers/plugins/sso/__tests__/sso.detached-login.test.ts -t getLastSignInAt`; expect FAIL (not exported).
- [ ] **Step 3:** Implement via `readLock()` in a try/catch.
- [ ] **Step 4:** Rerun; expect PASS.

Test-first: yes - `getLastSignInAt` returns the `succeededAt` of a written lock and null for missing/failed/corrupt locks.

### Task 2: `session/cookie-auth.ts` shared module

**Files:** Create `src/providers/plugins/sso/session/cookie-auth.ts`; Test `session/__tests__/cookie-auth.test.ts` (AC10).

**Interfaces (all exported):**
- `STORE_READ_DEADLINE_MS = 3000`
- `type CredentialsSupersededCheck = (sentCookies: string) => Promise<boolean>`
- `buildCookieHeader(cookies: Record<string, string>): string` - drop entries with empty name or control characters, join `; ` (same rule as `sso-auth.plugin.ts:64-87`).
- `readWithDeadline<T>(read: () => Promise<T | null>, deadlineMs = STORE_READ_DEADLINE_MS): () => Promise<T | null>` - the single home of the deadline rule (AR-1): returns null on throw, empty or timeout; timer cleared and `unref`'d on settle; a late result of a timed-out read is ignored; while a timed-out read is still unsettled, a new call on the same guarded reader returns null at once.
- `sentCredentialsSuperseded(sentCookieHeader: string | undefined, source?: { refreshNow(): Promise<{ cookies: Record<string, string> } | null> }): Promise<boolean>` - true only if `refreshNow()` yields credentials, sent header and `buildCookieHeader(fresh.cookies)` are both non-empty and differ; false for everything else; never throws, no logging of headers. Comment: assumes the store changes only at sign-in.
- `readCookieAuth(read: () => Promise<{ cookies: Record<string, string> } | null>): Promise<{ cookies: string; credentialsSuperseded: CredentialsSupersededCheck }>` - calls `read()` once, `cookies` is `''` when nothing usable; callback goes through `sentCredentialsSuperseded` with a `refreshNow` built on `readWithDeadline(read)`.
- `readAnalyticsCookieAuth(ssoUrl: string, env: ..., overrides?: ...)` - `readCookieAuth` over `getStoredAnalyticsCredentials(ssoUrl, env, overrides)` (lazy import, unwraps `.credentials`; same arguments for first read and re-read). Copy the parameter types from `getStoredAnalyticsCredentials`.

- [ ] **Step 1: Failing tests:** `buildCookieHeader` drops empty names/control chars; `sentCredentialsSuperseded` true for differing headers, false for equal / no source / empty sent / null / throw / empty builder result; `readWithDeadline` with fake timers: never-answering read -> null after `STORE_READ_DEADLINE_MS`, late result ignored, next call while unsettled -> null immediately, next call after it settles starts a fresh read, timer cleared on success; `readCookieAuth`: header equals `buildCookieHeader` of first read, callback re-runs same reader (assert call args for `readAnalyticsCookieAuth`), differing re-read true, equal/null/throw/never-answering false.
- [ ] **Step 2:** Run the file; expect FAIL (module missing).
- [ ] **Step 3:** Implement the module per Interfaces.
- [ ] **Step 4:** Run the file; expect PASS.

Test-first: yes - the cookie-auth unit file above fails until the module exists.

### Task 3: Adopt `buildCookieHeader` in `SSOAuthInterceptor` and session sync

**Files:** Modify `proxy/plugins/sso-auth.plugin.ts:64-90`, `proxy/plugins/sso.session-sync.plugin.ts:33-37`; Tests `sso-auth.plugin.test.ts`, `sso.session-sync.plugin.test.ts`.

- [ ] **Step 1:** Add a session-sync test: an entry with an empty name or control characters is dropped from the `cookies` string the sync context receives (fails today, non-filtering private builder).
- [ ] **Step 2:** Run it; expect FAIL.
- [ ] **Step 3:** `onRequest` calls the shared `buildCookieHeader`, keeping its warning log and its throw when nothing is left; session sync deletes its private builder and uses the shared one.
- [ ] **Step 4:** Run both files; expect PASS (existing sso-auth cases unchanged).

Test-first: yes - session-sync drops invalid cookie entries from the sent header.

### Task 4: Refresher bypass, followers, `refreshNow()`

**Files:** Modify `proxy/plugins/credential-refresh.ts`; Tests: the red `credential-refresh.test.ts` plus new cases; fix mocks in `sso-auth.plugin.test.ts`, `sso.session-sync.plugin.test.ts`, `otlp.plugin.credentials-refresh.test.ts` and any other test that mocks `sso.detached-login.js` with a fixed list (add `getLastSignInAt`).

**Interfaces:** Consumes `getLastSignInAt(this.params)` (T1), `readWithDeadline` (T2). Produces `refreshNow(): Promise<T | null>` on `CredentialRefresher` (returns stored credentials; null on failed/empty read, leaving `current` unchanged).

- [ ] **Step 1: Failing tests** (spec item 1, AC1), over and above the red test: unchanged stamp does not bypass; stepped-back clock does not read per call; failed/empty read after a stamp change causes no second read in the window; `refreshNow()` while a throttle read is in flight starts its own read and gets the post-sign-in store; an older read finishing late does not overwrite a newer snapshot; two concurrent `refresh()` after a stamp change resolve to new credentials from one store read; a call during a plain throttle read returns the snapshot at once; failed bypass read resolves followers with the unchanged snapshot and frees the slot; `refreshNow()` records the stamp so the next `refresh()` does not re-read; never-answering store: `refreshNow()` null after the deadline, next call starts a fresh read once the abandoned one settled.
- [ ] **Step 2:** Run the file; expect the red test and new cases FAIL.
- [ ] **Step 3:** In `refresh()`: read the stamp after the marker edge; bypass when stamp non-null and `!== lastActedStamp`; remember the stamp together with `lastRefreshedAt` before the store await (every attempt); publish the bypass read's promise with no await between decision steps, clear it in `finally`; followers of a bypass read await it. One private reader (wrapped in `readWithDeadline`) used by `refresh()` and `refreshNow()`; reads numbered at start, a read assigns `current` only if no later-started read already assigned; `refreshNow()` joins only an in-flight read started by `refreshNow()`. Update the `refresh()` comment: the lock stamp covers the detached sign-in, the marker edge covers sign-ins that clear the marker without stamping (`profile login`, launch-time re-auth, an accepted metrics send).
- [ ] **Step 4:** Run the file and the mock-updated test files; expect PASS.

Test-first: yes - the red `credential-refresh.test.ts` (re-login inside the 5 s window serves fresh cookies) plus the AC1 cases.

### Task 5: Expiry plugin supersede branch

**Files:** Modify `proxy/plugins/sso-session-expiry.plugin.ts` (constructor `:67`, `onUpstreamResponse` `:76`); Test `sso-session-expiry.plugin.test.ts`.

**Interfaces:** Consumes `sentCredentialsSuperseded` (T2) and `CredentialRefresher.refreshNow` (T4). `createInterceptor` passes `context.credentialRefresher`, cast to the SSO type after the existing JWT guard. New module-level `syntheticUnauthorized(response, tools, message): ...` called only by the new branch (header comment: the 401 body must later become per-client).

- [ ] **Step 1: Failing tests** (AC2-AC4): redirect on a request whose `cookie` differs from `buildCookieHeader(fresh)` -> 401 "session was just renewed ... re-send", `markAnalyticsAuthInvalid` and `startDetachedSsoLogin` not called, `readBody` asserted (also when it rejects, still 401); equal header (including a store entry the builder drops) -> marks invalid and starts one sign-in; `refreshNow()` null or throwing -> 401 via the old path; no `credentialRefresher`/JWT -> unchanged.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** New branch before the mark/start steps and outside the existing `failedStep` try: drain body in its own try (ignore, `logger.debug`), `sentCredentialsSuperseded(context.headers['cookie'], refresher)`; true -> one debug line "request carried superseded credentials", return `syntheticUnauthorized(...)`; false -> existing code, old inline 401 block untouched.
- [ ] **Step 4:** Run the file; expect PASS.

Test-first: yes - a redirect on a superseded-cookie request yields a 401 with no marker write and no sign-in start.

### Task 6: Gate clears a provably stale marker

**Files:** Modify `src/providers/plugins/sso/sso.auth-gate.ts` (`ensureCodeMieSsoAuth` ~`:92-116`); Tests `sso.auth-gate.test.ts` (add `getLastSignInAt` to the detached-login mock `:11-16`, `clearAnalyticsAuthStatus` to the marker mock `:10`), and a real-marker-file case.

**Interfaces:** Consumes `getLastSignInAt(source)` (T1), existing `clearAnalyticsAuthStatus()`, `markerAppliesToProfile`.

- [ ] **Step 1: Failing tests** (AC5): valid creds + applicable marker with `detectedAt < stamp` -> `ok: true`, clear called; `detectedAt >= stamp`, or a re-read before the clear showing a newer marker -> not cleared, blocks and signs in; other-profile marker not cleared; API key set -> not cleared; clear that does nothing still `ok: true`; real marker files: stale cleared, later genuine re-mark blocks.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** When no API key and the marker applies, non-null stamp and finite `detectedAt`: if `detectedAt < stamp` re-read marker and stamp, clear only if the condition still holds, then proceed as if no marker existed; if the re-read marker no longer meets it, act on that one.
- [ ] **Step 4:** Run the file plus `tests/integration/analytics-auth-gate.test.ts`; expect PASS.

Test-first: yes - a marker older than the last sign-in is cleared and the gate returns `ok: true`.

### Task 7: `signed-in-recently` outcome and text

**Files:** Modify `sso.detached-login.ts` (`DetachedLoginOutcome` `:9`, `acquireLock` `:174-176`, `describeLogin` `:314-346`); Tests `sso.detached-login.test.ts` (including the red `:106`), `sso.auth-gate.test.ts` `:236-241,277`, `copilot-chat-otlp.plugin.test.ts:81-82`, `copilot-cli-otlp.plugin.test.ts:123-124` only where they assert the post-success outcome name.

- [ ] **Step 1:** Update `:95-104` to expect `'signed-in-recently'`; add `describeLogin('signed-in-recently')` test (AC6): contains "re-send your prompt" and "wait", seconds equal `Math.round(COOLDOWN_MS / 1000)`, no "did not complete", no `codemie profile login`; `describeLogin('cooldown')` unchanged (`:240-242`).
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Add the union member; `acquireLock` returns it for the `succeededAt`-within-cooldown branch only (post-failure/dead-pid branch stays `cooldown`); add the `describeLogin` case with text: "A sign-in finished moments ago; re-send your prompt. If it is rejected again, wait about N seconds and re-send: a new sign-in then opens automatically."; `default` branch gets a `never` check. `ensureCodeMieSsoAuthOrWait` still waits only for `started`/`in-progress`.
- [ ] **Step 4:** Run the files above; expect PASS (the red test is green); `npm run typecheck` shows no non-exhaustive consumer.

Test-first: yes - the red post-success-text test and `describeLogin('signed-in-recently')` cases.

### Task 8: Metrics client and processor plumbing

**Files:** Modify `session/processors/metrics/metrics-types.ts:150` (`MetricsApiConfig`), `metrics-api-client.ts` (`MetricsSenderOptions` `:292`, `sendMetric` auth-failure at `:90-95`, `MetricsSender` config literal `:327-337`, `Required<MetricsApiConfig>` constructor default `async () => false`), both `BaseProcessor.ts` `ProcessingContext`, `metrics-sync-processor.ts:187`; Tests: new `metrics-api-client` test, `metrics-sync-processor.test.ts`.

**Interfaces:** Consumes `CredentialsSupersededCheck` (T2) as the one named type on all four declarations: `credentialsSuperseded?: CredentialsSupersededCheck`.

- [ ] **Step 1: Failing tests** (AC9, AC11 first half; real marker files in a temp `CODEMIE_HOME`, mocked `fetch`): 401 and 200+HTML with callback true -> no marker; false / throws / absent -> marker as before; non-auth failure -> no marker; a send after a sign-in cleared the marker does not re-create it; API-key mode never asks the callback; `metrics-sync-processor` passes `context.credentialsSuperseded` to `MetricsSender` (absent stays absent).
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** On `isAuthFailure` with cookies, `await credentialsSuperseded(sentCookies)` in a try; true -> debug line (no cookie content), skip `markAnalyticsAuthInvalid`; classification, retry and throw unchanged.
- [ ] **Step 4:** Run both files; expect PASS.

Test-first: yes - an auth failure with callback true writes no marker.

### Task 9: Daemon sync interceptor wiring

**Files:** Modify `proxy/plugins/sso.session-sync.plugin.ts:178-185` (ctor) and per-tick `:262`; Test `sso.session-sync.plugin.test.ts`.

- [ ] **Step 1:** Failing test: the sync context carries `credentialsSuperseded` that calls `sentCredentialsSuperseded(sent, this.credentials)`, and it is unset in local-dev mode.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Set `(sent) => sentCredentialsSuperseded(sent, this.credentials)` (the refresher that built `context.cookies`); no sender edit.
- [ ] **Step 4:** Run; expect PASS.

Test-first: yes - daemon sync context exposes the callback outside local-dev.

### Task 10: Hook wiring

**Files:** Modify `src/cli/commands/hook.ts`: sync context `:486-507`, SessionStart `:1057-1101` (`new MetricsSender` `:1094`), SessionEnd `:1316-1354` (`:1347`); Test `hook.analytics-wiring.test.ts`.

- [ ] **Step 1:** Failing cases: each of the three sites gets `cookies` from `readAnalyticsCookieAuth(ssoUrl, config?.env, { provider: getConfigValue('CODEMIE_PROVIDER', config) })` and a callback whose re-read uses those same arguments; the senders receive `credentialsSuperseded`; with `HookProcessingConfig.cookies` preset or an API key, no callback and the preset cookies are used as before.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Replace the inline `Object.entries(...).join('; ')` at the three sites with the helper; sites skip on `cookies === ''`; pass the callback to context and `new MetricsSender`.
- [ ] **Step 4:** Run; expect PASS.

Test-first: yes - hook sync, SessionStart and SessionEnd senders carry the callback.

### Task 11: Desktop runtime wiring

**Files:** Modify `src/telemetry/runtime/DesktopTelemetryRuntime.ts` (`buildProcessingContext` `:351-382`, `syncer.sync` `:340`, senders `:393,:433`); Test `DesktopTelemetryRuntime.test.ts`.

- [ ] **Step 1:** Failing cases: context cookies come from `readCookieAuth(() => new CodeMieSSO().getStoredCredentials(credentialsUrl))` (reader passed as is); the context carries the callback to `syncer.sync`; both senders pass `context.credentialsSuperseded`; no cookies -> early return as today.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement per case; remove the inline join.
- [ ] **Step 4:** Run; expect PASS.

Test-first: yes - desktop context and both senders carry the callback.

### Task 12: Codex, pi, opencode upload contexts

**Files:** Modify `codex.incremental-sync.ts:160-189`, `pi.incremental-sync.ts:335-364`, `opencode.incremental-sync.ts:173-203` (`buildUploadContext`) under `src/agents/plugins/*/`; Tests: their `*.incremental-sync.test.ts`.

- [ ] **Step 1:** Failing case per agent: upload context cookies from `readAnalyticsCookieAuth(ssoUrl, env)` (the arguments used today) and a callback whose re-read uses the same arguments.
- [ ] **Step 2:** Run the three files; expect FAIL.
- [ ] **Step 3:** Replace the inline join with the helper in each.
- [ ] **Step 4:** Run the three files; expect PASS. Then check AC11 by grep: no remaining inline `Object.entries(...cookies...).join('; ')` at these sites; every non-test `new MetricsSender(` passes `credentialsSuperseded` or is a documented unwired case (preset-cookie hook path).

Test-first: yes - each agent's upload context carries a callback built from its own reader arguments.
