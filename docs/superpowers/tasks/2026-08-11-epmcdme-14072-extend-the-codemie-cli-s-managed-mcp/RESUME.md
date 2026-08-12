# RESUME — EPMCDME-14072 (written before a context compaction, 2026-08-11)

**Read this first after any compaction or context reset. Trust this file and `git log` over recollection.**

## Where the run is

- **Flow**: `sdlc-factory:sdlc-standard`. **Stage 6 CLOSED (approve). Stage 7 QA PASSED. Stage 8 in progress.**
- **Task dir**: `docs/superpowers/tasks/2026-08-11-epmcdme-14072-extend-the-codemie-cli-s-managed-mcp/`
- **Branch**: `EPMCDME-14072_managed-mcp-oauth-config` — **11 commits** off `main` @ `917b4f0`, HEAD `ff130d8`
- **`.state.json`**: `phase: main`, `impl_mode: subagent`
- **SDD ledger**: `.superpowers/sdd/progress.md` (git-ignored scratch; `git clean -fdx` would destroy it)

Stages 0–7 are **complete**. Remaining: **8 (actual complexity, running) → 9 (commit artifacts) → 10 (handoff)**.

> **The run stopped being HITL partway through.** The user instructed it to continue *completely
> autonomously*, so the assistant adjudicated CR-007 and answered the `code-review.check` gate itself.
> Both are recorded as assistant decisions in `decisions.jsonl` and `code-review-check3.json` — no
> human answered them. Treat them as reversible if the user disagrees: the spec change is one commit,
> the floor removal three (`6645e66`, `4c21bef`, `ff130d8`).

**QA gates (Stage 7): passed.** license-check, lint, typecheck, build, unit, integration,
commitlint-last, affected, hook-eslint, ci-commitlint-range all PASS. `secrets` SKIPPED (the script
scans staged changes only and the tree is clean — but gitleaks ran in pre-commit on every commit, and
CI runs `gitleaks-action` unconditionally). `ui` SKIPPED correctly — no UI surface in the diff.
`qa-report.md` also notes `.ai-run/guides/quality-gates.md` is stale in two places (test script names,
and what `license-check` actually does) — unrelated to this task, worth a follow-up.

## CR-007 — ADJUDICATED (no longer blocking)

The user instructed the run to continue **completely autonomously**, so CR-007 was decided rather
than escalated. **The auth floor is removed.** It is recorded in `spec.md` as **Decision 5** ("May
the CLI raise a backend entry's auth to a colliding default's? **No — forward as published, warn
instead**") with the full rationale in §5, including the rejected alternative so it is not
reintroduced.

Why removal rather than adoption: the floor contradicts Decision 1 (courier) and Decision 4 (backend
wins) — both user-approved — and §4's precedence table, and its security case does not survive
contact with what the bundled defaults are. They are public third-party SaaS endpoints (Notion,
Linear, Box, Canva, Vercel, Netlify, Miro). Writing `oauth: false` for one discloses nothing; the
endpoint rejects the client. Forcing `oauth: true` onto an endpoint the backend deliberately
published as unauthenticated breaks a working server the CLI has no standing to override.

The **observability half is retained** — a `logger.warn` still names any collision that lowers auth
relative to the default it displaced — so the change is reported, not silent.

## Findings — ALL CLOSED

No open findings. Five fix rounds; verdicts in `code-review-final.json`, `code-review-check.json`,
`code-review-check2.json`, `code-review-check3.json` (the last covers rounds 4 and 5).

| id | status |
|---|---|
| CR-001 … CR-006 | resolved (rounds 1–3) |
| **CR-007** | **Adjudicated → auth floor REMOVED.** Spec Decision 5 + §5. Not a human decision. |
| **CR-008** | Moot by construction — the predicate is *decomposed*, not duplicated: `collidesWithManagedEntry = sameManagedName \|\| sameManagedEndpoint`, and the downgrade report keys on the narrow one, so a report is a strict subset of a displacement. |
| **CR-009** | Deferred — pre-existing; the parse asymmetry is intentional (each helper is conservative for *its own* question). |
| CR-010 … CR-017 | resolved (rounds 4–5): spurious name-collision warn, double-count, orphaned comment, understated spec scope, weak aliasing test, unreachable-shape assertions, unreported displaced default, lost absent-`oauth` coverage. |

**Deliberately NOT fixed — do not "helpfully" fix these:** the 5 pre-existing findings in
`code-review-deferred.md`, including **URL normalization**. Both round-5 lenses recommended it; it was
rejected here because it changes which entries displace which, touches AC5, and contradicts spec §5.
The sidecar names the correct fix for whoever takes the follow-up ticket: one normalizing comparison
inside `sameManagedEndpoint`, comparison only, never changing the URL that gets written.

**A correction that matters if you re-read the early rounds:** the `security` risk flag on CR-002/003
was overstated. The oauth object carries **no secret material** — a public `clientId`, scopes, a
callback host/port and two endpoint URLs; no client secret, no token. Getting `oauth` wrong breaks a
connection, it does not disclose anything. That is also what makes Decision 1's pass-through safe.
`spec.md` §5 was corrected; the frozen review diffs still contain the old phrasing by design.

## Verdict artifacts (all on disk, all authoritative)

- `code-review-final.json` — round 1: request-changes, CR-001 critical + CR-002 major
- `code-review-check.json` — round 2: CR-001/002 resolved; **new** CR-003/004 critical, CR-005/006 major
- `code-review-check2.json` — round 3: CR-003–006 resolved; **CR-007/008/009 open**; all 8 ACs pass
- `code-review-deferred.md` — **5 pre-existing findings, deliberately out of scope. Do NOT fix these.**
- Frozen diffs: `code-review.diff` (round 1, do not overwrite), `code-review-check.diff`,
  `code-review-check2.diff`, `code-review-current.diff`

## Facts that cost real work to establish — do not re-derive

1. **All 8 acceptance criteria PASS** at HEAD. AC6 was upgraded `partial → pass` by a full acceptance
   re-audit run at the user's prompting (the check-round default skips the acceptance lens; that
   default was stale after three rounds had rewritten the logic).
