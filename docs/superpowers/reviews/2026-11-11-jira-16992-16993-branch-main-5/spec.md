# Spec bundle: EPMCDME-16992 + EPMCDME-16993 (fetched from Jira 2026-11-11, verbatim)

Scope note: this repository is the CodeMie CLI (codemie-code). Both tickets also name backend root causes (postgres/reader.py, rollups.py, session_binding.py) that live in the separate backend repository and cannot be changed here. Judge the CLI-side acceptance: what the CLI sends for (a) a continued session with copied parent history and (b) a prompt-less reopen of an old session. Acceptance criteria for 16992 are only in comment 16079089. 16993 has no AC section; its 'Expected result' plus the verification comment 16079046 (OTel startup records still extend duration after PR 779) define acceptance.

---

**EPMCDME-16992**: https://jiraeu.epam.com/browse/EPMCDME-16992

- **Summary:** [CLI Analytics] A continued Claude Code session re-reports its parent's copied history: cost, tokens, tool calls, agents and turns are counted twice
- **Type:** Bug
- **Status:** In Progress

**Links**
- Relates to EPMCDME-16993: [CLI Analytics] Opening an old Claude Code session without a prompt rewrites its analytics: duration grows by days, the session moves into the opening day and is reclassified (In Progress, Bug)

The description also mentions EPMCDME-16537, EPMCDME-16774 and EPMCDME-16993 as text references. Only EPMCDME-16993 exists as a formal issue link.

**Attachments (3)**
1. `cli-analytics-8ac53605-session-detail.jpg` (id 6497755, 75 kB, by Auto EPMD-EDP AIAssistant, 2026-11-07T21:54:19Z)
2. `evidence-continued-session-copied-history.md` (id 6497753, 4 kB, by Auto EPMD-EDP AIAssistant, 2026-11-07T20:24:36Z)
3. `plan.md` (id 6499880, 12 kB, by Auto EPMD-EDP AIAssistant, 2026-11-09T15:48:43Z)

**Description (raw wiki markup, verbatim)**

