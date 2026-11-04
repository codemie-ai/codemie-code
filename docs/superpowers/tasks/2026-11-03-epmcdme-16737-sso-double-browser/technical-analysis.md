# Technical Research

**Task**: sso credential-refresh auth-gate detached-login
**Generated**: 2026-11-03
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16737: [CodeMie CLI][SSO] Re-authentication opens the browser twice. Fix the race: (1) CredentialRefresher.refresh() must re-read stored creds when sso-login.lock succeededAt is newer than lastRefreshedAt (src/providers/plugins/sso/proxy/plugins/credential-refresh.ts); (2) SSOSessionExpiryInterceptor.onUpstreamResponse must not mark auth invalid / start sign-in when the redirected request carried credentials superseded by a successful sign-in - re-read store unthrottled and compare with cookies actually sent, else return a retryable 401 (sso-session-expiry.plugin.ts, sso-auth.plugin.ts, PluginContext.credentialRefresher); (3) hook gate (sso.auth-gate.ts ensureCodeMieSsoAuth) must ignore analytics-auth-status marker whose detectedAt is older than latest succeededAt, so no second browser; (4) split 'cooldown' outcome into post-success vs post-failure in acquireLock/describeLogin (sso.detached-login.ts) - post-success text must never say 'did not complete' nor suggest `codemie profile login`. Acceptance: a real revoke after a sign-in still triggers exactly one new sign-in; fail/timeout/interrupt recovery and API-key/policy no-retry rules of EPMCDME-16568 unchanged; one expiry = exactly one browser. Already applied (uncommitted) regression tests from the ticket patch: src/providers/plugins/sso/proxy/plugins/__tests__/credential-refresh.test.ts and src/providers/plugins/sso/__tests__/sso.detached-login.test.ts (both red on main 72b47add). Open PR #720 also edits the 401 body in sso-session-expiry.plugin.ts. Ticket evidence (incl. reproduction output and root-cause table) in ~/Downloads/EPMCDME-16737/EPMCDME-16568-double-browser-evidence.txt. Reproduced end-to-end on this code: req-B 0.1s after sign-in sent stale-revoked-1 cookie -> 401 'did not complete' + marker re-written; prompt after 30s cooldown opened browser #2.

---

## 2. Codebase Findings

### Existing Implementations

