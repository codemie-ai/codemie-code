# EPMCDME-16983 MCP OAuth login hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first MCP OAuth login can finish (configurable 300 s wait, actionable failure hints, safe callback page) and the shipped #678 persistence is hardened (rotation race, documented deviations) and covered by tests.

**Architecture:** One helper in `src/mcp/constants.ts` yields all timing values; callback-server throws typed errors; the provider is the single place that turns them into stderr hints; token-store gains a side-effect-free peek and a compare-then-forget used by `renewSilently`.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `@/` alias), Vitest, `@modelcontextprotocol/client`.

**Spec:** `docs/superpowers/tasks/2026-11-25-epmcdme-16983/spec.md` (analysis: `technical-analysis.md` there).

Tests are written and run in this task on the user's explicit request. Run only `npx vitest run src/mcp`. Lint, typecheck, manual checks, git, Jira and GitHub actions are not tasks here: no task commits; the calling flow commits. `.ai-run/guides/` is not edited.

## Global Constraints

- Env `MCP_PROXY_AUTH_TIMEOUT_SECONDS`: trimmed decimal integer, digits only, 10..3600; anything else falls back to 300 s with a debug log.
- Timings from T seconds: callback = T, lockMaxWait = 0.75 T, lockStale = 1.25 T, all in exact integer ms.
- Callback error text: HTML-escaped, control chars stripped, 200 chars max per field; page headers `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`. Messages unchanged: `OAuth authorization timed out after 0.25s`, `OAuth error: <code> — <description>`.
- No log/hint ever holds a token, secret, code, state or callback URL.
- Tests only under `src/mcp/__tests__/`; each test uses its own temp `CODEMIE_HOME` and restores env.

## Review Focus

- `MCP_PROXY_AUTH_TIMEOUT_SECONDS=" 300 "`, `"1e3"`, `"0x20"`, `"+60"`: only the trimmed plain-digit form is accepted (T1).
- Callback `?error=` with no description, or a 10k-char one: page and error stay bounded (T2).
- Lock file written by an old version (no `staleAfterMs`) is still honoured (T3).
- `MCP_PROXY_PERSIST_TOKENS=off` during adoption: peek returns undefined, no write (T5/T6).
- Hostname-changed (undecryptable) file during peek: returns undefined, no throw (T5).

---

### Task 1: Timing helper and temp-home test helper

**Files:**
- Modify: `src/mcp/constants.ts` (after `getMcpClientName`, line 7)
- Create: `src/mcp/__tests__/helpers/temp-home.ts`
- Test: `src/mcp/__tests__/mcp-auth-timeout.test.ts`

**Interfaces:**
- Produces: `interface McpAuthTimings { callbackTimeoutMs: number; lockMaxWaitMs: number; lockStaleMs: number }`; `getMcpAuthTimings(): McpAuthTimings` (reads env at call time); `useTempCodemieHome(): { dir(): string }` registering `beforeEach`/`afterEach` that set a fresh `CODEMIE_HOME` temp dir and restore `CODEMIE_HOME`, `MCP_PROXY_AUTH_TIMEOUT_SECONDS`, `MCP_PROXY_PERSIST_TOKENS`, `MCP_CLIENT_NAME`.

Test-first: yes — `getMcpAuthTimings()` is not exported, so the table test fails at import.

- [ ] Write `mcp-auth-timeout.test.ts`: unset gives `{300000, 225000, 375000}`; `"10"` gives `{10000, 7500, 12500}`; `"3600"` gives `{3600000, 2700000, 4500000}`; `" 60 "` accepted; rejected (all give 300 s): `"0" "9" "3601" "-1" "1.5" "abc" "" "Infinity" "99999999999"`; for every accepted value assert `lockMaxWaitMs < callbackTimeoutMs < lockStaleMs` and `lockStaleMs <= 2**31-1`.
- [ ] Implement helper in `constants.ts` (regex `^\d+$` on trimmed value, then range test; `logger.debug` on fallback). Implement `temp-home.ts` (`mkdtempSync`, `rmSync` after).
- [ ] Run `npx vitest run src/mcp/__tests__/mcp-auth-timeout.test.ts`; expect PASS.

