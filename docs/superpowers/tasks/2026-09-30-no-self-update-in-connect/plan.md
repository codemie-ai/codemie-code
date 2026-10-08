# No self-update inside CodeMie Connect (EPMCDME-15433) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The CLI never self-updates via npm when bundled in CodeMie Connect (marker `codemie-connect.json` next to its package.json).

**Architecture:** One exported async helper `isCodemieConnectInstall()` in `src/utils/cli-updater.ts` reuses the `getCurrentCliVersion()` path base (`path.resolve(dirname, '../../package.json')` sibling). Both `checkAndPromptForUpdate()` and the `self-update` command call it first.

**Tech Stack:** TypeScript ESM, Vitest, commander.

**Spec:** inline requirements (ticket EPMCDME-15433); research in `technical-analysis.md` beside this file.

Commit per task using the repository's existing convention (Conventional Commits). Stage only own files; never stage `.codemie/codemie-cli.config.json`. No push, no PR.

## Acceptance criteria

- In Connect, startup update check returns silently before `shouldCheckForUpdate()`, lock, last-check file, npm, or prompt (even with `CODEMIE_AUTO_UPDATE=false`).
- In Connect, `self-update` with or without `--check` prints exactly "This CodeMie CLI is part of CodeMie Connect. Update it from the CodeMie Connect app." and exits 0, with no spinner and no npm.
- Without the marker, behavior is unchanged; `bin/codemie.js` and `tests/integration/cli-commands/self-update.test.ts` are untouched.

## Global Constraints

ESM `.js` import extensions, `logger.debug` for swallowed errors, no `any`, explicit return types. Helper/startup tests go in `src/utils/__tests__/cli-updater.test.ts`; the command guard test goes in the new `src/cli/commands/__tests__/self-update.test.ts`. Never run `codemie` from PATH; use `node bin/codemie.js`.

## Task 1: Helper + startup guard

**Files:**
- Modify: `src/utils/cli-updater.ts` (add helper after `getCurrentCliVersion()`, ~l.56; guard at top of `checkAndPromptForUpdate()`, ~l.328)
- Test: `src/utils/__tests__/cli-updater.test.ts`

**Interfaces:**
- Produces: `export async function isCodemieConnectInstall(): Promise<boolean>`

Test-first: yes — helper returns true when the marker exists and false when absent; `checkAndPromptForUpdate()` in Connect never calls `getLatestVersion`/`installGlobal` nor writes the last-check file; without the marker the path still proceeds (calls `getLatestVersion`).

