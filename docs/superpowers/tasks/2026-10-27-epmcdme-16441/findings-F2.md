# F2 findings: backend trace for P5 (EPMCDME-16441)

Source: sibling checkout /Users/vponkratina/work/ai/codemie at commit 48fa31b56 (2026-10-27), read-only. It may differ from the
deployed backend; no prod/live access, so nothing below is measured from prod. "Inferred" = deduced from code/guides only.
Paths below are relative to `src/codemie/`, except guides (`.ai-run/guides/integration/`).

## 200 body shape
VERBATIM ANSWER: the `/event-hooks` discard body DOES carry a drop field; the `/logs|/metrics|/traces` discard body carries
`partial_success.rejected_*` and a reason in `error_message`. An ACCEPTED request carries no drop/reason field.

| Route | Discard body (gate refused) | file:line |
|---|---|---|
| `POST /event-hooks` (NDJSON, JSON answer) | `{"accepted": 0, "dropped": <N>, "reason": "<reason>"}`; `N` = number of NDJSON lines that parsed as objects (`wire_count`) | repository/cli_analytics/postgres/ingestor.py:379-381; wire_count otlp.py:884 |
| `POST /logs`, `/metrics`, `/traces` (OTLP) | `Export{Logs,Metrics,Trace}ServiceResponse` with `partial_success.rejected_log_records` / `rejected_data_points` / `rejected_spans` = N and `partial_success.error_message` = `<reason>`. Encoded JSON (camelCase: `partialSuccess.rejectedLogRecords`, `errorMessage`) if request content-type is application/json, else protobuf bytes (media type from `_PROTOBUF_RESPONSE_MEDIA_TYPE`) | ingestor.py:367, 220-242, `_OTLP_RESPONSES` ingestor.py:96 |
| `/event-hooks` accepted | literal `{}` (no `accepted` field) | ingestor.py:383 |
| OTLP accepted, none rejected | empty success response (zero bytes in protobuf, `{}` in JSON); `rejected` only set when non-zero | ingestor.py:220-226, 368-369 |
| OTLP discard with N == 0 (no countable records) | indistinguishable from accepted (setattr skipped when `rejected` falsy) | ingestor.py:222 |

Reason strings: `cli_analytics_disabled`, `project_context_required`, `project_context_conflict` (service/analytics/cli_analytics_project_gate.py:37-39).
Always HTTP 200 (rest_api/routers/cli_analytics.py:155-156, `_ingest_response`). Doc: events.md:36-43.
CLI Task 4 implication: hooks stream = parse JSON, test `dropped > 0` / `reason`. OTLP streams are posted as protobuf by the forwarder
(forwarder.ts:265-267), so the answer is protobuf `Export*ServiceResponse`: decode `partial_success` (field name per signal) or treat a
non-empty body as a rejection signal; `error_message` holds the reason when the gate refused (also holds a content-rejection text
"records the analytics storage cannot store were dropped", ingestor.py:99, for DB-rejected records, so match on the three reason
strings, not on mere presence).

## Gate drop reasons (gate.py:52-81)
Order inside the gate: blank/missing header -> `project_context_required` (:55-56); any `codemie_project_name` anywhere in the request
differing case-insensitively from the header, or two different values -> `project_context_conflict` (:58-59, no strip, no casefold
beyond lower()); then DB lookup: unknown/deleted project, no access (`has_access_to_application`), or no current membership (when
`ENABLE_USER_MANAGEMENT` and not admin/maintainer) -> `project_context_required` (:62-74); project exists but `cli_analytics_enabled`
false -> `cli_analytics_disabled` (:78-79). Policy lookup exception -> 503 (retried) (:75-77).
- Router order: flag 404, size 413, content type 415 (event-hooks), decode 400, then gate (events.md:24; router :163-176, :371-395).
- A discarded request writes nothing: no raw rows, ledger entry or dirty key (ingestor.py:366-367/379-381 return before `_store`). So
  re-sending after enabling would store it; the CLI has already deleted its spool on 2xx (forwarder.ts:130).
- Explicit project values counted: `codemie_project_name` on NDJSON events, OTLP log/span/metric attributes and resource attributes
  (otlp.py:475-482, 535, 674, 746, 807, 831, 884). A resource-attribute project from the Claude OTEL env that differs from the
  header triggers conflict for the whole OTLP request (inferred as a P2/P5 vector, not measured).
- No server-side log/metric of a discard exists on the path (no logger call in ingestor.py:366-381 or gate.py besides the 503 path).

## 413 limit
`config.ANALYTICS_INGEST_MAX_BODY_BYTES = 5_242_880` (configs/config.py:204). Checked on `/event-hooks` (router :378-379) and OTLP
(:166-167) against the whole body, before the gate; no partial acceptance. Guide: ~7,000 unsent `agent.usage.request` events reach it
and the same body is refused on every retry (events.md:18). The forwarder treats non-2xx other than auth as `failed` and re-posts the
whole snapshot (forwarder.ts:130-139), so an oversized session spool is stuck forever unless the CLI splits it (CLI check belongs to
another task; not verified here).

## Dedup collisions
- Identity: with a non-empty `event_id`, hash over (type, session key, event_id) on both `event-hooks` and OTLP-log hook paths (otlp.py:621-627,
  898-900, 635-637); user_email excluded. Without `event_id`: hash of the event JSON (otlp.py:900/910). Ledger key `(day, h)`, UTC day of
  `timestamp`, kept 14 days (`CLI_ANALYTICS_DEDUP_RETENTION_DAYS`) (storage.md:108-111; ingestor.py:171-174).
