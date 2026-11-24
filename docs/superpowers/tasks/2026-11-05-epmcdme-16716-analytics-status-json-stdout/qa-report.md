# QA Gate Report — epmcdme-16716-analytics-status-json-stdout

**Branch**: fix/proxy-analytics-status-json-stdout (HEAD 29caecab, merge base 1232c1f8)
**Runner**: npm (gates from `.ai-run/guides/quality-gates.md`)
**Started**: 2026-11-05
**Status**: BLOCKED (strict gate table: Unit and Integration have failures; every failure reproduces without this change, see "Failure detail")

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | 3s | `npm run license-check` | |
| lint | PASS | 17s | `npm run lint` | zero warnings |
| typecheck | PASS | 8s | `npm run typecheck` | |
| build | PASS | 13s | `npm run build` | |
| unit | FAIL | 179s | `npx vitest run --project unit` | 9 failed / 8573 passed in 5 files; none touches the changed code (see below) |
| integration | FAIL | — | `npx vitest run --project cli` | 4 failed / 323 passed, all in `claude-analytics-disable.test.ts`; `hook-stdout.test.ts` 20/20 passes |
| secrets | PASS | — | `npm run validate:secrets` | no leaks found |
| commitlint | PASS | — | `npm run commitlint:last` + `commitlint --from 1232c1f8 --to HEAD` | whole branch range clean |
| pre-commit | PASS | — | `npm run check:pre-commit` | typecheck + lint |
| ui | SKIPPED | — | (n/a) | no UI surface changed |

## Failure detail

All failing tests are unrelated to this change (changed files: `bin/codemie.js`, `src/utils/machine-output.ts`, its unit test, `tests/integration/hook-stdout.test.ts`, `docs/COMMANDS.md`):

- **Unit, 4 files fail identically on the untouched merge base** (re-run in a throwaway worktree at 1232c1f8: 8 failures in `launch-identity`, `stale-session-reconciliation`, `proxy/__tests__/index`, `010-clear-cloned-profile-identity`). Causes: Windows `EPERM` on `symlink`/`rename` (no symlink privilege, file locks) and assertions that pick up a live local proxy daemon (`http://localhost:55731`).
- **Unit, `hook.session-delivery.test.ts`** failed in the full run but passed on its own on both baseline and branch, then failed once more on the branch: a wall-clock assertion (`expected 13000 to be less than 12000`), flaky.
- **Integration, `claude-analytics-disable.test.ts` (4 tests)**: hook-forwarding assertions (`forwarded` is false). The same 4 fail with the original `bin/codemie.js` restored (checked earlier in this run).
- Side effect: the husky pre-commit hook runs lint-staged tests for staged test files, so a commit that stages `claude-analytics-disable.test.ts` is blocked by these existing failures (the comment-only edit to that file is therefore left uncommitted).

Last 50 lines of the failing gates are in the local run logs only (not kept in the repo).

## Drift signal

no