2. **Reverting the last three commits is the WORST option.** It forfeits **AC5** outright — the
   criterion those commits exist to satisfy — *and* creates a migration hazard: a config already
   written by this branch would be evicted by the reverted code on its next failed fetch. I offered
   revert earlier as reasonable; the re-audit disproved that. Do not re-offer it as a good option.
3. **`orgMcpServers === null` also means "no CodeMie URL configured"**, not just "fetch failed".
   So "seed no defaults on a failed fetch" is **not** an acceptable fix — it would permanently stop
   seeding defaults for those tenants. An implementer found this; it is correct.
4. **The three tests changed in round 3 were legitimate.** Verified independently: all three were
   added one commit earlier by `fccae6b` and asserted the tenant URL being replaced by the public
   endpoint — which *is* CR-004. They pinned the defect and could not survive any correct fix.
5. **`typeof x === 'object'` / null-reachability was chased three times and is UNREACHABLE** through
   every producer. Dismissed with evidence. Do not re-raise.
6. **Marker state schema `{ managedNames: string[] }` must not change** — explicit spec non-goal.

## Commits (do not squash or amend)

```
40c2c5a fix(proxy): scope the managed MCP oauth floor to matching urls   <- round-3 fix (CR-003..006)
fccae6b fix(proxy): guard the managed MCP collision replacement          <- round-2 fix (CR-001/002)
5e02120 feat(proxy): log the managed MCP oauth shape breakdown           <- T6  (reviewed clean)
bebef08 fix(proxy): let a backend managed MCP entry beat a bundled default <- T5 (reviewed clean)
32bf826 fix(proxy): deep-copy managed MCP entries with nested oauth config <- T4 (reviewed clean)
d3479c2 fix(proxy): stop downgrading managed MCP auth to oauth: false    <- T3 CENTRAL FIX
4dd58b4 fix(proxy): treat an all-invalid MCP catalog as a fetch failure  <- T2  (reviewed clean)
fa466d9 feat(proxy): accept and preserve structured MCP oauth config     <- T1  (reviewed clean)
```

`desktop.ts` grew 645 → 813 lines across the two collision fix rounds.

## Gates and emissions already recorded — never re-raise

| Gate | Decision |
|---|---|
| `spec.approved` | approve |
| `plan.approved` | approve |
| `code-review.final` | request-changes |
| `code-review.check` | request-changes (round 2) |
| `code-review.check` | request-changes (round 3) |

Jira emissions (all `succeeded`, adapter = `codemie-jira-assistant` skill, comments on EPMCDME-14072):
`record_complexity_score/initial`, `artifact_published/spec`, `artifact_published/plan`.
Still owed at Stage 8: `record_complexity_score/actual`.

**The user explicitly authorized fix rounds beyond the flow's one-round limit.** That authorization
is on record; a further round is allowed but should be confirmed, not assumed.

## Remaining stages after code review resolves

7. **qa-gates** — dispatch the `qa-gates` agent (`branch`, `merge_base: main`, `repo_path`, `run_dir`). Keep the digest, do NOT read `qa-report.md`. `--ui` is **not** set, so **skip `feature-verification` entirely**.
8. **Actual complexity** — `git diff main...HEAD --name-only` + `--stat`, dispatch `complexity-assessor` with `mode: "actual"`, then emit `record_complexity_score/actual`.
9. **Commit artifacts** — `"/home/taras_spashchenko/EPAM/cm/codemie-public-skills/ai-packages/sdlc-factory/scripts/run-script.cmd" commit-artifacts <task-dir> <slug>`
10. **Handoff** — verify artifacts, write `.state.json` `phase: "done"`, `stage: 10`, `completed_at`, print the handoff block. Do **not** create the PR; offer `mr-creator`.

Helper scripts base: `/home/taras_spashchenko/EPAM/cm/codemie-public-skills/ai-packages/sdlc-factory/scripts/run-script.cmd`
(`sdlc-gate <task-dir> <gate_id> <decision> "<rationale>"`, `sdlc-emit <task-dir> <intent> <k> <v> <status>`).

## Standing user instructions

- **TDD IS MANDATORY** — stated three times, unprompted. Every implementer must show real RED output
  before writing production code, and the controller must verify it in the report. This overrides
  the repo's default "tests only on explicit request".
- Repo rules (`AGENTS.md`): no git operations or tests unless asked — **superseded for this task**
  by the SDLC flow the user invoked.
- Slug: `epmcdme-14072-extend-the-codemie-cli-s-managed-mcp`.
