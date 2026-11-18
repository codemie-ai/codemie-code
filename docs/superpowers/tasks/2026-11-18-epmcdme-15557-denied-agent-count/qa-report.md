# QA Gate Report — epmcdme-15557-denied-agent-count

**Branch**: fix/EPMCDME-15557-denied-agent-count
**Gated commit**: `ad78ebcf` (HEAD; 7 commits on top of `origin/main` `37a2fe47`). This replaces the earlier report, which covered 4 of the then 6 commits and predated `ece9dd1d` (the commit that made an unresolved call not count and renamed the API to `toolOutcomes`).
**Runner**: npm (gates taken from `.ai-run/guides/quality-gates.md`)
**Run**: 2026-11-18, Windows, Node 22
**Status**: BLOCKED on the unit gate as the guide defines it (all tests must pass). The 6 failing tests are outside this change; see the breakdown for how that was established and what was not re-checked. CI on the pushed branch (Test Ubuntu, Test Windows, Build, CodeQL, Gitleaks, PR Title) was green on the previous push.

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | 2s | `npm run license-check` | |
| lint | PASS | 15s | `npm run lint` | zero warnings |
| typecheck | PASS | 6s | `npm run typecheck` | |
| build | PASS | 9s | `npm run build` | |
| unit | FAIL | 273s | `npx vitest run --project unit` | 6 failed, 11729 passed, 75 skipped (5 files of 624). None are in files this change touches. See breakdown. |
| integration | PASS | 83s | `npx vitest run --project cli` | 384 passed, 13 skipped |
| commitlint | PASS | 2s | `npx commitlint --from origin/main --to HEAD` | all 7 branch commits clean |
| secrets scan | SKIPPED | — | `npm run validate:secrets` | no container engine (Docker/Podman) on this machine; the guide allows the skip and CI runs it (Gitleaks passed). The user approved skipping it for the commit hook only. |
| ui | SKIPPED | — | (n/a) | no UI surface changed |

## Unit gate breakdown (6 failures, 5 files)

| Test file | Failures | Cause |
|-----------|----------|-------|
| `src/cli/commands/analytics/sync/scheduler/__tests__/generators.test.ts` | 1 | Symlink test: `EPERM`, this Windows account cannot create symlinks |
| `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` | 1 | Symlink test, same cause |
| `src/cli/commands/proxy/connectors/__tests__/codex-desktop-roundtrip.test.ts` | 1 | Symlink test, same cause |
| `src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts` | 1 | Symlink test, same cause |
| `src/cli/commands/analytics/__tests__/copilot-managed-report.test.ts` | 2 | Cost-report assertions (`Priced sessions: 1/1`, `Total cost: $2.50`); not diagnosed |

What was established, and when:

- On the earlier run (12 failures) the persisting failures were re-run on a clean checkout of the then merge base `252233ba`: the 4 symlink tests and the 2 `copilot-managed-report` assertions failed identically there, and the 6 load timeouts passed in isolation. The same 6 tests fail now.
- **Not re-checked:** the comparison against the new base `37a2fe47` (after the rebase). The `connect-orchestrator` symlink test sits in code touched by the commit that arrived with the rebase (#835), so the "fails on the base" statement for that one test rests on the earlier run plus the identical `EPERM` cause. The Windows CI job on the pushed branch passed the symlink tests, which supports the local-account explanation.
- The load timeout seen in an intermediate full run (`copilot-managed-report`, "leaves Claude output unchanged") did not occur in this run and passes in isolation.

Tests added or changed by this ticket all pass: `claude-named-invocations`, `orchestrator`, `session-summary`, `ClaudeSessionAdapter`, `claude.metrics-processor-names`, `run-prompts`, `claude-run-baseline` and the rest of `src/agents/plugins/claude` and `claude-code-otlp` (63 files, 1240 tests in the targeted run after the last behavior change).

## Verification beyond the gates (on the built code, `ece9dd1d`)

- Pre-fix extractor (`origin/main`) against the fixed build over all 689 local Claude Code transcripts: 6 sessions changed, 19 calls removed, all 19 errored calls, none pending. No `skills`, `commands` or other diffs, no count increased, no exceptions.
- 28-case scenario matrix through the OTLP `agent.session.summary` and `ClaudeSessionAdapter.extractMetrics` (allowed, denied by `is_error` and `isError`, denied `Task`, mixed, no result, no id, denied `Skill` unchanged), plus two-`Stop` sequences (pending then ok, pending then denied): all pass.
- Real Claude Code 2.1.327 runs in an isolated project (user settings and CodeMie hooks not loaded): a hook denying `Agent` wrote `tool_result` with `is_error: true` and text `PreToolUse:Agent hook error: QA-15557 deny`; before the fix `{Explore: 1}`, after `{}` on the OTLP summary, the session adapter and the live `MetricsProcessor`. The allowed control run gives `{Explore: 1}`. For the hook-denied call Claude Code fired only `PreToolUse` (no `PostToolUse`, `PostToolUseFailure` or `PermissionDenied`).

## Not verified

- A `claude_code.tool.execution` span for a hook-denied call (local OTLP export did not produce spans even in the control run).
- Manual run of the CodeMie proxy end to end; the backend repository was read (agent_count logic, denied-call gating) but not run.

## Drift signal

no
