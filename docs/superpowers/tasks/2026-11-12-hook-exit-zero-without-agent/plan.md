# EPMCDME-16960 Plan: `codemie hook` exits 0 outside a CodeMie session

> Commit per task using the repository's existing convention: `fix(hook): ...`, ticket EPMCDME-16960 in the body, no Co-Authored-By. Never stage `.codemie/codemie-cli.config.json`.
>
> Safety: run only the hook test files, never the full `npm test`. Prefix every run with `HOME=<tmpdir> CODEMIE_HOME=<tmpdir>`, e.g. `HOME=$T CODEMIE_HOME=$T npx vitest run src/cli/commands/__tests__/hook.not-managed.test.ts`.

**Placement decision:** the skip goes in the `createHookCommand()` action, not in `initializeLoggerContext()`/`initializeHookContext()`. The exported `processEvent()` contract (still throws when called without config and without env) is unchanged for the plugin callers. Consequently `hook.lock.test.ts` ~L355-365 stays valid; Task 2 checks this and edits it only if it fails.

**Ordering decision:** the check sits right after the OTLP analytics branch (`hook.ts` ~L1694) and before the `session_id`/`hook_event_name` validation (~L1697), so an unmanaged run never exits 2.

## negative-constraints
- Nothing printed to stderr: Task 1 uses `logger.debug` only (no `console.error`, no `logger.warn`); Task 1 test asserts no `console.error`.
- Not `warn` level: Task 1.
- Do not drop the names-only listing or the existing `[hook:debug] CODEMIE_AGENT missing...` line: Task 1 extracts it into a shared helper, values never logged.
- Do not silently change `processEvent()`: Task 1 leaves its throws intact.
- No full-suite test run, no staging of the config file: header + Task 3.

## Task 1: Skip unmanaged sessions in the hook action

Test-first: yes — new test `hook.not-managed.test.ts` fails because the action sets `process.exitCode = 1` and calls `console.error` when `CODEMIE_AGENT` (or `CODEMIE_SESSION_ID`) is unset.

**Files:** modify `src/cli/commands/hook.ts`; create `src/cli/commands/__tests__/hook.not-managed.test.ts`.

- [ ] Write the test first, modelled on `hook.analytics-wiring.test.ts` L62-100 (stdin replaced via `Object.defineProperty(process,'stdin',{value: Readable.from([...]), configurable:true})`, restored afterwards; `process.exitCode` and `process.env` saved/restored per test; `@group unit` docblock). Use a valid claude event (`session_id`, `hook_event_name: 'SessionEnd'`). Spy `console.error` and `logger.debug`, plus `logger.close`. Cases: (a) `CODEMIE_AGENT` unset, (b) `CODEMIE_AGENT=claude` with `CODEMIE_SESSION_ID` unset. Each asserts `process.exitCode === 0`, `console.error` not called, a `logger.debug` call matching `/not a CodeMie session|CODEMIE_AGENT missing|CODEMIE_SESSION_ID missing/`, and `logger.close` called. Case (a) also asserts the `[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars:` line.
- [ ] Run it; confirm both cases fail for the stated reason.
- [ ] In `hook.ts` ~L198-209 extract the names-only `CODEMIE_*` listing plus the existing debug line into a small private helper `logMissingAgentEnv(): void` and call it from `initializeLoggerContext()` before its throw (behavior unchanged).
- [ ] Add a private `isCodemieManagedSession(): boolean` next to it: when `CODEMIE_AGENT` is unset it calls `logMissingAgentEnv()` and returns false; when `CODEMIE_SESSION_ID` is unset it calls `logger.debug('[hook:debug] CODEMIE_SESSION_ID missing, not a CodeMie session, skipping')` and returns false; otherwise true.
- [ ] In the action (`hook.ts` ~L1694, after the OTLP branch, before the `session_id` check) add: if `!isCodemieManagedSession()`, `await logger.close(); process.exitCode = 0; return;`, with a one-line comment that global hooks fire for non-CodeMie `claude` runs. The `finally` already cleans up signal listeners.
- [ ] Run the new test; confirm it passes.
- [ ] **Mutation check:** temporarily remove only the new early-return block from the action; run the new test file and confirm exactly the new test cases fail (and nothing else in that file); restore the block and re-run to confirm green.
- [ ] Commit (`fix(hook): ...`).

## Task 2: Reconcile the tests that encoded the old behavior

Test-first: no — update existing assertions to the new contract.

- [ ] `tests/integration/hook-stdout.test.ts` ~L416-430: change the expectations for `CODEMIE_AGENT: ''` to `res.code === 0` and empty stderr; keep the file-log assertion for `[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars: `. Rename the test title to match.
- [ ] `src/cli/commands/__tests__/hook.lock.test.ts` ~L355-365: it calls `processEvent` directly, whose contract is unchanged, so it should still pass; run it. Edit it only if it fails (then align it to the actual behavior and note why in the commit body).
- [ ] Run only `tests/integration/hook-stdout.test.ts`, `hook.lock.test.ts` and the new test file (temp HOME/CODEMIE_HOME). Commit (`fix(hook): ...` or fold into Task 1's commit if the repo convention prefers test-with-code).
