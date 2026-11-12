DONE

Commit: 6244bd2b feat(analytics): remove git working copy on sync uninstall

Changed paths:
- src/cli/commands/analytics/sync/uninstall.ts (modified: header, UninstallDeps, runUninstall, createRealUninstallDeps)
- src/cli/commands/analytics/sync/__tests__/uninstall.test.ts (modified)

Test command:
`npx vitest run --project unit src/cli/commands/analytics/sync/__tests__/uninstall.test.ts`

TDD evidence:
- RED: 4 failing assertions (missing "local git working copy was removed" / "last-sent markers" text, "nothing to remove" fired with working copy present), EXIT=1.
- GREEN: `Test Files 1 passed (1)`, `Tests 9 passed (9)`, EXIT=0.

Changed exported symbols:
- `UninstallDeps.removeWorkingCopy(): Promise<boolean>` (new field)
- `runUninstall`/`createRealUninstallDeps` behavior updated (signatures unchanged)

Real `removeWorkingCopy` does `stat(gitWorkingCopyPath())` to capture prior existence, then `rm(..., { recursive: true, force: true })`, returning that existence boolean. "Nothing to remove" now requires job, settings and working copy all absent. Kept-line now names both markers.

Verification: `npm run typecheck` EXIT=0. `npx eslint` on both changed files, `--max-warnings=0`, EXIT=0. Full suite once: `npx vitest run --project unit src/cli/commands/analytics` → 44 files / 696 tests passed, EXIT=0 (some stray `error: unknown command 'config'` stderr lines from an unrelated subprocess-stub test, not a failure). Pre-commit hooks (lint-staged, typecheck, gitleaks) passed.

Concerns: none.
