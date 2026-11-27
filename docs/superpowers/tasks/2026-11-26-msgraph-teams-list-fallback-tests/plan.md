# msgraph teams-list memberOf fallback tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify EPMCDME-16358 acceptance criteria 1-4 and cover criterion 5 with a Vitest integration test file.

**Architecture:** Subprocess test following `tests/integration/msgraph-email-read.test.ts`: copy `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` to a temp dir (avoids ESM loading), run `node -r stub.cjs msgraph.js teams --teams-list [--json]` with a temp HOME holding a valid token cache. The stub overrides `https.request`, routes on `options.path`, and appends each requested path to a log file in the temp dir.

**Tech Stack:** Vitest, node:child_process spawn, node:https stub.

**Spec:** requirements in the task dispatch; research in `technical-analysis.md` (same dir).

Commit per task using the repository's existing convention.

## Global Constraints

- Only new file: `tests/integration/msgraph-teams-list.test.ts` (plus the repro artifact from Task 3). Do not modify `.codemie/codemie-cli.config.json`.
- `msgraph.js` is changed ONLY if a test shows a criterion is not met (state which one in the report).
- nextLinks in stubs are absolute `https://graph.microsoft.com/v1.0/me/memberOf?...` URLs (script strips that exact prefix).
- Failure stubs use 500/403, never 429 (429 triggers real sleeps).
- Same env handling as the precedent: HOME/USERPROFILE/CODEMIE_HOME = temp dir, delete NODE_ENV and VITEST, 20 s timeout with SIGKILL, temp dirs removed in `afterEach`.
- Stage files by explicit path only, never `git commit -a`. `.codemie/codemie-cli.config.json` has an intentional local edit and must never be staged.
- Don't commit `state.local.json` or `steps.local.jsonl`.

## Review Focus

- Non-team groups (no `resourceProvisioningOptions` or lacking `'Team'`) on every page are filtered out: asserted in Task 1.
- A later-page 403 is not swallowed by the joinedTeams 403 catch: asserted in Task 2.

### Task 1: Harness + fallback paging tests (criteria 1, 2, 5)

**Files:**
- Create: `tests/integration/msgraph-teams-list.test.ts`

**Interfaces:**
- Produces: `runTeamsList(routes: Array<{match: string; status: number; body: object}>, args?: string[]): Promise<{code: number|null; stdout: string; stderr: string; paths: string[]}>`. Routes are an ordered list of `{ match: string; status: number; body: object }`. For each request, the first entry whose `match` is a substring of `options.path` wins. `graphGet` encodes the first memberOf query with URLSearchParams (`%24select=...%2C...&%24top=999`), while the stub's nextLink keeps a literal `?$skiptoken=p2`, so exact-key matching would never hit page 1. Put the `skiptoken=p2` entry before the bare `/me/memberOf` entry. An unmatched path returns 404 so a routing mistake fails fast instead of looping until the timeout. The route table is passed to the stub as JSON via env var; `paths` is read from the request log file.

- [ ] **Step 1: Write the failing tests** (reuse the precedent's spawn/temp-dir/token-cache helpers; add the URL-aware stub and request log):
  - `falls back to memberOf and lists teams from every page`: joinedTeams 403; memberOf page 1 has only non-team groups plus a nextLink to `...memberOf?$skiptoken=p2`; page 2 has a team (`resourceProvisioningOptions: ['Team']`) and another non-team group. Assert exit 0, stdout lists the team line `${id.slice(0,36)}  ${displayName}` and none of the non-team names, and `paths` contains both memberOf pages in order after joinedTeams.
  - `single-page memberOf returns the team and requests no further page`: joinedTeams 403, one memberOf page without nextLink containing a team and a non-team. Assert same output format, and `paths` has exactly one memberOf request.
- [ ] **Step 2: Run** `npx vitest run tests/integration/msgraph-teams-list.test.ts`. Expected: PASS (the fix is already on main). If one fails, investigate the script, and only then fix `msgraph.js` minimally.

Test-first: yes — multi-page test fails if `listMemberTeams` stops following `@odata.nextLink` (proved in Task 3); single-page test pins pre-fix behavior.

### Task 2: joinedTeams success and later-page failure tests (criteria 3, 4)

**Files:**
- Modify: `tests/integration/msgraph-teams-list.test.ts`

- [ ] **Step 1: Add tests** using `runTeamsList`:
  - `joinedTeams 200 never requests memberOf (plain output)`: assert `paths` has no `/me/memberOf` entry and stdout lines are `${id.slice(0,36)}  ${displayName}`.
  - same with `--json`: stdout parses to the joinedTeams `value` array (`JSON.stringify(teams, null, 2)` format), no memberOf request.
  - `fallback --json returns only team groups`: joinedTeams 403, one memberOf page with a team and a non-team group. stdout parses as JSON, contains the team object only, and no non-team displayName appears.
  - `later memberOf page failing with 500 exits 1 with empty stdout`: joinedTeams 403, page 1 contains a team plus nextLink, page 2 returns 500. Assert code 1, `stdout === ''`, stderr non-empty.
  - same with page 2 returning 403 (must not be swallowed): code 1, empty stdout.
- [ ] **Step 2: Run** the file as in Task 1. Expected: all PASS; fix `msgraph.js` only if a criterion is shown unmet.

Test-first: yes — each test asserts an acceptance criterion that currently has no coverage; failure of any means a production defect.

### Task 3: Mutation check (no repo changes to msgraph.js)

- [ ] **Step 1:** Copy `msgraph.js` to a throwaway temp dir, edit that copy so `listMemberTeams` ignores `@odata.nextLink` (stop after the first page), and run the multi-page test against it. Add the `MSGRAPH_SCRIPT_PATH` override (default: the repo file) to the test helper only if it is needed to point the test at the copy. Expected: the multi-page test FAILS and the single-page test still PASSES.
- [ ] **Step 2:** Save the failing multi-page output from the mutated copy (test name, assertion message) to `docs/superpowers/tasks/2026-11-26-msgraph-teams-list-fallback-tests/repro.md` as the bug-repro artifact.
- [ ] **Step 3:** Run again without the override; expected all PASS. Confirm `git status` shows no change to `msgraph.js`, and delete the throwaway copy.

Test-first: no — verification of test sensitivity only; produces no committed file beyond `repro.md` and the optional env override in Task 1's helper.

## Negative-constraint pass

- "Do not touch `.codemie/codemie-cli.config.json`": no task edits it; Global Constraints forbid staging it.
- "Production msgraph.js changed only if a test shows a criterion unmet": Tasks 1-2 step 2 gate this; Task 3 mutates a throwaway copy only.
- "Use 500/403, not 429": Task 2 and Global Constraints.
- "Not the repo file for the mutation": Task 3.