```
h3. Environment
* Production https://codemie.lab.epam.com, backend 2.65.3
* CodeMie CLI 0.16.6 (claude-code-otlp plugin), Claude Code on macOS, project epm-cdme-cp
* Checked 2026-11-07 ~20:00 UTC (API) and ~21:30 UTC (UI), read-only, with the reporter's own sessions

h3. Sessions
* Parent P: 8ac27927-7e9b-4f6f-b5f4-f5df494d7aeb (started 2026-11-01T17:44:35Z)
* Continuation C (reported): 8ac53605-1c95-4576-87c9-d77d73ce5cbc. P's transcript records {{continued-in}} -> C at 2026-11-01T19:43:28.390Z.

h3. Steps to reproduce
# With CodeMie CLI 0.16.6 analytics connected (claude-code-otlp), work in a Claude Code session P: several prompts, API requests and tool calls.
# Let Claude Code continue P into a new session C (P's transcript gets a {{continued-in}} record naming C; C's transcript starts with P's lines copied: same uuid, message.id, requestId and timestamps, sessionId rewritten to C).
# End C without new model work.
# Open Analytics > CLI Analytics, set Users = yourself and Start/End date = the whole day of P's work (here the UTC day 2026-11-01; in a UTC+1 browser 11/01/2026 01:00 - 11/02/2026 00:59).
# Check Sessions > C (session detail) and the Overview, Cost, Users and Repositories tabs.

h3. Actual result
* C's own work is one {{<synthetic>}} assistant message with 0 tokens, 0 tool calls, 0 prompts (3 own transcript lines; 528 of 531 lines are copies of P).
* Production shows for C: cost $7.4552357 (cache read $3.8158945), input 216, output 67,209, cache read 17,344,975, cache create 245,431, 108 api_request events (all 2026-11-01 17:45:33Z..19:36:12Z), tool calls 111 with "No outcomes observed", agents 2, turns 2, start 2026-11-01T17:44:35.647Z (P's first line).
* 109 of C's 110 usage-bearing messages have message ids that are also in P. P itself is counted correctly in Production (its tokens equal P main transcript + its two subagent transcripts exactly), so every value shown for C is a second copy.
* Aggregates for the reporter's 2026-11-01 UTC day: Overview/Cost total $69.2968 and 135,014,744 tokens instead of $61.8415 and 117,356,913 (+$7.4552, +12.1%); Users/Repositories turns 21 instead of 19.
* Session detail says 111 tool calls and 2 agents while the aggregate tabs show 0 tool calls and no agent subtypes for C (they use hook-counted calls; the detail uses the summary).

h3. Expected result
* A continued session reports only its own requests, tokens, cost, tool calls, agents and turns; lines inherited from the parent are not re-reported (here: $0, 0 tokens, 0 tool calls, 0 agents, 0 turns for C).
* C's start is its own start (2026-11-01T19:43:28Z; the CLI itself recorded sessionStartedAt 19:43:50.857Z), not the parent's.
* User, project and repository totals count each model request once.

h3. Technical root cause
* codemie-code v0.16.6 {{src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts}} reads transcript lines after the persisted mainOffset; a new session id starts at offset 0, so C's first Stop/SessionEnd pass reads P's copied lines.
* {{transcript/usage-request.ts}} derives an agent.usage.request for each copied request, and {{transcript/session-summary.ts}} / {{session-signals.ts}} (countTurns, tool and agent counts) build agent.session.summary from all lines. No code handles Claude Code's {{continued-in}} continuation or skips lines whose uuid/message.id belong to another session.
* {{claude-code-otlp.event-id.ts}}: usage event ids are content keys of payloads carrying C's session id, and the backend groups requests per session, so the copies are stored as C's own rows.
* Backend start = least(started_at, activity_started_at) then takes the copied first timestamp.

h3. Impact
* Financial correctness: API-equivalent cost and tokens of continued work are counted twice in user, project and repository totals. Here +$7.46 (+12.1%) on one day.
* Session detail shows another session's tool calls, agents and turns.
* Permanent once ingested.

h3. Evidence
* Attached evidence-continued-session-copied-history.md: per-metric own vs copied vs Production table, catalog prices and calculation, aggregate deltas, code path. Contains ids, timestamps and counts only; no conversation content.
* Attached cli-analytics-8ac53605-session-detail.jpg: Production UI session detail of C (see comment of 2026-11-07).

h3. Related (not duplicates)
* EPMCDME-16537: codemie-claude --resume/--continue re-sends legacy metric records (claude.metrics-processor.ts, same JSONL appended). There tokens and cost are not doubled; here a new session id with copied history doubles cost and tokens through the claude-code-otlp transcript path.
* EPMCDME-16774: delivery by a later launch uses that launch's repository headers (legacy /v1/metrics path).
* EPMCDME-16993: the same session C was later reopened without a prompt, which moved it into 2026-11-07 reports.
```


**Comments on EPMCDME-16992 (2 total, oldest to newest)**

1. **ID 16070594**: Auto EPMD-EDP AIAssistant (Auto_EPMD-EDP_AIAssistant@epam.com), created 2026-11-07T21:54:19.572+0000
2. **ID 16079089**: Dzmitry Lopukh (Dzmitry_Lopukh@epam.com), created 2026-11-10T16:53:40.799+0000

---

**Comment 16070594**