### Task 2: Callback server: default timeout, typed errors, safe error page

**Files:**
- Modify: `src/mcp/auth/callback-server.ts` (default at :33, error page :62-67, timeout :113-116)
- Test: `src/mcp/__tests__/mcp-auth.test.ts` (existing, `timeoutMs: 250` tests stay), `src/mcp/__tests__/mcp-auth-callback-errors.test.ts`

**Interfaces:**
- Consumes: `getMcpAuthTimings()` (T1).
- Produces: `class CallbackTimeoutError extends Error { readonly timeoutMs: number }`; `class OAuthCallbackError extends Error { readonly oauthError: string; readonly description?: string }` (both exported; `message` text unchanged; description in message is the sanitised text).

Test-first: yes — the typed-error and page tests fail until implemented.

- [ ] Tests: `startCallbackServer()` with fake timers rejects only after 300 s default (accepted a callback at 299 s, rejected `CallbackTimeoutError` after) and with `MCP_PROXY_AUTH_TIMEOUT_SECONDS=10` after 10 s; `?error=insufficient_scope&error_description=x` rejects `instanceof OAuthCallbackError` with `oauthError === 'insufficient_scope'`; `<script>` and `\n` in the description: response body contains `&lt;script&gt;`, no raw `<script>`, no newline in the error message, 200-char truncation, both headers present.
- [ ] Implement: default `getMcpAuthTimings().callbackTimeoutMs`; the two classes; a private `sanitize(text)` (strip control chars, truncate 200) and `escapeHtml`; headers on the error page (and the other pages).
- [ ] Run `npx vitest run src/mcp/__tests__/mcp-auth.test.ts src/mcp/__tests__/mcp-auth-callback-errors.test.ts`; expect PASS.

### Task 3: Auth-lock options object and per-lock stale age

**Files:**
- Modify: `src/mcp/auth/auth-lock.ts` (constants :19-26, `LockInfo` :28, `isStale` :51, `tryCreate` :57, `acquireAuthLock` :77); `src/mcp/auth/mcp-oauth-provider.ts:211` (call site)
- Test: `src/mcp/__tests__/mcp-auth-lock.test.ts`

**Interfaces:**
- Consumes: `getMcpAuthTimings()` (T1).
- Produces: `acquireAuthLock(options: { maxWaitMs: number; staleAfterMs: number }): Promise<() => void>`; lock JSON `{pid, createdAt, staleAfterMs}`; `isStale` uses the file's own `staleAfterMs`, falling back to 150 000 for old files. No env parsing in `auth-lock.ts`.

Test-first: yes — the options-object signature and the recorded `staleAfterMs` fail on current code.

- [ ] Tests (temp home): acquire then release removes file; second acquire waits and gets the lock after release; stale by dead PID (write lock with unused pid) is removed; stale by age using the file's own `staleAfterMs` while the caller passes a larger one; old-format file (no `staleAfterMs`) fresh is respected and old (>150 s) is removed; give-up returns a no-op after `maxWaitMs: 400` and leaves the holder's file; written file records the caller's `staleAfterMs`.
- [ ] Implement; provider call becomes `acquireAuthLock({ maxWaitMs: t.lockMaxWaitMs, staleAfterMs: t.lockStaleMs })` using `getMcpAuthTimings()`. Fix the stale comments (:20, :23).
- [ ] Run `npx vitest run src/mcp/__tests__/mcp-auth-lock.test.ts src/mcp/__tests__/mcp-auth.test.ts`; expect PASS.

### Task 4: Provider: explicit timeout and the failure hint

