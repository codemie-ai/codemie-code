# Cookie-only SSO credentials do not expire locally (EPMCDME-17014) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Stop deleting cookie-only SSO credentials on a client-invented 24h expiry; detect real expiry from server rejection (redirect or session-shaped 401).

**Architecture:** One helper `effectiveExpiresAt` owns the "no `codemie_access_token` means no expiry" rule and is called by every TS reader. `deriveExpiresAt` stops inventing a TTL. A small module holds `isSessionRejection401`, used by `sso-session-expiry.plugin.ts` with an in-memory identical-cookie loop guard.

**Tech Stack:** TypeScript ESM (`.js` import extensions, `@/` alias), Vitest with module mocks and dynamic imports, `logger` (never console).

**Spec:** `docs/superpowers/tasks/2026-11-10-sso-cookie-only-expiry/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- Cookie-only = cookies without `codemie_access_token`; never expired, never deleted, no remaining time shown. JWT-bearing credentials behave as today.
- No migration of stored data; no change to JWT-type credentials (`jwt-auth.plugin.ts`, `security.ts` JWT paths).
- 403 is never session rejection. Hook gate stays local-only (no network probe). Lock and cooldown unchanged.

## Review Focus

- Legacy on-disk cookie-only credential with a past synthetic `expiresAt`: still returned, not deleted (Tasks 1, 2).
- JWT credential with past `exp`: still deleted/expired (Tasks 2, 3, 4).
- Non-session 401 repeating after a sign-in returned identical cookies: no loop (Task 5).
- User ignores the browser tab on a dead session: 401 with identical cookies but no completed sign-in still recovers (Task 5).
- Suppressed 401 returns the untouched original response, body not consumed (Task 5).
- `analytics-cli.js` mirror drifting from the helper (Task 4).

---

### Task 1: Write the AC2 and AC4 regression tests and record them failing on pre-fix code

**Files:**
- Test: `src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts` (create; real `getStoredCredentials`, mocked `CredentialStore`, marker module, `sso.detached-login.js`); `src/utils/__tests__/sdk-client.test.ts` (add case)

- [ ] **Step 1: Write tests** (Test-first: yes — AC2: cookie-only credential stored 24h+1min ago, no marker: `ensureCodeMieSsoAuthOrWait` ok, `startDetachedSsoLogin` and `open` not called, `clearSSOCredentials` not called. AC4: `sdk-client` credential load with the same stale credential: client created with cookies, no "No valid SSO credentials found" failure, `clearSSOCredentials` not called).
- [ ] **Step 2:** Run `npx vitest run src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts src/utils/__tests__/sdk-client.test.ts`; expect FAIL on the new cases. Record the failing output in the task notes before moving on; these tests must be red on the unmodified code. They turn green by Task 2.

### Task 2: Remove invented expiry; add `effectiveExpiresAt`; fix `getStoredCredentials`

**Files:**
- Modify: `src/providers/plugins/sso/sso.auth.ts` (`deriveExpiresAt` :46-64, `authenticate` :139-143, `getStoredCredentials` :214-218)
- Test: `src/providers/plugins/sso/__tests__/sso.auth.test.ts` (replace the two 24h-fallback cases at :24-42; add `getStoredCredentials` cases)

**Interfaces:**
- Produces: `export function effectiveExpiresAt(credentials: { cookies: Record<string, string>; expiresAt?: number }): number | undefined`, returns `expiresAt` only if `cookies.codemie_access_token` is present.
- `deriveExpiresAt` returns `number | undefined` (undefined without a decodable JWT `exp`).

- [ ] **Step 1: Failing tests** (Test-first: yes — cookie-only credential stored 24h+1min ago is returned by `getStoredCredentials`, `clearSSOCredentials` not called; callback with only `_oauth2_proxy` stores no `expiresAt`; `effectiveExpiresAt` undefined for cookie-only incl. legacy synthetic value, stored value for JWT-bearing; JWT-bearing past-`exp` credential is cleared and null returned). Follow the existing mocking style for `CredentialStore.getInstance`.
- [ ] **Step 2:** Run `npx vitest run src/providers/plugins/sso/__tests__/sso.auth.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement: drop the `Date.now()+24h` fallback and DEFAULT_TTL; omit `expiresAt` from the stored object when undefined; add `effectiveExpiresAt`; in `getStoredCredentials` compare `Date.now()` against `effectiveExpiresAt(credentials)` only.
- [ ] **Step 4:** Run the same command plus the Task 1 files; expect PASS.

### Task 3: Use the helper in health and setup-steps readers

**Files:**
- Modify: `src/providers/plugins/sso/sso.health.ts:87-110`, `src/providers/plugins/sso/sso.setup-steps.ts` (`validateAuth` ~:284, `getAuthStatus` ~:360)
- Test: `sso/__tests__/sso.health.test.ts`, `sso/__tests__/sso.setup-steps.test.ts`

**Interfaces:** Consumes `effectiveExpiresAt` from Task 2.

- [ ] **Step 1: Failing tests** (Test-first: yes — cookie-only credential with past `expiresAt`: health reports no "SSO session expired" and no hours line; both `authStatus.expiresAt` values undefined; JWT-bearing past credential still reports expired).
- [ ] **Step 2:** Run both test files; expect FAIL.
- [ ] **Step 3:** Replace direct `credentials.expiresAt` reads with `effectiveExpiresAt(credentials)`. `utils/profile.ts` and `profile/display.ts` stay untouched.
- [ ] **Step 4:** Run both files; expect PASS.

