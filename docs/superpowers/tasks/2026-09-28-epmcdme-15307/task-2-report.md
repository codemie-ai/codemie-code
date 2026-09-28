DONE

Commit: 8e25ebb — fix(utils): pass self prefix to npm install/uninstall/list for @codemieai/code
Changed paths:
- src/utils/processes.ts
- src/utils/__tests__/processes.test.ts

Test command:
npx vitest run src/utils/__tests__/processes.test.ts > docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log

RED/GREEN: RED — 3 new tests (installGlobal/uninstallGlobal/listGlobal splice self-prefix argv) failed with the pre-fix argv (missing `--prefix C:\X`), 38 pre-existing tests still passed. GREEN — after splicing `...(await getSelfPrefixArgs(packageName))` into all three helpers (before `--force` in installGlobal; inside the existing try in listGlobal), all 41 tests passed.

Concerns: none. Existing `test-package` argv assertions are byte-identical to before (mock returns `[]` for any package other than `@codemieai/code`). Combined run with cli-bin.test.ts and npm-prefix.test.ts: 69 passed. `npm run typecheck`: clean.
