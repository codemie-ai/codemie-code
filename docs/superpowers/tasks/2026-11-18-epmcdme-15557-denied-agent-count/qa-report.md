# QA Gate Report — epmcdme-15557-denied-agent-count

**Branch**: fix/EPMCDME-15557-denied-agent-count
**Gated commit**: `ab817771` (the last code commit; 9 commits on top of `origin/main` `37a2fe47`; the commit that adds this report changes only this file). This replaces the earlier reports: the first covered 4 of the then 6 commits and predated `ece9dd1d` (an unresolved call no longer counts; API renamed to `toolOutcomes`), the second predated `ab817771` (the live processor counts an Agent call in the run that emits its group, fixing a call lost across runs).
**Runner**: npm (gates taken from `.ai-run/guides/quality-gates.md`)
**Run**: 2026-11-18, Windows, Node 22
**Status**: BLOCKED on the unit gate as the guide defines it (all tests must pass). The 6 failing tests are outside this change; see the breakdown for how that was established and what was not re-checked. CI on the pushed branch (Test Ubuntu, Test Windows, Build, CodeQL, Gitleaks, PR Title) was green on the previous push.

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | 3s | `npm run license-check` | |
| lint | PASS | 15s | `npm run lint` | zero warnings |
| typecheck | PASS | 6s | `npm run typecheck` | |
| build | PASS | 11s | `npm run build` | |
| unit | FAIL | 272s | `npx vitest run --project unit` | 6 failed, 11733 passed, 75 skipped (5 files of 624). None are in files this change touches. See breakdown. |
| integration | PASS | 122s | `npx vitest run --project cli` | 384 passed, 13 skipped |
| commitlint | PASS | 2s | `npx commitlint --from origin/main --to HEAD` | all 9 branch commits clean |
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

Tests added or changed by this ticket all pass: `claude-named-invocations`, `orchestrator`, `session-summary`, `ClaudeSessionAdapter`, `claude.metrics-processor-names`, `run-prompts`, `claude-run-baseline` and the rest of `src/agents/plugins/claude` and `claude-code-otlp` (63 files, 1244 tests in the targeted run after the last behavior change, including the two new `claude-run-baseline` tests and two new `run-prompts` tests for a group held back by an unresolved call).

## Verification beyond the gates (on the built code)

- Pre-fix extractor (`origin/main`) against the fixed build over all 703 local Claude Code transcripts (re-run on `ab817771`): 6 sessions changed, 19 calls removed, all 19 errored calls, none pending. No `skills`, `commands` or other diffs, no count increased, no exceptions.
- 28-case scenario matrix through the OTLP `agent.session.summary` and `ClaudeSessionAdapter.extractMetrics` (allowed, denied by `is_error` and `isError`, denied `Task`, mixed, no result, no id, denied `Skill` unchanged), plus two-`Stop` sequences (pending then ok, pending then denied): all pass.
- Real Claude Code 2.1.327 runs in an isolated project (user settings and CodeMie hooks not loaded): a hook denying `Agent` wrote `tool_result` with `is_error: true` and text `PreToolUse:Agent hook error: QA-15557 deny`; before the fix `{Explore: 1}`, after `{}` on the OTLP summary, the session adapter and the live `MetricsProcessor`. The allowed control run gives `{Explore: 1}`. For the hook-denied call Claude Code fired only `PreToolUse` (no `PostToolUse`, `PostToolUseFailure` or `PermissionDenied`).

- Live `MetricsProcessor` on the real hook-denied and allowed transcripts (`ab817771`): denied gives no `agentInvocations`, allowed gives `{Explore: 1}`.
- Pre-fix (`origin/main`) against fixed `MetricsProcessor` over 77 real transcripts with agents, processed in one run: identical in 76, lower in 1 (an errored call removed); never higher.

## Known limitation (accepted)

- In the per-record agent metrics of a live session, an `Agent` or `Task` call is not counted when its turn is still held back at the end of the session and a later turn was already recorded (a sibling tool call that never got a result, or a turn without usage data); this was not seen in 16,125 real turns, and the session summary `agents` count is not affected.
- Why it stays: the live path counts an Agent call in the run that emits its assistant group (`emittedGroupLines`), because a call counted from the message slice is lost when it is pending in one run and resolved in a later one. The opposite gap is a group that never emits (a sibling call unresolved, or no chunk carries usage) while a later group did: on the final pass nothing emits it. Reproduced on the built code: the held group with a successful `Agent` call gives `{}` when a later group is emitted in the same final run, in an earlier run, or when it has no usage; it is counted when it is the last group or when it resolves later. The slice-based design (`ece9dd1d`) had the opposite gap.
- Why it is not fixed here: counting each call exactly once in both cases needs state saved between runs. Counting by the run in which a call's result first appears was prototyped and rejected: it counts every call one run late and failed 8 processor tests, 4 of which predate this ticket (`extracts agent subtype from Task tool_use block`, the two resumed-record tests, and the pending-`Task` baseline test) and 4 of which this ticket added. Marking counted groups needs a new persistence path, because `processedRecordIds` holds the ids of delivered delta records only.
- Frequency: in 178 local main transcripts (16,125 assistant groups) only 3 groups were held back (all with an unresolved tool call), none was followed by a later group, and none held an `Agent`/`Task` call.
- Not affected: `agent.session.summary.agents` (OTLP) and `ClaudeSessionAdapter.extractMetrics`, which read the whole transcript. No backend consumer of the legacy `agentInvocations` was found.

## Not verified

- Processing a transcript in growing prefixes through the built `MetricsProcessor`: the harness gave the same one-shot/incremental differences on the pre-fix build, so it does not discriminate; the held-back-group case is covered by the unit tests instead.

- A `claude_code.tool.execution` span for a hook-denied call (local OTLP export did not produce spans even in the control run).
- Manual run of the CodeMie proxy end to end; the backend repository was read (agent_count logic, denied-call gating) but not run.

## Drift signal

no
