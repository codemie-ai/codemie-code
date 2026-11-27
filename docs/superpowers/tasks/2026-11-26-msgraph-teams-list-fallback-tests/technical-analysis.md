# Technical Research

**Task**: msgraph teams-list memberOf pagination
**Generated**: 2026-11-26
**Research path**: filesystem

---

## 1. Original Context

task_context: Jira EPMCDME-16358 (Bug) "msgraph teams --teams-list omits teams when memberOf fallback spans multiple pages". When /me/joinedTeams returns HTTP 403 (token lacks Team.ReadBasic.All) the command falls back to /me/memberOf. The paging fix from PR #690 (commit d35f86f3, listMemberTeams in src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js) is already on main. Work on this branch: VERIFY acceptance criteria 1-4 with tests, fix msgraph.js only if a criterion is not met, and add regression tests for criterion 5.
Acceptance criteria:
1. When /me/joinedTeams returns 403 and the fallback is used, the command follows @odata.nextLink until all /me/memberOf pages are processed.
2. The fallback returns team groups from later pages without silently truncating the list.
3. The /me/joinedTeams path and the command's output format remain unchanged.
4. Users whose memberships fit on one page receive the same results as before.
5. Regression tests cover a multi-page fallback with a team on a later page and a single-page fallback.
Extra check wanted (from the PO story): a failing later memberOf page must make the command exit with an error and not print a partial list as complete; non-team groups on pages must be filtered out; joinedTeams success path must not call memberOf.
Hints: the script has no exports and runs main() on load; existing precedent for running it as a subprocess with a stubbed https.request and temp HOME token cache is tests/integration/msgraph-email-read.test.ts. Tests are explicitly requested for this task (AGENTS.md normally gates them).

---

## 2. Codebase Findings

### Existing Implementations
All in `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (1962 lines, CommonJS, no exports):
- `listMemberTeams(token)` (l.890-903): starts at `/me/memberOf` with `{$select:'id,displayName,description,resourceProvisioningOptions', $top:999}`. Loops: `graphGet(next, token, params)`; keeps groups where `Array.isArray(g.resourceProvisioningOptions) && includes('Team')`; `next = page['@odata.nextLink'].replace(GRAPH_BASE,'')` (`GRAPH_BASE = 'https://graph.microsoft.com/v1.0'`, l.51); params reset to `{}` after page 1. Loop ends when no nextLink.
- `cmdTeams` `--teams-list` branch (l.995-1010): tries `graphGet('/me/joinedTeams', token, {$select:'id,displayName,description'})`; `catch(e)` rethrows unless `/403|Forbidden/.test(e.message)`, then `teams = await listMemberTeams(token)`. Output: `--json` prints `JSON.stringify(teams,null,2)`; otherwise per team `${id.slice(0,36)}  ${displayName}`.
- `httpsRequest` (l.70-98): `https.request(opts, cb)`; status >= 400 rejects with `Error('HTTP <code>')` (so the message matches `/403/`), plus `statusCode`, `responseBody`. `graphGet` (l.112-129) retries only on 429 (up to 3 attempts, sleeps 2-60 s) and otherwise rethrows.
- `main().catch(err => { console.error(err.message); process.exit(1); })` (l.1959): any thrown error from a later page yields exit 1, message on stderr. Because printing happens only after `listMemberTeams` returns, a failing later page prints nothing to stdout (no partial list).

Code-reading verdict (to be confirmed by tests): criteria 1, 2, 4 and the extras appear met by the existing code. Criterion 3: the joinedTeams branch and output format are untouched by the paging code. No defect found, so no `msgraph.js` change is expected.

### Architecture and Layers Affected
Skill script only (Claude plugin skill asset, CLI-style script under `skills/msgraph/scripts/`). No registry, provider or TypeScript src layer is involved. New work is a test file only.

### Integration Points
Microsoft Graph v1.0 over `node:https` (not fetch). Token from `~/.ms_graph_token_cache.json` (`access_token`, `expires_at`, `username`); `getValidToken()` accepts an unexpired cached token without network.

### Patterns and Conventions
Precedent `tests/integration/msgraph-email-read.test.ts` (100 lines): spawn `node -r stub.cjs <copied msgraph.js> <cmd> <flags>`. Notable details:
- The script is copied into a temp dir because the repo's `"type":"module"` would otherwise load it as ESM.
- The stub, written to a `.cjs` file, overrides `https.request = (opts, onResponse) => ...`, emitting `data`/`end` on a fake `res` with `statusCode` and `headers`.
- Env: `HOME`, `USERPROFILE` and `CODEMIE_HOME` set to a temp dir; `NODE_ENV` and `VITEST` deleted.
- 20 s timeout with SIGKILL; temp dirs removed in `afterEach`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/testing/testing-patterns.md` (Vitest conventions) exists; not needed beyond the precedent. `SKILL.md` and `README.md` in the skill dir describe the command. No ADRs on this.

