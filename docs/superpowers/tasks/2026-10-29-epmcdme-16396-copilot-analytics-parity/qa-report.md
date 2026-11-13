# QA Gate Report — epmcdme-16396-copilot-analytics-parity

**Branch**: EPMCDME-16396_analytics-disable (HEAD 8e2cfb1b, merge base for this task 0309ed65)
**Runner**: npm (guide-first: `.ai-run/guides/quality-gates.md`)
**Started**: 2026-10-29T13:55Z
**Status**: BLOCKED by the guide's literal pass criteria — every failure is pre-existing and identical on the baseline (see below)

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| License headers | PASS | 3s | `npm run license-check` | |
| Lint | PASS | 12s | `npm run lint` | zero errors, zero warnings |
| Typecheck | PASS | 6s | `npm run typecheck` | |
| Build | PASS | 11s | `npm run build` | |
| Unit tests | FAIL (pre-existing) | 41s | `npx vitest run --project unit` | 13 failed / 6460 passed / 2 skipped |
| Integration tests | FAIL (pre-existing) | 23s | `npx vitest run --project cli` | 4 failed / 279 passed / 10 skipped |
| Secrets scan | PASS (no staged changes to scan) | 2s | `npm run validate:secrets` | gitleaks ran clean on every commit via the pre-commit hook |
| Commitlint | PASS | — | `npm run commitlint:last` + every commit in 0309ed65..HEAD | 8/8 commits conform |
| Windows cross-platform CI | N/A | — | — | CI-only job; this run executed on Windows 11 locally |

## Failure detail

All 17 failing tests were re-run on a throwaway worktree of the pre-feature commit `0309ed65` and fail identically there, so none are caused by this task:

- Unit (13): `codex.incremental-sync` (1), `opencode.incremental-sync` (1), `pi.incremental-sync` (1), `providers-core` claude.enrichArgs (8), `sso.auth-gate` (2).
- Integration (4): `tests/integration/sso-claude-plugin.test.ts` (enrichArgs flag injection x3, full flow x1).

Tests added or changed by this task all pass: copilot-analytics-preferences (+ matrix), copilot-analytics-gate, copilot-chat-otlp plugin, copilot-cli-otlp plugin, analytics-command, analytics-status wiring.

## Drift signal

no — the plan's stated interfaces are implemented; documented deviations are recorded in plan.md "Amendments after code review".
