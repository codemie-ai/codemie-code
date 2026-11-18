# EPMCDME-17385 + EPMCDME-17410: Cowork analytics attribution

Branch `EPMCDME-17385_17410_cowork-attribution`, baseline `252233ba1658a506b6d38fbf6707ea8a8c0926fa` (origin/main).
Code commit tested and described here: `1ffe202b` (`fix(analytics): pin the Cowork session project and declare CodeMie funding`).
Status: implementation done and scoped-checked; **not yet independently reviewed, not approved, no PR**.

## Requirements

- **17385**: the Cowork session project is resolved once, before the first analytics append, with the existing
  cwd/config/profile-fallback rules, and stays fixed for all later events, usage, summaries and the session end,
  across folder add/remove/reorder, work in another project's folder and daemon restarts. Incremental delivery,
  stable-folder and native Claude Code behavior unchanged. No per-folder allocation.
- **17410**: Cowork sessions the daemon actually served are stored `subscription_type=codemie` (CodeMie spend). No folder
  consent for Cowork. Native sessions and other clients unchanged. Evidence must be durable and daemon-side, not a
  blanket claim for legacy sessions.

## Design (smallest supported CLI change; no backend change)

| Piece | Change |
|---|---|
| `cowork/cowork-attribution.ts` (new) | Write-once per-session pin `<id>.cowork-attribution.json` = `{project, projectSource}`; `coworkFundingSource()` allows a funding claim only with a daemon-written served mark **and** a pin for the project being sent, with a real source. |
| `CoworkEventProducer.ts` | `pinAttribution()` before the first append of a processing; every pass, end pass and own event is stamped with the pinned project (repository, branch, cwd stay per pass as before). A session with no pin but a spool binding keeps the spool's project; a session with neither is pinned at its next processing. A failed config load writes no pin. |
| `evidence-send.ts` / `forwarder.ts` | For an unrecorded session (no evidence context, no guard) that passes the funding gate, `requestHeaders` sends the canonical `buildAttributionHeaders({destination:'analytics', routedViaCodemie:true, subscriptionType:'codemie', project, projectSource})`: Session-Id, Routed-Via-CodeMie, Subscription-Type, Project, Project-Source. No publication-contract, funding-route or consent header. Otherwise the legacy Project header alone, as before. |

### Backend consumer trace (read-only, `C:/codemie-dev/codemie` `origin/main` a01605f354; no backend change needed)

- `IngestRoute` (`cli_analytics_ingest_route.py`): any evidence header (Session-Id is required) selects the evidence gate;
  `classify(routed=true, ...)` -> `codemie` with no organization needed. Sending Subscription-Type alone would not do:
  the class is derived from Routed-Via-CodeMie.
- `resolve_destination` (`cli_analytics_project_gate.py`): the header project is honoured only when `Project-Source` is
  `linked_folder` or `profile`; without it the backend routes by registered repository or default project and could move
  the session. Hence the pin carries the source and no claim is made without one.
- No contract header => `_denied()` is false and `private_classes` is `{personal}` only, so codemie is stored without
  consent, and no consent is fabricated. A session that already has legacy rows adopts its legacy project.
- Existing backend tests on `origin/main` cover this wire shape: `test_cli_analytics_evidence_routing.py`
  (codemie routing needs no organization; header project + `Project-Source` stores the destination; body project vs
  header conflict is a context conflict). Spend grouping by subscription class: `grouped_cost_sql.py`/`scope.py`.

## Verification (CLI repo, cwd = this worktree)

| Check | Result |
|---|---|
| Baseline reproduction: new 17385/17410 tests run with the three source edits reverse-applied (`git apply -R`), `npx vitest run .../CoworkEventProducer.test.ts -t "EPMCDME-17385"` | exit 1, 11 failed: events/end stamped `other-project` instead of `synthetic-project` (the reported defect), no funding headers. Edits restored afterwards. |
| Same test file with the fix | exit 0, 83 passed / 2 skipped (the 2 skips are pre-existing `win32` skips) |
| `npx vitest run src/telemetry/runtime/cowork` + otlp-spool `forwarder`, `forwarder-contract`, `evidence-lifecycle` + `client-attribution.plugin` + `attribution-headers` tests | exit 0, 9 files, 281 passed / 2 skipped |
| `npx eslint` on touched dirs/files, `--max-warnings 0` | exit 0 |
| `npm run check:pre-commit` (typecheck + lint, the required Stop hook) | exit 0 |
| Commit hooks (husky) | passed on commit `1ffe202b` |

