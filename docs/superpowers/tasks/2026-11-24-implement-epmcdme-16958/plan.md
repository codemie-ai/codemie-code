# EPMCDME-16958 Headless SSO Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Opt-in paste-back SSO login for machines without a browser.
**Architecture:** `authenticate()` gains `headless`; it skips server/browser, prints the login URL and reads a pasted token (raw or full redirect URL) through a shared pure parser extracted from `handleCallback`. Storage is unchanged.
**Tech Stack:** TypeScript ESM (`.js` imports, `@/` alias), commander, ora, existing prompt lib, Vitest.
**Spec:** `docs/superpowers/tasks/2026-11-24-implement-epmcdme-16958/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- Mode is never inferred: no env var, no auto-detect, no flag on agent commands.
- `src/bin/sso-login.ts`, hook/daemon gate, proxy daemon, session-expiry plugin: behavior unchanged (message text only).
- No new dependencies; no backend change; no change to credential storage, cookie format or expiry.
- Token/cookies/pasted input never in logs, console or error messages (fixed error strings; `sanitizeLogArgs`).
- Use project error classes, `logger` (not console) in libs, `exec()` from `src/utils/exec.ts`.

## Review Focus

- Empty/whitespace paste, garbage, valid base64 without `cookies`: fixed error, nothing stored, bounded retries.
- Pasted URL with `token`, `auth` or `data` param, URL-encoded: all parsed.
- stdout not a TTY (stdin TTY): fail fast (check both).
- `config.js` fetch hangs: bounded by timeout.
- Failed headless `refresh` leaves existing credentials intact.

## Task 1: Shared token parser + headless `authenticate()`

**Files:** Modify `src/providers/plugins/sso/sso.auth.ts:74-182,347-404`, `src/providers/core/types.ts:413-429`; Create `src/providers/plugins/sso/sso.token-parser.ts`; Test `src/providers/plugins/sso/__tests__/sso.token-parser.test.ts`, extend `sso.auth.test.ts`.

**Interfaces:**
- Produces: `parseSSOToken(input: string, opts?: {signal?: AbortSignal}): Promise<{apiUrl: string; cookies: Record<string,string>}>` (accepts raw token or URL; trims; throws project error with fixed message; `/config.js` fetch uses `AbortSignal.timeout`). `SSOAuthConfig.headless?: boolean`.

Test-first: yes — parser accepts raw token and `http://localhost:1234/?token=...` (also `auth`/`data`), rejects empty/garbage/no-cookies with a message not containing the input; `authenticate({headless:true})` with mocked prompt stores credentials, starts no server, and never calls `open`.

- [ ] Write parser tests, then extract `handleCallback`'s decode/cookies/config.js logic (:347-404) into `parseSSOToken`; `handleCallback` calls it (browser tests must still pass).
- [ ] In `authenticate`, when `config.headless`: skip `startLocalServer`/browser; print URL `${ensureApiBase(url)}/v1/auth/login/{randomHighPort}` (never bound; printed even if `quiet`) plus an instruction to copy the address bar even if the browser shows a connection error; call the Task 2 prompt; limited retries (3) under one overall deadline (`timeout`); then reuse the existing store path (:141-156). Fix the abort handling at :162 so abort yields a "cancelled" message.

## Task 2: No-echo paste prompt

**Files:** Create `src/providers/plugins/sso/sso.paste-prompt.ts`; Test `__tests__/sso.paste-prompt.test.ts`.

**Interfaces:** Produces `promptForPastedToken(opts: {deadlineMs: number; signal?: AbortSignal}): Promise<string>`; throws fixed-message errors for no TTY (requires `stdin.isTTY && stdout.isTTY`), timeout, abort.

Test-first: yes — with `isTTY=false` it rejects immediately with the no-TTY message; with a short deadline and no input it rejects with the timeout message and echo/raw-mode is restored.

- [ ] Implement with the existing prompt tooling (check password/hidden input support first; else raw-mode `readline`), restoring terminal state in `finally`; race against deadline and abort signal. Verify Ctrl+C behavior of the chosen lib.

## Task 3: `profile login` / `refresh` flags