```
h3. Production UI verification (2026-11-07 ~21:30 UTC, backend 2.65.3, browser UTC+1)
Analytics > CLI Analytics, Users = reporter, read-only. UI values equal the API responses.

||Where||Value shown for C (8ac53605)||Comment||
|Session detail: Cost / Cache-read|$7.46 / $3.82|P's copied requests|
|Session detail: Input / Output / Cache read / Cache create / Total|216 / 67.2K / 17.3M / 245.4K / 17.7M|P's copied requests|
|Session detail: Turns / Tool calls / Agents / Skills|2 / 111 ("No outcomes observed") / 2 / 0|P's prompts, tool uses and Agent calls|
|Session detail: Started|Nov 01, 18:44 (= P's start 17:44:35Z)|C was created 19:43:28Z|
|Session detail: Token & cost growth|108 request points rising to $7.46|P's request timeline|
|Session detail / Tools & Models: Most Used Tools, Agent subtypes|No data available|no hook-counted tool calls in C|
|Overview / Users / Repositories: Tool calls|0|detail says 111|
|Whole day 2026-11-01 UTC (API /v1/analytics/cli-analytics/overview, the endpoint the Overview tab calls): Sessions / total cost|4 / $69.30|includes C's $7.46; expected $61.84|

Attached cli-analytics-8ac53605-session-detail.jpg (session detail of C).

Note: the dollar amounts in the original description were lost when the ticket was created (the "$" values were removed by shell expansion, e.g. "cost .4552357", "here: /bin/zsh"). The description was corrected on 2026-11-07; no figures changed.
```

---

**Comment 16079089**

```
h3. Verification: partially fixed (copied history is no longer re-reported; Started is still the parent's)

*Environment:* Preview ([https://codemie-preview.lab.epam.com|https://codemie-preview.lab.epam.com/]), session detail read from /v1/analytics/cli-analytics/sessions/\{id}
*CodeMie CLI:* {{0.16.6}} (main {{dcb710b8}} with the fix; build before the fix {{{}940ded91{}}}), Claude Code {{{}2.1.318{}}}, Windows 11
*Developer:* dzmitry_lopukh
*Test date:* 2026-11-10
h3. What was checked
 * Parent P {{{}122c71ed-d794-4c58-945a-8be697988354{}}}: one prompt, one Bash tool call, 2 model requests, started 2026-11-10T16:10:45.913Z.
 * P's transcript got a {{continued-in}} record naming the continuation; the continuation transcript is P's lines copied (same uuid, message.id, timestamps, sessionId rewritten). The continuation was assembled by hand, not created by Claude Code itself. Opened as a fresh session and closed with /exit, no prompt, no own model work.
 * The same scenario on the build before the fix and on main with the fix.

h3. Results
||Session||Build||Cost||Input / Output / Cache read / Cache create||Turns / Tool calls||Started (UTC)||Result||
|{{122c71ed-d794-4c58-945a-8be697988354}} (P)|-|0.1401636|20261 / 77 / 57196 / 23288|1 / 1|16:10:45.913|reference|
|{{c947eb0c-188c-48d9-96fd-93afbed95d30}} (continuation)|before the fix ({{{}940ded91{}}})|0.1401636|20261 / 77 / 57196 / 23288|1 / 1 (detail total), 0 hook-counted|16:10:48.156|bug reproduces: P's cost, tokens, turn and tool call shown a second time|
|{{74d08da4-6f14-40bc-9ff3-6a0eb551e802}} (continuation)|with the fix ({{{}dcb710b8{}}})|0|0 / 0 / 0 / 0|0 / 0|16:10:48.156|copies not re-reported; Started is still P's first line (the continuation's own start was 16:23:52Z)|
h3. Acceptance criteria
 # A continued session reports only its own requests, tokens, cost, tool calls, agents, turns: *passed* (0 on the fixed build; the build before the fix shows P's values)
 # The continuation's start is its own start: *failed* (Started = 2026-11-10T16:10:48.156Z, P's first line; own start 16:23:52Z; Duration 808,718 ms is counted from that start)
 # User/project/repository totals count each model request once: *passed* for the continuation with the fix (cost 0); not measured on aggregate tabs

h3. Notes
 * The continuation was created by copying P's transcript, because {{claude --resume}} under a new id publishes nothing ("no recorded scope"), so a real Claude Code continuation (background session resumed) was not exercised.
 * On the build before the fix the detail shows 1 tool call in the total and 0 in the hook-counted field.
```

---

**EPMCDME-16993**: https://jiraeu.epam.com/browse/EPMCDME-16993

- **Summary:** [CLI Analytics] Opening an old Claude Code session without a prompt rewrites its analytics: duration grows by days, the session moves into the opening day and is reclassified
- **Type:** Bug
- **Status:** In Progress

