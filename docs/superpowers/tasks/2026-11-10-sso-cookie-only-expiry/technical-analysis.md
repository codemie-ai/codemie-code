# Technical Research

**Task**: sso auth credentials expiry (EPMCDME-17014)
**Generated**: 2026-11-10
**Research path**: filesystem

---

## 1. Original Context

[CodeMie CLI][SSO] Cookie-only SSO credentials are deleted after a fixed 24 h local expiry while the server session is still valid: the next prompt opens a browser sign-in that returns the same cookie.

Description: On Production, an SSO login stores only the _oauth2_proxy cookie (no codemie_access_token, see EPMCDME-16776). deriveExpiresAt (src/providers/plugins/sso/sso.auth.ts:46-64) can then not read a JWT exp and falls back to a fixed Date.now() + 24h (DEFAULT_TTL). CodeMieSSO.getStoredCredentials (sso.auth.ts:214-217) treats that synthetic time as the real expiry: after it the credential is deleted from the store (store.clearSSOCredentials(url)) and null returned, although the server-side oauth2-proxy session is still valid (144 h on Production). Next reader finds no credentials: proxy daemon (sso.proxy.ts) logs "SSO credentials not found"; Claude Code UserPromptSubmit hook gate (sso.auth-gate.ts ensureCodeMieSsoAuthOrWait -> ensureCodeMieSsoAuth -> startDetachedSsoLogin -> sso-login -> CodeMieSSO.authenticate) opens the browser. The browser still has the valid session so sign-in completes in ~2 s returning the same cookie. The sign-in callback (handleCallback) receives cookie names and values only, so the CLI never learns the server's cookie expiry. Also `codemie assistants chat` / sdk-client credential load prints "No valid SSO credentials found ... Please run: codemie profile login", which makes agents start a login.

Expected: a stored SSO credential is not deleted, and no browser sign-in started, while the server still accepts it. When the client cannot know the real expiry (cookie-only credentials), it must not invent one that ends the session early; expiry is detected from server rejection (oauth2-proxy redirect, 401/403), which the proxy and hook gate already handle. When session really expires, one sign-in recovers it (existing lock and cooldown behaviour).

Required regression tests (to be planned):
1 Unit (sso.auth.ts): stored cookie-only (_oauth2_proxy) credential signed in 24h+1min ago, server still valid -> getStoredCredentials returns it, store not cleared, no client-invented earlier expiry.
2 Integration (hook gate + detached login, mocked CodeMie API): same credential >24h old, API accepts -> ensureCodeMieSsoAuthOrWait ok; startDetachedSsoLogin/browser not called.
3 Integration: API answers with oauth2-proxy sign-in redirect (or 401) -> exactly one detached sign-in started; after success prompt proceeds with no second browser launch.
4 Integration (codemie assistants chat / sdk-client credential load, mocked API): stored cookie-only credential 24h+1min old, API accepts -> command reaches API and succeeds, no "No valid SSO credentials found", credential not deleted.
5 Unit (deriveExpiresAt / credential store): callback returning only _oauth2_proxy -> stored credential carries no client-invented expiry earlier than server's (no fixed Date.now()+24h).