- [ ] **Step 1: Write failing tests.** In the existing test file add a `describe` block. Mock `fs/promises` (partial via `vi.mock('fs/promises', ...)` with `default` exposing `access`, `readFile`, `writeFile`, `unlink`, `mkdir`) or use `vi.spyOn(fs, 'access')` on the default import; control marker presence by resolving/rejecting `access` only for a path ending in `codemie-connect.json`. Cases: (a) helper true with marker, (b) helper false without marker (rejected access, no throw), (c) Connect: `checkAndPromptForUpdate()` resolves, `getLatestVersion` and `installGlobal` not called, `fs.writeFile` not called for `.last-update-check`, also with `CODEMIE_AUTO_UPDATE=false` (inquirer not invoked); (d) no marker: `getLatestVersion` is called (make `readFile` reject for last-check so `shouldCheckForUpdate()` proceeds). Restore env in `afterEach`.
- [ ] **Step 2:** Run `npx vitest run src/utils/__tests__/cli-updater.test.ts`; expect the new tests FAIL (helper undefined).
- [ ] **Step 3: Implement.** Add the helper: resolve `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../codemie-connect.json')`, `await fs.access(...)` -> true; catch -> `logger.debug('CodeMie Connect marker not found:', error)` and return false. In `checkAndPromptForUpdate()` add `if (await isCodemieConnectInstall()) return;` as the first statement, before the `try` that calls `shouldCheckForUpdate()` (so the catch's `releaseUpdateLock()` is never reached). Add one line to the header comment noting Connect installs never self-update.
- [ ] **Step 4:** Re-run the test file; expect PASS.

## Task 2: self-update command guard + test

**Files:**
- Modify: `src/cli/commands/self-update.ts:4-21` (import helper; check as first statement in the action, before `ora(...)`)
- Create: `src/cli/commands/__tests__/self-update.test.ts` (sibling of the existing `__tests__` files in that dir)

**Interfaces:**
- Consumes: `isCodemieConnectInstall(): Promise<boolean>`

Test-first: yes — with the helper mocked to true, running `self-update` and `self-update --check` prints the Connect line, calls neither `checkForCliUpdate` nor `updateCli`, and never calls `process.exit` with a non-zero code.

- [ ] **Step 1: Write failing test.** `vi.mock('../../../utils/cli-updater.js', ...)` returning `isCodemieConnectInstall: vi.fn().mockResolvedValue(true)`, `checkForCliUpdate: vi.fn()`, `updateCli: vi.fn()`, `isAutoUpdateEnabled: vi.fn()`; mock `ora` so an accidental spinner is detectable. Spy on `console.log` and `process.exit` (mockImplementation no-op). Build the command via `createSelfUpdateCommand()` and `await command.parseAsync(['node', 'self-update'])` / `[..., '--check']` (fresh command per case). Assert: `console.log` called with the exact Connect line, `checkForCliUpdate`/`updateCli`/`ora` not called, `process.exit` not called with a non-zero code. Follow the dynamic-import mocking pattern in `.ai-run/guides/testing/testing-patterns.md`; restore mocks in `afterEach`.
- [ ] **Step 2:** Run `npx vitest run src/cli/commands/__tests__/self-update.test.ts`; expect FAIL (guard absent, so `checkForCliUpdate` gets called).
- [ ] **Step 3: Implement.** Inside the existing `try`, before the spinner: `if (await isCodemieConnectInstall()) { console.log('This CodeMie CLI is part of CodeMie Connect. Update it from the CodeMie Connect app.'); return; }` (plain text; a plain `return` yields exit code 0 and keeps the `catch` and its `process.exit(1)` unreachable). Add the import to the existing import list.
- [ ] **Step 4:** Re-run the test file; expect PASS.

## Task 3: Mutation check

**Files:** `src/utils/cli-updater.ts` and `src/cli/commands/self-update.ts` (temporary edits, each restored), no other changes.

Test-first: no — verification of the tests from Tasks 1 and 2.

- [ ] **Step 1:** Temporarily remove the guard in `self-update.ts`; run `npx vitest run src/cli/commands/__tests__/self-update.test.ts`; confirm the new test fails. Restore.
- [ ] **Step 2:** Temporarily remove the marker check in the helper (make it always return false); run `npx vitest run src/utils/__tests__/cli-updater.test.ts`; confirm at least one new test fails. Restore.
- [ ] **Step 3:** Confirm `git diff src/utils/cli-updater.ts src/cli/commands/self-update.ts` matches Tasks 1 and 2 only; re-run both test files and confirm PASS.
- [ ] **Step 4:** Manual check after `npm run build`: create a temporary `codemie-connect.json` in the repo root, run `node bin/codemie.js self-update --check` and `node bin/codemie.js self-update`, confirm the one-line message and exit 0; delete the marker afterward (it must not remain, or TC-030 breaks).

## Task 4: Gates (run by the flow; listed for the record)

Not a separate implementation task: the flow runs `npm run lint`, `npm run typecheck`, the unit test project, `npm run build`, then `npx vitest run tests/integration/cli-commands/self-update.test.ts` (needs network). The agent test project is skipped.

## Negative-constraint pass

- No prompt/lock/last-check/npm in Connect, even with `CODEMIE_AUTO_UPDATE=false`: Task 1 guard sits before `shouldCheckForUpdate()` and the `try`/catch.
- `bin/codemie.js` unchanged: no task edits it.
- No npm/spinner in self-update in Connect: Task 2 guard precedes `ora` and `checkForCliUpdate`; its test asserts neither is called.
- Exit 0 (no non-zero exit) in Connect: Task 2 uses plain `return`; test asserts no non-zero `process.exit`.
- No-marker installs unchanged: Task 1 test (d), integration test untouched.
- Integration test `tests/integration/cli-commands/self-update.test.ts` untouched: no task edits it.
- Do not commit `.codemie/codemie-cli.config.json`, no push/PR, no `codemie` from PATH: stated in header and constraints.