**Links (issue links):**
- Relates to EPMCDME-16496: [CLI Analytics] Sessions without token usage are missing from CLI Analytics, so GitHub Copilot Chat sessions never appear (Bug, In Progress, Major)
- Relates to EPMCDME-16992: [CLI Analytics] A continued Claude Code session re-reports its parent's copied history: cost, tokens, tool calls, agents and turns are counted twice (Bug, In Progress, Major)

The description also mentions EPMCDME-16847, EPMCDME-16774 and EPMCDME-16992 under "Related (not duplicates)". Only EPMCDME-16992 is an actual issue link. EPMCDME-16847 and EPMCDME-16774 are text references only.

**Attachments (3):**
1. `cli-analytics-nov7-window-overview.jpg` (46,420 bytes), added 2026-11-07 21:57:20 UTC, by Auto EPMD-EDP AIAssistant. ID 6497666.
2. `evidence-reopen-without-prompt.md` (4,049 bytes), added 2026-11-07 20:26:43 UTC, by Auto EPMD-EDP AIAssistant. ID 6497754.
3. `plan.md` (12,240 bytes), added 2026-11-09 15:48:59 UTC, by Auto EPMD-EDP AIAssistant. ID 6499881.

**Description (raw Jira wiki markup, verbatim):**

```text
h3. Environment
* Production https://codemie.lab.epam.com, backend 2.65.3
* CodeMie CLI 0.16.6 (claude-code-otlp plugin), Claude Code on macOS (UTC+1)
* Checked 2026-11-07 ~20:00 UTC (API) and ~21:30 UTC (UI), read-only, with the reporter's own sessions

h3. Session
* 8ac53605-1c95-4576-87c9-d77d73ce5cbc (repository epm-cdme/hyperfactory/control-plane, branch EPMCDME-16428). All model work happened on 2026-11-01, last transcript write 2026-11-01T19:46:29Z.
* On 2026-11-07 the reporter only opened/viewed the session and sent no prompt. Local evidence: a Claude Code process opened it at 18:17:46Z (CLI evidence record created 18:17:46.494Z, launch_mode native, routed_via_codemie false), two hook posts at 18:17:46Z and 18:17:48Z, parse state saved 18:17:48Z. The transcript was not modified: no prompt, no model request, no tool call.
* The same happened to three more of the reporter's old sessions within 43 s; each now ends at the open: 8ac27927-7e9b-4f6f-b5f4-f5df494d7aeb (18:17:50.967Z), 9d0bf1c0-d446-457c-994c-d54732be8627 (18:17:30Z), d0fb4149-61de-4142-b621-4c1831183481 (18:18:13.659Z).

h3. Steps to reproduce
# With CodeMie CLI 0.16.6 analytics connected (claude-code-otlp), finish a Claude Code session S with some work on day D1.
# Several days later (D2), open S again in Claude Code (resume) and exit without sending a prompt.
# Open Analytics > CLI Analytics, set Users = yourself and Start/End date = a short window on D2 around the open (here 11/07/2026 19:00 - 19:30 in a UTC+1 browser = 18:00-18:30Z).
# Check Overview, Cost, Users, Activity, Sessions and the session detail of S.
# Repeat with the whole D1 day (here the UTC day 2026-11-01) and with S's displayed start minute.

h3. Actual result
* Usage and cost are unchanged (108 api_request events, all 2026-11-01; $7.4552357): the open added no consumption.
* Duration is 520,392,765 ms = 6d 0h 33m (start 2026-11-01T17:44:35.647Z to end 2026-11-07T18:17:48.412Z) with active time 625 ms.
* The session is now listed for D2: Overview/Cost for 2026-11-07 18:00-18:30Z show 1 session, $7.4552357, 17,657,831 tokens, 2 turns and Dead sessions 1, all consumed on 2026-11-01. Users shows Last active Nov 07 19:17 (the open). Activity places the session on Sunday 17:00 (its 2026-11-01 UTC start), outside the selected window. The Overview "Net lines over time" chart is empty (see comment: it plots net lines, not cost).
* The session is also still listed for the whole D1 day (2026-11-01, via its D1 usage rows), so its $7.46 is reported in both the D1 and the D2 day views. It is not listed for its displayed start minute (2026-11-01 17:44:00-17:44:59Z).
* Classification is unknown / legacy_project, bound by the D2 open (native launch, not routed via CodeMie). The D1 work ran through the CodeMie SSO proxy (CLI wrapper session record: provider ai-run-sso), i.e. CodeMie-routed.

h3. Expected result
* Opening or resuming a session without a prompt, model request or tool call does not change its analytics: duration ends at the last real activity on D1, the session is reported only for D1, and its classification and project attribution stay those of the work that was done.
* Per the reader's own rule (reader.py _active_in_window): an old session resumed with no new activity in the window stays excluded from that window.

h3. Technical root cause
* The CLI sends the reopened session's lifecycle hooks as hook events stamped at the open time. Backend vocabulary.DIMENSION_HOOK_TYPES includes agent.session.start/stop/end; the rollup sets session_dims.started_at = min(ts) and last_event_at = GREATEST(last_event_at, max(ts)) of these types (postgres/rollups.py).
* postgres/reader.py _activity_range: end = greatest(last_event_at, ended_at), so duration runs to the open.
* postgres/reader.py _SESSION_ADMITTED_IN_WINDOW: (started_at in window AND has_any_activity) OR active_in_window. has_any_activity has no day bound. This session's first dimension hook is the open, so started_at lies on D2 and the whole session, with its D1 cost, is admitted to D2.
* KPI tiles are session-scoped: get_cost_kpis / get_session_model_costs sum every cost_daily row of the admitted sessions with no day filter, so all D1 usage lands in the D2 tiles.
* The first accepted evidence request binds subscription class and origin from that request's headers (session_binding.py / cli_analytics_project_gate.py), so the open's launch context decides the class of past work.
* The delivered spool lines are no longer on disk, so the exact hook types are inferred: only a dimension hook type moves last_event_at, and the CLI evidence record is created by the SessionStart pass.

h3. Impact
* Duration is overstated by days for any session that is reopened later; Sessions list, Session Detail and duration-based reports are affected.
* Day/period reports show old consumption on the day a session was merely opened, in addition to its own day, so adding up daily views counts the cost twice.
* Subscription class and project origin of past work can change on a later open (here CodeMie-routed work reads as unknown).

h3. Evidence
* Attached evidence-reopen-without-prompt.md: timeline of the open, Production values, window queries, code path. Ids, timestamps and counts only; no conversation content.
* Attached cli-analytics-nov7-window-overview.jpg: Production UI Overview for the D2 window (see comment of 2026-11-07).

h3. Related (not duplicates)
* EPMCDME-16847: Claude Desktop duration extended by housekeeping OTel records (retention_sweep, metric exports, minutes). Here the session lifecycle hooks of a later open extend it by days and also change window membership and classification.
* EPMCDME-16774: a later launch delivers an old session under its own repository headers (legacy /v1/metrics path).
* EPMCDME-16992: same session also re-reports its parent's copied history.
```


