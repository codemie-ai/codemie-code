# Code review: EPMCDME-16383 (mask secrets in forwarded hook payloads)

Result: **approved** after one fix-up round. Reviewed on the uncommitted working tree against HEAD `c433480` (11 files, +578/-44 in round 1). Profile: full (security-sensitive). Tests were not run by the review; the QA stage owns execution.

## Round 1 (code-review.final): request-changes, 5 blocking

| ID | Kind | Finding | Status after check round |
|---|---|---|---|
| CR-001 | code | `message` was dropped on every Claude hook event; spec limits it to Notification (`claude-code-otlp.plugin.ts`) | resolved: dropped only on Notification, together with `title` |
| CR-002 | code | Credential-file deny-list missed `.pgpass`, `.kube/config`, `*.tfvars`, `.htpasswd` and was mostly untested (`tool-fields.ts`) | resolved: list extended, table test with positives and negatives |
| CR-003 | code | New test cases added where existing ones should be extended (AC8) | resolved: folded into existing cases; new cases only for the Notification drop and the sensitive-file Read table |
| CR-004 | decision | `src/utils/security.ts` grows to 639 lines (guideline: 500) | resolved by user decision: keep the masker in `security.ts` as an accepted exception (the spec places it there) |
| CR-005 | code | Masker left credential tails: other `Authorization` schemes, escaped-quote JSON, `SECRET_KEY`-style names (`security.ts`) | resolved: whole credential masked after any scheme; escaped JSON, `SECRET_KEY`/`DB_PASS` names and whole-container redaction covered, with table cases |

## Round 2 (code-review.check): approve, confidence high

All 5 prior findings resolved, no new findings. Spec items and acceptance criteria AC1-AC9 graded pass after the fixes.

## Deferred (not blocking, pre-existing or out of scope)

- Spool lines written before this change are POSTed as they are (old `raw`, unmasked fields). Spool and forwarder changes are out of scope.
- Credential content via tools other than Read (Bash `cat .env`, Grep/Glob output, Write/Edit `tool_input` on sensitive paths) is covered by text-pattern masking only.
- Fields merged after `limitPayload` (`repo_remote`, `git_branch`, `story_*`, env fields) are not masked; the spec stamps common fields after masking. A credentialed remote URL would still reach the spool.

## Notes

- The pinned-head record could not be produced: `sdlc-review-report pin` refuses while source changes are uncommitted, and the user commits manually. This file was assembled from the review working files (`code-review-*.local.*`, kept out of git).
