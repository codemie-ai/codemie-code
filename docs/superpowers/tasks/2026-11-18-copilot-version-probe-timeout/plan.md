# Bound the Copilot and base-class version probe - Plan

**Spec**: `spec.md` (EPMCDME-16976). Repo: codemie-code only.
**Conventions**: `@/` imports with `.js` extensions, `logger.debug` (no console.log), no `any`, explicit return types on exports, zero-warning lint. Vitest per `.ai-run/guides/testing/testing-patterns.md`.
**Repo rules**: Make no git operations. Leave changes uncommitted. Do not touch `package-lock.json` or `.codemie/codemie-cli.config.json`. Whole-suite gates and harness verification belong to later stages and are not tasks here.
**Scope note**: `copilot-cli-otlp` and `copilot-chat-otlp` extend `OtlpAgentAdapter`, which has no `getVersion`. They are not affected, so no task touches them.

## Task 1 - exec() hardening options and shared constant

Files: `src/utils/exec.ts`; new `src/utils/__tests__/exec.test.ts`.

- Extend `ExecOptions` with `closeStdin?: boolean` and `killGraceMs?: number`. Document in the JSDoc that `killGraceMs` only applies together with `timeout` and is a no-op without it. Document that `closeStdin` is ignored when `interactive` is set.
- In `exec`, when `closeStdin` is set and `interactive` is not, build stdio as `['ignore', 'pipe', 'pipe']`. Otherwise keep `'pipe'` / `'inherit'` exactly as today.
- Add one private helper `terminate(child, killGraceMs)`:
  - It sends SIGTERM.
  - It destroys `child.stdout` and `child.stderr` and calls `child.unref()`.
  - When `killGraceMs` is set, it starts a grace timer (not unref'd) that sends SIGKILL, destroys the pipes and unrefs again.
- Settle the promise exactly once, using a `settled` flag.
- Guard the SIGKILL with a `closed` flag set in the `close` handler. `cleanup()` clears both the timeout timer and the grace timer. A child that exits on SIGTERM therefore neither waits out the grace period nor gets a late kill.
- Without `closeStdin` or `killGraceMs`, the timeout path must stay byte-for-byte as today: a single `child.kill()` and the rejection `Command timed out after Nms`.
- Export `VERSION_PROBE_OPTIONS: ExecOptions = { timeout: 5000, closeStdin: true, killGraceMs: 500 }`, with a short comment that new agent `--version` probes should use it.

Test-first: yes - `exec.test.ts` with real `node -e` children. Tests fail before the change, because the new options do not exist and the stubborn child never lets the promise settle in time:
- timeout rejects once with the existing message;
- no options means the same result and a single SIGTERM (AC9);
- `closeStdin: true` gives a stdin-reading child EOF, so it exits 0 without the timer;
- a child that exits on SIGTERM clears the grace timer, and the call returns well before `killGraceMs` with no late SIGKILL;
- a SIGTERM-ignoring child is SIGKILLed after the grace period (skip on win32), and a child holding stdout open does not keep the process alive after the promise settles;
- a late `close` or `error` after the timeout does not re-settle;
- `VERSION_PROBE_OPTIONS` equals the literal values (assert once).

## Task 2 - BaseAgentAdapter.getVersion probe bounded

Files: `src/agents/core/BaseAgentAdapter.ts` (`getVersion`); `src/agents/core/__tests__/BaseAgentAdapter.test.ts`.

- Change the `exec(this.metadata.cliCommand, ['--version'])` call to pass `VERSION_PROBE_OPTIONS`.
- Import `VERSION_PROBE_OPTIONS` from `@/utils/exec.js`. Keep the existing `exec` import from `utils/processes.js`. Add a one-line comment explaining the split: the tests mock `processes.js` only, so the constant stays real.
- In the existing `catch`, add `logger.debug` with the error message, so a timeout can be told from a failure. Keep the `null` return.

Test-first: yes - in the existing `BaseAgentAdapter.test.ts` (which already mocks `processes.js` `exec`), add a `getVersion` describe block. It fails today because `exec` is called with no options. Assert `exec` is called with `cliCommand`, `['--version']` and `VERSION_PROBE_OPTIONS`; a parsed version is returned on success (AC4); `null` is returned when `exec` rejects with a timeout error (AC5).

## Task 3 - CopilotCliPlugin.getVersion probe bounded

Files: `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts` (`CopilotCliPlugin.getVersion`); new `src/agents/plugins/copilot-cli/__tests__/copilot-cli.version.test.ts`.

- Pass `VERSION_PROBE_OPTIONS` to the `exec(this.metadata.cliCommand, ['--version'])` call. Import the constant from `@/utils/exec.js`. Keep `exec` imported from `utils/processes.js`, with the same one-line comment on the import split.
- Add `logger.debug` in the existing `catch`. Keep the `null` return. Leave the `(\d+\.\d+\.\d+)` parse and the trimmed-stdout fallback untouched.

Test-first: yes - the new test file uses `vi.mock` of `utils/processes.js` (`exec`, `commandExists`) with a dynamic import after setup. It fails today because no options are passed. Cases:
- `exec` is called with `VERSION_PROBE_OPTIONS`;
- `copilot 1.2.3` parses to `1.2.3`;
- non-version output falls back to the trimmed stdout;
- `exec` rejecting with `Command timed out after 5000ms` returns `null` and nothing is thrown.

## Negative-constraint pass

- No default timeout or default behaviour change in `exec()` (NG4): Task 1 makes both options opt-in, and the AC9 test covers it.
- Codex, gemini, claude, kimi, doctor, `client-version-cache`, `mcp/index` and `commandExists` are not bounded, along with any other unbounded probe (NG3): no task touches them.
- No stricter Copilot "installed" detection (NG2) and no parallel `list` (NG5): no task touches `commandExists` or `list.ts`.
- No process-group kill and no configurable timeout: Task 1 does not add `detached` or an env var.
- No new user-visible output on timeout (AC5): Tasks 2 and 3 only add `logger.debug`.
- No git operations, and no edits to `package-lock.json` or the codemie config: none of the tasks do any.
