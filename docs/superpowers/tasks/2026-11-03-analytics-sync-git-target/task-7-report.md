DONE

Commit: acd28675 feat(analytics): add sync install-command builder

Changed paths:
- src/cli/commands/analytics/sync/install-command.ts (new)
- src/cli/commands/analytics/sync/__tests__/install-command.test.ts (new)

Test command:
`npx vitest run --project unit src/cli/commands/analytics/sync/__tests__/install-command.test.ts`

TDD evidence:
- RED: `Cannot find module '../install-command.js'` (module not yet created), EXIT=1.
- GREEN: `Test Files 1 passed (1)`, `Tests 9 passed (9)`, EXIT=0.

Changed exported symbols:
- `InstallCommandOptions` interface (new)
- `buildInstallCommand(opts: InstallCommandOptions): string` (new)

No bootstrap command added (per instruction). `npm run typecheck` EXIT=0. `npx eslint` on both changed files, `--max-warnings=0`, EXIT=0. Pre-commit hooks (lint-staged, typecheck, gitleaks) passed.

Concerns: none.