- "First stored version stays; a changed event must carry a new event_id" (events.md:435). Consequence (inferred, not measured): any CLI
  event re-sent with the same `event_id` but updated content (e.g. a regenerated `agent.subagent.usage` or session summary) is silently
  dropped as a repeat. Needs CLI-side check that `buildEventId` (src/agents/core/OtlpAgentAdapter.ts:161) changes with content.
- Same event_id in two sessions: both kept (session in hash). Same event across a UTC midnight with a shifted `timestamp`: stored twice
  (events.md:437), a double count rather than a loss.
- Discarded requests never enter the ledger, so the gate does not poison dedup.

## Developer / repository / branch attribution
- Developer: `user_email` of the authenticated sender on `/event-hooks` (router :386-387), stored but not in event identity; session
  developer in reader = `jwt_email` -> `dev_name_max` -> `developer_name` (reader.py:281-282), fallbacks via cost_daily email (:100-107).
  A request sent with a different login than the session's first can attribute to another email (inferred; P1/P5 edge).
- Project: stored name replaces `codemie_project_name` of hook rows naming the accepted project or none (`_attributed_to`,
  ingestor.py:278-284, 329-345). Rows naming a different project are left untouched (can only occur if gate passed with matching case).
- Repository: `coalesce(repo_remote, repository)` from `session_dims` (reader.py:276); repository = basename of the session's start dir
  (router docstring D2, :32-35). Branch: `session_dims.branch`, from `hook_events.git_branch` (storage.md:204). A hook-only session with
  no `started_at` is excluded from the sessions list (`d.started_at IS NOT NULL`, reader.py:287) (inferred: sessions never listed if
  no event sets `started_at`; not measured).
- Router doc D1 says the KPI session universe is sessions with a priced API call (cost_daily) (router :26-30), and session detail
  starts from cost_daily (reader.py:710). A factory session with hooks but no priced usage would not show in KPIs (inferred).

## Subagent roll-up
- `agent.subagent.usage` is stored in `hook_events` keyed by the event's own `session_id`, so the CLI must stamp the PARENT session id
  on it (otherwise it becomes its own session). Rows: `subagent_invocations` always; `session_usage` rows (token_source=`subagent_usage`)
  only when `_totals_are_a_source` holds (rollups.py:589-607): NO `usage_requests` for that session+agent, NO `api_request` in
  `log_events` for the session at all (any agent), NO non-totals `session_usage` row for that agent, and NO session_usage row with
  `attrs.otel_requests` on any day. The condition is stricter than "session has no own usage_requests": a parent that has any OTel
  `api_request` log suppresses ALL subagent totals (guide events.md:230 agrees). Latest event with totals wins per agent
  (rollups.py:627-651); one `usage` array element per model.
- Totals rows have `source_cost_usd = NULL`, no hourly rows (rollups.py:640, storage.md:141,295). The storage guide states the
  dashboard endpoints "do not read" session_usage / subagent_invocations yet (storage.md:186), and cost aggregates read `cost_daily`
  (reader.py:340-380, 764). Inference (not measured): subagent-only token totals reach neither dashboard cost nor KPI totals; they sit
  in session tables only. Whether the deployed reader differs must be checked on prod.
- Dirty marking: hook `agent.subagent.usage` marks `USAGE_FACTS` (dirty.py:19, storage.md:124); recompute is async via `rollup_dirty`,
  so lag, not loss, is expected.

## Suspected backend defects: ticket drafts (not filed; no ticket access)
1. Title: Distinct drop reasons for unknown project / no access / no membership (all report `project_context_required`).
   Evidence: service/analytics/cli_analytics_project_gate.py:63-74. Expected: separate reasons (e.g. `project_not_found`,
   `project_access_denied`) so senders can tell a bad header from a missing header.
2. Title: Log and count every CLI analytics ingest discard (reason, project, user, record count).
   Evidence: ingestor.py:366-367, 379-381 return silently; gate logs only on 503 (gate.py:76). Expected: structured log + metric, so
   silent loss (HTTP 200, spool deleted by CLI) is measurable on prod. Sev: high for this ticket's P5 measurement.
3. Title: Make a gate discard distinguishable from an empty success on OTLP routes with zero countable records.
   Evidence: ingestor.py:222 (`if rejected:`). Expected: `error_message` = reason even when N = 0. Low severity.
4. Title: Subagent totals suppressed whenever the session has any OTel api_request; not visible on dashboards.
   Evidence: rollups.py:589-607, storage.md:141,186; reader cost from cost_daily. Expected: confirm on prod whether a factory run with
   subagents loses subagent cost; either surface `session_usage` totals in KPI/cost or document the exclusion. INFERRED, needs prod check.
5. Title: Same-`event_id` update of a stored event is silently dropped (first version wins).
   Evidence: otlp.py:621-627; events.md:435. Expected: confirm CLI regenerates event_id for changed summaries; consider surfacing a
   count of ledger-skipped records in the response. INFERRED; may be CLI-side (check OtlpAgentAdapter buildEventId).
6. Title: Whole-body 413 with no partial acceptance on oversize spools.
   Evidence: router :166-167, :378-379. Expected: either larger limit/streaming or a documented sender-split contract; CLI must split.
   Possibly CLI work rather than backend.
No suspected correctness defect found in the dedup hash, case-insensitive project canonicalisation, or the dirty/rollup subagent SQL by
reading alone.

## Not verified here (needs prod / owner)
`cli_analytics_enabled` history for EPMCDME and the factory project; any discard counts in prod logs; deployed backend version vs
48fa31b56; which project the factory runs under; whether CLI posts oversize bodies. Event_id composition on the CLI side.
