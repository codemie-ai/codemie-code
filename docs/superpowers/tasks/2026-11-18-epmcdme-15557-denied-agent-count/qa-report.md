# QA Gate Report — epmcdme-15557-denied-agent-count

**Branch**: fix/EPMCDME-15557-denied-agent-count
**Runner**: npm (gates taken from `.ai-run/guides/quality-gates.md`)
**Started**: 2026-11-18
**Status**: BLOCKED on the unit gate as the guide defines it (all tests must pass); every failing test is outside this change and fails identically on the merge base (see below)

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | 5s | `npm run license-check` | |
| lint | PASS | 35s | `npm run lint` | zero warnings |
| typecheck | PASS | 13s | `npm run typecheck` | |
| build | PASS | 23s | `npm run build` | |
| unit | FAIL | 315s | `npx vitest run --project unit` | 12 failed, 11705 passed, 43 skipped (8 files). None are in files this change touches. See breakdown. |
| integration | PASS | 93s | `npx vitest run --project cli` | 384 passed, 13 skipped |
| commitlint | PASS | — | `npm run commitlint:last` + the other 3 branch commits | all 4 commits clean |
| secrets scan | SKIPPED | — | `npm run validate:secrets` | no container engine (Docker/Podman) on this machine; the guide allows the skip and CI runs it. The user approved skipping it for the commit hook only. A manual grep of each staged diff for secret-like strings found nothing. |
| ui | SKIPPED | — | (n/a) | no UI surface changed |

## Unit gate breakdown (12 failures, 8 files)

The 12 failures were re-run in isolation, then the persisting ones on a clean checkout of the merge base `252233ba` (a temporary worktree, now removed).

| Group | Count | Result |
|-------|-------|--------|
| Timeouts under full parallel load (`continuation.test.ts`, `codex.incremental-sync.test.ts` x2, `hook.session-delivery.test.ts`, `copilot-managed-report.test.ts` x2) | 6 | Pass when re-run in isolation on the branch. Flaky under load. |
| Symlink tests (`generators`, `connect-orchestrator`, `codex-desktop-roundtrip`, `vscode-claude-code`) | 4 | `EPERM: operation not permitted, symlink`: this Windows account cannot create symlinks. Fail identically on the merge base. |
| `copilot-managed-report.test.ts` cost report (`Priced sessions: 1/1`, `Total cost: $2.50`) | 2 | Assertion failures. Fail identically on the merge base. |

Tests added or changed by this ticket all pass: `claude-named-invocations`, `orchestrator`, `session-summary`, `ClaudeSessionAdapter`, `claude.metrics-processor-names`, `run-prompts` and the rest of `src/agents/plugins/claude` (1235 tests) were green on every run.

## Failure detail

No failure comes from this change. The two `copilot-managed-report` assertions are unexplained (not diagnosed); they are unrelated to named-invocation counting and reproduce on `main`.

## Drift signal

no