**Files:** Modify `src/cli/commands/profile/auth.ts:14-29,65-103,125-149`; Test `src/cli/commands/profile/__tests__/auth.test.ts` (new).

Test-first: yes — `login --no-browser` calls `authenticate` with `headless:true` and starts no ora spinner; `--headless` alias equivalent; `refresh --no-browser` clears credentials only after authenticate succeeds (authenticate rejection leaves them).

- [ ] Add `--no-browser` (alias `--headless`) option; skip spinner in headless; pass flag through `handleLogin`/`handleRefresh`; reorder refresh so clear follows successful store. Check `sso.login-lock.ts` for whether login takes the lock mid-paste and note outcome in the commit.

## Task 4: `setup --no-browser` plumbing

**Files:** Modify `src/cli/commands/setup.ts:37-38,252`, `src/providers/core/types.ts:300`, `src/providers/core/codemie-auth-helpers.ts:90-100`, `src/providers/plugins/sso/sso.setup-steps.ts` (~:135,278-307), `anthropic-subscription.setup-steps.ts:72`, `moonshot-subscription.setup-steps.ts:59`; Tests alongside existing setup-step tests.

**Interfaces:** `getCredentials(isUpdate?: boolean, options?: {headless?: boolean})`; `authenticateWithCodeMie(url, timeout, headless?: boolean)`; `promptForReauth(..., headless?: boolean)` (skips the choice prompt when true, runs headless).

Test-first: yes — SSO `getCredentials(false,{headless:true})` calls `CodeMieSSO.authenticate` with `headless:true`; `promptForReauth` with headless true shows no prompt; subscription analytics-sync login passes it; without options all calls unchanged.

- [ ] Add option `--no-browser` (alias `--headless`) to setup and pass `{headless}` at `setup.ts:252`; thread through the listed call sites. Bedrock/jwt/litellm/ollama are untouched.

## Task 5: Three-way re-auth prompt

**Files:** Modify `sso.setup-steps.ts` `promptForReauth`, callers via `src/providers/core/auth-validation.ts`, `AgentCLI.ts:343/385`, `profile/index.ts:145`, `src/utils/auth.ts` `promptReauthentication`; update their tests/mocks.

Test-first: yes — with TTY, choosing "paste token" calls authenticate with `headless:true`; default choice runs the browser flow exactly as today's yes; "no" returns false; without TTY, `isNonInteractiveEnvironment` path prints the error, returns false, shows no prompt.

- [ ] Replace yes/no with choices (browser default / paste token / no); keep non-interactive guard untouched.

## Task 6: anthropic-subscription headless login

**Files:** Modify `src/providers/plugins/anthropic-subscription/anthropic-subscription.setup-steps.ts:29-50`, `anthropic-subscription.auth.ts:18`; Test in that plugin's existing tests.

Test-first: yes — with headless and status not logged in: prints instructions naming `claude auth login` paste flow and `claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN`, then runs `claude auth login` interactively; already `loggedIn` (`authMethod: oauth_token`) skips login; no TTY throws a fast clear error; final-status `ConfigurationError` text mentions both routes (also without flag, browser path unchanged).

- [ ] Implement per spec design points 1-3; no new claude flags; do not touch `beforeRun`.

## Task 7: Headless hint text

**Files:** Modify `sso.detached-login.ts:401-440` (`describeLogin`), `src/cli/commands/skills/lib/require-auth.ts:17`, `AgentCLI.ts:389`; update existing text-asserting tests.

Test-first: yes — each listed `describeLogin` case (started/in-progress, failed, still-unauthenticated, timeout, cooldown, open-failed), the require-auth message and the AgentCLI message contain `codemie profile login --no-browser`.

- [ ] Strings only; no behavior change; do not add hints elsewhere.

## Spec notes

- negative-constraints: honored by Global Constraints; Tasks 1-7 touch no `sso-login.ts`, gate, daemon, `beforeRun`, storage or deps; no auto-detection in any task.
- Arch plan_notes: parser split (T1), fetch timeout + one deadline (T1), stdin+stdout TTY (T2), fixed error strings (T1/T2), login lock check (T3). Not planned (outside spec): identity confirmation before store.
- Criterion 20 (real-backend check) is a manual pre-merge step, not a plan task.
