# QA Gate Report — EPMCDME-15369

**Branch**: fix/EPMCDME-15369
**Runner**: npm
**Started**: 2026-10-23T13:00:00Z
**Status**: BLOCKED (pre-existing, confirmed-unrelated failures — see Drift signal and Failure detail)

## Gates

| Gate  | Status | Duration | Command | Notes |
|-------|--------|----------|---------|-------|
| license-check | PASS | ~3s | `npm run license-check` | all dependency licenses recognized |
| lint  | PASS | ~15s | `npm run lint` | zero errors, zero warnings |
| typecheck | PASS | ~20s | `npm run typecheck` | no diagnostics |
| build | PASS | ~25s | `npm run build` | `dist/` rebuilt, all plugin assets copied, statusline bundled |
| unit tests | **FAIL** | 52.7s | `npx vitest run --project unit` | 13 failing tests, all pre-existing and unrelated to this change (see below) |
| integration tests | **FAIL** | 36.4s | `npx vitest run --project cli` | 4 failing tests in `tests/integration/sso-claude-plugin.test.ts`, pre-existing and unrelated |
| secrets scan | PASS | <1s | `npm run validate:secrets` | nothing staged (changes already committed); Gitleaks ran clean on both commits via the pre-commit hook at commit time |
| commitlint (both commits) | PASS | <1s | `npm run commitlint:last` (+ manual check of the first commit) | both commits conform to Conventional Commits |

## Failure detail

**Unit gate — 13 failures, all pre-existing, confirmed unrelated to this diff:**
- `src/providers/core/__tests__/providers-core.test.ts` (8 tests, `defaultAgentHooks > claude.enrichArgs`)
- `src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts` (1 test)
- `src/agents/plugins/opencode/__tests__/opencode.incremental-sync.test.ts` (1 test)
- `src/agents/plugins/pi/__tests__/pi.incremental-sync.test.ts` (1 test)
- `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts` (2 tests)

None of these touch `OtlpAgentAdapter.ts`, `hook.ts`, or either test file this task modified. Root-caused during Stage 4: the checkout's shell has `CODEMIE_MODEL`, `ANTHROPIC_MODEL`, `CODEMIE_MODEL_SOURCE` set (this is a live CodeMie CLI session), and these tests read ambient `process.env` without isolating it — a pre-existing test-isolation gap, not something this change introduced. Confirmed via `git stash` of the unrelated pre-existing dirty files (`connect-orchestrator.ts`, `spool-config.ts`, `sso.proxy.ts`): the identical 13 (then 14/15, depending on run) failures reproduce with or without those files present, and with or without this task's fix. Re-running `npx vitest run --project unit` directly on `OtlpAgentAdapter.test.ts` and `hook.analytics-wiring.test.ts` in isolation: 57/57 pass.

**Integration (cli) gate — 4 failures in `tests/integration/sso-claude-plugin.test.ts`**, all asserting on `enrichArgs` output that unexpectedly includes an injected `--settings <temp-model-picker-config>.json` flag. Same category as the unit-gate pollution — model-picker config injection driven by the ambient CLI session environment — and in a file unrelated to this task's change (Claude plugin auto-install flag injection, not the OTLP hook path).

## Drift signal

no — implementation matches plan.md exactly (try/catch around `ensureOtlpProxy` in `OtlpAgentAdapter.processOtlpEvent`, no changes to `connect-orchestrator.ts`/`daemon-manager.ts`).
