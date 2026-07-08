# QA Gate Report — analytics-session-filter-bug

**Branch**: fix/analytics-session-filter
**Runner**: npm
**Started**: 2026-07-08T22:40:00Z
**Status**: PASSED

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | <1s | `npm run license-check` | No missing/stale Apache-2.0 headers |
| lint | PASS | ~3s | `npm run lint` | Zero errors, zero warnings |
| typecheck | PASS | ~5s | `npm run typecheck` | No diagnostics (also fixed a pre-existing unrelated error, see note below) |
| build | PASS | ~10s | `npm run build` | dist/ rebuilt, plugin assets copied |
| unit | PASS | 6.96s | `npm run test:unit` | 2240 passed, 1 skipped, 150 files |
| integration | PASS | 19.15s | `npm run test:integration` | 203 passed, 1 skipped, 27 files — see note below |
| secrets | PASS | <1s | `npm run validate:secrets` | Ran per-commit via pre-commit hook (no leaks); no staged changes at gate time |
| commitlint | PASS | <1s | `npx commitlint --from HEAD~5 --to HEAD` | All 5 commits on this branch conform |
| ui | SKIPPED | — | (n/a) | No UI surface changed (diff touches only .ts files) |

## Notes

- **Pre-existing environment gap (fixed, unrelated to this change's logic):** `node-pty` was declared in `package.json` but not installed in this checkout, failing 8 integration test files (`skills-integration.test.ts`, `cli-commands/{doctor,error-handling,help,list,profile,version,workflow}.test.ts`) with `Cannot find package 'node-pty'`. Ran `npm install node-pty` to install it (package.json already listed it; package-lock.json only lost 12 stray `"peer": true` metadata lines — no dependency version changes). All 27 integration files pass after the install.
- **Pre-existing typecheck error (fixed as part of this branch, with explicit user approval):** `src/utils/auth.ts` referenced a `jwt_token` field that doesn't exist on `CodeMieClientConfig` (the SDK reads `external_token`), breaking `tsc --noEmit` repo-wide and blocking every commit's pre-commit hook. Fixed in a separate commit (`fix(utils): use external_token instead of nonexistent jwt_token SDK field`).
- The golden-dataset analytics test (`tests/integration/analytics.test.ts`) — the one most relevant to this fix — passes fully (7/7).

## Drift signal

no
