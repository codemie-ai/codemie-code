# QA Gate Report — epmcdme-17189-resume-codemie-session-id

**Branch**: fix/EPMCDME-17189-resume-codemie-session-id
**Runner**: npm (gates taken verbatim from `.ai-run/guides/quality-gates.md`)
**Status**: BLOCKED (unit gate: 12 failing tests, none in or caused by the changed code; see below)

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | 4s | `npm run license-check` | |
| lint | PASS | 23s | `npm run lint` | `--max-warnings=0` |
| typecheck | PASS | 9s | `npm run typecheck` | |
| build | PASS | 24s | `npm run build` | dist rebuilt, bundles emitted |
| unit | **FAIL** | 228s | `npx vitest run --project unit` | 12 failed / 10453 passed / 34 skipped, 7 files (details below) |
| integration | PASS (on rerun) | 240s + 14s | `npx vitest run --project cli` | first run: 338 tests passed, 3 files errored with `Hook timed out in 10000ms` in `beforeAll` (machine under load); the 3 files rerun alone: 13/13 passed |
| secrets | PASS | 5s | `npm run validate:secrets` | gitleaks: no leaks found |
| commitlint | PASS | — | `npm run commitlint:last` | 0 problems, 0 warnings |
| ui | SKIPPED | — | (n/a) | no UI surface changed |

## Failure detail — unit gate

All 12 failures are in files that do not import or exercise the changed code (`session-ownership.ts`, `claude.plugin.ts` resume path, `AgentCLI` resume gate, `ResumeOwnershipResult`). The suites for the changed code pass (session-ownership 26, AgentCLI-resume 34, claude.plugin.resume-ownership 4).

| File | Failures | Cause (evidence) |
|------|----------|------------------|
| `src/agents/core/__tests__/launch-identity.test.ts` | 2 | Environment leakage: this session runs inside a CodeMie wrapper that exports 30 `CODEMIE_*` variables (e.g. `CODEMIE_URL=http://localhost:52975`). With those unset the file passes. |
| `src/utils/__tests__/config-per-profile-identity.test.ts` | 1 | Same: passes with `CODEMIE_*` unset. |
| `src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts` | 2 | Same: passes with `CODEMIE_*` unset. |
| `src/cli/commands/__tests__/hook.session-delivery.test.ts` | 1 | Same: passes with `CODEMIE_*` unset. |
| `src/agents/core/session/__tests__/stale-session-reconciliation.test.ts` | 2 | `EPERM: operation not permitted, symlink ...` — Windows without symlink privilege. Fails identically on the base commit 9c31fd39 in a clean worktree. |
| `src/cli/commands/analytics/sync/scheduler/__tests__/generators.test.ts` | 1 | Same `EPERM ... symlink` cause. |
| `src/cli/commands/analytics/__tests__/copilot-managed-report.test.ts` | 3 (2 with clean env) | `Priced sessions` / `Total cost` assertions. Fails identically on the base commit 9c31fd39 in a clean worktree (2 of its tests; the third is env-dependent). |

The only way to turn this gate green here is a Windows account with symlink privilege (developer mode) and an environment without the wrapper's `CODEMIE_*` variables, or running the gate on CI. CI (`npm run ci`, including the `test-windows` job) is the authoritative run.

## Drift signal

no