Purpose A - "after a sign-in succeeds, the next request/prompt uses the new cookies and does not start another sign-in".
- `CredentialRefresher.refresh()` - `proxy/plugins/credential-refresh.ts:76`. Throttle 5 s from `lastRefreshedAt` (`:31`, `:82`); bypass only via `consumeAuthRecoveryEdge()` (`:103`), which fires when it has observed the analytics-auth-status marker invalid and later cleared. It never reads sso-login.lock. If no call happens while the marker is set (req-A, then req-B after the whole sign-in), `sawAuthInvalid` is never set, so the throttle holds. Consumers: `SSOAuthInterceptor.onRequest` (`sso-auth.plugin.ts:59`, builds the `cookie` header into `context.headers['cookie']` at `:90`), Claude/Codex normalizers (`claude-request-normalizer.plugin.ts:226`, `codex-request-normalizer.plugin.ts:144`, model-catalogue fetch), session sync via `syncCredentialRefresher` (`sso.session-sync.plugin.ts:74,152`; same instance as `credentialRefresher` when sync falls back to the main source, `sso.proxy.ts:151-155`). Built once in `sso.proxy.ts:129`, exposed as `PluginContext.credentialRefresher` (`types.ts:59`). `get()` returns the last snapshot; JWT variant is a no-op.
- `SSOSessionExpiryInterceptor.onUpstreamResponse` - `sso-session-expiry.plugin.ts:76`. On any 302/303 with `location` containing `/oauth2/start`: drains body, `markAnalyticsAuthInvalid(reason, targetApiUrl)` (`:94`), `startDetachedSsoLogin(targetApiUrl)` (`:99`), returns a synthetic 401 with `describeLogin(outcome ?? 'failed')` (`:112`). No check of which cookies the request carried. Constructed with only `targetApiUrl` (`:67`); `createInterceptor` does not take `context.credentialRefresher`. Only `onUpstreamResponse` implementer for expiry; invoked in `sso.proxy.ts:632-637` (errors from a hook are logged and the previous response is kept). `tools.retry` (`sso.proxy.ts:621`) re-forwards with `context.headers`; the request's cookie is still in `context.headers['cookie']` when `onUpstreamResponse` runs.
- `ensureCodeMieSsoAuth` - `sso.auth-gate.ts:72`. Reads stored creds (`:92`), `getAnalyticsAuthStatus()` (`:102`), filters by `markerAppliesToProfile` (`:49`, URL match only); with a surviving marker it reports "rejected the stored credentials" and calls `startDetachedSsoLogin` (`:116`). No comparison of `marker.detectedAt` against the lock. `ensureCodeMieSsoAuthOrWait` (`:135`) waits only for outcomes `started`/`in-progress` (`:142`), then rechecks. Callers: `cli/commands/hook.ts:619-627`, `claude-code-otlp.plugin.ts:451,482`, `copilot-chat-otlp.plugin.ts:211`, `copilot-cli-otlp.plugin.ts:263`.
- `sso-login.lock` - `sso.detached-login.ts`. `LoginLock {pid, startedAt, succeededAt?, failedAt?, error?}` (`:22`); path `getCodemiePath('sso-login.lock')` (`:40`), global, not keyed by profile/URL. `readLock` (`:43`) is module-private; not exported. `releaseLoginLockOnSuccess` stamps `succeededAt` (`:210`), called from `src/bin/sso-login.ts:38` (after `sso.auth.ts:145-148` stores creds then clears the marker). `COOLDOWN_MS` 30 s, `LOCK_MAX_AGE_MS` 150 s.
- `acquireLock` - `sso.detached-login.ts:159`. Returns `'cooldown'` from two distinct branches: post-success (`succeededAt` within 30 s, `:174-176`) and post-failure/dead-process (`age < COOLDOWN_MS`, `:183-185`). `DetachedLoginOutcome = 'started'|'in-progress'|'cooldown'|'failed'` (`:9`).
- `describeLogin` - `sso.detached-login.ts:314`. `'cooldown'` -> "The previous sign-in attempt did not complete. Run `codemie profile login`." (`:345-346`) for both branches. A `wait.status==='succeeded'` text exists (`:325-328`, still tells user to run `codemie profile login`). `outcome===undefined && !wait` -> neutral API-key text (`:319`). Consumers of the string: `sso-session-expiry.plugin.ts:112`, `hook.ts:627`, `claude-code-otlp.plugin.ts:482`, `copilot-chat-otlp.plugin.ts:177`, `copilot-cli-otlp.plugin.ts:225` (newlines flattened).
- Marker `analytics-auth-status.json` - `src/utils/analytics-auth-status.ts`. `AnalyticsAuthStatus.detectedAt` preserved from any existing marker on re-mark (`:48-55`), so a re-write after sign-in keeps the old time unless the marker was cleared. Writers: expiry plugin, `metrics-api-client.ts:91`. Clearers: `sso.auth.ts:148`, `metrics-api-client.ts:79`, `AgentCLI.ts:360`. Readers: `credential-refresh.ts:105`, `sso.auth-gate.ts:102`.
- Reproduction per evidence file (`~/Downloads/EPMCDME-16737/...evidence.txt`): req-A 401 + browser #1; sign-in ok ~3.3 s later; req-B 0.15 s later sent `stale-revoked-1` cookie (upstream log line 94), got 401 with "did not complete", marker re-written (`detectedAt` 1793655381663 > `succeededAt` 1793655381261); prompt after 30 s cooldown -> browser #2. Control (req-B at 6 s, outside the 5 s throttle) -> one browser.

