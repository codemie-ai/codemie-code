# QA Gate Report — non-interactive-sso

**Branch**: EPMCDME-13953_non-interactive-sso
**Runner**: npm
**Started**: 2026-08-06T17:47:00Z
**Status**: PASSED

## Gates

| Gate  | Source | Status | Duration | Command | Notes |
|-------|--------|--------|----------|---------|-------|
| license-check | guide | PASS | ~2s | `npm run license-check` | exit 0, dependency license report clean |
| lint  | guide | PASS | ~15s | `npm run lint` | `eslint {src,tests}/**/*.ts --max-warnings=0`; zero errors/warnings |
| typecheck | guide | PASS | ~10s | `npm run typecheck` | `tsc --noEmit`; no diagnostics |
| build | guide | PASS | ~20s | `npm run build` | `dist/` rebuilt; all plugin assets copied successfully |
| unit  | guide | PASS | 21.06s | `npm run test:unit` | 183 files / 2636 tests passed, 1 pre-existing skip (unrelated to this change) |
| integration | guide | PASS | 26.19s | `npm run test:integration` | `--project cli` (no network auth); 29 files / 213 tests passed, 1 pre-existing skip |
| ui    | guide | SKIPPED | — | (n/a) | no UI surface changed (diff touches only `src/providers/core/`, `src/utils/`, `docs/`) |
| secrets | hook | SKIPPED | ~1s | `npm run validate:secrets` | self-skipped: "No staged changes to scan" — nothing is staged since commits are deferred to explicit user request per project policy; CI's `gitleaks-action` will scan for real once pushed |
| commitlint | hook | N/A | — | `npm run commitlint:last` | no new commits made this session (implementation is uncommitted, per project git policy) |

## Failure detail (if any)

None. All gates that ran, passed.

## Drift signal

no — implementation matches spec.md's design exactly (new `isNonInteractiveEnvironment()` utility in `src/utils/interactive.ts`, single guard added in `handleAuthValidationFailure`, no other files modified except the fix-up documentation addition in `docs/AUTHENTICATION.md`).

## Notes for the caller

- **Secrets scan is a local self-skip, not a real pass** — it never inspected the actual diff content because nothing is staged. CI's `gitleaks-action` (separate job in `.github/workflows/ci.yml`, scans push/PR diff unconditionally) is the check that actually owes coverage here and has not run yet.
- **Cross-platform Windows CI** (`test-windows` job) was not run locally — same `test:unit`/`test:integration` commands, no CRLF-sensitive files were touched by this change, so no repro attempted.
- **Commitlint** has nothing to check yet since no commits exist for this task.
