# Technical Research

**Task**: sso auth headless login
**Generated**: 2026-11-24
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16958 (Bug, Major) — "Add non-interactive/device-code SSO login flow for headless machines without a local browser".

Summary: There is no non-interactive authentication mode for machines with no browser (e.g. Raspberry Pi).
Root cause (confirmed on main): `authenticate()` in `src/providers/plugins/sso/sso.auth.ts` always spawns a local HTTP callback server then unconditionally opens a local browser. There is no `--no-browser`/headless/device-code flag anywhere (`src/cli/commands/profile/auth.ts`, `src/bin/sso-login.ts`). The OAuth redirect must land on `localhost:<port>` of the same machine that initiated login, so printing the URL does not help on a headless box.
Requested behavior: A non-interactive authentication flow: print a URL to authenticate from any device, then accept a token pasted back on the headless machine.
Reference: GitHub issue https://github.com/codemie-ai/codemie-code/issues/229

---

## 2. Codebase Findings

### Existing Implementations

Purpose: sign in to CodeMie SSO from a machine with no browser.
- None found. Searched src (non-test) for `--no-browser`, headless, device code, `DISPLAY`, `isHeadless`: no relevant hits.

Purpose: browser-based SSO login (the only flow today).
- `src/providers/plugins/sso/sso.auth.ts:74-182` `CodeMieSSO.authenticate(config)`: starts local server on ephemeral port (`startLocalServer`, :239, `listen(0)`), builds `${ensureApiBase(url)}/v1/auth/login/${port}` (:116-117), opens browser (win32: `explorer.exe` spawn; else `open` pkg, :126-132), polls `callbackResult` every 100 ms until timeout (default 120000) or abort (:409-449). Prints the URL as "If browser does not open, visit" unless `quiet`.
- `sso.auth.ts:347-404` `handleCallback(url)`: reads `token`/`auth`/`data` query param (fallback regex on decoded search), base64-decodes to JSON, requires `token.cookies`, tries `GET {apiUrl}/config.js` with cookies to resolve `VITE_API_URL`, returns `{success, apiUrl, cookies}`. This parse-and-resolve logic is private and coupled to the HTTP request; a pasted token would carry the same base64 payload (the callback payload shape), which is not verified for a paste path.
- `sso.auth.ts:141-156` on success: `deriveExpiresAt(cookies)` (:48), `CredentialStore.storeSSOCredentials(credentials, codeMieUrl)` (`src/utils/security.ts`), `withVerifiedOwner`, `clearAnalyticsAuthStatus`. Signal handlers SIGINT/SIGTERM abort (:90-109).
- Types: `SSOAuthConfig {codeMieUrl, timeout?, quiet?}` and `SSOAuthResult` at `src/providers/core/types.ts:413-429`.

Callers of `authenticate()` (non-test) — all pass no mode option:
- `src/cli/commands/profile/auth.ts:14-29,65-103` `codemie profile login --url <url>` (only option `--url`; ora spinner "Launching SSO authentication..."); `handleRefresh` (:125-149) clears creds then calls `handleLogin(url)`.
- `src/bin/sso-login.ts:22` detached process, `parseArgs` with only `--url`, `quiet: true`, 120 s; spawned by `src/providers/plugins/sso/sso.detached-login.ts:373` (auth gate for hooks/daemon); lock handling in `sso.login-lock.ts`.
- `src/providers/core/codemie-auth-helpers.ts:90-100` `authenticateWithCodeMie(url, timeout)` (dynamic import).
- `src/providers/plugins/sso/sso.setup-steps.ts:304-307` re-auth during `codemie setup`.

Other touched code: `src/cli/commands/profile/index.ts:48` registers login command.

### Decisions Already in the Code
- Callback transport: loopback HTTP server on ephemeral port, port embedded in the login URL path (`/v1/auth/login/{port}`) — `sso.auth.ts:113-117`; alternative (server-side polling/device code) not present; reason none found. The server endpoint contract lives outside this repo.
- Credentials are cookie-based (`SSOCredentials {cookies, apiUrl, expiresAt?}`), stored keyed by normalized base URL (`sso.auth.ts:149-151`).
- Windows opens browser via `explorer.exe` deliberately (comment :127-128).
- `quiet` suppresses stdout banners for callers with stdout contracts (types.ts:416).
- Conventions (AGENTS.md): ESM with `.js` imports, `@/` alias, `logger` not console in libs, project error classes, no tests unless requested.

