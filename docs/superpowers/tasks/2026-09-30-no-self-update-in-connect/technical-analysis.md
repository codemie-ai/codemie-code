# Technical Research

**Task**: cli-updater self-update connect
**Generated**: 2026-09-30
**Research path**: filesystem

---

## 1. Original Context

task_context: EPMCDME-15433 — CodeMie Connect bundles its own CodeMie CLI; the CLI must recognise it is the Connect-bundled copy and stop self-updating via npm.
Requirements (from user, verbatim essentials):
- Detection: file `codemie-connect.json` exists next to the CLI's own package.json (node_modules/@codemieai/code/codemie-connect.json). getCurrentCliVersion() in src/utils/cli-updater.ts already resolves package.json via path.resolve(dirname, '../../package.json'); same base works. npm/bootstrap installs never have the file, behavior unchanged. File is written by the app, not this repo.
- Background check: bin/codemie.js calls checkAndPromptForUpdate() on every start. Inside Connect it must return before touching npm or the last-check file (skip silently, no prompt even if CODEMIE_AUTO_UPDATE=false).
- `codemie self-update` (src/cli/commands/self-update.ts), with or without --check: inside Connect print one line telling the user to update from the CodeMie Connect app ("This CodeMie CLI is part of CodeMie Connect. Update it from the CodeMie Connect app.") and exit 0 without calling npm.
- One small helper in cli-updater.ts used by both.
- Tests go in src/utils/__tests__/cli-updater.test.ts; tests/integration/cli-commands/self-update.test.ts (self-update --check without marker) must stay green unchanged. Mutation check on the new tests required.
- Keep the change small. Do not run `codemie` from PATH; use node bin/codemie.js.

---

## 2. Codebase Findings

### Existing Implementations
- `/Users/mert_efe/codemie-installers/codemie-code/src/utils/cli-updater.ts` (411 lines) — all updater logic.
  - `getCurrentCliVersion()` (l.42-56): `path.dirname(fileURLToPath(import.meta.url))` then `path.resolve(dirname, '../../package.json')`, read with `fs/promises`, returns `version` or null; try/catch with `logger.debug`. Works from both `src/utils/` and `dist/utils/`.
  - `shouldCheckForUpdate()` / `recordUpdateCheck()` (l.62-89): read/write `LAST_CHECK_FILE` = `<getCodemiePath()>/.last-update-check`, computed at module load (l.32).
  - `acquireUpdateLock()` / `releaseUpdateLock()`: `.update-lock` file.
  - `isAutoUpdateEnabled()` (l.152): `parseBooleanEnv(process.env.CODEMIE_AUTO_UPDATE, true)`.
  - `checkForCliUpdate()` (l.174): calls `getLatestVersion(CLI_PACKAGE_NAME)` (npm view).
  - `updateCli()` (l.266): `installGlobal` (npm).
  - `checkAndPromptForUpdate()` (l.328-410): first statement inside `try` is `shouldCheckForUpdate()`; then `checkForCliUpdate()`, `recordUpdateCheck()`, then silent update or prompt. The `catch` block calls `releaseUpdateLock()` (unlinks the lock file) on any error.
- `/Users/mert_efe/codemie-installers/codemie-code/src/cli/commands/self-update.ts` (68 lines) — `createSelfUpdateCommand()`; action starts `ora` spinner immediately, calls `checkForCliUpdate()`, exits 1 if null, prints up-to-date / update-available, `--check` returns early, otherwise `updateCli(..., false)`. Imports `checkForCliUpdate, updateCli, isAutoUpdateEnabled` from `../../utils/cli-updater.js`. Errors caught -> `process.exit(1)`.
- `/Users/mert_efe/codemie-installers/codemie-code/bin/codemie.js` l.9, l.37-43: imports `checkAndPromptForUpdate` from `../dist/utils/cli-updater.js`; skipped when `NODE_ENV=test` or `VITEST=true`; wrapped in try/catch. Note: bin runs built `dist/`, so a build is needed before `node bin/codemie.js` reflects changes.
- Other consumer: `src/agents/core/BaseAgentAdapter.ts:35` imports `getCurrentCliVersion` (mocked in `BaseAgentAdapter.version-notice.test.ts`).
- No existing reference to `codemie-connect` / Connect marker anywhere in `src` (greenfield addition).

### Architecture and Layers Affected
- Utility layer: `src/utils/cli-updater.ts`.
- CLI layer: `src/cli/commands/self-update.ts`.
- Entry point: `bin/codemie.js` (unchanged by design; it only calls `checkAndPromptForUpdate`).

### Integration Points
- npm (`getLatestVersion`, `installGlobal` in `src/utils/processes.ts`), `~/.codemie` state files via `getCodemiePath()`.
- `package.json` `files` list (dist, bin, scripts, ...) does not include `codemie-connect.json`; the marker is written externally by the Connect app into the installed package directory.

