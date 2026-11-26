DONE

Commit: 211f9026 feat(analytics): add git target options and test push to sync install

Changed paths:
- docs/ANALYTICS-REPORT.md
- src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts
- src/cli/commands/analytics/index.ts
- src/cli/commands/analytics/sync/__tests__/install.test.ts
- src/cli/commands/analytics/sync/install.ts

Test command:
`npx vitest run src/cli/commands/analytics/sync/__tests__/install.test.ts src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts`

TDD evidence:
- RED: added `testGitPush`/`removeWorkingCopy` to the test harness and 4 new tests (order,
  auth-failure rollback, webhook-only no-op, summary repository line). Ran: 3 failed —
  `testGitPush` never called, exit code 0 instead of 1, "Repository:" missing from output.
  Failures were assertion mismatches (feature missing), not crashes/typos.
- GREEN: implemented `testGitTarget`/`printGitFailure` in install.ts, wired into `runInstall`
  between the collector check and `replaceJob`, added `testGitPush`/`removeWorkingCopy` to
  `InstallDeps` and `createRealInstallDeps`. One test still failed after first pass because
  the test's own override var wasn't the one asserted on (test-construction bug, not prod
  code) — fixed the test, then 35/35 passed, then 37/37 after adding CLI-option tests.

Changed exported symbols:
- `InstallDeps` (install.ts): added `testGitPush(git, email)`, `removeWorkingCopy()`.
  Call sites updated: `createRealInstallDeps` (real: `GitTarget(...).testPush()`,
  `rm(gitWorkingCopyPath(), {recursive:true,force:true})`), both test files' mocks.
- No other exported signatures changed.

Helpers reused: `GitTarget.testPush`/`gitWorkingCopyPath` (Task 3), `createGitRunner`/
`gitHint` (Task 2), `SyncGitError.gitCause` (Task 2), `redactSecrets` (existing),
`validateInstallOptions` (Task 1, untouched).

CLI: added `--git-repo <url>`, `--git-branch <name>`, `--git-path <dir>`, `--format <json>`
to `sync install` only (run/uninstall have no `--webhook` either, so no git options were
added there — only their descriptions were reworded, per the task's own instruction to
cover "webhook and/or team git repository"). Reworded: sync group description, `run`
description, `--webhook` help text, uninstall doc comment.

Verification: target tests 37/37 PASS; `npx vitest run --project unit src/cli/commands/analytics`
684/684 PASS; `npm run typecheck` clean; `eslint --max-warnings=0` clean on all 4 changed
.ts/.test.ts files; pre-commit hook (lint-staged + typecheck + gitleaks) passed on commit.

Concerns: none. Pre-existing unrelated sso.auth-gate failure not encountered/relevant here.
