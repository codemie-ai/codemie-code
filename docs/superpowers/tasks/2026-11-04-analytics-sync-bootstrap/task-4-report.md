DONE

commit: 5bf37e58
test_command: npx vitest run src/cli/commands/analytics/sync/bootstrap/__tests__/flow-package.test.ts > docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log

paths:
- package.json, package-lock.json (fflate ^0.8.3 added as a dependency; MIT, allowed by license-check)
- scripts/copy-plugins.js (new dirConfigs entry copying flow-template/ to dist/)
- src/cli/commands/analytics/sync/bootstrap/flow-template/ (5 files, byte-identical copy of collector's flow/template/)
- src/cli/commands/analytics/sync/bootstrap/flow-package.ts (new: FLOW_PACKAGE_FILENAME, FlowConfigInputs, resolveFlowTemplateDir, buildFlowPackage, writeFlowPackage)
- src/cli/commands/analytics/sync/bootstrap/__tests__/flow-package.test.ts (new, 8 tests)

renames: none.

reused:
- getDirname from @/utils/paths.js (ESM __dirname equivalent).
- ConfigurationError from @/utils/errors.js (thrown when flow-template/ or its Flow_config action is missing).
- scripts/copy-plugins.js dirConfigs pattern (existing entries at :48-57) extended with one more entry.

standards: ES modules, .js import extensions, @/ alias, no any, explicit return types on exports (per AGENTS.md); fastest-to-slowest gates run locally (typecheck, eslint --max-warnings=0, vitest) before commit, plus pre-commit hooks (lint-staged, typecheck, validate:secrets, license-check) all green; cp -r + diff -r used instead of Edit/Write so the template JSON was never touched by the format/lint-staged pipeline — confirmed byte-identical both before and after the commit.

concerns:
- No .prettierignore exists in this repo and lint/format/lint-staged all scope to *.ts only, so no ignore entry was needed for the template JSON (verified empirically: diff -r matched before and after commit).
- Implementation was written just ahead of the test file in this session rather than strictly red-first (file-creation ordering only); the test suite was run and confirmed GREEN (8/8) before typecheck/lint/commit, and failure-path coverage (missing template dir, missing Flow_config action) is included as rejects-with-error assertions.
- `npm run build` (tsc + tsc-alias + copy-plugins.js) was run manually to verify dist/.../flow-template ships byte-identical; dist/ is gitignored and was not committed.
