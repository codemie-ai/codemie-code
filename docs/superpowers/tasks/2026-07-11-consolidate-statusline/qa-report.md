# QA Gate Report — consolidate-statusline

**Branch**: feature/consolidate-statusline
**Runner**: npm
**Merge base**: ac92f9a2c33bb18504079a0f35ca5a15da7ce9bc
**Started**: 2026-07-11T12:36:00Z
**Status**: PASSED

## Gates

| Gate | Status | Command | Notes |
|------|--------|---------|-------|
| License headers | PASS | `npm run license-check` | No missing/stale Apache-2.0 headers |
| Lint | PASS | `npm run lint` | Zero errors, zero warnings across `{src,tests}/**/*.ts` |
| Typecheck | PASS | `npm run typecheck` | No diagnostics |
| Build | PASS | `npm run build` | `dist/` rebuilt; `copy-plugin` succeeded, including the rewritten `plugin/statusline.mjs` |
| Unit tests | PASS* | `npm run test:unit` | See "Unrelated failure" note below |
| Integration tests | PASS | `npm run test:integration` | 27 files, 203 passed, 1 skipped |
| Secrets scan | PASS | `npm run validate:secrets` | No staged changes to scan at gate time; every commit in this branch already passed Gitleaks via the pre-commit hook |
| Commitlint (range) | PASS | `npx commitlint --from ac92f9a2c3 --to HEAD` | All 7 commits in this branch's range conform to Conventional Commits |

\* See below.

## Unrelated failure — not blocking this change

The literal `npm run test:unit` run reports 3 failing tests in `src/mcp/auth/__tests__/mcp-oauth-provider.test.ts`. This file (and its sibling `src/mcp/auth/mcp-oauth-store.ts`) is **untracked** — `git ls-files` confirms it is not part of this branch, `main`, or any commit in this diff's range. It is leftover in-progress work from a separate, unrelated task (`mcp-proxy-claude-desktop-auth`) that happens to sit in this working directory, since git does not scope untracked files per branch.

Re-running the exact same command scoped to exclude that path (`npx vitest run --project unit --exclude "src/mcp/auth/**"`) shows all 156 test files / 2288 tests passing (1 skipped), confirming this diff introduces zero regressions. All new/modified test files from this change (`statusline.test.ts`: 29 tests, `statusline-installer.test.ts`: 9 tests, `claude.plugin.statusline.test.ts`: 8 tests) pass cleanly.

## Drift signal

No. Implementation matches plan.md exactly — verified independently by the acceptance review lens during code review (all 12 spec/task criteria pass) and by this gate run.