Scenarios covered (all synthetic fixtures, real producer + spool + forwarder, `fetch` mocked): folder of another project
joins then session ends (no conflict, final summary/end sent under the first project); daemon restart with changed
folder/profile; linked-folder project then folder removed; no project at first then a project appears (stays none);
pre-existing spool binding without a pin; cursor-only without binding; failed config load writes no pin; funding
headers exact set for profile and linked-folder sources; no mark -> Project header alone; spool-bound pin with no
source -> Project header alone; native (non-Cowork) session control -> Project header alone.

### Review follow-up R1: the actual Desktop metadata transition (synthetic)

The first regression scenarios changed `.codemie` config at the *same* discovered folder and appended no new work. R1
adds `sends work done after the folders change ...` (3 cases): Desktop's `userSelectedFolders` changes to a DISTINCT
directory resolving another project (add: none -> P2; reorder: [P2,P3] -> [P3,P2]; remove: [P2] -> none), then a new
prompt, tool call + result and answer with usage are appended to the transcript. Flow: collect and forward P1; change
folders; process inside the discovery window (cached folder) and forward; (reorder/remove: new producer = daemon restart);
process after the discovery refresh; end; forward. Asserts: the new prompt, tool start/end and usage (`msg_synthetic_H2`) are
actually sent; every sent event and every request's `X-CodeMie-Project` stays P1; the final summary and `agent.session.end`
are delivered; no project conflict in the spool status; discovered cwd really changed.

| Check (delta after `1ffe202b`) | Result |
|---|---|
| R1 cases on baseline source (the 3 source edits reverse-applied, `-t "after the folders change"`) | exit 1, 3 failed (RED). Source restored; `git status` shows only the test file modified. |
| `npx vitest run src/telemetry/runtime/cowork/__tests__/CoworkEventProducer.test.ts` with the fix | exit 0, 86 passed / 2 skipped |
| `npx eslint` on that test file, `--max-warnings 0` | exit 0 |

Source is unchanged by R1, so the earlier 281-test scoped run and `check:pre-commit` on `1ffe202b` still describe the source.
Evidence class: **synthetic fixture** (real producer/spool/forwarder, mocked HTTP). It is not live backend acceptance: the
backend persistence, public projection and spend path was traced in source only; no live persisted row was observed.

### Local backend acceptance probe (synthetic input, real local persistence)

Evidence class: **synthetic Cowork transcript input** through the changed real producer, spool and forwarder (CLI `f4efdf83`),
real HTTP ingestion into an existing local backend and PostgreSQL, read back through the public APIs. No mocked fetch,
ingest, gate or reader. **Not macOS Claude Desktop UI acceptance.**

- Backend: existing local Podman container `codemie-epmcdme17339` (image `localhost/codemie:17339-cdd8829`, revision
  `cdd8829db3`) on `127.0.0.1:18339` with its own PostgreSQL. Reused as is; nothing stopped, rebuilt or reconfigured.
- Isolation: a temp `CODEMIE_HOME`/HOME, proxy variables cleared, `NO_PROXY=127.0.0.1,localhost`, the only endpoint the
  verified localhost URL. Local test credentials were read in-process (never in argv or logs). Fresh random session id and
  two fresh test projects (P1, P2). The probe file is local only and not committed.
- Scenario: served mark written; profile without own project plus global workspace project P1; initial events collected and
  forwarded; Desktop `userSelectedFolders` switched to a DISTINCT folder resolving P2; new prompt, tool call and usage
  appended and forwarded; session ended and forwarded. A native control (spool session with no served mark, project P1) was
  forwarded too.

**Final outcome: PASS.** Run `r4` (fresh projects `zz17385-r4-p1/p2`, fresh random session ids), command
`PROBE_RUN=r4 PROBE_OUT=<evidence>/result-r4.json npx vitest run <local probe file>`, exit status `0`, `Tests 1 passed`. The
probe is a local file outside the repo (its credentials are read in-process from the harness's existing local file; never
in argv, logs or the result). Earlier runs r1-r3 were diagnostic: r1/r2 used unpriced model names (cost 0), r3 had a wrong
list-row mapping (it read `session_id`; the list endpoint keys rows by `trace_id`), so its final assertion failed. r4 fixes the
mapping and turns every acceptance value into an executable assertion (all ten true):

