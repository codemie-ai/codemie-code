# QA Gate Report — otlp-continued-and-reopened-sessions

**Branch**: EPMCDME-16992_16993_otlp-continued-and-reopened-sessions
**Runner**: npm (gates from `.ai-run/guides/quality-gates.md`)
**Status**: BLOCKED on 12 test failures that also fail on unmodified `main` (c77969d8); every gate on the changed code is green

## Gates

| Gate | Status | Command | Notes |
|------|--------|---------|-------|
| license | PASS | `npm run license-check` | |
| lint | PASS | `npm run lint` | zero warnings |
| typecheck | PASS | `npm run typecheck` | |
| build | PASS | `npm run build` | |
| commitlint | PASS | `npm run commitlint:last` | |
| unit | FAIL | `npx vitest run --project unit` | 9290 passed, 8 failed (5 files); same 8 fail on main |
| integration | FAIL | `npx vitest run --project cli` | 326 passed, 4 failed (1 file); same failures on main |
| ui | SKIPPED | n/a | no UI surface changed |

## Failure detail

All 12 failures were reproduced on a clean worktree of `main` (c77969d8) with the same command, so none comes from this change. They are Windows/machine issues:

- `src/agents/core/session/__tests__/stale-session-reconciliation.test.ts` (2): `EPERM` creating a symlink
- `tests/integration/analytics/claude-analytics-disable.test.ts` (5 asserts): `EBUSY` removing a temp dir
- `src/agents/core/__tests__/launch-identity.test.ts` (2), `src/utils/__tests__/config-per-profile-identity.test.ts` (1): read this machine's own profile config
- `src/agents/plugins/opencode/__tests__/opencode.run-session.test.ts` (1)
- `src/cli/commands/analytics/__tests__/copilot-managed-report.test.ts` (2): fixed-date fixture

All 41 files / 1050 tests under `src/agents/plugins/claude-code-otlp` and `src/cli/commands` pass.

## Drift signal

no