**Comments on EPMCDME-16993 (3 total, oldest to newest)**

1. **16070695**: Auto EPMD-EDP AIAssistant (Auto_EPMD-EDP_AIAssistant@epam.com), created 2026-11-07T21:57:20.198+0000
2. **16077824**: Auto EPMD-EDP AIAssistant (Auto_EPMD-EDP_AIAssistant@epam.com), created 2026-11-10T12:53:00.485+0000
3. **16079046**: Dzmitry Lopukh (Dzmitry_Lopukh@epam.com), created 2026-11-10T16:26:23.652+0000

---

**Comment 16070695 (2026-11-07T21:57:20.198+0000)**

```text
h3. UI verification and root cause of "the 2026-11-07 KPI includes $7.46 but the trend chart does not" (2026-11-07 ~21:30 UTC, Production 2.65.3)

*UI check.* Analytics > CLI Analytics, Users = reporter, Start 11/07/2026 19:00, End 11/07/2026 19:30 (browser UTC+1 = 18:00-18:30Z). All eight tabs read; every value equals the API response for the same window:
||Tab||Shown||
|Overview|Sessions 1, Duration 6d 0h 33m, Turns 2, Tool calls 0, Est. cost $7.46, Cache-read cost $3.82, Total tokens 17.7M, Dead sessions 1; "Net lines over time": No data available|
|Cost|Total est. cost $7.46, 17.7M tokens, most expensive session = 8ac53605|
|Users|1 session, 2 turns, 0 tool calls, 17.7M tokens, $7.46, Last active Nov 07, 2026, 19:17 (the open)|
|Repositories|epm-cdme/hyperfactory/control-plane: 1 session, 2 turns, $7.46|
|Tools & Models|Most used tools: No data; claude-opus-5-5 17.7M tokens|
|Activity|1 session on Sunday, hour 17 (its 2026-11-01 17:44Z start, outside the selected window)|
|Efficiency|Dead sessions 1, Wasted cost $7.46|
|Sessions|1 row dated Nov 01, 18:44, $7.46|

*Whole-day windows (API, users = reporter):* 2026-11-01 -> 4 sessions, $69.30, including 8ac53605; 2026-11-07 00:00-21:30Z -> 3 sessions, $36.01, including 8ac53605 again. The same $7.4552 is reported on both days.

*Root cause of the KPI-vs-trend gap (2.65.3 code):*
# The session is in the 2026-11-07 window only because of this ticket: session_dims.started_at is the reopen hook time, and _SESSION_ADMITTED_IN_WINDOW admits started_at-in-window sessions whose activity exists on any day (_has_any_activity has no day bound).
# The KPI tiles are session-scoped, not day-scoped: get_cost_kpis and get_session_model_costs sum every cost_daily row of the admitted sessions without a day filter, so all 2026-11-01 usage is shown in the 2026-11-07 tiles.
# The only time series on Overview is not a cost trend: cli_analytics_handler.get_overview builds daily_buckets only from get_lines_daily (net lines per lines_daily day). 8ac53605 has no lines_daily rows (its copied history has no Write/Edit), so "Net lines over time" is empty. No CLI Analytics tab has a per-day cost trend.
# Code reading only, not observed in data: get_lines_daily is also restricted to the admitted sessions, not to the window's days, so a reopened session that did change lines on D1 would draw a D1 bar inside a D2 window.

*Conclusion:* the mismatch is a symptom of this ticket's window admission, not a separate defect. When a prompt-less reopen no longer admits the session to D2, the D2 tiles drop to $0 and only the D1 view reports $7.46.

Attached cli-analytics-nov7-window-overview.jpg (Overview for the D2 window).

Note: the dollar amounts in the original description were lost when the ticket was created ("$" values removed by shell expansion, e.g. ".4552357"). The description was corrected on 2026-11-07; the statement that the session is no longer listed for D1 was narrowed to its start minute, because it is still listed for the whole D1 day.
```

