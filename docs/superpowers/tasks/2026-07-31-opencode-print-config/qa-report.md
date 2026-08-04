# QA Gate Report — opencode-print-config

**Branch**: feat/opencode-print-config
**Runner**: npm
**Started**: 2026-07-31T16:00:00.000Z
**Status**: PASSED

## Gates

| Gate | Source | Status | Duration | Command | Notes |
|------|--------|--------|----------|---------|-------|
| license-check | guide | PASS | ~1s | `npm run license-check` | No missing/stale Apache-2.0 headers. |
| lint | guide | PASS | ~3s | `npm run lint` | Zero errors, zero warnings across `src` + `tests`. |
| typecheck | guide | PASS | ~4s | `npm run typecheck` | No diagnostics. |
| build | guide | PASS | ~10s | `npm run build` | `dist/` rebuilt; `copy-plugin` succeeded. |
| unit | guide | PASS | ~9s | `npm run test:unit` | 176 files, 2536 passed, 1 skipped. |
| integration | guide | PASS | ~12s | `npm run test:integration` | 30 files, 204 passed, 10 skipped. |
| ui | guide | SKIPPED | — | (n/a) | No UI surface changed — diff touches only `src/agents/core/**` and `tests/integration/opencode/**`, no `.tsx/.jsx/.css/.html` files. |
| secrets | guide | SKIPPED | — | `npm run validate:secrets` | Self-skipped: "No staged changes to scan" (nothing was staged at gate-run time; all changes were already committed). The same Gitleaks-backed scan already ran clean via `.husky/pre-commit` on every commit in this branch — most recently the fix-up commit `4b2ce5f`, which reported "no leaks found". To re-run this gate standalone: `git diff main...HEAD --name-only \| xargs git add -N && npm run validate:secrets`. |
| commitlint | guide | PASS | ~1s | `npm run commitlint:last` (+ full-range `commitlint --from main --to HEAD` for completeness) | 0 problems across all 6 commits on the branch. |

## Failure detail (if any)

None — all gates passed or self-skipped for a documented, non-blocking reason.

## Drift signal

no
