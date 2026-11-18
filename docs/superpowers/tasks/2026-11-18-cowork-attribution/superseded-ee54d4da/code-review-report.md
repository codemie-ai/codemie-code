# Final code review and actual complexity: EPMCDME-17385 + EPMCDME-17410

Shareable summary of the `sdlc-factory:code-review` (full profile) and `complexity-scoring` (actual) outputs.
Machine verdict: `code-review-final.json`. Complexity: `actual-complexity.json`. Review inputs: `review-facts.md`.
Frozen `.local` files (diff, lens outputs, brief, fix pack) are not committed.

- Reviewed range: `252233ba1658a506b6d38fbf6707ea8a8c0926fa...ee54d4dabad27328739ca6a10365f34e05aedbe5`
  (frozen diff sha256 `a1192bd9991d0b4dedd2df7139c4c3d2ceaf1cf6b7aaffcbac5cd2ae8a644bd3`, 6 source/test files, 634 diff lines).
- Production source at the PR head is identical to the reviewed source `ee54d4da`. The only later source-tree delta is
  commit `b24c1773`, test-only, written in response to this review (below), plus this evidence commit.
- Coverage: all four lenses (blind, edge-case, verification-gap, acceptance) and standards completed. (The first round at
  `16567370` lost its edge-case lens and is superseded; its files are not part of this record.)

## Verdict as produced

`request-changes`, confidence `low` (risk flags: security, public-api). The verdict is reported as produced, not
overridden. Four findings, handled as follows:

| ID | Finding | Status |
|---|---|---|
| CR-001 (major, test gap) | refusal of a project that cannot travel as a raw header was untested | Fixed by test only (`b24c1773`): `coworkFundingHeaders` returns nothing for such a project; the test fails when the guard is removed (verified). |
| CR-003 (major, test gap) | the `!req.evidence && !req.guard` gate on funding headers was untested | Fixed by test only (`b24c1773`): a recorded session never declares Cowork funding even when the gate would pass; fails when the condition is removed (verified). |
| CR-002 (major, evidence) | no security-review sign-off recorded for the attribution-header change | **Open, external pre-MERGE gate.** Not fabricated. It does not block creating this PR. |
| CR-004 (critical, decision) | EPMCDME-17410 AC1 only partly met for sessions with no served mark, spool-bound pre-pin sessions, and identity-failed sessions | Reassessed below; reviewer left it as a decision, so it stays listed. |

The earlier identity-failure defect (round-one CR-002, guessed Project-Source `profile`) was fixed in `ee54d4da` before this
review; this review lists the remaining identity-failure case only as a conservative non-declaration.

### CR-004 reassessment (source-backed)

- The ticket reproducer starts a task after connecting, with a profile project, with or without a folder. A fresh served
  session gets the daemon mark at its first request, and the funding gate is evaluated at each send (mark + pin with a real
  source), so a mark written after the pin still enables funding. Producer/forwarder tests and the real-local-backend
  synthetic probe (see `../record.md`) show `codemie` and CodeMie spend for that path. No current-reproducer defect was
  confirmed.
- Sessions collected before marks/pins existed and rows already stored `unknown` are history; the handoff excluded history
  repair and `record.md` disclosed the limit before approval of `16567370`. A session with no project sends no Project
  header, unchanged from baseline. An unresolved project origin conservatively declares no funding; Project-Source is
  never fabricated.
- Classification: approved migration limitation / conditional concern, not a new confirmed defect. The reviewer's verdict
  is unchanged by this note.

## PR-ready versus merge-ready

- **PR-ready:** yes. Implementation done, scoped checks passed (`record.md`), real-local-backend synthetic acceptance
  recorded, review complete with all lenses, findings handled as above.
- **Merge-ready: no.** Outstanding: **security-review sign-off (CR-002, CRITICAL attribution-header change)**; acceptance
  by the owners of the CR-004 migration limitation; no macOS Claude Desktop UI acceptance and no run against current
  `origin/main` backend (see `record.md`). Merge, auto-merge and any main push are not part of this task.

## Actual complexity

`actual-complexity.json`: size **M**, total **17/36**, routing label `brainstorming` (band 15-20); component scope 3,
requirements clarity 2, technical risk 4, file change estimate 4, dependencies 1, affected layers 3; 8 files, +715/-9
(`252233ba...b24c1773`, including `record.md` and tests). The assessor read only part of the changed files
(`cowork-attribution.ts`, the top of `evidence-send.ts`), so the score rests mainly on the diffstat and the funding-gate
logic. Not published to Jira: the Jira Labels/comment publication configured in `project.md` was not authorized for this
task.