### Task 4: Mirror the rule in `analytics-cli.js` (heavier task)

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/codemie-analytics/scripts/analytics-cli.js:261`
- Test: create `src/agents/plugins/claude/plugin/skills/codemie-analytics/__tests__/analytics-cli.test.ts` (Glob `**/analytics-cli*.test.*` first; extend if one exists)

The script is NOT importable: `resolveAuth` is not exported and `main()` runs at load (`main().catch(...)` near line ~894). The test must therefore spawn the script as a subprocess (`child_process.spawnSync` of `node <script>` with a temp `CODEMIE_HOME` / credentials dir) containing an encrypted fixture credentials file. Write the fixture by reusing the script's own key derivation and cipher (`createDecipheriv` aes-256-gcm; see its `readEncryptedFile` and `CREDENTIALS_DIR`) in reverse (encrypt with the same key/format). Pass paths as arguments/env, do not run from inside the temp dir. This is the heavier task: budget for fixture plumbing and for choosing a subcommand that reaches `resolveAuth` without network.

- [ ] **Step 1: Failing test** (Test-first: yes — fixture with only `_oauth2_proxy` and a past `expiresAt`: process does not print "SSO credentials expired"; fixture with `codemie_access_token` and a past `expiresAt`: prints it and returns no auth).
- [ ] **Step 2:** Run the test; expect FAIL on the cookie-only case.
- [ ] **Step 3:** Change the condition to also require a `codemie_access_token` cookie, with a one-line comment pointing at `effectiveExpiresAt`.
- [ ] **Step 4:** Run the test; expect PASS.

### Task 5: Session-shaped 401 recovery with loop guard

**Step 0 (fixture task, no browser work):** Real gateway captures are not available offline. Record in the `session-rejection.ts` header comment that the predicate is status-only (`statusCode === 401`) by assumption, with the spec Risk (unverified non-session 401 causes) as the stated reason, and encode the assumed shapes as fixtures in `session-rejection.test.ts`. If the executor has real captures, base the predicate on the observed difference instead.

**Files:**
- Create: `src/providers/plugins/sso/proxy/plugins/session-rejection.ts` exporting `isSessionRejection401(response: { statusCode?: number; headers?: Record<string, unknown> }): boolean`
- Modify: `src/providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.ts` (response handling near :82-144; update KNOWN GAP header :24-29)
- Test: `proxy/plugins/__tests__/sso-session-expiry.plugin.test.ts`; create `proxy/plugins/__tests__/session-rejection.test.ts`

**Loop guard rule:** the plugin records a fingerprint of the rejected cookies when it acts on a 401. A later 401 is suppressed ONLY when (a) a sign-in has completed since the fingerprint was recorded (use `getLastSignInAt` from `sso.login-lock.ts`, re-exported by `sso.detached-login.ts`, as `sso.auth-gate.ts` does) AND (b) the stored cookies are still identical to the fingerprint. Without (a), a user ignoring the browser tab on a dead session would never recover. State is in-memory only. The guard clears when stored cookies change or a redirect rejection is seen. On the suppressed path the plugin returns the untouched original response and must not consume the body (the redirect path calls `tools.readBody` to drain a 302 body; the 401 suppression path must not).

- [ ] **Step 1: Failing tests** (Test-first: yes —
  - `isSessionRejection401` true for 401, false for 200/403/302.
  - Plugin on a 401 writes the marker via `markAnalyticsAuthInvalid`, calls `startDetachedSsoLogin` once and returns the existing synthetic 401, same as the redirect path.
  - Superseded-cookie request replays once as for the redirect.
  - 403 starts no sign-in.
  - 401 with identical cookies after a completed sign-in (`getLastSignInAt` later than the fingerprint) writes no marker, starts no sign-in, returns the original response, and `tools.readBody` is not called.
  - 401 with identical cookies but NO completed sign-in since the fingerprint still writes the marker and starts a sign-in.
  - Guard clears when stored cookies change or a redirect rejection is seen.)
- [ ] **Step 2:** Run both test files; expect FAIL.
- [ ] **Step 3:** Implement the predicate module; in the plugin treat a matching 401 like the redirect rejection (shared recovery branch) with the loop guard above.
- [ ] **Step 4:** Run both files; expect PASS.

### Task 6: AC3 integration test for gate recovery

**Files:**
- Test: extend `src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts` (from Task 1)

**Interfaces:** Consumes Tasks 2 and 5 behavior only; no production code.

- [ ] **Step 1: Test** (Test-first: yes — with an `invalid` marker written by the plugin for an oauth2 redirect, and separately for a session-shaped 401, `ensureCodeMieSsoAuthOrWait` starts exactly one `startDetachedSsoLogin`; after sign-in success the prompt proceeds with no second browser launch. Confirm it fails when the 401 branch from Task 5 is disabled.)
- [ ] **Step 2:** Run `npx vitest run src/providers/plugins/sso`; expect PASS once Tasks 2-5 are in.

## Negative-constraint pass

Non-goals honored: no migration (Task 2 ignores stored value only), no gate network probe (Task 6 uses marker), no 403 handling (Task 5 test), no JWT-type changes, no loop-guard persistence, no metrics/OTLP classifier changes, no sdk-client sign-in on 401, no whole-suite gate or manual verification task.