**Files:**
- Modify: `src/mcp/auth/mcp-oauth-provider.ts` (`ensureCallbackServer` :82, `waitForAuthorizationCode` :251-265)
- Test: `src/mcp/__tests__/mcp-auth-hints.test.ts`

**Interfaces:**
- Consumes: `CallbackTimeoutError`, `OAuthCallbackError` (T2), `getMcpAuthTimings`, `getMcpClientName`.

Test-first: yes — no hint is written today, so the stderr assertions fail.

- [ ] Tests (spy `console.error`, `CODEMIE_DEBUG`/`MCP_PROXY_DEBUG` unset, mock `execFile` as `mcp-auth.test.ts:22-34`): drive the provider with a short callback timeout via fake timers; timeout case writes a line naming `MCP_PROXY_AUTH_TIMEOUT_SECONDS` and the `MCP_CLIENT_NAME` value, error rethrown is the same `CallbackTimeoutError`; `insufficient_scope` callback writes a hint naming `MCP_CLIENT_NAME` and not `MCP_PROXY_AUTH_TIMEOUT_SECONDS`; other `OAuthCallbackError` codes get no hint; `dispose()` mid-wait rejects `Callback server closed` with no hint; stderr never contains the code, state or `redirectUrl`; provider passes `timeoutMs: getMcpAuthTimings().callbackTimeoutMs` explicitly (assert via timing at `MCP_PROXY_AUTH_TIMEOUT_SECONDS=10`).
- [ ] Implement in `waitForAuthorizationCode`: catch, branch on `instanceof`, `console.error` the hint, rethrow the original; keep the `finally`.
- [ ] Run `npx vitest run src/mcp/__tests__/mcp-auth-hints.test.ts src/mcp/__tests__/mcp-auth.test.ts`; expect PASS.

### Task 5: token-store: peek, compare-then-forget, headers; store tests

**Files:**
- Modify: `src/mcp/auth/token-store.ts` (header :1-19; new functions after `loadPersistedLogin`:115 and `forgetPersistedLogin`:158)
- Test: `src/mcp/__tests__/mcp-token-store.test.ts`