Other touched code: `src/bin/sso-login.ts` (detached child; sets lock result), `src/providers/plugins/sso/proxy/plugins/index.ts:42` (registration, priority 11 after SSOAuth priority 10), `src/providers/plugins/sso/sso.proxy.ts` (see above). PR #720 (open) edits `sso-session-expiry.plugin.ts` (+13/-4) plus `src/bin/proxy-daemon.ts` and `cli/commands/proxy/*`.

### Decisions Already in the Code

- Expiry acts on the redirect signature alone, deliberately not on local `expiresAt` (`sso-session-expiry.plugin.ts:9-16`; also `credential-refresh.ts:58-64`): a server-side revoke leaves the JWT `exp` unchanged. Reason recorded.
- Throttle is a flat 5 s window, not `expiresAt`-based (`credential-refresh.ts:29-31,58-75`); the marker-edge bypass was added as a partial fix for the in-window gap. Reason recorded.
- Post-success cooldown of 30 s after `succeededAt` instead of removing the lock (`sso.detached-login.ts:200-209`, PR #655 review): damps redirect bursts; `succeededAt` branch is split from the alive-pid branch (`:167-173`).
- Marker is a single global file; profile matching done at read via `baseUrl` (`sso.auth-gate.ts:37-61`, PR #655 review).
- `codemie profile login` signs in in-process without the lock (per new test comment, `sso.detached-login.test.ts:107-108`), so following the current cooldown text opens another window.
- Lock timestamps (`succeededAt`) and the marker (`detectedAt`) are stored per-writer in different files; no existing helper exposes "latest succeededAt" to code outside `sso.detached-login.ts` (`readLock` private). Needed by items 1, 2, 3 in a read-direction not currently exported.
- Convention: new shared code under `@/` alias with `.js` extensions; plugin files use relative imports; error classes / `logger.debug`; `sanitizeLogArgs` for secrets (AGENTS.md). Plugins read credentials only via `CredentialRefresher`.

### Task Statements Checked Against the Code

- "CredentialRefresher.refresh() re-reads only on throttle expiry / marker edge" - holds (`credential-refresh.ts:81-85`); the red test reproduces it.
- "`PluginContext.credentialRefresher` is available to the expiry plugin" - field exists (`types.ts:59`), but `createInterceptor` of the expiry plugin currently passes only `config.targetApiUrl` (`sso-session-expiry.plugin.ts:67`); `credentialRefresher` is typed `CredentialRefresher<SSOCredentials|JWTCredentials>` (SSO narrowing used in `sso-auth.plugin.ts:30`).
- "cookies actually sent" are recoverable at response time - holds: `context.headers['cookie']` is set in `sso-auth.plugin.ts:90` and reused by `tools.retry`. Whether it is the only place (e.g. other normalizers rewriting cookie) - not found other writers (grep of `headers['cookie']` limited to sso-auth).
- "return a retryable 401" - 401 synthesis already exists (`:110-118`); nothing in the code distinguishes a "retryable" 401 from the expiry 401 (body is Anthropic-shaped, KNOWN GAP `:26-31`). Client retry behaviour is outside this repository: unverified.
- "hook gate would open a second browser because marker.detectedAt < succeededAt is not checked" - holds (`sso.auth-gate.ts:102-116`; evidence run 2).
- "post-success cooldown text says 'did not complete'" - holds (`sso.detached-login.ts:346`; red test `sso.detached-login.test.ts:106`).
- "fail/timeout/interrupt recovery and API-key/policy no-retry rules unchanged" - keeps in place: post-failure `cooldown` branch (`:183-185`), `wait.status` texts (`:322-331`), `apiKey` guards (`sso.auth-gate.ts:115`, `sso-session-expiry.plugin.ts:55-62`), `describeLogin(undefined)` neutral text (`:319`). Consumers listed above.
- "Open PR #720 also edits the 401 body in sso-session-expiry.plugin.ts" - holds (gh pr view 720: file +13/-4); content not diffed here.
- "both tests red on main 72b47add" - not run (tests only on explicit request).
- Evidence-file claims (upstream behaviour of oauth2-proxy mock, timing) - unverified outside this repo beyond the file itself.

### Consumers of Changed Contracts

- `DetachedLoginOutcome` / `'cooldown'` (if split): `sso.auth-gate.ts:35,73,116,142`; `sso-session-expiry.plugin.ts:88,112`; `copilot-chat-otlp.plugin.ts:174-177`; `copilot-cli-otlp.plugin.ts:218-225`; `hook.ts:619-627`; `claude-code-otlp.plugin.ts:451-482`. Existing tests asserting `'cooldown'`: `sso.detached-login.test.ts:84,102,241,249`; `sso.auth-gate.test.ts:236-241,277`; `copilot-chat-otlp.plugin.test.ts:81-82`; `copilot-cli-otlp.plugin.test.ts:123-124`. `describeLogin('cooldown')` test at `sso.detached-login.test.ts:240-242` expects "codemie profile login" (conflicts with the new post-success text requirement if it is the same outcome).
- `describeLogin` strings: also read by `tests/integration/hook-stdout.test.ts`, `tests/integration/analytics-auth-gate.test.ts` (reference lock/gate; not opened).
- `CredentialRefresher.refresh()` behaviour: `sso-auth.plugin.ts:59`, normalizers (`claude-...:226`, `codex-...:144`), `sso.session-sync.plugin.ts:152`; tests `sso-auth.plugin.test.ts`, `sso.session-sync.plugin.test.ts`, `otlp.plugin.credentials-refresh.test.ts`. OTLP forwarder is NOT a consumer (own `otlp-spool/auth-state.ts` path, `credential-refresh.ts:14-19`).
- Marker `detectedAt` semantics: `credential-refresh.ts:105`, `sso.auth-gate.ts:102`; the `markAnalyticsAuthInvalid` "preserve detectedAt" rule (`analytics-auth-status.ts:48-55`).
- Lock module exports: `sso.auth-gate.test.ts:11-20` fully mocks `sso.detached-login.js` with a fixed export list (`startDetachedSsoLogin, waitForDetachedSsoLogin, describeLogin, SSO_LOGIN_WAIT_MS`); any new export the gate/refresher imports is absent there.

### Architecture and Layers Affected

Provider plugin layer (SSO): proxy plugins (`credential-refresh.ts`, `sso-session-expiry.plugin.ts`, `sso-auth.plugin.ts`, `types.ts`), SSO login lock module (`sso.detached-login.ts`), hook-gate (`sso.auth-gate.ts`), shared util marker (`utils/analytics-auth-status.ts`). Dependency direction today: `credential-refresh.ts` -> `utils/analytics-auth-status`; proxy plugins -> `sso.detached-login` (expiry plugin) ; `sso.auth-gate` -> `sso.detached-login`. `credential-refresh.ts` currently does not import `sso.detached-login`.

### Integration Points

Cross-process: detached `bin/sso-login.js` writes lock + credential store + clears marker; proxy daemon and hook process read them. Credential store (`getStoredPlatformCredentials`, `codemie-auth-helpers.ts`; keytar/encrypted file). Upstream oauth2-proxy redirects. Agents consume the 401 body.

### Patterns and Conventions

`ProxyPlugin.createInterceptor(context)` + `ProxyInterceptor` hooks; shared state via `PluginContext`; atomic lock write via tmp+rename (`writeLockAtomically`); best-effort helpers that never throw and log via `logger.debug`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, standards, testing, security, usage); no SSO-lock/cooldown content found (grep for `sso-login.lock|cooldown|succeededAt` in `docs/*.md` and guides: no hits). `docs/ARCHITECTURE-PROXY.md`, `docs/AUTHENTICATION.md`, `docs/HOOKS.md` exist; not read in detail.

### Architectural Decisions
Recorded inline only: PR #655/#661/#624 review notes in `credential-refresh.ts`, `sso.detached-login.ts`, `sso.auth-gate.ts`, `sso-session-expiry.plugin.ts` headers. EPMCDME-16568 behaviour is described in the ticket evidence file, not in repo docs.

### Derived Conventions
Comments describe what/why without ticket numbers in production code is the owner's rule (CLAUDE.local.md); existing source does carry PR references.

---

## 4. Testing Landscape

### Existing Coverage
- `proxy/plugins/__tests__/credential-refresh.test.ts` (untracked, new): one test; real temp `CODEMIE_HOME`, fake `Date` only, mocks `getStoredPlatformCredentials`, uses real marker and `releaseLoginLockOnSuccess`.
- `sso/__tests__/sso.detached-login.test.ts` (modified): new test at `:106` (post-success cooldown text); existing cooldown/succeeded/lingering tests `:81-135`, describeLogin tests `:235-260`.
- `sso-session-expiry.plugin.test.ts` (7 tests, mocks `startDetachedSsoLogin`, `markAnalyticsAuthInvalid`); no test for a request carrying superseded cookies.
- `sso.auth-gate.test.ts` (mocks detached-login and marker); no test where marker is older than a success.
- Also `sso-auth.plugin.test.ts`, `sso.session-sync.plugin.test.ts`, `src/bin/__tests__/sso-login.test.ts`, `tests/integration/analytics-auth-gate.test.ts`, `hook-stdout.test.ts`.

### Testing Framework and Patterns
Vitest 4.1.x (projects `unit`, `cli`, `agent`), dynamic-import mocking per `.ai-run/guides/testing/testing-patterns.md`; `vi.mock` factories for modules; fake timers limited to `Date`.

### Coverage Gaps
Items (2) and (3) have no tests; the `readLock`-based "latest succeededAt" reader does not exist so has none. Test-writing/running is only on explicit request (AGENTS.md).

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_HOME` (via `getCodemiePath`) locates `sso-login.lock` and `analytics-auth-status.json`. `CODEMIE_SESSION_ID` unrelated. No new vars found for this area.

### Configuration Files
None governing cooldown (`COOLDOWN_MS`, `LOCK_MAX_AGE_MS`, `CREDENTIAL_REFRESH_INTERVAL_MS` are code constants).

### Feature Flags and Deployment Concerns
None found. Daemon (`dist/bin/proxy-daemon.js`) is long-lived, so the fix takes effect after daemon restart. `.codemie/codemie-cli.config.json` has an unrelated local modification.

---

## 6. Risk Indicators

- Lock and marker are global, not profile/URL-keyed (`sso.detached-login.ts:39`, `analytics-auth-status.ts:42`): comparing `succeededAt` to `detectedAt` can be satisfied by another profile's sign-in (the gate already re-checks for this at `sso.auth-gate.ts:151`).
- Keeps an existing mechanism in place: the marker-edge bypass `consumeAuthRecoveryEdge` (`credential-refresh.ts:103`) and the 30 s post-success cooldown (`sso.detached-login.ts:174`) are both retained by the task's acceptance; see Existing Implementations A.
- A "real revoke after a sign-in still triggers exactly one new sign-in": the proposed supersede check must distinguish stale cookies from genuinely revoked fresh cookies; cookie comparison relies on `context.headers['cookie']` (`sso-auth.plugin.ts:90`) against the store.
- Speculative: `readLock` is private; new cross-module reads of `succeededAt` would require exporting something from `sso.detached-login.ts`, and `sso.auth-gate.test.ts:11-20` mocks that module with a fixed export list.
- Speculative: splitting `'cooldown'` changes the exported union `DetachedLoginOutcome` used in 5 production files and 4 test files; one existing test (`sso.detached-login.test.ts:240-242`) asserts the opposite of the new requirement for `describeLogin('cooldown')`.
- PR #720 edits the same file/body region in `sso-session-expiry.plugin.ts` (merge conflict risk); `proxy-daemon.ts` also changes there.
- The retry mechanism for a "retryable 401" is client-side and unverified; 401 body is Anthropic-shaped for all clients (KNOWN GAP in header).
- Expiry plugin catches errors and still emits a 401 (`:100-108`); an added re-read failure must follow the same fallback so the raw 302 never leaks.
- Concurrency: several simultaneous redirects share the process; the lock uses tmp+rename atomic writes (`:149`).

---

## 7. Summary for Complexity Assessment

Layers: SSO provider plugin (proxy interceptors, hook gate, detached-login lock module) plus one shared util (analytics-auth-status). Production files in the described scope: `credential-refresh.ts`, `sso-session-expiry.plugin.ts`, `sso.auth-gate.ts`, `sso.detached-login.ts`, with `sso-auth.plugin.ts`/`types.ts` touched by the ticket text; the `DetachedLoginOutcome` union reaches five more production consumers (hook, three OTLP agent plugins, gate). No new dependencies, config, migrations or env vars.

Technical novelty is low-to-moderate: all mechanisms exist and are cross-process file-based (lock, marker, credential store); the new logic is comparisons between existing timestamps and cookie sets. The hard part is correctness around global (unkeyed) lock/marker state and keeping the acceptance cases (real revoke after sign-in, failure/timeout/interrupt recovery, API-key no-retry) intact. Two regression tests already exist and are red; no tests exist for the expiry-plugin supersede check or gate marker comparison; several existing tests assert current 'cooldown' text/outcomes and a fully mocked detached-login module.

Key risks: PR #720 overlap in the expiry plugin, contract change on the exported outcome union, test mocks that enumerate module exports, and the unverified client behaviour for a retryable 401.

---

## 8. External References

- `~/Downloads/EPMCDME-16737/EPMCDME-16568-double-browser-evidence.txt` - resolved (9.4 KB). Facts: tested on upstream/main 2fb00777 (0.16.3), mock oauth2-proxy (revoked cookie -> 302 `/oauth2/start`). Run 2 timeline: req-A 401 at t=…378.0, login `succeededAt` …381261, req-B at …381.8 sent `stale-revoked-1` (upstream log line `POST /v1/messages token=stale-revoked-1 valid=false` at …381.641), 401 with "did not complete. Run `codemie profile login`", marker re-written (`detectedAt` …381663). Prompt within cooldown: exit 2 with the same text; prompt after 30 s: second browser (lock succeededAt …415876). Control with req-B at 6 s: one browser, 200. The "root-cause table" mentioned in the task was not found in this file.
- Same directory also holds `EPMCDME-16568-regression-tests.patch` (5 KB) and `EPMCDME-16568-repro-harness.tgz` (5 KB); neither opened (tests are already applied; tgz is untrusted data).
- PR #720 via `gh pr view 720`: title "fix(proxy): keep the port bound and prompt for sign-in when the SSO login expires", OPEN; changes `sso-session-expiry.plugin.ts` +13/-4, `src/bin/proxy-daemon.ts`, `cli/commands/proxy/*`; diff not read.

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- property on `interface MetricsRequestError` — `metrics-api-client.ts:39`; set at :193, :201 (401/403) and :262 (`Boolean(contentType?.includes('text/html'))` in `parseMetricsResponse`, :246-265, which runs only when JSON.parse of the body fails). Read at :90. Consumer: `sendMetric` only.
- const arrow function `isAuthFailure(response: Response)` — `src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts:101-104`: status 401, 403 or 302. Module-private. Used in `send()` (:138, :143). The forwarder fetches with `redirect:'manual'` (:86), so 302 is visible. Flow: first auth failure -> one more `attempt()`; second -> returns `'auth-expired'`.
- Documented in prose in `proxy/plugins/sso-session-expiry.plugin.ts:21-27` ("three independent classifiers ... no shared isSessionRejection()"): metrics client (401/403/HTML), OTLP forwarder (401/403), expiry plugin (302/303 to `/oauth2/start`). That comment predates the forwarder's 302 (it says forwarder = 401/403); the code at forwarder.ts:101-104 includes 302.
- `metrics-sync-processor.ts:187` (per `process()` call; `cookies: context.cookies`, `apiKey: context.apiKey`, retryAttempts 3, timeout 30000) — calls `sendSessionMetric` per branch (:219).
- `src/cli/commands/hook.ts:1094` (SessionStart) and `:1347` (SessionEnd); cookie built inline from `getStoredAnalyticsCredentials` result (:1067-1069, :1326-1328); timeout 10000, retryAttempts 2; process is the short-lived hook process.
- `src/telemetry/runtime/DesktopTelemetryRuntime.ts:393` (start) and `:433` (end); cookie from `buildProcessingContext` (:~350-375, `CodeMieSSO().getStoredCredentials`); returns early when no cookies.
- `metrics-aggregator.ts:110` uses only the static `MetricsSender.METRIC_TOOL_USAGE_TOTAL`.
- `src/providers/plugins/sso/session/BaseProcessor.ts:15-42` (the "session/BaseProcessor.ts" under the SSO provider): fields `apiBaseUrl`, `cookies: string`, `apiKey?`, `clientType`, `version`, `dryRun`, `sessionId?`, `agentSessionId?`, `agentSessionFile?`, `syncDeadlineMs?`, `abortSignal?`. Also exports `ProcessingResult` (`metadata?: Record<string, unknown>`) and `SessionProcessor`. No `shouldStopSync`, no `gitBranch`, no `finalPass`.
- `src/agents/core/session/BaseProcessor.ts:15-46`: same fields plus `gitBranch?` and `finalPass?`; also exports `shouldStopSync(context)` (:53). `ProcessingResult.metadata` is a typed object here.
- Consumers of the SSO-provider copy: `sso.session-sync.plugin.ts:25` (holds `private context`), `metrics-sync-processor.ts:15`, `conversations/syncProcessor.ts:14`, `session/BaseSessionAdapter.ts:113`. Consumers of the agents/core copy: `SessionSyncer.ts:16` (`sync(sessionId, context)` :156, passes the same object to every processor :248, checks `shouldStopSync` :233), `shouldStopSync` importers (metrics-sync-processor.ts:16, syncProcessor.ts:16, SessionSyncer.ts), all agent session adapters/processors (claude, codex, gemini, pi, opencode, kimi, copilot-cli), `cli/commands/hook.ts`, `telemetry/runtime/*`, `agents/core/session/BaseSessionAdapter.ts:186`.
- Where `cookies` is assigned: `sso.session-sync.plugin.ts:178-185` (ctor) and `:262` (per tick); `hook.ts:~1096-ish buildContext` (returns `cookies` at :~519, loaded once per hook invocation :500-503); codex/pi/opencode `*.incremental-sync.ts` `buildContext` (codex :174-183; builds fresh each tick, cookies read from the credential store per call, no throttle); `codex.plugin.ts:237,385`, `pi.plugin.ts:407`, `opencode.plugin.ts:242`, `cli/commands/opencode-metrics.ts:213` set `cookies: ''`; `DesktopTelemetryRuntime.ts:~375`.
- Where `cookies` is read: `metrics-sync-processor.ts:189`, `conversations/syncProcessor.ts:77`, `DesktopTelemetryRuntime.ts:389,395,429,435`.
- Marker is one global file, written by multiple processes/profiles with no profile key; reader-side filtering is `markerAppliesToProfile` in `sso.auth-gate.ts:38-49` (documented there). The clearer (`clearAnalyticsAuthStatus`) has no equivalent filter.
- `CredentialRefresher` recovery edge (invalid -> cleared) is the signal that forces a re-read; it therefore depends on `clearAnalyticsAuthStatus` being called exactly when fresh creds are stored (`credential-refresh.ts:66-74`). Clearing from a metrics send also trips it.
- OTLP forwarding intentionally uses its own `markCredentialsStale` path rather than `CredentialRefresher` (`credential-refresh.ts:14-19`).
- "metrics sender path that writes the marker": holds — `MetricsApiClient.sendMetric` is the only `markAnalyticsAuthInvalid` caller in the metrics path (:91); the only other writer is `sso-session-expiry.plugin.ts:94`.
