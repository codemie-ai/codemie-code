DONE

Commit: 4eb1375 — fix(utils): use running copy's prefix in restoreCliBinLink
Changed paths:
- src/utils/cli-bin.ts
- src/utils/__tests__/cli-bin.test.ts

Test command:
npx vitest run src/utils/__tests__/cli-bin.test.ts > docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log

RED/GREEN: RED — new test mocking `deriveSelfPrefix` to return `/home/u/.codemie/npm-prefix` failed because `exec` (`npm prefix -g`) was still called. GREEN — after `restoreCliBinLink` calls `deriveSelfPrefix()` first and uses it as the prefix when non-null (skipping the `npm prefix -g` exec entirely), falling back to the existing lookup otherwise, all 9 tests passed.

Concerns: none. Existing 8 tests mock `deriveSelfPrefix` to return `null` via the module-level mock default, so they exercise the unchanged `npm prefix -g` path. Combined run with processes.test.ts and npm-prefix.test.ts: 69 passed. `npm run typecheck`: clean.