| Assertion (real response fields) | Result |
|---|---|
| all HTTP calls return 200 | true |
| `GET /sessions/<id>`: `summary_state=final`, `subscription_type=codemie`, `project_origin=profile` | true |
| sessions list for P1 (rows keyed `trace_id`) contains the session as `codemie`/`final`; P2 list does not | true / true |
| overview P1 `kpis`: `api_cost_usd > 0`, `subscription_cost_usd = 0`, `api_cost_usd = total_cost_usd`, 1 session | true |
| overview with `subscription_type=codemie` equals P1; `subscription_type=unknown` has 0 sessions | true |
| session `cost_usd` = overview `api_cost_usd` | true |
| detail input/output/cache-read/cache-creation tokens equal the sums over the unique spooled usage events | true |
| native control (spool session, no served mark): `subscription_type=unknown`, `project_origin=none` | true |
| two further forwards of the same spool leave overview cost/tokens/sessions and the session's tokens/cost/state unchanged | true |

Values (r3, same behavior): P1 1 session, 120 input / 126 output / 250 cache creation / 3500 cache read tokens, cost
`0.002998` all API, subscription `0`. The synthetic model name `gpt-4.1` is used only because this backend's catalog prices it.

Evidence files (outside the tracked tree, in `C:/codemie-dev/_local/epmcdme-17385-17410/evidence-live/`): `result-r4.json`
(compact; session/project ids, statuses and the ten check results; no credentials, cookies, tokens or payload text; a
case-insensitive search for cookie/password/token/bearer finds nothing), `probe-r4.log` (vitest output), `exit-r4.txt`,
and the probe `probe-src/zz-live-backend-probe.local.test.ts`, moved out of `src/` after the run so the Stop hook lints only
tracked code. Its ESLint warnings (unused imports, `require()` inside `vi.hoisted`) were confined to that untracked file;
after the file move `npm run check:pre-commit` exits `0` (`exit-precommit.txt`).

**Which acceptance axis is proven.** The UI's overview spend cards (`overviewMetrics.ts` on `codemie-ui` `origin/main`) read
`kpis.api_cost_usd` and `kpis.subscription_cost_usd`; that is the axis asserted above: the Cowork session is API (CodeMie)
spend, not subscription spend. The separate `/cost` endpoint's `funding` buckets (api_based / subscription / unknown) were
**not** verified as CodeMie and show this session as `unknown`. They are derived from the publication-contract/funding
route, which this change deliberately does not send (no consent or contract header for Cowork). `/cost` `kpis` still lists
`subscription_types=[codemie]`. Do not read this record as proof of every cost path.

**Backend revision vs current main.** The probed backend is `cdd8829db3` (17339 branch build). Current `origin/main` is
`6460ae3523` (not the earlier `a01605f354` used for the source trace). Ingest, evidence gate, classification and scope files
match `origin/main`. The overview/spend reader and handler files DO overlap the verified path and differ
(`cli_analytics_handler.py`, `reader.py`, `grouped_cost_sql.py`, `session_money.py`, `funding_buckets.py`,
`cost_key_sql.py`). Inspection of those diffs shows pricing-completeness changes (`cost_priced`, per-session
`unpriced_models`, EPMCDME-17152) and not the `api_cost_usd`/`subscription_cost_usd` class split (the `kpis` assembly lines
are unchanged), but this was not run against current main, so the result is evidence for `cdd8829db3` plus a diff
inspection for `6460ae3523`.

Other limits: the probe created test projects and sessions in that backend's shared test DB (data only). Windows host, no
real Claude Desktop UI; synthetic input.

## Limitations and unverified items

- **Live acceptance is synthetic input.** Persistence, projection and CodeMie spend were observed on a local backend (see
  above), not with a real macOS Claude Desktop session or on `origin/main`'s backend build.
- Sessions collected before this change: a bound session with a pin-less cursor keeps its spool project (no re-resolution),
  and declares funding only if its current resolution agrees with it; if not, it is pinned with source `none` and stays
  on the legacy Project header (no codemie claim). A session with a cursor but **no served mark** (collected before marks
  existed) never claims funding. Rows already stored `unknown`, events already discarded and sessions already conflicted
  or provisional are **not repaired** (out of scope); an already-conflicted session stays conflicted.
- The first project is the one resolved from the working directory known at first processing; discovery caches that for one
  inactivity timeout, so a folder added within that window before the first processing counts as "at the start".
- Evidence-style requests route like native evidence: if the pinned project is not usable by the user, the backend
  falls back to the registered-repository/default project with a route note instead of the legacy `context_required`
  discard. This is the existing native evidence behavior, not new.
- Repository/branch/cwd stamps are still recomputed per pass (only the project is fixed, as specified).
- Attribution-header change: **CRITICAL under the repo security guide; security-review sign-off required before merge.**

## Next gates (after user approval)

`sdlc-factory:code-review` on `252233ba...HEAD`, fix confirmed findings, `sdlc-factory:complexity-scoring` (actual), shareable
review/complexity artifacts in the PR, then `sdlc-factory:mr-creator` for the single PR referencing both tickets.