### Architectural Decisions
Inline comment at l.887-889 documents why memberOf is paged (team filter is client-side).

### Derived Conventions
Integration tests live in `tests/integration/`, are named by kebab-case, use a header doc comment, and keep imports explicit from `vitest`.

---

## 4. Testing Landscape

### Existing Coverage
No test references `listMemberTeams`, `memberOf` or `--teams-list` (grep across tests/ and src/ found nothing beyond the script). Only `msgraph-email-read.test.ts` exercises the script at all.

### Testing Framework and Patterns
Vitest, with subprocess integration style as above. A new stub must be URL-aware, since several endpoints are hit: route on `options.path` (`/v1.0/me/joinedTeams?...`, `/v1.0/me/memberOf?...`, and nextLink paths such as `/v1.0/me/memberOf?$skiptoken=...`). Pass the scenario via an env var (JSON) or a per-test generated stub file, and append each requested path to a log file in the temp dir so tests can assert the call sequence (for example, that memberOf is not called when joinedTeams returns 200).

### Coverage Gaps
Everything in the task: multi-page fallback, single-page fallback, filtering, later-page failure, joinedTeams success, and the `--json` and text output formats.

---

## 5. Configuration and Environment

### Environment Variables
Test-only: `HOME`, `USERPROFILE`, `CODEMIE_HOME` (temp dir). The script itself needs only the token cache file.

### Configuration Files
None relevant. `.codemie/codemie-cli.config.json` shows modified in git status and is unrelated.

### Feature Flags and Deployment Concerns
None. The script is shipped as a plugin skill asset.

---

## 6. Risk Indicators

- Speculative: nextLink values in the stub should be absolute `https://graph.microsoft.com/v1.0/me/memberOf?$skiptoken=...` URLs; `replace(GRAPH_BASE,'')` only strips that exact prefix.
- A 429 in a stub would trigger real sleeps (2 s or more); the stub should avoid 429s.
- A later-page failure test should use a non-429 status such as 500 or 403. A 403 on a later page is not re-caught: the fallback call is outside the try block, so it propagates, and exit 1 is expected.
- Windows-style quoting is irrelevant; the tests use `spawn` with an argv array.
- Failure mode of the fake `res`: `res.statusCode`, `res.headers` and `on('data'/'end')` must all be provided, as in the precedent.
- Speculative: if a test unexpectedly fails, the likely area is nextLink handling (`$top` dropped on later pages is intentional, since nextLink carries its own query).
- No docs gap; no guide covers the msgraph script.

---

## 7. Summary for Complexity Assessment

The change surface is one new test file (likely `tests/integration/msgraph-teams-list.test.ts`) that reuses the established subprocess and stubbed `https.request` pattern. The target code (`listMemberTeams`, the `--teams-list` branch of `cmdTeams`) is already paged on main, and reading it shows criteria 1-4 and the extra checks are satisfied, so a production fix is not expected. Only the test scenarios need confirming by running them.

There is no technical novelty beyond making the stub route by URL and log request paths. Existing coverage of this feature is nil, so the tests are the whole deliverable. The risk is low: the script is isolated, deterministic under a stub, and the precedent works. The main pitfalls are the ESM/CJS copy trick, avoiding 429 retries, and asserting stdout is empty and exit code is 1 on a later-page failure.

---

## 8. External References

None named by the task
