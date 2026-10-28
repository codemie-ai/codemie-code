# QA Gate Report — global-profiles-share-workspace-identity (EPMCDME-15411)

**Branch**: EPMCDME-15411_global-profile-identity-isolation
**Runner**: npm
**Started**: 2026-10-27T17:15:00Z
**Status**: PASSED

## Gates

| Gate            | Status | Duration | Command                                      | Notes |
|-----------------|--------|----------|-----------------------------------------------|-------|
| license-check   | PASS   | ~1s      | `npm run license-check`                       | No missing/stale Apache-2.0 headers. |
| lint            | PASS   | ~5s      | `npm run lint`                                | 0 errors, 0 warnings (`--max-warnings=0`). |
| typecheck       | PASS   | ~8s      | `npm run typecheck`                           | `tsc --noEmit`, 0 diagnostics. |
| build           | PASS   | ~6s      | `npm run build`                               | `tsc && tsc-alias && copy-plugin`; statusline bundle rebuilt. |
| unit tests      | PASS   | 40.7s    | `npx vitest run --project unit`               | 377 files / 5887 tests passed, 2 skipped. See env-pollution note below. |
| integration     | PASS   | 27.1s    | `npx vitest run --project cli`                | 37 files / 282 tests passed, 1 file / 10 tests intentionally skipped. |
| secrets scan    | PASS   | <1s      | `npm run validate:secrets`                    | Gitleaks: no secrets found (no staged changes at scan time; also ran clean on the fix-up commit via pre-commit). |
| commitlint      | PASS   | <1s      | `npm run commitlint:last`                     | Last commit (`966b64d7`): 0 problems, 0 warnings. All 4 commits on branch follow Conventional Commits. |
| ui              | SKIPPED | —       | (n/a)                                          | No UI surface changed — backend config/migration/statusline-resolution fix only. |

## Failure detail (if any)

None. All gates passed on this run.

## Environment-pollution note (pre-existing, unrelated to this change)

Running the unit-test gate from inside an **active `codemie-claude` CLI session** (this terminal's own shell has real `CODEMIE_URL`, `CODEMIE_MODEL`, etc. exported) causes 6 test files / 14 tests to fail — `sso.auth-gate.test.ts`, `providers-core.test.ts`, `codex.incremental-sync.test.ts`, `opencode.incremental-sync.test.ts`, `pi.incremental-sync.test.ts`, `AgentCLI-model-source.test.ts` — because those files don't clear the real `CODEMIE_*` env vars in `beforeEach` and read live machine state instead of their fixtures. This reproduces identically with **zero code changes on `main`**, confirmed by re-running the same files in isolation before and after unsetting the vars. For this QA report the gate was run with those vars explicitly unset, which is the clean/correct baseline; no production or test code was altered to work around it, since it is out of scope for EPMCDME-15411. Worth a follow-up ticket to add `beforeEach` env clearing to those 6 files so local `npm test` runs are session-independent.

## Drift signal

no
