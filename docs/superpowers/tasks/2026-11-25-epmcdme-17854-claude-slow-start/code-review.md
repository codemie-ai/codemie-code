# Code review — EPMCDME-17854 (Claude slow-start session loss)

reviewed_head: f3dcf8f94ba6d19aea5ff623f7cf0b5794627209
base: 98d196e90b37e266718bf55cde78f65018942a38 (PR target: main)
scope: branch vs base, 11 files, +256/-14 (diff sha256 abf4e19eaa3435e745b4e3b1436e251f8182daded0b4c79e4559a0f1ea04137a)
profile: full (risk-promoted: auth/credentials) · lenses: blind, edge-case, verification-gap, standards · acceptance: n/a (no spec file; criteria taken from the ticket text)
machine verdict: `code-review-final.json` — request-changes, confidence low (low because no spec file was given to the acceptance lens)

## Findings and disposition

| id | severity | finding | disposition |
|---|---|---|---|
| CR-001 | major (standards) | 7 commit subjects carry `EPMCDME-17854` inline; git-workflow.md prefers the ticket in the body footer. commitlint does not enforce it. | Accepted. Recent `main` history (e.g. EPMCDME-16970, -16967, -16971, -16496) and the user's task contract use `type(scope): EPMCDME-NNNN ...`; the branch is squash-merged, so the PR title carries the convention. No history rewrite. |
| CR-002 | minor | `undelivered` flag is not reset between the first send and the `retryOnce` retry; a batch could be both spooled and held if the retry fails ambiguously. | Not fixed (fix-later). Only claude startup/clear holds; both copies carry identical event ids, which the backend dedups. Changing code after approval would change the reviewed revision. |
| CR-003 | minor | `isConnectionRefused` checks only `err.code` / `err.cause.code`; a refusal nested in an `AggregateError` is treated as ambiguous and the start is not held. | Not fixed (fix-later). The daemon URL is a literal `127.0.0.1`, so no dual-stack `AggregateError`; the direct form was exercised in the real-CLI run. |

No finding requires a substantive implementation change; no fresh approval cycle was triggered.

## Actual verification (revision-bound, f3dcf8f9)

- vitest, targeted: OtlpAgentAdapter, hook-credentials, otlp-forward, claude-code-otlp, owner-pending-retention, spool-io — 33 files, 1094 tests, exit 0.
- `tsc --noEmit`, eslint on touched `.ts`, `npm run build`: exit 0.
- Real `codemie hook` CLI + real daemon + local spool, isolated `CODEMIE_HOME` (Windows):
  - slow daemon 8 s: start hook exits 0 (7.4 s), batch held, after readiness `agent.session.start` + `agent.session.env` spooled once (0 duplicate ids), next hook exit 0 with empty stdout and `agent.tool.end` collected, no stop marker, no `resume_unknown`.
  - fast-start control: same events, no marker.
  - unknown resume: `resume_unknown` marker and notice, nothing spooled or held.
  - late daemon 25 s: earlier run on the same hold/replay path (the replay code is unchanged since 966c934b).

## Limits

- No exactly-once guarantee after a daemon crash between the replay's append and the queue-entry removal (out of scope by decision; identical event ids, backend dedups).
- Only Windows exercised; full suites and CI not run; local-only artifacts (`*.local.*`) are not committed.

## PR #897 review follow-up

Reviewed implementation: 98677230a0bc7890410ff96b5785109a10a73088. Base: f6af774c. Combined implementation and test diff: 15 files, +478/-33. The machine verdict above records the original review; it was not rerun. Its retry-flag and aggregate-refusal findings are addressed by the follow-up.

- Windows CLI and local daemon at 585df4ab: the 8 s cold start without a connection record delivered both original records and accepted the next hook without resume_unknown. With the backend unreachable and a live hook already spooled, replay appended both startup records once.
- At 98677230, 135 targeted tests passed, including fresh-start attribution and unchanged sibling lookup. The real CLI scenarios were not rerun after that narrow change.
- The broader run at 585df4ab had 4300 passing tests and one Windows symlink EPERM. That failure was not reproduced on the current exact base.
- GitHub CR-002 security sign-off remains pending. CR-007/009/010/013 retain the existing timeout, fingerprint, scope and destination boundaries. The agreed crash-mid-write limitation remains.