---

**Comment 16077824 (2026-11-10T12:53:00.485+0000)**

```text
h3. Re-verified on Production 2.65.3 (2026-11-10 ~12:50 UTC, read-only API): still reproduces

* 8ac53605-1c95-4576-87c9-d77d73ce5cbc is listed for the custom window 2026-11-07T18:00Z-18:30Z. That window contains only the reopen; the session has no API request or tool call after 2026-11-01T19:36Z.
* It is also listed for its real day, 2026-11-01 (whole day and 17:00-20:00Z). So it is still reported on both days.
* With Last 7 Days, the Sessions list shows it with Date "Nov 01". To a user this looks like a Nov 1 session leaking into a recent preset. The same will happen in Last 24 Hours / Last Hour for any old session reopened inside that window.
* Session Detail today: start 2026-11-01T17:44:35.647Z, duration 144.6 h, active_ms 625, subscription_type unknown, project_origin legacy_project. Unchanged from the description.
* No merge request is referenced on this ticket yet, although its status is Ready for Review.

*Relation:* this is the Claude Code reopen case of EPMCDME-16496 AC4 ("listed and counted for a period only when it has activity ... in that period"). 16496's AC4 is not met in Production 2.65.3. Production evidence is in the comment there, including two sessions admitted by records stamped at exit. The fix for this ticket should be verified against that criterion too.

*Root-cause location (tag 2.65.3):* {{postgres/reader.py}} {{_SESSION_ADMITTED_IN_WINDOW}}, line 225 (main: line 257 / {{_admitted_arms}} line 268). The first branch is {{started_at BETWEEN start AND end AND _has_any_activity}}, and {{_has_any_activity}} has no day bound (lines 214-222).

*Required regression test:* a live PostgreSQL test of a session active on D1 that gets only session.start/env/end (and git.snapshot) hooks on D2. It must not be listed or counted for any window on D2, in any of these endpoints: sessions, overview, users, repositories, cost, activity. Its duration must end at the last D1 activity.
```