### Task Statements Checked Against the Code
- "`authenticate()` always spawns a local HTTP callback server then unconditionally opens a browser": holds (`sso.auth.ts:113,126-132`).
- "No `--no-browser`/headless/device-code flag in `profile/auth.ts`, `sso-login.ts`": holds (only `--url` in both).
- "Redirect must land on localhost:<port> of the same machine": holds for the client side (port in URL, loopback server); server-side behavior is outside this repo — unverified (what would settle it: backend `/v1/auth/login/{port}` implementation or issue #229).
- "Accept a token pasted back": the callback token format is base64 JSON with `cookies` (`sso.auth.ts:350-368`); whether the backend offers a displayable token for a non-loopback login is unverified (backend outside repo; issue #229 not read, no network access used).

### Consumers of Changed Contracts
- `SSOAuthConfig`: constructed in `profile/auth.ts:79`, `sso-login.ts:22`, `codemie-auth-helpers.ts:96`, `sso.setup-steps.ts:307`; mocked in many tests (`vi.mock('.../sso.auth.js')` in agents/plugins tests, `src/bin/__tests__/sso-login.test.ts`). Adding optional fields leaves these unchanged.
- `SSOAuthResult` consumed at the same call sites.
- `CodeMieSSO.authenticate` storage side effects relied on by `hook-credentials.ts:26`, `credential-owner.ts` (`withVerifiedOwner`), auth gate (`sso.auth-gate.ts`).
- Other `CodeMieSSO` users are `getStoredCredentials`/`clearStoredCredentials` only.

### Architecture and Layers Affected
- CLI (`src/cli/commands/profile/auth.ts`) -> Provider plugin (`src/providers/plugins/sso/sso.auth.ts`) -> core types (`src/providers/core/types.ts`) -> utils credential store (`src/utils/security.ts`). Also entry `src/bin/sso-login.ts` and setup steps.

### Integration Points
- CodeMie backend `/v1/auth/login/{port}` and `/config.js`; OS keychain via `CredentialStore`; `open` package; Node `http`.

### Patterns and Conventions
- Class `CodeMieSSO` with private helpers; config object with optional flags; `quiet` flag pattern; `commander` commands with `.option`; `ora` spinner + chalk output.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` referenced by AGENTS.md (architecture, external-integrations, project-config, security-practices); not read in detail. `docs/ARCHITECTURE-PROXY.md` exists per AGENTS.md. No doc found describing a headless flow.

### Architectural Decisions
- None found for SSO login transport.

### Derived Conventions
- See Patterns above.

---

## 4. Testing Landscape

### Existing Coverage
- `src/providers/plugins/sso/__tests__/sso.auth.test.ts`: `deriveExpiresAt`, `effectiveExpiresAt`, `getStoredCredentials`, `authenticate` storage (mocks `security.js`, `open`, `analytics-auth-status`, `credential-owner`).
- `src/bin/__tests__/sso-login.test.ts`; `sso.auth-gate*.test.ts` (gate, lock, marker, integration).
- `tests/helpers/sso-auth.ts`: integration helper writing an SSO profile.

### Testing Framework and Patterns
- Vitest; `vi.mock` of modules, dynamic imports after setup.

### Coverage Gaps
- No tests for `profile/auth.ts` login command found; no tests for `handleCallback` parsing in isolation found (only via `authenticate`).

---

## 5. Configuration and Environment

### Environment Variables
- None related to browser/headless found. `CODEMIE_DEBUG` for debug logging.

### Configuration Files
- Profiles via ConfigLoader (`getPlatformUrl(config)` resolves URL).

### Feature Flags and Deployment Concerns
- None found.

---

## 6. Risk Indicators

- `handleCallback` and server/page code are private and intertwined in `sso.auth.ts` (472 lines); `authenticate()` has a single hard-wired flow.
- Speculative: backend support for non-loopback login/token display is outside this repo and unverified; the pasted-token contract may depend on it.
- Speculative: four call sites plus the detached `sso-login.ts` (stdout/quiet contract, lock handling) would need a decision on whether they take the new mode.
- Pasted token carries session cookies; security guide (credential/logging sanitization, `sanitizeLogArgs`) applies to any prompt/echo handling.
- Existing tests mock `CodeMieSSO` widely; `sso.auth.test.ts` mocks `open`.
- Headless detection does not exist; none of `DISPLAY`/TTY checks are present.

---

## 7. Summary for Complexity Assessment

The change sits in a small vertical: CLI login command (`profile/auth.ts`), the `CodeMieSSO.authenticate` method in `sso.auth.ts`, and the `SSOAuthConfig` type. Only one login flow exists (loopback server + browser); nothing for headless use exists, and the token parsing in `handleCallback` is the existing reusable piece. Call sites: four non-test callers plus the detached `sso-login` entry.

Technical novelty is moderate: a paste-token prompt flow is new to this module, and its dependency on backend behavior (outside the repo, issue #229 not read) is unverified. No new third-party packages are evidenced as required; `open`, `http`, `inquirer`/`ora` already used.

Test posture: a unit test file exists for `sso.auth.ts` with established mocks; command-level tests for login are absent. Key risks are the unverified backend contract and secret handling of the pasted token.

---

## 8. External References

None named by the task as a path. The GitHub issue URL (https://github.com/codemie-ai/codemie-code/issues/229) was not fetched (outside the repository; unresolved for this filesystem pass).