Comment context (QA): a 2026-11-04 sign-in via the local proxy URL stored its credential under the loopback key (http://localhost:53485) rather than Production key; not reproduced on 0.16.6, not part of this ticket. Related, not duplicates: EPMCDME-16776, 16568, 16737. Not required: concurrent duplicate sign-ins.

Research focus: all readers/writers of stored SSO credentials and expiresAt, how server rejection is handled, how expiresAt is consumed (including JWT-bearing credentials), existing tests/mocking patterns.

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: a stored SSO credential stays usable while the server accepts it.
- Writer of `expiresAt`: `deriveExpiresAt` `src/providers/plugins/sso/sso.auth.ts:46-64` — JWT `codemie_access_token` `exp*1000` if decodable, else `Date.now()+24h`. Only caller: `authenticate()` `sso.auth.ts:139-143`, then `CredentialStore.storeSSOCredentials` (`src/utils/security.ts:457`, keychain + encrypted file, key from `deriveUrlStorageKey`). Exported; tests import it.
- Enforcer (the only deleting reader): `CodeMieSSO.getStoredCredentials` `sso.auth.ts:187-221` — `Date.now() > expiresAt` -> `store.clearSSOCredentials(url)` + return null (`:215-217`). `expiresAt` falsy = never expires (so an absent field already passes). Also deletes only the lookup `url` key (plus its legacy key, `security.ts:509-522`).
- Callers of `getStoredCredentials` (all inherit the deletion): `codemie-auth-helpers.ts:210` (`lookupStoredCredentials`, used by `getStoredPlatformCredentials`, `getStoredAnalyticsCredentials`, sdk-client, gate, proxy), `:438` (`resolveProjectListAuth`), `sso.models.ts:63,122`, `proxy/sso.proxy.ts:111`, `otlp-spool/auth-state.ts:46`, `agents/core/hook-credentials.ts:27,29` (its doc notes the clearing side effect), `cli/commands/test-metrics.ts:97`, `proxy/inspect-desktop.ts:128`, `proxy/connectors/managed-mcp-remote.ts:134`, `skills/lib/skills-metrics.ts:371`, `telemetry/runtime/DesktopSessionMetrics.ts:60`. `codemie-auth-helpers.ts:231` comments "an expired credential is deleted by getStoredCredentials".
- Other consumers of `expiresAt` on SSO credentials (non-deleting): `sso.health.ts:87-110` (error "SSO session expired" if past, else "Session expires in N hour(s)"); `sso.setup-steps.ts:284` (validateAuth result) and `:360` (getAuthStatus -> `profile/display.ts:133`, `utils/profile.ts:90-97` which shows remaining time via `Math.max(0, ...)`).
- JWT (separate type) `expiresAt`: `jwt-auth.plugin.ts:45` throws "JWT token expired"; `security.ts:624,643` `retrieveJWTCredentials` returns null; `jwt.setup-steps.ts:240`; `JWTAuthCheck.ts:74`. Distinct store/type from SSO cookies; not touched by `deriveExpiresAt`.
- `handleCallback` `sso.auth.ts:342-399`: decodes base64 `token.cookies` only; fetches `/config.js` for apiUrl; returns `{success, apiUrl, cookies}` — no expiry information.

Purpose B: server rejection triggers recovery (one sign-in).
- Proxy: `proxy/plugins/sso-session-expiry.plugin.ts` — acts on 302/303 to `/oauth2/start` alone (header comment: independent of local `exp`); writes marker via `markAnalyticsAuthInvalid`, calls `startDetachedSsoLogin`, returns synthetic Anthropic-shaped 401; replays once if request used superseded cookies. Header documents KNOWN GAP: plain 401 and HTML 200 bypass this plugin (metrics path handles 401/403/HTML in `session/analytics-auth-marker.ts` / metrics-api-client; OTLP forwarder handles 401/403). No shared `isSessionRejection()`.
- `proxy/plugins/credential-refresh.ts:34-105` — `CredentialRefresher` re-reads store at most every 5 s; deliberately not gated on `expiresAt` (comment lines 77-83); triggers on sign-in lock stamp or marker invalid->cleared edge.
- Hook gate: `sso.auth-gate.ts` `ensureCodeMieSsoAuth` `:128-186` is "cheap, local-only": `hasValidAuth = Boolean(apiKey)` or `Boolean(found?.credentials.cookies)` from `getStoredAnalyticsCredentials` (`:146-156`); no network probe. Starts `startDetachedSsoLogin(loginUrl)` (`:173-174`) when no creds (reason "no valid CodeMie SSO credentials found") or an applicable marker exists (reason "metrics endpoint rejected..."). Markers older than last sign-in are dropped (`dropMarkerOlderThanSignIn` `:98-117`). `ensureCodeMieSsoAuthOrWait` `:193-212` waits via `waitForDetachedSsoLogin` and re-checks. Lock/cooldown lives in `sso.detached-login.ts` (not read in depth).
- Server rejection never clears stored credentials: `clearSSOCredentials`/`clearStoredCredentials` callers are only `getStoredCredentials` (expiry) and `cli/commands/profile/auth.ts:115,146` (logout).
- sdk-client: `src/utils/sdk-client.ts:~42-110` — `getStoredPlatformCredentials(config)`; if no cookies/apiUrl -> `spinner.fail('No valid SSO credentials found')` and throws `ConfigurationError('SSO authentication required. Please run "codemie setup" ...')`. It does not probe the API when creds exist (creates `CodeMieClient` with cookies). `fetchCodeMieUserInfo` (`codemie-auth-helpers.ts:298-339`) throws on 401/403 ("Authentication failed - invalid or expired credentials"). Note: the literal "Please run: codemie profile login" text was not found in sdk-client.ts; `auth-validation.test.ts:48` uses "No valid SSO credentials found." (search `grep "No valid SSO credentials" src`: sdk-client.ts:67 and that test only). Assistants-chat path to this loader not traced.

Other touched code: `src/providers/core/types.ts` `SSOCredentials` (optional `expiresAt`, ~l.462/476), `src/utils/credential-crypto.ts` (`normalizeUrlForKey`).

### Decisions Already in the Code
- Optional `expiresAt` already means "unknown/never" at the enforcer (`sso.auth.ts:215`: `credentials.expiresAt &&`). Convention for JWT too (`security.ts:624`).
- Expiry vs. server rejection: credential-refresh and session-expiry plugin explicitly chose redirect signature over local `exp` (recorded rationale: server-side revoke does not change JWT `exp`; live repro 2026-10-16).
- Gate is intentionally local-only, no network probe per prompt (`sso.auth-gate.ts:119-127`).
- Delete-on-read: expiry cleanup is a side effect of every read, noted at `hook-credentials.ts:17`. Reason for 24h default: none found.
- Stored shape written `{cookies, apiUrl, expiresAt}` (always sets `expiresAt` today), `sso.auth.ts:139-143`.

### Task Statements Checked Against the Code
- "deriveExpiresAt falls back to Date.now()+24h" — holds (`sso.auth.ts:47,63`).
- "getStoredCredentials deletes and returns null" — holds (`:215-217`); lines match the ticket.
- "callback receives cookie names and values only" — holds (`handleCallback` `:359-391`).
- "Proxy daemon logs 'SSO credentials not found'" — holds, `sso.proxy.ts:~100-104` throws AuthenticationError "SSO credentials not found for ..." (the debug log at `:114` is the sync-only variant).
- "Hook gate opens browser via startDetachedSsoLogin" — holds (`sso.auth-gate.ts:173-174`).
- "expiry detected from server rejection (redirect, 401/403), which proxy and hook gate already handle" — partly contradicted: proxy plugin handles only the 302/303 `/oauth2/start` redirect (own header lists plain 401 as KNOWN GAP); the gate does not observe the API at all, it reads the marker written by the proxy plugin / metrics client / OTLP forwarder (`markAnalyticsAuthInvalid` writers: sso-session-expiry.plugin, analytics-auth-marker, analytics-auth-status). 401/403 handling exists on the metrics and OTLP paths only.
- "'Please run: codemie profile login' printed by assistants chat/sdk-client" — unverified/partly contradicted: sdk-client message is 'Please run "codemie setup"'; `profile login` text appears in proxy and health hints (`sso.health.ts:91`).
- "Production oauth2-proxy session 144 h, no codemie_access_token" — unverified (server-side; nothing in repo confirms).
- Test 2/3 premise "mocked CodeMie API": the gate has no API call (see above) — contradicted as stated for the gate itself; the API response reaches it only via marker/proxy.
- Non-goal QA loopback-key note — holds that `lookupStoredCredentials` exempts loopback baseUrls (`codemie-auth-helpers.ts:202-205`); not otherwise examined.

### Consumers of Changed Contracts
Contract: `SSOCredentials.expiresAt` semantics and `getStoredCredentials` delete-on-expiry.
- Readers listed under Purpose A (13 `getStoredCredentials` callers). `sso.health.ts:87` flags credentials with past `expiresAt` as unhealthy independently of the store (still gets a stored, past-expiry credential only if one exists). `utils/profile.ts:90-97` and `display.ts:133` treat absent `expiresAt` by skipping the display (`if (expiresAt)`), `sso.health.ts:101-105` skips the hours line when absent.
- Existing stored credentials already on disk carry a synthetic `expiresAt` (24h) — readers see them with the field set.
- Tests asserting the 24h fallback: `sso/__tests__/sso.auth.test.ts:24-42` (two cases) — contradicted by a "no invented expiry" change.
- `deriveExpiresAt` exported; only importer outside sso.auth.ts is that test (grep src, tests).

### Architecture and Layers Affected
Providers/SSO plugin (`sso.auth.ts`), core credential helpers (`codemie-auth-helpers.ts`), utils store (`security.ts`), proxy plugins (session-expiry, credential-refresh), hook gate (`sso.auth-gate.ts`, `hook-credentials.ts`), utils `sdk-client.ts`, CLI profile/health display.

### Integration Points
`open` browser, local callback http server, `/config.js` fetch, keytar/file store, `sso.detached-login.ts` lock, `analytics-auth-status` marker file, oauth2-proxy `/oauth2/start` redirect, `/v1/user`.

### Patterns and Conventions
ES modules with `.js` imports and `@/` alias; singleton `CredentialStore.getInstance()`; dynamic import of `CodeMieSSO` in helpers; `logger.debug`; specific error classes (`ConfigurationError`, `AuthenticationError`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` present: architecture, integration/external-integrations, testing/testing-patterns, development-practices, security (not read in depth; none covers SSO expiry). Design notes live in header comments (session-expiry plugin, credential-refresh).

### Architectural Decisions
Recorded only inline (session-expiry plugin header, credential-refresh doc, gate docstring). No ADR found.

### Derived Conventions
Optional `expiresAt` = unknown; marker + lock for rejection; Vitest with `vi.mock` of module paths.

---

## 4. Testing Landscape

### Existing Coverage
- `sso/__tests__/sso.auth.test.ts` — only `deriveExpiresAt` (3 cases); no `getStoredCredentials` test found.
- `sso/__tests__/sso.auth-gate.test.ts`, `.lock.test.ts`, `.marker.test.ts`, `sso.detached-login.test.ts` — gate behaviour.
- `utils/__tests__/sdk-client.test.ts` — credential lookup, mocks `ora`, `codemie-sdk`, config, logger, `sso.auth.js`.
- `core/__tests__/codemie-auth-helpers.test.ts`, `auth-validation.test.ts`, `sso.health.test.ts`, `sso.setup-steps.test.ts`, `agents/core/__tests__/hook-credentials.test.ts`, `proxy/plugins/__tests__/` (session-expiry, credential-refresh presumed).

### Testing Framework and Patterns
Vitest; module-level `vi.mock` (gate test mocks `sso.auth.js`, `analytics-auth-status.js`, `sso.detached-login.js`, logger); `vi.mocked(...).mockResolvedValue`. Dynamic-import mocking per testing-patterns guide.

### Coverage Gaps
No test of `getStoredCredentials` expiry/clearing; no test spanning real store + gate; no assistants-chat test located; gate tests mock `sso.auth.js` entirely so required test 2 would need a store-level or `getStoredCredentials`-real setup.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_INSECURE` (sdk-client), `CODEMIE_PROFILE_CONFIG` (gate/profile source), `CODEMIE_SESSION_ID`, `CODEMIE_DEBUG`.

### Configuration Files
Profile config via ConfigLoader; credentials in `CREDENTIALS_DIR` `*.enc` files and keychain (`security.ts`).

### Feature Flags and Deployment Concerns
None found for expiry. Credentials are machine-key encrypted (AES-256-CBC).

---

## 6. Risk Indicators

- Deletion is centralised in one read path used by 13 callers; any change to it affects proxy, hooks, desktop, skills and model fetch alike.
- Already-stored credentials carry a synthetic `expiresAt`; Speculative: a fix limited to `deriveExpiresAt` leaves those on disk still expiring.
- Rejection detection is incomplete: plain 401 bypasses the session-expiry plugin (KNOWN GAP in its header), and the gate is local-only with no API call, so tests 2/3 as phrased do not map onto a gate network call (see Task Statements).
- Three independent classifiers of "session rejected" with no shared helper (plugin header).
- `sso.health.ts:87` and `jwt-auth.plugin.ts:45` treat past `expiresAt` as hard failure; JWT-bearing SSO creds with a real `exp` follow the same paths as cookie-only ones.
- `sso.auth.test.ts` asserts the 24h fallback and would fail on any change.
- Speculative: removing local expiry with no server check makes a revoked credential persist until a proxy/metrics rejection marks it; the gate only reacts to markers.
- Existing mechanism for the same purpose kept in place by the ticket's stated approach ("proxy and hook gate already handle" rejection): see Purpose B subsection.
- Loopback-key storage (QA note) is adjacent and explicitly out of scope.

---

## 7. Summary for Complexity Assessment

The defect sits in two small spots in `src/providers/plugins/sso/sso.auth.ts` (`deriveExpiresAt` write at :63 and the delete-on-read at :215-217), but the contract they define (`SSOCredentials.expiresAt` plus clearing on read) is consumed by about 13 callers through `getStoredCredentials` and by health/profile display. Layers: SSO provider plugin, utils credential store, core auth helpers, proxy plugins, hook gate, sdk-client. The change surface for the code itself looks small; the test surface is larger.

No novel patterns; the existing optional-`expiresAt`-means-unknown convention, marker, lock and cooldown mechanisms already exist. Rejection handling is partial: only the oauth2 redirect is handled in the proxy, 401 is a documented gap there, and the hook gate performs no network call, which affects how the required integration tests 2 and 3 can be framed.

Test posture: the SSO gate, detached-login, sdk-client and helper modules have Vitest coverage with module mocks; `getStoredCredentials` expiry has none, and assistants-chat has no located test. Main risks: stale on-disk credentials with synthetic expiry, shared reader blast radius, unified rejection handling being absent.

---

## 8. External References

None named by the task (Jira tickets EPMCDME-16776/16568/16737 referenced by id only; not accessible from the filesystem).
