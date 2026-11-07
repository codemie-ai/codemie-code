# Session report default output under CodeMie home (EPMCDME-14585) Implementation Plan

**Goal:** Default session report output is `getCodemiePath('analytics')/codemie-analytics-[email-]<sessionId>.json` instead of `<cwd>/docs/codemie/analytics`.

**Conventions:** Commit per task using the repository's existing convention (Conventional Commits, body `Refs: EPMCDME-14585`, no Co-Authored-By/attribution footer). Stage files by explicit path; never stage `.codemie/codemie-cli.config.json`. Do not push or open a PR. Subdirectory name `analytics` is an assumption (ticket does not name it). ES modules, `.js` import extensions.

**Verified:** `generateReportJson` (`report-generator.ts:59-60`) already runs `mkdirSync(dirname(outputPath), { recursive: true })`, so no extra directory creation is needed. `BaseAgentAdapter` passes no `outputPath`, so no adapter logic changes.

**Negative constraints:** explicit `outputPath` unchanged (Task 1 keeps `??` precedence, test retained); `CODEMIE_SESSION_ANALYTICS_REPORT=0` unchanged (Task 2 test); do not edit `openwiki/` or historical `docs/superpowers/` records (Task 3 touches only `docs/ANALYTICS-REPORT.md`); legacy files in `docs/codemie/analytics` not used or modified (Task 1 regression test); do not stage the config file (header).

### Task 1: Change default path, JSDoc, and regression test

**Files:** `src/cli/commands/analytics/report/session-report.ts` (lines 8, 18, 66-68); test `src/cli/commands/analytics/report/__tests__/session-report.test.ts`.

**Test-first: yes — with `CODEMIE_HOME` set to temp dir A and `process.cwd()` spied to temp dir B (containing `.git/` and a pre-existing `docs/codemie/analytics/legacy.json`), `generateSessionReport` without `outputPath` calls the writer with a path equal to `A/analytics/codemie-analytics-<id>.json`; it fails against the current cwd default.**

- [ ] Extend the existing default-path test (lines 89-104) to also assert the path's dirname equals `getCodemiePath('analytics')` under a temp `CODEMIE_HOME`.
- [ ] Add the regression test described above (use `mkdtempSync` dirs, restore env/spy in `afterEach`, remove temp dirs). Assert: path starts with `A/analytics`, does not start with `B`, `B/docs/codemie/analytics` contains only `legacy.json` afterwards (mocked writer writes nothing, so also assert no call path lies under B). Add a case that explicit `outputPath` still wins over the default.
- [ ] Run the new tests; confirm they fail.
- [ ] In `session-report.ts` replace the `join(process.cwd(), 'docs', ...)` default with `join(getCodemiePath('analytics'), \`codemie-analytics-${emailPrefix}${options.sessionId}.json\`)`; import `getCodemiePath` from `../../../../utils/paths.js` (or `@/utils/paths.js` matching the file's neighbours); drop `docs`/`process.cwd()` usage.
- [ ] Update the line 18 JSDoc: default is `<CODEMIE_HOME or ~/.codemie>/analytics/codemie-analytics-[email-]<sessionId>.json`.
- [ ] Run the test file; confirm green.
- [ ] **Mutation check:** temporarily restore the old default (`join(process.cwd(), 'docs','codemie','analytics', ...)`), re-run the file, and confirm the new regression test (and the extended default-path assertion) fail while the other tests still pass; then revert the mutation (`git diff` must show only the intended change) and re-run to green.
- [ ] Commit: `fix(analytics): write session reports under the CodeMie home, not the user's repo`.

### Task 2: Adapter-level test coverage

**Files:** test `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts` (existing assertion at ~line 45, kill-switch test).

**Test-first: no — characterization tests on already-correct adapter behavior; no production change.**

- [ ] Keep/strengthen the assertion that `generateSessionReport` is called without `outputPath` (so the new home default applies), and confirm the `CODEMIE_SESSION_ANALYTICS_REPORT=0` case still skips the call. Run the file; commit with `test(analytics): cover session report default path at the adapter boundary`.

### Task 3: Update user documentation

**Files:** `docs/ANALYTICS-REPORT.md:260`.

**Test-first: no — documentation only.**

- [ ] Replace `./docs/codemie/analytics/...` with `<CODEMIE_HOME or ~/.codemie>/analytics/codemie-analytics-[<email>-]<session_id>.json`, and add one sentence that nothing is written into the working repository (use `getCodemiePath` semantics: `CODEMIE_HOME` overrides `~/.codemie`). Commit with `docs(analytics): document session report location under the CodeMie home`.
