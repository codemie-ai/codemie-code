# Backend handoff: claude -p end-of-session loss and subagent usage/cost (EPMCDME-16441, P3 and P4)

Audience: backend team. Built from findings-T2.md, findings-T3.md and findings-F2.md (CLI code reading plus a read-only trace of the
sibling backend checkout at commit 48fa31b56). Nothing here was measured from prod. Anything marked "inferred, not measured from prod"
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
- Is the deployed backend the same as 48fa31b56?

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
1. Ingest/project gate: `agent.subagent.*` events carry the pinned project, so no gate change. The CLI also rewrites any differing project in an event to the pinned one before sending.
2. Dedup: first stored version wins for the same `event_id` (otlp.py:621-627, events.md:435). The CLI changes `event_id` when the cumulative usage content grows, so updates are not dropped (CLI event-id read; inferred, not measured from prod). Confirm that "latest event with totals wins per agent" (rollups.py:627-651) holds with the resulting multiple rows.
3. Aggregation (`rollups.py:575-660`, `_totals_are_a_source` at 589-607): `agent.subagent.usage` totals become a `session_usage` source (token_source=`subagent_usage`) only if there is no `usage_requests` row for that session+agent, no OTel `api_request` log for the session (any agent), no non-totals `session_usage` row for that agent, and no `attrs.otel_requests` row. The CLI sends both per-request rows and totals, so in a CLI-hook session the cost counts once through the requests (inferred, not measured from prod).
4. Possible drop (inferred, not measured from prod): if a subagent's `agent.usage.request` events never arrived AND the session has any OTel `api_request` (Claude Code native OTEL on), the subagent totals are suppressed and its cost disappears. Totals rows have `source_cost_usd = NULL` (rollups.py:640).
5. Reader: the storage guide (storage.md:186) says dashboard endpoints do not read `session_usage`/`subagent_invocations`; cost aggregates read `cost_daily` (reader.py:340-380, 764). Confirm whether subagent-only totals ever reach dashboard or KPI cost.
6. Recompute lag: `agent.subagent.usage` marks `USAGE_FACTS` dirty and is recomputed asynchronously via `rollup_dirty` (dirty.py:19); expect lag, not loss.

### Open questions that need prod/backend access
- For factory sessions with subagents: compare `subagent_invocations` token sums against `usage_requests` per `agent_id` and against `cost_daily` for the session.
- Do any factory sessions have subagent totals but no per-request rows, with OTel `api_request` present?
- Does the deployed reader (versus 48fa31b56) surface `session_usage` totals in KPI cost?
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
