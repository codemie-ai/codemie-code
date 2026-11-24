# Technical Research

**Task**: sso proxy oauth2 session-expiry detached-login
**Generated**: 2026-10-15T00:00:00Z (updated 2026-10-15T12:00:00Z — PR #624 integration angle)
**Research path**: filesystem

---

## 1. Original Context

Fix Issue 1 (Expired SSO session) from docs/superpowers/investigations/2026-10-13-EPMCDME-15316-findings.md — the local proxy blindly relays an oauth2-proxy 302 redirect to /oauth2/start (expired SSO session) upstream to Claude Code unchanged, which produces a <synthetic> turn with no usage instead of a clear re-login error. Implement the combined fix 2+3 from the findings: detect the firm signal (302/303 status with Location matching /oauth2/start) combined with the proxy's own stored credential expiry (expiresAt from sso.auth.ts), and when both indicate an expired session, replace the relayed response with a 401 JSON body Claude Code understands (Anthropic-shaped authentication_error) instead of relaying the raw redirect/HTML. If the redirect appears but the local credential still looks fresh, or there's no redirect, treat it as a generic upstream error with the real status code — do not mislabel infra 5xx blips as session-expired.

Relevant findings-doc excerpt (Issue 1, already investigated — use as the problem statement, not something to re-investigate from scratch):
- Local proxy checks cookie expiry once at startup (sso.proxy.ts:92 -> sso.auth.ts:212), then keeps cookies in memory and injects them per-request (sso-auth.plugin.ts:85), relaying upstream status/headers/body verbatim (sso.proxy.ts:452) with no content-type check and no redirect handling.
- Firm signal: 302/303 status + Location header matching /oauth2/start.
- The proxy already has expiresAt (from the JWT exp, sso.auth.ts:45).
- Recommended: merge fix 2 (HTML/redirect detection) with fix 3 (per-request expiry check) — when the 302->/oauth2/start signature appears AND the stored credential's expiresAt is at/past expiry, label it 'session expired' and return a 401 with an Anthropic-shaped JSON error body Claude Code can parse. If the redirect/HTML appears while the local credential still looks fresh, or there's no redirect at all, treat it as a generic upstream/infra error with the real status code instead.
- A repro suggestion from the findings doc: a CodeMieProxy unit test with a mocked upstream returning the 302/HTML to verify this.

### Update (2026-10-15) — integrate with PR #624's re-auth flow

This branch has been fast-forward-merged on top of upstream PR #624 ("fix(proxy): block prompts immediately when SSO session is invalid", EPMCDME-15378; commits `349a15b3`…`d3e346ce`), which fixed the `UserPromptSubmit` auth-gate hook (`src/providers/plugins/sso/sso.auth-gate.ts`) to kick off re-login via a detached child process (`src/providers/plugins/sso/sso.detached-login.ts`, new) instead of blocking synchronously.

New decision: the plugin this task builds should **not** return a static "run `codemie profile login`" message in isolation. When it detects the expired-session signature, it should also call `markAnalyticsAuthInvalid()` (`src/utils/analytics-auth-status.ts`, pre-existing) and `startDetachedSsoLogin()` (`src/providers/plugins/sso/sso.detached-login.ts`, introduced/hardened by PR #624), so a session-expiry detected on the completions-proxy path immediately feeds the same marker + auto-reauth mechanism the hook uses, rather than running a second, divergent remediation path. This section's Section 2/6/7 below are revised accordingly; Sections 2–5 content from the first pass (plugin pipeline architecture, `onUpstreamResponse` hook, `SSOCredentials.expiresAt`, `gateway-key.plugin.ts`'s 401 JSON shape) remains valid and is retained, not re-derived.

---

## 2. Codebase Findings

### Existing Implementations

- `src/providers/plugins/sso/proxy/sso.proxy.ts` — `CodeMieProxy`, the core proxy. `handleRequest` runs: short-circuit hooks → `onRequest` hooks → forward via `ProxyHTTPClient.forward()` → `runUpstreamResponseHooks()` (`onUpstreamResponse`) → `onResponseHeaders` hooks → `streamResponse()` (sets `downstream.statusCode`/headers verbatim, unconditional today) → `onResponseComplete` hooks. `start()` builds `PluginContext` once at proxy startup (lines ~119-125): `{ config, logger, credentials, syncCredentials, profileConfig }`. `config` is the full `ProxyConfig` (`proxy-types.ts`), which already carries `targetApiUrl: string` (the profile's resolved CodeMie base URL — the same value passed to `getStoredPlatformCredentials({ baseUrl: this.config.targetApiUrl, ... })` at startup) and `provider?: string`.
- `src/providers/plugins/sso/proxy/plugins/sso-auth.plugin.ts` — `SSOAuthPlugin` (priority 10). Guard: `!('cookies' in context.credentials)` → `NoOpInterceptor`. Owns `SSOCredentials` (`{ cookies, apiUrl, expiresAt? }`) once at startup; only implements `onRequest` (cookie injection), unchanged by PR #624.
- `src/providers/plugins/sso/sso.auth.ts` — `CodeMieSSO`. `deriveExpiresAt` (JWT `exp`), `getStoredCredentials()` (startup-time expiry check only). `SSOCredentials.expiresAt: number | undefined` (`core/types.ts`).
- `src/providers/plugins/sso/proxy/plugins/types.ts` — `ProxyInterceptor.onUpstreamResponse(context, response, tools)`; `UpstreamResponseTools.readBody`/`retry`/`fromBuffer`. This remains the correct integration seam for the fix.
- `src/providers/plugins/sso/proxy/plugins/gateway-key.plugin.ts` — precedent for the Anthropic-shaped 401 body: `{ type: 'error', error: { type: 'authentication_error', message } }`.
- `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts` / `copilot-encrypted-content-sanitizer.plugin.ts` — closest `onUpstreamResponse` templates (read body, decide, `fromBuffer`/retry).
- `src/providers/plugins/sso/proxy/plugins/registry.ts` + `index.ts` — ascending-priority plugin registration/execution.

**New for the PR #624 integration angle:**

- **`src/providers/plugins/sso/sso.auth-gate.ts`** — `ensureCodeMieSsoAuth(input: AuthGateInput): Promise<AuthGateResult>`. `AuthGateResult = { ok: true } | { ok: false; reason: string; loginOutcome: DetachedLoginOutcome | undefined }`. Logic: resolves `loginUrl = getPlatformUrl(source)` (profile `baseUrl` first, workspace `ssoUrl` fallback, via `getAnalyticsPlatformSource`/`getPlatformUrl` in `src/providers/core/codemie-auth-helpers.ts`); checks stored SSO cookies (`getStoredAnalyticsCredentials`) and the shared marker (`getAnalyticsAuthStatus()`); if auth looks broken (`!hasValidAuth` or a marker is present) and no `apiKey` is set and a `loginUrl` resolved, calls `loginOutcome = await startDetachedSsoLogin(loginUrl)` and returns `{ ok: false, reason, loginOutcome }`. Never throws — catches internally and fails closed with a generic reason.
- **`src/providers/plugins/sso/sso.detached-login.ts`** — `startDetachedSsoLogin(codeMieUrl: string): Promise<DetachedLoginOutcome>` where `DetachedLoginOutcome = 'started' | 'in-progress' | 'cooldown' | 'failed'`. Single string arg — a login URL, nothing else. Internally: acquires a **global** lock file at `getCodemiePath('sso-login.lock')` (`LOCK_MAX_AGE_MS = 150_000`, `COOLDOWN_MS = 30_000`); if free, resolves `bin/sso-login.js` relative to `getDirname(import.meta.url)` **of this module** (`../../../bin/sso-login.js`, independent of the caller's own file location) and `spawnDetached(process.execPath, [script, '--url', codeMieUrl], { windowsHide: true })`; writes `{ pid, startedAt }` into the lock. If another process (live PID, age < 150s) already holds the lock, returns `'in-progress'`; a dead-PID lock younger than 30s returns `'cooldown'`; otherwise the lock is treated as stale and replaced. `releaseLoginLockOnSuccess()` is called by the detached child itself after a successful sign-in. `describeLogin(outcome)` renders the user-facing hint string per outcome. Never throws.
- **`src/utils/analytics-auth-status.ts`** — `markAnalyticsAuthInvalid(reason: string, baseUrl: string): Promise<void>` writes `~/.codemie/analytics-auth-status.json` via `getCodemiePath`, preserving the original `detectedAt` if a marker already exists; `getAnalyticsAuthStatus(): Promise<AnalyticsAuthStatus | null>` reads it (returns `null` if absent or `status !== 'invalid'`); `clearAnalyticsAuthStatus()` deletes it. All three are best-effort / never throw, by design (module header comment: "auth-status bookkeeping must never break metrics sending or hook processing"). Existing writers: `MetricsApiClient.sendMetric()` (`metrics-api-client.ts:90-93`, on `isAuthFailure` — same `(reason, baseUrl)` call shape the new plugin should match) and the SSO login flow (`sso.auth.ts:148`, clears on success); existing clearers also include `AgentCLI.ts:349-350`. Existing reader: only `sso.auth-gate.ts`'s `ensureCodeMieSsoAuth`.
- **`src/cli/commands/hook.ts`** (`enforceAnalyticsAuthGate`, lines ~561-600) — the actual `UserPromptSubmit` caller of `ensureCodeMieSsoAuth`. On `authResult.ok === false`, builds `message = [genericBanner, 'Reason: ' + authResult.reason, describeLogin(authResult.loginOutcome)].join('\n')` and either throws (programmatic/VSCode mode) or `process.exit(2)` with the message on stderr (CLI mode), **blocking the prompt before it is even forwarded to the proxy**. This fires once per prompt submission, not continuously — a session-expiry detected mid-stream by the proxy (this task) has no equivalent "block the next prompt" lever of its own; it relies on the shared marker file so the *next* `UserPromptSubmit` picks it up, and gains an *immediate* re-auth start (rather than waiting for that next hook invocation) only if the proxy plugin calls `startDetachedSsoLogin` itself.

### Architecture and Layers Affected

- **Provider/proxy plugin layer** (`src/providers/plugins/sso/proxy/plugins/`) — unchanged conclusion: the fix is a new `ProxyInterceptor` implementing `onUpstreamResponse`, registered like every other proxy plugin.
- **Core proxy orchestration** (`sso.proxy.ts`) — not expected to change.
- **Credential/auth module** (`sso.auth.ts`, `core/types.ts`) — read-only consumer of `SSOCredentials.expiresAt`, unchanged.
- **New: cross-process coordination layer** (`src/utils/analytics-auth-status.ts`, `src/providers/plugins/sso/sso.detached-login.ts`) — these two modules, plus the hook-layer caller (`sso.auth-gate.ts` / `hook.ts`), are not modified by this task but are now a load-bearing *integration point*: the new plugin becomes a second writer of the marker file and a second caller of `startDetachedSsoLogin`, alongside `MetricsApiClient` and `sso.auth-gate.ts` respectively. No code in either module needs to change to support this — both are already general-purpose, caller-agnostic utilities (plain `reason`/`baseUrl`/`codeMieUrl` string args, no caller-identity concept).

### Integration Points

- **Internal — credential state**: `PluginContext.credentials` (`SSOCredentials`, including `expiresAt`), unchanged from the first pass.
- **Internal — login URL resolution, now resolved**: the earlier open question "does the proxy plugin process have access to what it needs to resolve a login URL" is answered by `PluginContext.config.targetApiUrl` — the exact profile base URL already resolved once at CLI level and threaded into `ProxyConfig` before the proxy starts (`sso.proxy.ts` passes this same value to `getStoredPlatformCredentials` at startup). This is the proxy-plugin-layer equivalent of what `sso.auth-gate.ts` has to reconstruct from `CODEMIE_PROFILE_CONFIG`/`CODEMIE_URL` env vars (`getAnalyticsPlatformSource`/`getPlatformUrl` in `codemie-auth-helpers.ts`) — the proxy plugin's version is *more* direct (a resolved field on an in-memory config object, not env parsing), not less. No new config plumbing is needed to call `startDetachedSsoLogin(context.config.targetApiUrl)` or `markAnalyticsAuthInvalid(reason, context.config.targetApiUrl)`.
- **Internal — duplicate-login race, already handled**: `startDetachedSsoLogin`'s lock file lives at a fixed global path (`getCodemiePath('sso-login.lock')`), not scoped to a caller or process. Whether `startDetachedSsoLogin` is invoked from a one-shot `codemie hook` child process (the existing `UserPromptSubmit` path) or from inside the long-lived proxy daemon process (this task's new call site), both race for the *same* lock file; the loser gets `'in-progress'`/`'cooldown'` instead of spawning a second browser window. No additional de-dup logic is required in the new plugin — reusing `startDetachedSsoLogin` as-is already satisfies "avoid duplicate-login races with the hook."
- **Internal — module layering is clean**: `sso.detached-login.ts` imports only `node:fs`, `node:path`, `@/utils/paths.js`, `@/utils/processes.js`, `@/utils/logger.js`; `analytics-auth-status.ts` imports only `node:fs`, `@/utils/paths.js`, `@/utils/logger.js`. Neither imports anything from `providers/plugins/sso/proxy/` or any proxy-plugin module, so there is no circular-import risk importing them *into* `proxy/plugins/`. Both are already imported from multiple other layers (`sso.auth.ts`, `metrics-api-client.ts`, `AgentCLI.ts`, `sso.auth-gate.ts`, `hook.ts`) — cross-layer imports of these two specific utilities are an established pattern, not a new precedent.
- **External**: unchanged — oauth2-proxy's 302/303 + `Location: .../oauth2/start` signature; no existing code inspects `Location` headers.

### Patterns and Conventions

- Unchanged from the first pass (one `ProxyPlugin`/`ProxyInterceptor` pair per file, `createInterceptor()` guard-by-credential-shape, `tools.readBody`/`fromBuffer` discipline, Anthropic-shaped error JSON).
- **New**: the established `(reason: string, baseUrl: string)` call shape for `markAnalyticsAuthInvalid`, matched exactly by `MetricsApiClient`'s existing call (`metrics-api-client.ts:90-93`) — the new plugin's call should follow the same two-argument convention, e.g. `markAnalyticsAuthInvalid('oauth2-proxy redirected to /oauth2/start (expired SSO session)', context.config.targetApiUrl)`.
- **New**: `describeLogin(loginOutcome)` is the established way to turn a `DetachedLoginOutcome` into a user-facing hint string; reusing it in the synthesized 401 body's `message` field (instead of a hardcoded string) would keep the proxy-path message consistent with `hook.ts`'s block message for the same `loginOutcome`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No guide under `.ai-run/guides/` or `docs/` documents the proxy plugin pipeline's `onUpstreamResponse` contract, the analytics-auth-status marker/lock mechanism, or oauth2-proxy session-expiry handling. The nearest thing to documentation for the new angle is the PR #624 commit series itself (`349a15b3`, `677a5c8b`, `8080b878`, `e757ce5e`, `c8d9232b`, `d3e346ce` — visible in `git log`), whose commit messages describe hardening `startDetachedSsoLogin`'s lock semantics (unreadable-lock grace period, spawn-error handling, lock-creation race). Treat that commit series, plus the module header comments in `sso.detached-login.ts` and `analytics-auth-status.ts`, as the authoritative design rationale in place of a written guide.

### Architectural Decisions

- `types.ts` inline comments on `onUpstreamResponse`/`handleRequest` (unchanged) remain the rationale for choosing `onUpstreamResponse`.
- `analytics-auth-status.ts`'s header comment states the marker's cross-process contract explicitly: "Writers: MetricsApiClient marks the status invalid... Readers: the unified `codemie hook` UserPromptSubmit gate blocks the prompt..." — this is the only in-repo text describing the marker as a multi-writer, single-reader-pattern mechanism, and it predates and is agnostic to which component writes it, which is why adding the new plugin as a second writer requires no change to this module.
- `sso.detached-login.ts`'s header-level doc comment on `startDetachedSsoLogin` ("A lock file prevents concurrent sign-ins and enforces a cooldown after a failed attempt. Never throws.") is the explicit design statement that this function is meant to be safely called from multiple, uncoordinated call sites.

### Derived Conventions

See Patterns and Conventions above.

---

## 4. Testing Landscape

### Existing Coverage

- `src/providers/plugins/sso/proxy/__tests__/transparent-vscode-proxy.integration.test.ts` — reusable `CodeMieProxy` end-to-end scaffold (fake upstream `http.createServer`, real plugin registry, `fetch` assertions).
- `src/providers/plugins/sso/proxy/plugins/__tests__/copilot-encrypted-content-sanitizer.plugin.test.ts` / `codex-encrypted-content-sanitizer.plugin.test.ts` — unit-level template for a new `onUpstreamResponse` plugin test (hand-built `PluginContext`/`ProxyContext`, `vi.fn()`-based `UpstreamResponseTools`, `response(statusCode)` helper via `Readable.from([]) as IncomingMessage`).
- `src/providers/plugins/sso/proxy/plugins/__tests__/gateway-key.plugin.test.ts` — precedent for asserting the Anthropic-shaped 401 body via a mocked `ServerResponse`.
- **New: `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts`** — mocks `startDetachedSsoLogin` via `vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({ startDetachedSsoLogin: vi.fn() }))` and asserts the exact URL argument it was called with (e.g. `expect(startDetachedSsoLogin).toHaveBeenCalledWith(configured.ssoUrl)`), plus that it is *not* called when credentials are valid or an API key is set. This is the pattern a new caller (the proxy plugin's own test) should mirror: mock both `startDetachedSsoLogin` and `markAnalyticsAuthInvalid` as `vi.fn()` and assert call args, rather than letting them run for real.
- **New: `src/providers/plugins/sso/__tests__/sso.detached-login.test.ts`** — exercises the lock file semantics directly against a temp dir (`vi.mock('@/utils/paths.js', ...)` redirecting `getCodemiePath` to a `mkdtemp` directory, `vi.mock('@/utils/processes.js', ...)` for `spawnDetached`/`isProcessAlive`). Confirms two concurrent calls to `startDetachedSsoLogin` with the same lock resolve to exactly one `'started'` and one `'in-progress'`/`'cooldown'` — directly supports the "shared lock prevents duplicate logins across callers" conclusion above without needing a new test to prove it.
- **New: `src/utils/__tests__/analytics-auth-status.test.ts`** — pins `markAnalyticsAuthInvalid`/`getAnalyticsAuthStatus`/`clearAnalyticsAuthStatus`'s file-based contract (preserves `detectedAt` across repeated `markAnalyticsAuthInvalid` calls, overwritten `reason`/`baseUrl` on a new call with a different `baseUrl`).

### Testing Framework and Patterns

Vitest, `vi.fn()`/`vi.mock()`/`vi.hoisted()`, real in-process `http.createServer` for proxy integration tests, `mkdtemp` + real filesystem for lock/marker-file tests (not an in-memory fs mock).

### Coverage Gaps

- No existing test covers `onUpstreamResponse` reacting to a redirect/non-JSON response, or per-request `expiresAt` comparison — unchanged from the first pass.
- No existing test exercises `startDetachedSsoLogin`/`markAnalyticsAuthInvalid` being called *from the proxy plugin pipeline* (as opposed to from the hook/CLI layer) — this is new ground; the plugin's own unit test (following the `sso.auth-gate.test.ts` mocking pattern) is where this coverage needs to be added.
- No existing test exercises the cross-process race between a hook-triggered `startDetachedSsoLogin` call and a proxy-plugin-triggered one sharing the same lock file in the same test run — `sso.detached-login.test.ts`'s existing "two concurrent calls" test already proves the mechanism generically, so a plugin-specific race test is likely unnecessary duplication rather than a real gap.

---

## 5. Configuration and Environment

### Environment Variables

None specific to this feature. Proxy startup config (`targetApiUrl`, `syncCodeMieUrl`, `clientType`, `provider`, `profileConfig`) comes from `ProxyConfig`, already resolved before the proxy starts — no new env var is needed by the plugin to resolve a login URL (see Integration Points above).

### Configuration Files

No feature-specific config file. `~/.codemie/analytics-auth-status.json` (marker) and `~/.codemie/sso-login.lock` (lock) are the two existing runtime state files the new plugin will read/write/trigger, both already defined by pre-existing modules.

### Feature Flags and Deployment Concerns

None found. Gated only by `authMethod === AuthMethod.SSO` / `'cookies' in credentials`, unchanged.

---

## 6. Risk Indicators

- `expiresAt` is only ever set from the startup-time credential snapshot (`PluginContext.credentials`), never re-read from `CredentialStore` mid-session — unchanged risk from the first pass; the per-request check still compares against the same in-memory snapshot, not a freshly reloaded credential.
- No existing code anywhere matches `/oauth2/start` or inspects `Location` headers — the signature-matching logic and its tests are wholly new (unchanged).
- `tools.fromBuffer()` spreads `source.headers` and only forces `content-length`; a synthesized 401 must build its own header object or it will leak the original 302's `location`/`set-cookie`/`cache-control` (unchanged risk, already pinned by `plan.md`'s Review Focus and Task 1 tests).
- **New — reason-string specificity**: `MetricsApiClient`'s existing `markAnalyticsAuthInvalid` calls use HTTP-status-shaped reasons (e.g. `"HTTP 401: ..."`). The new plugin's reason should be similarly specific and distinguishable (e.g. naming the `/oauth2/start` redirect explicitly) — Speculative: a vague reason string (e.g. just `"session expired"`) would make the next `UserPromptSubmit` block message (`Reason: ${authResult.reason}`) harder to debug than the metrics-path equivalent, since the completions-path and metrics-path can both write this same marker and the hook/user can't currently tell which one fired.
- **New — immediate vs. next-prompt re-auth is additive, not required for correctness**: `ensureCodeMieSsoAuth`/`hook.ts` already re-trigger `startDetachedSsoLogin` on the *next* `UserPromptSubmit` purely from the marker file, even if the new plugin never calls `startDetachedSsoLogin` itself and only calls `markAnalyticsAuthInvalid`. Calling `startDetachedSsoLogin` directly from the plugin is valuable (starts the browser sign-in immediately instead of waiting for the user's next prompt) but is not load-bearing for the marker-propagation half of the fix — Speculative: if the plan separates these into two steps, the `markAnalyticsAuthInvalid` call is the higher-priority one; the `startDetachedSsoLogin` call is a UX improvement riding the same lock-file safety net the hook already relies on.
- **New — marker file is being given a second, differently-shaped writer**: today the marker's only writer (`MetricsApiClient`) is triggered by a failed outbound metrics POST (a `MetricsRequestError` with `isAuthFailure`); the new plugin would be triggered by an inbound signal on the completions path (a 302 to the model-proxy request) with no equivalent "retry attempts/backoff" wrapper around it. Speculative: nothing in `analytics-auth-status.ts` requires writers to agree on retry semantics (`markAnalyticsAuthInvalid` is a flat best-effort write), so this is not a blocker, but the plan should decide whether the new plugin's `onUpstreamResponse` call should write the marker on *every* confirmed-expired response in a session (fine, since `markAnalyticsAuthInvalid` preserves the original `detectedAt` and the write is idempotent/best-effort) or only once per proxy lifetime (an optimization, not a requirement).
- No layering or env-access blocker was found for calling `startDetachedSsoLogin`/`markAnalyticsAuthInvalid` from the proxy daemon process — `PluginContext.config.targetApiUrl` already supplies the login URL directly, and both target functions are plain, caller-agnostic, dependency-light utilities already imported from multiple other layers. This closes the explicit "flag clearly if..." concern raised in this task's instructions: there is no blocker to flag.

---

## 7. Summary for Complexity Assessment

The core fix remains a single, well-isolated change to the proxy plugin pipeline (`src/providers/plugins/sso/proxy/plugins/`), using the pre-existing `onUpstreamResponse` hook, with `gateway-key.plugin.ts` and the two encrypted-content-sanitizer plugins as direct structural templates, and `SSOCredentials.expiresAt` already available via `PluginContext.credentials` with no new credential-loading path required. The PR #624 integration adds exactly two new calls inside the same detection branch — `markAnalyticsAuthInvalid(reason, context.config.targetApiUrl)` and `startDetachedSsoLogin(context.config.targetApiUrl)` — both already-stable, already-tested, caller-agnostic utility functions with no proxy-specific wiring required: `PluginContext.config.targetApiUrl` supplies the login URL directly (more directly than the hook layer's own env-based resolution), and the shared lock file at `~/.codemie/sso-login.lock` already arbitrates races between this new call site and the pre-existing `UserPromptSubmit` hook call site without any new code.

Novelty is moderate and narrow: the `/oauth2/start` + `Location` signature-matching is new (as before), but the re-auth integration itself is "call two existing, well-tested, side-effect-only functions with arguments already available on `PluginContext`" — not a new subsystem, not a new cross-process protocol. Test coverage posture: strong existing precedent on both sides of the integration (`copilot-encrypted-content-sanitizer.plugin.test.ts` for the plugin side, `sso.auth-gate.test.ts`'s `vi.mock('@/providers/plugins/sso/sso.detached-login.js', ...)` pattern for mocking the new calls, `sso.detached-login.test.ts` for the lock-race guarantee). No blocker was found for the task's explicit concern about proxy-daemon-process env/layering access — this should be reflected in the plan as resolved, not as an open risk requiring further investigation. The main remaining design choices are the exact reason-string wording and whether to call `startDetachedSsoLogin` unconditionally on every confirmed-expiry detection or only once per proxy lifetime, both minor and resolvable by the plan/implementer.

---

## 8. External References

- `docs/superpowers/investigations/2026-10-13-EPMCDME-15316-findings.md` — resolved and read in full this pass (a prior version of this document incorrectly reported this path as missing; it exists and was used as the Issue 1 problem statement, quoted in Section 1). Key facts used: the confirmed real-backend repro of a `302` to `https://codemie.lab.epam.com/oauth2/start?rd=...` with a 138-byte nginx body; the "firm signal = 302/303 + `/oauth2/start`, not firm = bare 200/401/403 HTML, actively wrong = 5xx HTML with no redirect" classification; and the recommendation to merge fix 2 (redirect detection) with fix 3 (expiry check) rather than implement HTML-sniffing alone.
- `src/providers/plugins/sso/sso.auth-gate.ts`, `src/providers/plugins/sso/sso.detached-login.ts`, `src/utils/analytics-auth-status.ts` — the three modules the task named explicitly for re-research; all read in full this pass (current, post-merge content). Exact signatures, call shapes, and lock/marker semantics are captured in Section 2 above.
- `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts`, `src/providers/plugins/sso/__tests__/sso.detached-login.test.ts` — the task's "existing tests whose patterns a new caller should follow" ask; both read in full, patterns captured in Section 4.
- No other external (outside-repo) path was named by the task.
