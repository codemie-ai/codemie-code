# Code review — EPMCDME-17845 Copilot funding

- reviewed_head: 43c8e27ee7e7fd9204370199d94e1450f4592caf
- base: 87a196b5a87e697d60ced1f915dc1676b0af0cf7 (branch vs base, 11 files, +731/-11, profile `full` via security promotion)
- machine verdict: `code-review-final.json` (decision request-changes, confidence low: no spec, so acceptance lens n/a; 2 blocking, 10 advisory, 0 deferred, 7 dismissed)
- coverage: blind, edge-case, verification-gap, standards ran; acceptance n/a (no spec)

## Blocking findings and disposition

| id | finding | disposition |
|---|---|---|
| CR-002 | owner-held recovery branches of `transitionGate` had no test | **Fixed** after the review: three tests through the real hook and the real pending-owner queue (proven + held continues stamped; held + lost proof stops with no unstamped bytes; no identity + held + lost proof stops). Test-only change, no production change; commit follows the reviewed head. |
| CR-001 | ticket key in the subject of the four branch commits (git-workflow: put it in the body) | **Not rewritten.** The commits are local-only history that the repository squash-merges; the PR title (which becomes the squash commit) carries no ticket key. Recent main history also carries keys in subjects. Reviewer may ask for a reword. |

## Advisory (no code change in this PR)

CR-003 agent validation test, CR-006 jwt proof branch test, CR-008 test title wording, CR-009 gate vs stamp proof can disagree (both use `copilotRouteProof`; the gate is fail-closed), CR-010 async override signatures (typecheck passes), CR-011 e2e eager `readdirSync`, CR-012 machine-specific e2e runner paths: fix-later. CR-004 (Copilot generation fixed at 0: intended, Copilot controls gate each hook), CR-005 (pending-owner check is session-scoped; a pending entry only allows a stamped, owner-held claim, never positive authorization on its own), CR-007 (env-based routing proof: same trust model as Claude's managed launch): accepted.

## Verification at the reviewed head

tsc exit 0; vitest copilot-cli-otlp + evidence + otlp-spool 1157 passed; eslint changed files exit 0; build exit 0; e2e `run-copilot-funding.sh` 15/15 (real hook processes, real proxy daemon, backend router/ingestor/Postgres, `/overview`; replayed Copilot transcript and synthetic credentials). Four unrelated symlink/Codex-path test failures reproduce on the baseline 87a196b5.
