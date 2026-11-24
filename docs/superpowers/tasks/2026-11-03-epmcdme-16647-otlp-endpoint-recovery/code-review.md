# Code review - EPMCDME-16647

- Skill: `sdlc-factory:code-review` 0.9.15 (standalone), `code-review-orchestrator`, profile `balanced` (unknown complexity, 780 lines, 10 files), gate `code-review.final`
- Baseline: `12f451151716cebaa8f10f4aa077dbea814f39dd`
- reviewed_head: `c7471810f4f1adadf0e7a11472cc3db0b6a9aad2` (frozen diff `code-review.local.diff`, sha256 `8ad2811656e694e0f2d9ddfff94ff950dd9b85911674b4536fbc1d6698dddfb8`; `code-review.local.head` agrees)
- Reconciled_head: `b895ef4b6678aa4fe047da8fd5872fc38c3859e3` (fix commit for CR-001; delta c7471810..b895ef4b is 6 files, +113/-100, a move of existing code)
- Machine verdict: `code-review-final.json` (`request-changes`, confidence high, 2 findings, both standards, none behavioral); brief `code-review-brief.local.md`; fix pack `code-review-fix-pack.local.md`; lens files `lens-acceptance.local.md`, `lens-edge-case.local.json`, `standards-review.local.json`
- Coverage: edge-case, acceptance, standards ran; blind and verification-gap not in the balanced profile. Acceptance rows: 14 pass, 1 `pending-stage-7` (the human gate).
- Contract-review (`sdlc-task-contract/references/contract-review.md`) was applied by passing it to the orchestrator; behavior ACs (a)-(d) traced clean in source.

## SHA mapping after the CR-002 subject normalization
The four local commits were re-created with identical trees (tree `b86eb8962af6c58c842544409a225ae315fdf37f` at the tip) before the push; only the three old subjects changed (ticket key moved to a `Refs:` footer). Mapping old -> pushed: `b6e8d550` -> `72384bdd`, `38d1f33c` -> `d69c6821`, `c7471810` (reviewed_head) -> `42149529`, `b895ef4b` (reconciled_head) -> `140aec9e`. The review, the verdict and the assessment were made on the old SHAs; the trees are the same, so they apply to the pushed commits unchanged. CR-002 is therefore **fixed by the normalization** (the "history rewrite on explicit request" condition was met by the user's delivery instruction); the old SHAs are kept in local branch `backup/EPMCDME-16647-pre-normalize-b895ef4b`.

## Findings and dispositions (IDs stable)

| ID | Kind / severity | Status | Disposition |
|---|---|---|---|
| CR-001 | code, major, PROVEN (guide: files < 500 lines; connector 806 -> 898) | **fixed** in `b895ef4b` | Endpoint check/refresh/port helpers moved verbatim to `connectors/claude-code-otlp-endpoint.ts`; connector exports the three symbols it needs; importers (`connect-orchestrator.ts`, `index.ts`) and tests updated. Connector is back to 806 lines (baseline size - the pre-existing overage is not part of this task). Checked after the move: `tsc --noEmit` 0, eslint (changed files, zero warnings) 0, vitest 5 files / 209 tests passed (connector, connect-orchestrator, index, analytics-status, disconnect-orchestrator). Probes were not rerun: the moved code is unchanged and covered by those tests. |
| CR-002 | evidence, major, PROVEN (guide anti-pattern: ticket key in subject) | **fixed by commit-subject normalization before the push (see SHA mapping)**; the text below records the state at review time: | Subjects of `b6e8d550`, `38d1f33c`, `c7471810` end with `(EPMCDME-16647)`. Not a code defect; the commits are local and unpushed. Rewriting them is history surgery the reviewer itself limits to an explicit user request. Context: recent history on main also uses the key in subjects (`44896ea3`, `bb57e25f`) and the guide says the PR title becomes the squash commit. The new commit `b895ef4b` follows the guide (key in the footer). Options for the user: leave (squash title fixes it), or ask for a reword of the three subjects. |

## Conditional concern (not emitted as a finding)
After a restart with stored-but-rejected credentials, state health stays `ok` until the next unhealthy transition (the watcher reports unauthorized once). Outside the four ACs; not changed.

## Not covered
Real backend analytics delivery, expiry during a running SSO session, OS keychain, GUI/VS Code/Desktop reconnect (see `implementation-handoff.md` / `functional-verification-evidence.md`). The reviewed fix is a refactor; no second skill review round was run on `b895ef4b`, the delta was verified by the checks above.
