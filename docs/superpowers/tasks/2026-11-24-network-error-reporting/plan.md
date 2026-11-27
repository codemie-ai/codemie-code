# Network Error Reporting Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `codemie sdk` commands print the axios error code (e.g. `ERR_FR_TOO_MANY_REDIRECTS`) instead of "HTTP 500 error" for response-less network failures.

**Architecture:** A helper in `src/utils/network-error-capture.ts` wraps the public `axios.defaults.adapter` (resolved via `axios.getAdapter` when it is an array of names) and records response-less errors in a module store. `handleSdkError` reads and clears the store for the SDK-shaped `ApiError`. One idempotent `installNetworkErrorCapture()` is called by both client factories before `new CodeMieClient`.

**Tech Stack:** TypeScript ES modules, axios 1.18.1 (deduped with the SDK's), Vitest.

**Spec:** `docs/superpowers/tasks/2026-11-24-network-error-reporting/spec.md`

## Global Constraints
- Commit per task using the repository's existing convention: Conventional Commits per `.ai-run/guides/standards/git-workflow.md` and `commitlint.config.cjs` (allowed types/scopes only, e.g. `fix(cli): ...`). Ticket `EPMCDME-16977` and `Relates to #548` go in the footer, not the subject.
- Stage files by name only. Never `git add .`/`-A`/`commit -a`. Never stage or modify `.codemie/codemie-cli.config.json`. No `--no-verify`, no push, no PR, no branch/worktree, no Jira writes.
- Run tests narrowly: `npx vitest run --project unit <file>`. Never the full `npm test`.
- ES modules, `.js` import extensions, `@/` alias, `logger.debug` (no `console.log`), `sanitizeLogArgs` for logged errors, project error classes.
- `handleSdkError(error: unknown, operation: string): never` signature unchanged; the 9 command files are not edited; SDK in node_modules is not changed.
- Printed and logged text has no URLs, headers, cookies or tokens.
- Tests are explicitly authorized by the user (TDD).

## Review Focus
- Capture left unread by an earlier request must not attach to a later real empty-body 500 (Task 3).
- Real HTTP 500 with a response stays "API error: HTTP 500 error" (Task 1, 3).
- Install called twice must not double-wrap the adapter (Task 2).
- Second axios copy: install has no effect, `logger.debug` says so, output unchanged (Task 2).
- Error message containing a URL or token must be sanitized in output (Task 1).

## Negative-constraint pass
Non-goals honored: no SDK edits (Tasks use public axios only); no auth-proxy handling; JWT branch not fixed (Task 4 tests it with a mocked SDK only); no generic fallback wording (Task 1 keeps exact "HTTP 500 error"); no SDK private interceptors; config file untouched.

---

### Task 0: Axios scratch spike (no commit; criteria 10, 12)

Before Task 1 and before anything is committed, run a scratch spike outside the repo tree (`$TMPDIR`, nothing staged): how axios 1.18.1 exposes `axios.defaults.adapter` (array of names or a function), whether `axios.getAdapter` resolves it, whether `axios.create()` copies `defaults.adapter` at creation, and whether the SDK's `axios` import resolves to the same module. Report the result to the user before the first commit. Task 2 builds on this result.

### Task 1: Store and `handleSdkError` reporting (criteria 1, 3, 5, 6, 7)

**Files:**
- Create: `src/utils/network-error-capture.ts` (store part only)
- Modify: `src/cli/commands/sdk/utils/cli-utils.ts:~88` (the `ApiError` generic branch)
- Test: `src/cli/commands/sdk/utils/__tests__/cli-utils.test.ts`

**Interfaces:**
- Produces: `recordNetworkError(err: unknown): void` (only when the error has no `response`; stores `{code, message}` with message sanitized and URL/token stripped), `takeNetworkError(): {code: string; message: string} | undefined` (read and clear), `clearNetworkError(): void`.

Test-first: yes — `handleSdkError` with a recorded `ERR_FR_TOO_MANY_REDIRECTS` error and `new ApiError("HTTP 500 error", 500, {})` prints output containing the code and not "HTTP 500" (criterion 1; this is the first failing test of the plan).

- [ ] Step 1: Add that test to `cli-utils.test.ts` using the existing console.error/process.exit spy pattern. Run it; expect FAIL, and save the full RED output to `/tmp/evidence/failing-test.txt`.
- [ ] Step 2: Add tests: nothing recorded prints exactly `API error: HTTP 500 error`; `ApiError("boom", 500, {data})` with a record present is unchanged and the record is not consumed wrongly; a recorded message containing `https://host/x?token=abc` prints without the URL/token; second read yields nothing (clear-on-read); `recordNetworkError` ignores errors that have `response`; the existing 401 test still passes.
- [ ] Step 3: Implement the store. In `cli-utils.ts`, when the error is an `ApiError` with `statusCode === 500`, empty `response` and message `"HTTP 500 error"`, call `takeNetworkError()` and print `API error: <code>: <message>`; otherwise unchanged.
- [ ] Step 4: Run `npx vitest run --project unit src/cli/commands/sdk/utils/__tests__/cli-utils.test.ts`; expect PASS.
- [ ] Step 5: Commit (`fix(cli): ...`), staging the three files by name.

### Task 2: Adapter verification and install helper (criteria 10, 12)

**Files:**
- Modify: `src/utils/network-error-capture.ts`
- Test: `src/utils/__tests__/network-error-capture.test.ts`

**Interfaces:**
- Produces: `installNetworkErrorCapture(): boolean` — idempotent; returns whether the wrapper is active. Marks the wrapped adapter with a symbol to avoid double wrapping. The wrapper calls the original adapter, on rejection calls `recordNetworkError(err)` and rethrows. Clears the store at request start (used by Task 3).

Test-first: yes — a test that `axios.defaults.adapter` after install is a function that calls the real adapter (stub via `axios.getAdapter`) and records a response-less rejection.

- [ ] Step 1 (verification, do first): in a scratch node one-liner or the test, record how axios 1.18.1 exposes `defaults.adapter` (expected array `['xhr','http','fetch']`) and whether `axios.create()` copies `defaults.adapter` at creation (expected: yes, copied at create time, so the install must precede `new CodeMieClient`). Record the answer as a code comment above `installNetworkErrorCapture`. If it is an array, resolve via `axios.getAdapter(axios.defaults.adapter)` before wrapping.
- [ ] Step 2: Tests: default adapter shape is covered (array resolves to a function); install twice wraps once; an `axios.create()` instance made after install uses the wrapped adapter and one made before does not; `createRequire` resolution of `axios` from the repo root and from `codemie-sdk`'s directory is the same path (criterion 10); when the install cannot take effect (simulate by mocking `axios.getAdapter` to throw or a missing adapter), it returns false, calls `logger.debug` and output stays "HTTP 500 error".
- [ ] Step 3: Implement. Run `npx vitest run --project unit src/utils/__tests__/network-error-capture.test.ts`; expect PASS.
- [ ] Step 4: Commit, staging files by name.

### Task 3: Clear at request start (criterion 9, 4)

**Files:**
- Modify: `src/utils/network-error-capture.ts` (wrapper)
- Test: `src/utils/__tests__/network-error-capture.test.ts`, `cli-utils.test.ts`

Test-first: yes — a capture left unread from request A, then request B succeeds at the adapter level and the SDK later throws an empty-body real 500 for request C: `handleSdkError` prints `API error: HTTP 500 error` (store was cleared at the start of each request).

- [ ] Step 1: Write the stale-capture test (fake adapter that first rejects without response, then resolves a 500 with response). Run; expect FAIL.
- [ ] Step 2: In the wrapper, call `clearNetworkError()` before delegating. Also log the sanitized raw captured error with `logger.debug(...sanitizeLogArgs(...))` on record; add a test that debug is called and contains no URL.
- [ ] Step 3: Run both test files; expect PASS. Commit.

### Task 4: Shared install in both factories (criterion 11)

**Files:**
- Modify: `src/utils/auth.ts:~52-55` (call `installNetworkErrorCapture()` before `new CodeMieClient`), `src/utils/sdk-client.ts` (same in `getCodemieClient`)
- Test: `src/utils/__tests__/auth-network-capture.test.ts`, `src/utils/__tests__/sdk-client-network-capture.test.ts`

Test-first: yes — with `codemie-sdk` mocked, `getAuthenticatedClient` and `getCodemieClient` each invoke the install before the `CodeMieClient` constructor (order asserted via call order spies). Tests call the factories, not the helper directly.

The JWT branch of `getAuthenticatedClient` throws in this SDK version before a working client is built (`external_token` defect, a non-goal). So factory tests for it only assert (SDK mocked) that install precedes construction. The real-network test uses the SSO/cookie path only (Task 5).

- [ ] Step 1: Write both order tests; run; expect FAIL.
- [ ] Step 2: Add the one-line calls. Run both files; expect PASS. Commit.

### Task 5: SDK-level real network test (criteria 2, 11)

**Files:**
- Test: `src/cli/commands/sdk/utils/__tests__/network-error-sdk.test.ts`

Test-first: yes — a local `http` server on `127.0.0.1` 302-redirecting to itself; a real `CodeMieClient` built via each factory's SSO/cookie path (cookie construction as in `auth.ts`) calls an assistants list; `handleSdkError` output contains `ERR_FR_TOO_MANY_REDIRECTS` and not "HTTP 500". Also a control: without install the output is "HTTP 500 error" (documents the bug); save the control-test output to `/tmp/evidence/control-test.txt`. The server uses `listen(0, '127.0.0.1')` for an ephemeral port, never a fixed one.

The sandbox forbids port binding, so the executing agent must run this file outside the sandbox: `npx vitest run --project unit src/cli/commands/sdk/utils/__tests__/network-error-sdk.test.ts`.

- [ ] Step 1: Write the test, close the server in `afterAll`, mock only credential loading and config needed by the factories.
- [ ] Step 2: Run outside the sandbox; expect PASS. Commit.
