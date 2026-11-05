---
schema: sdlc-factory/code-review@1
decision: approve
reviewed_head: 9bc26b40eab58a6e3e78e6026a6045ad0b8b919c
---

# Code review — 2026-11-03-analytics-sync-git-target

**Decision:** approve (check round, confidence final medium · check high)  
**Reviewed head:** `9bc26b4` · **Rounds:** final → check

**Closed:** 13 fixed · 0 moot · 0 decided

Targeted check: all 13 prior blocking code findings (CR-001..CR-013) are resolved in the current source; every finding file is in changed_files except the CR-008 test, which is the untracked real-deps.test.ts. business_review and standards_review are carried forward from the final round unchanged, and no new findings were sought. Brief written to code-review-brief.local.md.

## Open — 0

## Coverage

Graded at the final round; the check round re-verified the findings, not these rows — Open and Closed above are current.

| Acceptance criterion | Status | Notes |
|---|---|---|
| Targets: git second target beside webhook; either or both, at least one required | pass | validateInstallOptions requires one; configuredTargets loops webhook then git |
| Settings shape: webhookUrl optional, git {repoUrl, branch?, path?}, format json, 0600 file | pass | types.ts + readStoredGit; stored path/branch not re-validated (CR-005) |
| Per-target markers: webhook keeps analytics-last-sent, git uses its own marker; own window/report/marker move | pass | realSyncDeps routes git to analytics-last-sent-git; wiring untested (CR-008); readMarker throw aborts loop (CR-006) |
| Git delivery via plain git through exec, no git library | pass | createGitRunner wraps exec |
| Persistent shallow working copy, reset hard to remote before each delivery, re-clone on failure | pass | ensureWorkingCopy clone/fetch+reset+clean; rm + re-clone on mismatch/refresh failure |
| Report at <git-path>/<lowercased email slug>/<webhook attachment name> | pass | slugFolder + report.fileName |
| Commit author is the resolved sync email via -c user.email/user.name | pass | commitAndPush passes both -c flags |
| No prompts: GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never, ssh BatchMode=yes, per-call timeout | pass | gitEnv; GIT_SSH override (CR-010) and gpgsign/hooks (CR-012) gaps |
| Unknown SSH host key fails with a hint on trusting the host once | pass | classifyGitError host-key + gitHint |
| Install validation is pure and runs before any scheduler mutation | pass | validateInstallOptions before testGitTarget/replaceJob |
| Install-command builder is a pure exported function with safe quoting | pass | buildInstallCommand, POSIX single-quote escaping |
| Run log: one line per target per run with target id and ok/skip/fail grammar | partial (final round) | multi-line git stderr is written unflattened, splitting one outcome over several lines (CR-007) |
| status.ts#parseLastRun still reads lines written by the previous single-target version | pass | suffix-less line treated as webhook |
| Exit code 1 if any target fails, 0 otherwise | pass | anyFailed ? 1 : 0 |
| Status disabled-state hint and SyncTargetMissingError mention both --webhook and --git-repo | pass | status.ts hint and errors.ts message |
| AC1: install --help lists git flags and --format; neither target fails with SyncConfigError before scheduler | pass | index.ts options; validateInstallOptions |
| AC2: --git-repo install does prompt-free test push before registering; on failure nothing registered and cause printed | pass | testGitTarget before replaceJob; gitHint printed |
| AC3: install rejects absolute/escaping --git-path, credential-bearing repo URL, non-json --format | partial (final round) | token-only https userinfo not rejected (CR-001) |
| AC4: sync run commits report to <git-path>/<slug>/... on configured/default branch with own credentials | pass | GitTarget.deliver; default-branch drift on reinstall (CR-011) |
| AC5: when remote moved, rebase and retry up to 3 attempts; other members' files untouched | pass | MAX_PUSH_ATTEMPTS=3; failed rebase never aborted (CR-013) |
| AC6: pushes rejected after retry limit log git failure; marker does not move | pass | push rethrows on attempt 3; runTarget returns before moveMarker |
| AC7: with both targets, both receive report; each marker moves only after its own delivery | pass | per-target loop; marker read throw breaks isolation (CR-006) |
| AC8: credential/host-key/unreachable failures fail at once; git marker held, webhook still delivers | pass | prompt-free env; independent markers |
| AC9: an empty window commits nothing | pass | buildReport null -> skip |
| AC10: sync status shows repository (no credentials), last successful push and last failure | partial (final round) | multi-line git errors and git-only setup failures never reach the git Last failure (CR-007, CR-009); token-only URL unredacted (CR-001) |
| AC11: install-command builder emits valid commands for webhook-only, git-only, both | pass | install-command.test.ts covers three shapes |
| AC12: uninstall removes the local working copy with settings and OS job | pass | uninstall.ts removeWorkingCopy |
| AC13: existing webhook-only settings, markers and run logs keep working | pass | legacy file loads with format defaulted; webhook marker path unchanged |
| Non-goal: no bootstrap command added | pass | builder only, not wired |
| Non-goal: format accepts only json | pass | validateFormat |
| Non-goal: no git host REST APIs, no git client library | pass | git subprocesses only |
| Non-goal: no interactive git at any point, including install | pass | same prompt-free runner at install |
| Non-goal: no storing tokens or credential-bearing URLs | partial (final round) | https://<token>@host accepted, persisted and printed unredacted (CR-001) |
| Non-goal: no change to webhook delivery behavior or its marker path | pass | sendWebhook and analytics-last-sent unchanged; target=webhook suffix only |

Standards: commit-format pass · code-quality pass · security fail (final round)
