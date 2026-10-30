# Backend handoff: claude -p end-of-session loss and subagent usage/cost (EPMCDME-16441, P3 and P4)

Audience: backend team. Built from findings-T2.md, findings-T3.md and findings-F2.md (CLI code reading plus a read-only trace of the
backend repository checkout). Nothing here was measured from prod. Anything marked "inferred, not measured from prod"
is deduced from code or guides only. No backend repo edits were made and no tickets were filed. CLI paths are relative to the
codemie-code repo, backend paths to `src/codemie/` of the backend repo.

## 1. claude -p end-of-session (CR-003, pattern P3)

### What the CLI sends
- Hook events go through `codemie hook --agent claude-code-otlp` into the proxy daemon spool, then POST `/v1/analytics/cli-analytics/event-hooks` (NDJSON).
- On SessionEnd the CLI emits `agent.session.end` and `agent.git.snapshot` (commits, HEAD end), after a transcript parse and two git resolutions
  (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:277-285`). Transcript-derived events (`agent.usage.request`, summary stats) are also produced at every `Stop`
  (plugin.ts:220-230), and in `-p` mode Stop fires once at the end of the turn.
- Send deadline 3 s with one resend (`src/agents/plugins/utils.ts:6,37`, `core/OtlpAgentAdapter.ts:118-121`). If SessionEnd is killed or the send fails, no later hook retries.
- Every event carries `session_id`, `event_id` (content hash), `timestamp` and the session-pinned `codemie_project_name`.
- A session that never gets `agent.session.end` is still forwarded: hooks-only sessions are force-forwarded after about 6 minutes (`otlp-spool/completeness-gate.ts`). The spool sweep is garbage collection only and never synthesizes or sends an end event.

### CLI outcome
- Unattended claude -p can lose `agent.session.end` and `agent.git.snapshot` when Claude Code cuts the SessionEnd hook off at exit. Inferred, not measured from prod: the effective SessionEnd deadline in `-p` mode is unknown; the configured 30 s is probably not the effective limit.
- Cost and usage events normally arrive via Stop (inferred, not measured from prod).
- No CLI fix was made: a synthetic end event would have to go through the adapter contract and needs the backend contract below. Out of scope for this task.

### What the backend must verify or change
1. Ingest: confirm `/event-hooks` accepts a session that has `agent.usage.request` and Stop-derived events but no `agent.session.end` (it should, nothing in the F2 trace rejects it).
2. Session completeness and duration: what does a missing `agent.session.end` change? Candidates: `started_at`/`ended_at`/duration in `session_dims`, and `git_branch` or commit data fed by `agent.git.snapshot` (reader.py:287 excludes sessions with no `started_at`; storage.md:204 sources branch from `hook_events.git_branch`).
3. Project gate: no change needed for this issue. `agent.session.end` carries the pinned project like every event.
4. Dedup: no change. A late genuine `agent.session.end` has a different `event_id` from any synthetic one, so a future CLI-side synthetic end would be stored twice unless the backend dedups by (session, type).
5. Rollups: confirm no rollup requires `agent.session.end` (rollups.py) to finalise a session or its cost.

### Open questions that need prod/backend access
- How many factory/`-p` sessions on prod have usage rows but no `agent.session.end`? (query `hook_events` by session_id for type `agent.session.end` vs `agent.usage.request`)
- Do those sessions appear in the sessions list and KPIs, with developer, repository, branch and cost?
- Is the deployed backend the same as the checked-out backend state?

### Ticket draft (backend, file only if the prod check shows impact)
Title: Sessions without agent.session.end (headless claude -p) lose duration/git snapshot in the sessions list
Link: EPMCDME-16441 (P3)
Description: The CLI cannot guarantee `agent.session.end` / `agent.git.snapshot` for `claude -p` because Claude Code may cut the SessionEnd hook off at exit (inferred, not measured from prod). Define and document what the backend does for sessions with usage events but no end event: derive `ended_at` from the last event, show the session, and source branch/repo from the earliest events that carry them.
Check on prod: count sessions with `agent.usage.request` and no `agent.session.end`; check whether they are listed with developer, repo, branch, cost.
Expected: sessions without an end event are listed and cost-complete; any missing field is derived or documented.
Severity: medium, unverified.

CLI-side companion ticket (separate, not backend): see findings-T2.md section 4 (measure the SessionEnd hook on a real `claude -p` run, then design a lower-latency end path).

## 2. Subagent usage/stop identity and cost (CR-004, pattern P4)

### What the CLI sends
| Event | Identity | Cost fields |
|---|---|---|
| `agent.subagent.usage` | `session_id` = parent session id; `agent_id` separate; pinned `codemie_project_name`; `event_id` = content hash (a grown cumulative summary gets a new id) | `usage[]` per-model token totals (input, cache 5m/1h, cache read, output, thinking, web search/fetch, api_calls). No USD; the backend prices from tokens |
| `agent.usage.request` (subagent) | parent `session_id`, plus `agent_id`/`agent_type` | per-request tokens |
| `agent.subagent.stop` | parent `session_id`; `event_id` = hash of payload + hook timestamp (a repeated stop is a new row) | none (description, tool_use_id, spawn_depth, worktree, started_at, duration_ms) |

Evidence: `claude-code-otlp.plugin.ts:373-412`, `transcript/orchestrator.ts:1096-1100,1140-1193,1240-1256`, `transcript/subagent-usage.ts:164-184,295-331`, `claude-code-otlp.event-id.ts:50-67`. That Claude Code's SubagentStop `session_id` is the parent's: inferred, not measured from prod.
Only subagent check-ins with an empty `agent_type` are skipped. A stop without `agent_transcript_path` forwards the stop only; the SessionEnd backstop re-derives usage unless SessionEnd is lost (links to section 1).
CLI-side gaps (not fixed, inferred, not measured from prod): the allowlist is evaluated on the hook cwd, so a subagent in a worktree outside the allowlist drops its Start/Stop and usage; backstop `worktree`/`cwd` for a subagent is the SessionEnd cwd.

### What the backend must verify or change
1. Ingest/project gate: `agent.subagent.*` events carry the pinned project, so no gate change. The CLI sends one hook request per project, each with an `X-CodeMie-Project` header equal to the project named by its events; events are never rewritten, and events without a project name go with the session's bound project (the first sendable name seen).
2. Dedup: first stored version wins for the same `event_id` (otlp.py:621-627, events.md:435). The CLI changes `event_id` when the cumulative usage content grows, so updates are not dropped (CLI event-id read; inferred, not measured from prod). Confirm that "latest event with totals wins per agent" (rollups.py:627-651) holds with the resulting multiple rows.
3. Aggregation (`rollups.py:575-660`, `_totals_are_a_source` at 589-607): `agent.subagent.usage` totals become a `session_usage` source (token_source=`subagent_usage`) only if there is no `usage_requests` row for that session+agent, no OTel `api_request` log for the session (any agent), no non-totals `session_usage` row for that agent, and no `attrs.otel_requests` row. The CLI sends both per-request rows and totals, so in a CLI-hook session the cost counts once through the requests (inferred, not measured from prod).
4. Possible drop (inferred, not measured from prod): if a subagent's `agent.usage.request` events never arrived AND the session has any OTel `api_request` (Claude Code native OTEL on), the subagent totals are suppressed and its cost disappears. Totals rows have `source_cost_usd = NULL` (rollups.py:640).
5. Reader: the storage guide (storage.md:186) says dashboard endpoints do not read `session_usage`/`subagent_invocations`; cost aggregates read `cost_daily` (reader.py:340-380, 764). Confirm whether subagent-only totals ever reach dashboard or KPI cost.
6. Recompute lag: `agent.subagent.usage` marks `USAGE_FACTS` dirty and is recomputed asynchronously via `rollup_dirty` (dirty.py:19); expect lag, not loss.

### Open questions that need prod/backend access
- For factory sessions with subagents: compare `subagent_invocations` token sums against `usage_requests` per `agent_id` and against `cost_daily` for the session.
- Do any factory sessions have subagent totals but no per-request rows, with OTel `api_request` present?
- Does the deployed reader (versus the checked-out backend state) surface `session_usage` totals in KPI cost?
- Is the Claude Code OTEL env enabled in the factory runs?

### Ticket draft (backend, file only if the prod check confirms)
Title: Subagent cost missing from session cost when OTel api_request exists and agent.usage.request is absent
Link: EPMCDME-16441 (P4/P5)
Description: `_totals_are_a_source` (src/codemie/repository/cli_analytics/postgres/rollups.py:589-607) suppresses `agent.subagent.usage` totals for the whole session when any OTel `api_request` exists, and totals rows have no cost (`source_cost_usd` NULL, rollups.py:640). If the per-request `agent.usage.request` rows of a subagent are missing (lost batch, 413, discarded request), its cost vanishes from session cost though the totals event arrived. Also confirm whether `session_usage`/`subagent_invocations` totals are read by dashboard and KPI cost (storage guide says not).
Check on prod: see open questions above.
Expected: either surface the totals as cost when requests are absent, or document the exclusion.
Severity: medium, unverified.

## 3. Related backend items from findings-F2.md (context, not part of CR-003/CR-004)
Distinct drop reasons for project not found / no access; log and count every ingest discard (high value for P5 measurement); OTLP discard with N == 0 is indistinguishable from success; whole-body 413 at 5,242,880 bytes with no partial acceptance. Full drafts: findings-F2.md.

## 4. Backend research feedback on sections 1 and 2 (supersedes the inferred items above)

Source: backend-side research relayed in the ticket discussion; not re-verified from the CLI repo. Backend references are as reported there.

### P3 (sessions without `agent.session.end`): already handled in the backend
- `ended_at` and `duration_ms` fall back to the last raw event (`rollups.py:1185-1200`, the EPMCDME-15584 fix).
- `started_at` and branch are derived from any of the 13 dimension event types, not only `agent.session.end`.
- Cost does not depend on the end event.
- Only remaining gap: a session with no dimension event at all is dropped by the reader because `started_at` is NULL (`reader.py:288`).
- Effect on section 1: items 2 and 5 of "What the backend must verify or change" are answered; the P3 backend ticket draft is not needed except for the no-dimension-event case.

### P4 (subagent cost): a bigger gap than section 2 states
- `agent.subagent.usage` totals never reach `cost_daily` or KPI cost.
- A subagent with totals but no `agent.usage.request` rows therefore has no cost, whether or not the OTel gate suppresses it (section 2 item 4 described only the gate case).
- Relaxing `_totals_are_a_source` would double-count; recommendation is to leave it alone.

### Scope decision for the backend plan (decided, see below)
- (a) Pin and document only (recommended by the backend research): tests pinning the P4 exclusion and the P3 fallback, documented in the storage guide; no SQL behaviour change.
- (b) Fix P4: price the totals tokens into `cost_daily` for agents with no request rows; invasive, touches model-price lookup, double-count risk, needs live-DB tests.
- (c) (a) plus a P3 reader fallback to `activity_started_at` when `started_at` is NULL.
Decision: superseded. The backend scope is the plan reviewed in section 9: query-time pricing of subagent totals (section 7), cost-less sessions listed with `cost_available` (sections 6 and 8), and a gate-discard log line and counter (section 6, decisions 4 and 4b). Options (a) to (c) are not taken as written.

## 5. Second backend research pass (read-only, backend repository HEAD)

Method: code read of the backend repository only; nothing measured from prod. Paths relative to `src/codemie/` unless marked REPO. Supersedes inferred items in sections 1, 2 and 4.

### Project gate (P5) - confirmed
Order per ingest route: authenticate (`rest_api/routers/cli_analytics.py:136`) -> feature flag `cliAnalytics` off = 404 (140) -> body over `ANALYTICS_INGEST_MAX_BODY_BYTES` = 413 -> hooks only: non-ndjson 415, empty 400, no parseable events 400 -> gate in the ingestor (`repository/cli_analytics/postgres/ingestor.py:366` OTLP, `379` hooks; gate code `service/analytics/cli_analytics_project_gate.py:52-81`):
1. blank/missing `X-CodeMie-Project` -> `project_context_required`
2. header vs explicit body project differ (case-insensitive) -> `project_context_conflict`
3. active project not found by name or deleted -> `project_context_required`
4. user lacks application access -> `project_context_required`
5. with `ENABLE_USER_MANAGEMENT`, non-admin without current `user_project` membership -> `project_context_required`
6. `cli_analytics_enabled` false -> `cli_analytics_disabled` (default false: `core/models.py:397`; REPO `src/external/alembic/versions/<revision>_...py:26`; personal projects forced false: `service/project/personal_project_service.py:228`)
A discard returns HTTP 200 (hooks body `{"accepted":0,"dropped":N,"reason":...}`; OTLP `partial_success` with `rejected_*` and `error_message`). The CLI treats any 2xx as final and deletes its spool. Discards are not logged or counted in the paths read (not searched repo-wide); a discard writes no rows, ledger entries or rollup keys. Several silent causes beyond "analytics not configured": unknown/deleted project name, no project membership, flag off, header/body mismatch.

### P3 (no end event) - confirmed with corrections
- The session summary event is `agent.session.summary` (`repository/cli_analytics/postgres/rollups.py:777`), not `agent.session.end`; `agent.session.end` is only one of the 13 dimension types (`repository/cli_analytics/vocabulary.py:79-93`).
- `ended_at`/`duration_ms` fall back to the last raw event across hooks, requests, logs, spans and metrics (`rollups.py:1190-1201`). `started_at` and branch come from any dimension type (`rollups.py:1910-1912`). Cost comes from `cost_daily`, built from `_cli_requests` (`rollups.py:739-764`), independent of the end event.
- Reader drop confirmed: `WHERE d.started_at IS NOT NULL AND ...` (`repository/cli_analytics/postgres/reader.py:284`).

### New gap: session list requires a cost_daily row
`get_session_cost_facts` does `FROM cost_daily ... JOIN sel ... JOIN act` (`reader.py:667-679`). A session with dimension events but no `agent.usage.request`/api-request rows is absent from the session list even though `session_dims` exists. For unattended `claude -p` runs this means: if the Stop-derived usage events are lost, the session disappears entirely, regardless of the end-event fallback. This is the strongest P3 backend lead to check on prod.

### P4 (subagent cost) - claim partly corrected
- Totals do reach `session_usage` (latest `agent.subagent.usage` with totals per agent, `source_cost_usd` NULL, `token_source='subagent_usage'`; `rollups.py:628-703`), only when `_totals_are_a_source` holds (`rollups.py:588-607`).
- Totals never reach `cost_daily`; `reader.py` has no reference to `session_usage` or `subagent_invocations`. KPI, session list, developer and model costs read `cost_daily` (`reader.py:334,352,407,667`). Per-subagent cost in session detail comes from `log_events` api_request rows by `agent_id` (`reader.py:1004-1015`).
- A subagent with totals but no request rows has tokens but no dollar cost in the list or KPIs. Subagent rows use the parent `session_id` (`rollups.py:628-629`), so attribution to the parent session holds.
- `insights_handler.py:1155,1251` mentions a `session_usage` aggregation key; not traced.

### Dedup, lag, list filters
- Dedup ledger: first stored version of a (type, session, event_id) wins; changed content needs a new `event_id` (`ingestor.py:17-27`; storage guide line 110). "Latest totals per agent" uses `DISTINCT ON (session_id, agent_id) ORDER BY ts DESC, ingest_seq DESC` (`rollups.py:645-652`).
- Rollup refresh every 30 s, batch 5000 (`configs/config.py:231-232`); refresher loop not read.
- Session list access is limited to super admins and project admins (`cli_analytics.py:117-130`); excluded when `started_at` is NULL or outside the window (clamped to raw retention), when filters (user email, project, repository, branch, search, framework) exclude it, or when no `cost_daily` row exists. Developer shown is `coalesce(session email, smallest cost_daily email, 'unknown')` (`reader.py:93-109`). A min-events filter was not found.

### Net effect on the plan
Questions for prod (replace earlier lists): per developer with missing factory MRs - is the project's `cli_analytics_enabled` true; did requests return `dropped`/`rejected_*` (needs CLI-side diagnostic, now added); do their sessions have `cost_daily` rows; for `claude -p` runs, do usage-request rows exist when `agent.session.end` is absent.
Scope choice from section 4 is decided: the backend plan in sections 6 to 9 (a gate-discard log/counter, plus relaxing the `cost_daily` inner join for sessions with dimension events only).

## 6. Backend decisions (answers to the backend team's questions)

Status: answers to the backend team's questions as recommended. Decisions 2 and 3 are superseded by section 7 (query-time pricing); decision 1 is extended by section 8 (`cost_available`); decisions 4 and 4b stand.

| # | Question | Decision | Notes |
|---|---|---|---|
| 1 | Should a session with dimension events but no cost rows appear in the session list? | A: list it at $0 by relaxing the join in `get_session_cost_facts` (`reader.py:673-675`) only | KPI cost totals stay unchanged and a test pins that. The list count can exceed the number of sessions with cost. Add a "cost unavailable" marker or a log line saying why cost rows are missing, so $0 is not read as free. Fixes the AC2 symptom (a `claude -p` session with lost usage events vanishes from the list). |
| 2 | Where do subagent token prices come from? | Superseded by section 7: the live catalog through the existing query-time pricer | The priced totals row needs a reliable model-price lookup; unknown models must produce no cost, not a guess. |
| 3 | What happens to a priced totals row when `agent.usage.request` rows arrive later, and to existing days? | Superseded by section 7: no priced rows are stored; the write-side `_totals_are_a_source` guard already prevents double-counting, and past days are corrected at query time | A priced row exists only while the agent has no request rows; once requests arrive it is removed, mirroring the `_totals_are_a_source` DELETE (`rollups.py:588-607`). Cannot double-count. A day's cost can change once when late requests replace the estimate. Days not re-dirtied keep their old figures; a historical backfill (B) is a separate decision. Add a test for the switch from totals-only to requests arriving. |
| 4 | What counts as a project-gate discard "count"? | A: one structured log line per discard plus an in-process counter labelled by reason | Log carries reason code, route (OTLP or hooks) and event count; no email or project name; nothing persisted. Record zero-event OTLP discards explicitly, since `N == 0` is otherwise indistinguishable from success. For OTLP this is the only trace, because the CLI does not decode protobuf. |
| 4b | Should the discard log line carry a pseudonymous user ID? | A: yes, an HMAC of the user ID, in the log line only | Not a counter label (metric cardinality). Key from existing secret config, never logged; rotating it breaks correlation across the rotation. Consider truncating to a short fixed length. Check log retention and access against data-handling rules. Allows a distinct-ID count of affected developers. |

Not backend scope: the CLI hooks-stream drop warning (already committed in the CLI) already logs the drop reason locally for hooks responses.

Nothing is open in this table.

## 7. Verification result and redesign (supersedes decisions 2 and 3 and the null-cost idea in section 6)

Source: read-only code check of the backend repository HEAD, plus the backend team's own analysis relayed in the ticket discussion. Nothing measured from prod.

### Verified facts
- Displayed cost is priced in Python at query time from `cost_daily` token columns using the live catalog (`service/analytics/handlers/coding_agent_pricing.py:62`, `CatalogPricer`; `reader.get_session_model_costs` at `reader.py:364-384`). No displayed total reads the stored `cost_usd`. A model absent from the catalog prices at 0.0 with a warning; `CatalogPricer` has no default-model fallback.
- `cost_usd: float` is required in `LocalAnalyticsSessionRow` (`rest_api/models/cli_analytics.py:224`), and `_float_sort_key` fails on None at five sort sites. Cost can never be NULL.
- `MCP_AUTH_HMAC_SECRET` (`configs/config.py:533`, empty default) also keys tool-OAuth state signing and `RedisEncryption` (`service/oauth/stores.py:37,41`, `service/oauth_security.py:82`). No existing pattern for hashing user IDs in logs.
- The rollup has no pricing code and no `llm_service` import. Whether the rollup refresher process has the model list loaded is unverified, but under the redesign it no longer matters.
- Past days can be re-dirtied only within raw retention, via `python -m codemie.repository.cli_analytics.postgres.backfill --from D --to D [--now]`; no REST/admin route.

### Redesign for subagent cost (replaces "price totals into cost_daily")
- Do not price in the rollup: it would build a new callback pattern, store USD that goes stale when the catalog changes, and nothing displayed reads it.
- Add the subagent totals tokens (`session_usage` rows with `token_source='subagent_usage'`, grouped by session and model) to `get_session_model_costs` (`reader.py:364`) and `get_session_detail_model_costs` (`reader.py:752`), so they flow through the existing `price_session_models` unchanged.
- No double-count guard is needed in the reader: totals rows exist only when `_totals_are_a_source` holds (`rollups.py:588-607`).
- Effects: no rollup pricing stage; no worry about the model list in rollup workers; past days are corrected immediately without re-dirtying or backfill.
- Residual (known, accept): token totals in `get_cost_kpis`, `get_model_breakdown` and `get_users` still read `cost_daily`, so money would include the subagent tokens while those token counts would not. Leave the token counts alone and record the mismatch.

### Corrections to section 6
| Item | Now |
|---|---|
| Decision 1 (list at $0) | Still A. The list row shows 0.0 for an unpriced or cost-less session; no NULL. A `cost_available` marker is optional, not required for correctness. |
| Decision 2 (subagent price source) | Resolved: the live catalog via the existing query-time pricer. |
| Decision 3 (priced totals row removed when requests arrive) | Not needed. Replaced by the query-time redesign above; the existing write-side guard already prevents double-counting. |
| "NULL means cost unavailable" | Invalid; cost is a required float. |
| Decision 4/4b (discard log, counter, pseudonymous ID) | Unchanged. Use a dedicated HMAC key, not `MCP_AUTH_HMAC_SECRET`; an empty key omits the hash field and never emits an unkeyed hash. |

### Process note
The backend team intends to send its spec back for this redesign (query-time pricing, dedicated HMAC key, null-cost correction). That is their spec gate, tracked in their own run.

## 8. Decision: additive `cost_available` field on the session-list row

Decided: yes, in scope.
- Add `cost_available: bool = True` to `LocalAnalyticsSessionRow` (`rest_api/models/cli_analytics.py`, next to `cost_usd` at line 224). Additive and non-breaking: existing consumers ignore it, and it does not affect sorting or `_pct`.
- Semantics: `false` when the session has no cost rows (the sessions listed because of the relaxed cost join, section 6 decision 1); `true` otherwise. `cost_usd` stays a required float and is 0.0 when `cost_available` is false.
- A session priced at 0.0 only because its model is missing from the catalog is a separate case; it has cost rows, so it stays `cost_available: true`. The warning logged by the pricer remains the signal for that case. Confirm this deliberately in the backend spec.
- UI follow-up (separate item, not part of the backend change): show "unavailable" instead of $0 when `cost_available` is false.
- Why: without it, a session whose usage events were lost reads as a real $0, which hides the `claude -p` loss this ticket is about.

## 9. Review of the backend implementation plan

The backend plan (query-time pricing of subagent totals in `get_session_model_costs` / `get_session_detail_model_costs`, opt-in left join with `cost_available`, gate-discard log line and counter, storage guide) matches sections 6 to 8. Reviewed from the plan text only; its line references were not checked against the backend code.

Points to tighten before implementation:
1. Zero-event discards: section 6 decision 4 requires recording an OTLP discard with `N == 0` explicitly, but Task 3's tests do not cover it. Add a test with `wire_count == 0`.
2. Filters on the totals branch: Task 1 scopes the `session_usage` branch of the UNION by `session_id` only. Verify it applies the same date, project, repository and developer filters as the `cost_daily` branch, otherwise subagent tokens can land in the wrong filter.
3. Detail view: the plan does not say what the session detail endpoint does for a session with no cost rows. If detail also needs `cost_daily` rows, the list would link to a 404 or an empty page. Add a check or test.
4. Counter semantics: the counter is in-process, per worker and reset on restart. State this in the storage guide so the numbers are not read as global.
5. Ops rollout: `CLI_ANALYTICS_LOG_HMAC_KEY` defaults to empty, so no hash appears until it is configured. Add the config rollout to the plan or ticket, otherwise logs give discard rates but not distinct developers.

Notes: `cost_available` is true when a session has any priced-source rows, totals included (consistent with section 8). Commits should follow Conventional Commits; ticket keys in subjects are allowed by the repo guide. TS/UI handling of the new field stays out of scope.
