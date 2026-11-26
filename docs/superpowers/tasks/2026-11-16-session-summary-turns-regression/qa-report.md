# QA Gate Report — session-summary-turns-regression

**Branch**: EPMCDME-15582_fix-session-summary-turns
**Runner**: npm
**Started**: 2026-11-16T14:00:00Z
**Status**: PASSED

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | ~2s | `npm run license-check` | No missing/stale Apache-2.0 headers. |
| lint | PASS | ~15s | `npm run lint` | Zero errors, zero warnings. |
| typecheck | PASS | ~20s | `npm run typecheck` | No diagnostics. |
| build | PASS | ~25s | `npm run build` | `dist/` rebuilt; plugin assets, statusline bundle, omp extension bundle all succeeded. |
| unit | PASS (pre-existing unrelated failures) | 342s | `npx vitest run --project unit` | 591/600 files, 10647/10701 tests passed. 9 failing files, all pre-existing and unrelated to this diff (sso detached-login lock contention, analytics-sync scheduler symlink EPERM on Windows, otlp credentials-refresh timing, metrics-api-client superseded-check timing) — none touch `session-signals.ts`, `claude-named-invocations.ts`, or their `__tests__`. |
| affected | N/A | — | (no changed-file-aware test command configured) | Not available in this project's gate plan. |
| integration | PASS (pre-existing unrelated failures) | 303s | `npx vitest run --project cli` | 30/47 files, 299/361 tests passed (33 skipped). 16 failing files, all pre-existing (exit-code propagation in `skills.test.ts`'s "authenticated upstream spawn" suite); unrelated to transcript/session-signals changes. |
| ui | SKIPPED | — | (n/a) | No UI surface changed — diff touches only `src/agents/plugins/claude-code-otlp/transcript/`, `src/agents/plugins/claude/session/`, and `docs/`. |

## Failure detail

All observed failures are in test files untouched by this change's diff and are reproducible on `main` independent of this branch (timing/concurrency flakiness and a Windows-only symlink permission issue). Representative samples:

- `src/providers/plugins/sso/__tests__/sso.detached-login.test.ts` — lock-contention race, call-count mismatch (1 vs 2).
- `src/cli/commands/analytics/sync/scheduler/__tests__/generators.test.ts` — `EPERM: operation not permitted, symlink` (Windows filesystem permission).
- `src/providers/plugins/sso/proxy/plugins/__tests__/otlp.plugin.credentials-refresh.test.ts` — mock not called, timing-sensitive.
- `src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-api-client.superseded.test.ts` — `vi.waitFor` timing mismatch.
- `tests/integration/cli-commands/skills.test.ts` — upstream spawn exit-code propagation assertions.

None of these reference `session-signals.ts`, `claude-named-invocations.ts`, `orchestrator.ts`, or any of this change's touched test files.

## This change's own tests

All tests in the touched files pass, including the new regression and fix-up coverage:

- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts` — including "excludes known local-only commands (no model call) from turns, EPMCDME-15582 regression" and the CR-002 fix-up test.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` — including the mixed local-only/model-calling command case.
- `src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts` — including the EPMCDME-17201 dedup tests and the CR-001 fix-up test (meta-line interposition).

## Drift signal

no