### Patterns and Conventions
- ESM, `.js` import extensions, `fs/promises` default import in cli-updater, `logger.debug` for diagnostics, explicit return types on exports (AGENTS.md).
- Failure to read state is swallowed with `logger.debug` (non-blocking startup pattern).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage, project.md, quality-gates.md). Relevant: `testing/testing-patterns.md` (Vitest, dynamic-import mocking), `development/development-practices.md`, `quality-gates.md`. Not opened in detail; findings above come from code.
- `docs/COMMANDS.md` l.1222 documents `codemie self-update`; README.md l.509 mentions it.

### Architectural Decisions
- None found specific to Connect. AGENTS.md: tests only on explicit request (this task requests them explicitly); git ops only on request.

### Derived Conventions
- Env-controlled behavior lives in `cli-updater.ts` header comment (l.7-10); it documents CODEMIE_AUTO_UPDATE and CODEMIE_UPDATE_CHECK_INTERVAL.

---

## 4. Testing Landscape

### Existing Coverage
- `/Users/mert_efe/codemie-installers/codemie-code/src/utils/__tests__/cli-updater.test.ts` (58 lines) — only `updateCli` failure fallback message (2 tests). No coverage of `getCurrentCliVersion`, `checkAndPromptForUpdate`, rate limiting, or locks.
- `/Users/mert_efe/codemie-installers/codemie-code/tests/integration/cli-commands/self-update.test.ts` (TC-030) — spawns `node bin/codemie.js self-update --check` against the real npm registry and real repo (no marker in repo root); expects exit 0 and `/is up to date|Update available/i`. Requires network and a built `dist/`.

### Testing Framework and Patterns
- Vitest. Existing file uses `vi.mock` for `../logger.js`, `../paths.js` (`/tmp/.codemie`), `../processes.js` (`installGlobal`, `getLatestVersion`), `../npm-prefix.js`; `vi.clearAllMocks()` in `beforeEach`; console spied with `vi.spyOn`. `fs/promises` is NOT mocked, so a marker test must either mock `fs/promises` or `fs`, or use a temp dir/real file next to the resolved package.json.
- `inquirer` and `chalk` are not mocked.

### Coverage Gaps
- `checkAndPromptForUpdate` has no tests (no assertion that npm / last-check file is untouched). `self-update.ts` has no unit tests; only the integration test.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_AUTO_UPDATE` (default true; false = prompt), `CODEMIE_UPDATE_CHECK_INTERVAL` (default 86400000), read in `cli-updater.ts` (interval read at module load). `NODE_ENV=test` / `VITEST=true` disable the startup check in `bin/codemie.js`.

### Configuration Files
- `.codemie/codemie-cli.config.json` is modified in the working tree (pre-existing, unrelated).

### Feature Flags and Deployment Concerns
- State files: `~/.codemie/.last-update-check`, `~/.codemie/.update-lock`.
- `package.json` `postinstall`: `scripts/postinstall.mjs` (not inspected).

---

## 6. Risk Indicators

- Speculative: the helper's placement must precede `shouldCheckForUpdate()` in `checkAndPromptForUpdate()`; the `catch` block calls `releaseUpdateLock()`, so an early return must sit before/outside any path that would touch the lock or last-check file.
- Speculative: in `self-update.ts` the `ora` spinner starts before `checkForCliUpdate()`; the marker check would need to run before the spinner/npm call to print only one line.
- Speculative: marker detection via fs at each startup adds one stat on every CLI start; a sync vs async helper choice affects test mocking (module `fs/promises` currently unmocked in the test file).
- Speculative: `getCurrentCliVersion()`'s '../../package.json' base is the same relative path; unit tests that mock `fs` need care since `import.meta.url` resolves to `src/utils/` in vitest.
- `bin/codemie.js` imports from `dist/`; manual verification requires `npm run build` and `node bin/codemie.js` (not PATH `codemie`).
- Integration test TC-030 needs network; a marker file must never exist in repo root or it will break (it would print the Connect message instead of matching the regex).
- Test coverage of the updater is thin (2 tests); mutation check will need tests on both the skip-before-npm and the no-marker path.

---

## 7. Summary for Complexity Assessment

The change touches two source files in two layers: the utility `src/utils/cli-updater.ts` (new small marker helper plus an early return at the top of `checkAndPromptForUpdate`) and the CLI command `src/cli/commands/self-update.ts` (early exit before spinner and npm). `bin/codemie.js` needs no edit. Test surface is `src/utils/__tests__/cli-updater.test.ts`; docs (`docs/COMMANDS.md`) may optionally mention the behavior. File change surface is roughly 3-4 files, small diff.

Technical novelty is low: it reuses the existing path-resolution base of `getCurrentCliVersion()` and the codebase's swallow-and-debug error style. No existing Connect concept exists in `src`, so the marker name is a new external contract owned by the Connect app.

Test posture is weak for this module: only `updateCli` is covered, `fs/promises` is not mocked in the current test file, and no tests exercise `checkAndPromptForUpdate` or the command. The integration test TC-030 is network-dependent and must remain unchanged. Main risks are ordering of the early return relative to rate-limit/lock file access, the spinner in self-update, and correct mocking of the marker in unit tests.

---

## 8. External References

None named by the task