**Interfaces:**
- Produces: `peekPersistedLogin(resource: URL): PersistedLogin | undefined` (same decode as `loadPersistedLogin`, never deletes, never throws, honours the kill switch); `forgetPersistedLoginIf(resource: URL, refreshToken: string): boolean` (unlinks only if the file's refresh token equals `refreshToken`). Extract the shared decode/skew logic into private helpers rather than duplicating.

Test-first: yes — peek and compare-then-forget do not exist; the characterization cases for existing behavior pass at once (stated in the test names).

- [ ] Tests: round trip with grant; expired with grant is returned, expired without grant is deleted by `load` but not by `peek`; skew (token expiring in 30 s counts expired); no write without `expires_in` and without grant; corrupt file and wrong-key file give undefined (peek too); `MCP_PROXY_PERSIST_TOKENS=off` neither reads nor writes; POSIX only (`it.skipIf(process.platform==='win32')`): dir 0700, file 0600; `forgetPersistedLoginIf` keeps a file whose refresh token differs, removes a matching one.
- [ ] Implement; update the header: two writers per file are possible via adoption (no cross-process lock), state the `CredentialStore` deviation (unattended reads, no keychain prompt) and POSIX-only modes.
- [ ] Run `npx vitest run src/mcp/__tests__/mcp-token-store.test.ts`; expect PASS.

### Task 6: Provider: refresh-rotation adoption

**Files:**
- Modify: `src/mcp/auth/mcp-oauth-provider.ts` (`restorePersistedLogin` :131, `renewSilently` :157-181)
- Test: `src/mcp/__tests__/mcp-auth-renewal.test.ts`

**Interfaces:**
- Consumes: `peekPersistedLogin`, `forgetPersistedLoginIf` (T5).
- Produces: private `seed(login: PersistedLogin): void` (sets `_tokens`, `_expiresAt ?? 0`, `_grant`, `_clientInfo` from the grant's client); `renewSilently(fetchFn?: FetchLike, allowAdopt = true)` stays source-compatible for existing callers (second arg private by convention: recursion only).

Test-first: yes — adoption is absent; the first refused-refresh test fails.

- [ ] Tests mock `refreshAuthorization`/`discoverOAuthServerInfo`/`selectResourceURL` via `vi.mock('@modelcontextprotocol/client', ...)` keeping `OAuthError` real; construct `OAuthError('invalid_grant', ...)`. Cases: restore + `tokenNeedsRenewal`; renewal success persists a new file; refusal with unchanged persisted token forgets the file (today's behavior); refusal with a newer persisted grant and a valid access token adopts it, makes no second refresh call (one call total), returns true, uses the adopted client info; newer grant with an expired access token retries exactly once; a refused retry with `invalid_grant` while the file now holds a still newer token does not unlink; refused retry with the file still holding the refused token forgets; network error (`new Error`) and `OAuthError('server_error')` on the retry keep the file; never more than two refresh calls.
- [ ] Implement per spec scope 4: grant-ending codes are `invalid_grant`, `invalid_client`, `unauthorized_client`; other `OAuthError` codes on the first attempt keep today's forget behavior only if no newer persisted grant exists. Refactor `restorePersistedLogin` to use `seed`.
- [ ] Run `npx vitest run src/mcp/__tests__/mcp-auth-renewal.test.ts`; expect PASS.

### Task 7: Two-start regression and stale test header

**Files:**
- Modify: `src/mcp/__tests__/mcp-auth.test.ts:8` (header says "in-memory")
- Test: `src/mcp/__tests__/mcp-auth-two-start.test.ts`

Test-first: no — characterization of already-shipped behavior; it is expected to pass on first run.

- [ ] Provider A (`new McpOAuthProvider(url)`) `saveClientInformation` + `saveTokens` with `expires_in` and `refresh_token`; provider B on the same temp home calls `restorePersistedLogin()`: `tokens()` equals A's access token, `tokenNeedsRenewal()` is false, `execFileMock` never called, no refresh call. Reword the header at `mcp-auth.test.ts:8` to describe the persisted-login provider. Run `npx vitest run src/mcp`; expect all PASS.

### Task 8: Documentation

**Files:**
- Modify: `docs/AUTHENTICATION.md` (storage paragraph :323, Configuration table :336-341, Troubleshooting :350)

Test-first: no — documentation only.

- [ ] Add the `MCP_PROXY_AUTH_TIMEOUT_SECONDS` row (default 300, range 10..3600, fallback behavior, small values may be too short, real window shorter because the clock starts at connect). Add a subsection on the timing limitation (lock-queue and pre-login steps come out of the window), the `insufficient_scope` symptom with VERIFIED (default name "CodeMie CLI" logs in; custom name showed the scope page) separated from HYPOTHESIS (gateway maps client names to scopes), the `CredentialStore` deviation and POSIX-only 0700/0600. Replace the "after 2 minutes" troubleshooting row. Do not touch `.ai-run/guides/`.

---

## Negative-constraint pass

No second store, no `CredentialStore` move, no migration (T5, T8 only document). No `scope` param, no client-name blocklist, no startup warning (T4 writes a hint only on failure). Callback clock is not moved (T2/T4 keep arming at connect). No cross-process refresh lock (T6 adopts, never locks). No bridge logging rewrite. No git/Jira/GitHub action in any task.

## Notes for Stage 7 (manual, not tasks)

Bridge-level two-start against the real gateway with `MCP_PROXY_DEBUG=true` (`[mcp-proxy][tokens]` lines); one 2-4 minute first login noting whether the MCP client restarts the proxy. Report the stale `security-practices.md` CredentialStore guidance to the guide maintainers; close PR #708 and answer #643 are recommendations for the PR description.