---

**Comment 16079046 (2026-11-10T16:26:23.652+0000)**

```text
h3. Verification of the fix (PR 779): not fixed on Preview, duration still grows on a prompt-less reopen

*Environment:* Preview (codemie-preview.lab.epam.com), profile dlopukhproject, CodeMie CLI 0.16.6 built from main b1cb4324 (includes PR 779), Claude Code 2.1.318 on Windows, native {{{}claude --resume{}}}, reporter-style reopen (no prompt, no model request, no tool call). Checked 2026-11-10.

*Method:* a fresh session was created with {{codemie-claude}} and sent to Preview. Its Session Detail was recorded, then the session was reopened with {{claude --resume}} and closed without sending any prompt. The transcript file was byte-identical before and after the reopen. Session Detail was read again after the reopen.

*Before the fix (main 940ded91, control):*
||Session||Before reopen||After reopen||
|8cc18f11-8154-4d53-969f-bf55ec565337|duration 43 303 ms (43 s), active 39 932 ms|duration 771 106 ms (12m 51s), active 40 938 ms|

The session end moved to the reopen time (2026-11-10 15:23:41Z); usage, cost, start, subscription and origin were unchanged. This matches the report.

*With the fix (main b1cb4324):*
||Session||Reopened||Before reopen||After reopen||
|56822da0-0493-44ab-bf9b-b7b58069411c|15:44Z, closed with /exit|duration 37 407 ms (37 s), active 33 034 ms|duration 722 745 ms (12m 2s), active 34 047 ms|
|c8891bf2-d488-4b28-8944-7d52cbbeddb6|15:58Z, closed with Ctrl+C|about 32 s, active 31 688 ms|duration 409 168 ms (6m 49s), active 31 688 ms|
 * The session end after the reopen is 2026-11-10 15:44:43.647Z for 56822da0 and 15:58:07.553Z for c8891bf2, i.e. the time of the reopen, days/minutes after the last real activity.
 * For c8891bf2 the end is 15:58:07.553Z, about 2 s after the process started and before the session was closed (Ctrl+C was sent at 15:58:30Z), so the way the session is closed does not matter.
 * Start, usage, cost, subscription_type (codemie) and project_origin (profile) did not change in either case.

*Local observation (what the CLI spooled on the machine for the reopened session):*
 * No hook events were spooled for the reopen: the last spooled hook event of each session is from its original run (15:33:16Z and 15:51:54Z). The part of the fix that suppresses the reopen hook events works.
 * Claude Code's own OTel log records for the reopen were spooled and delivered, stamped at the reopen time: hook_registered, plugin_loaded, managed_settings_resolved, mcp_server_connection, hook_execution_start and hook_execution_complete at startup (for c8891bf2: 15:58:06.164Z-15:58:07.553Z), plus user_prompt for /exit in the first case.
 * The session end shown on Preview equals the timestamp of the last of these records to the millisecond in both runs (15:44:43.647Z and 15:58:07.553Z).

*Result:* the reproduction steps still lead to the actual result from the description: duration grows to the time of the open while active time stays unchanged. The fix is not sufficient for this ticket.
```
