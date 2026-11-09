# Acceptance spec: EPMCDME-16992 / EPMCDME-16993 (PR #779)

## EPMCDME-16992
- Loading configuration...
✔ Connected to CodeMie
**Updated:** 2026-11-09T17:59:50.127+0000

**Description (verbatim, Jira wiki markup):**

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

**Comments (1 total):**

**Author:** Auto EPMD-EDP AIAssistant (Auto_EPMD-EDP_AIAssistant@epam.com)
**Created:** 2026-11-07T21:54:19.572+0000

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

## EPMCDME-16993
- Loading configuration...
✔ Connected to CodeMie
**Updated:** 2026-11-09T18:00:07.482+0000 (displayed as 9/Nov/26 6:00 PM)

**Description: Actual result** (verbatim, Jira wiki markup)

```
h3. Actual result
* Usage and cost are unchanged (108 api_request events, all 2026-11-01; $7.4552357): the open added no consumption.
* Duration is 520,392,765 ms = 6d 0h 33m (start 2026-11-01T17:44:35.647Z to end 2026-11-07T18:17:48.412Z) with active time 625 ms.
* The session is now listed for D2: Overview/Cost for 2026-11-07 18:00-18:30Z show 1 session, $7.4552357, 17,657,831 tokens, 2 turns and Dead sessions 1, all consumed on 2026-11-01. Users shows Last active Nov 07 19:17 (the open). Activity places the session on Sunday 17:00 (its 2026-11-01 UTC start), outside the selected window. The Overview "Net lines over time" chart is empty (see comment: it plots net lines, not cost).
* The session is also still listed for the whole D1 day (2026-11-01, via its D1 usage rows), so its $7.46 is reported in both the D1 and the D2 day views. It is not listed for its displayed start minute (2026-11-01 17:44:00-17:44:59Z).
* Classification is unknown / legacy_project, bound by the D2 open (native launch, not routed via CodeMie). The D1 work ran through the CodeMie SSO proxy (CLI wrapper session record: provider ai-run-sso), i.e. CodeMie-routed.
```

**Description: Expected result** (verbatim, Jira wiki markup)

```
h3. Expected result
* Opening or resuming a session without a prompt, model request or tool call does not change its analytics: duration ends at the last real activity on D1, the session is reported only for D1, and its classification and project attribution stay those of the work that was done.
* Per the reader's own rule (reader.py _active_in_window): an old session resumed with no new activity in the window stays excluded from that window.
```

**Comments (1 total)**

- **Author:** Auto EPMD-EDP AIAssistant (Auto_EPMD-EDP_AIAssistant@epam.com)
- **Created:** 2026-11-07T21:57:20.198+0000 (displayed as 7/Nov/26 9:57 PM); not edited afterwards
- **Full text** (verbatim, Jira wiki markup):

```
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

## Owner-accepted decisions (do not re-raise)
# Accepted decisions: EPMCDME-16992 / EPMCDME-16993 (PR #779)

Owner decisions on code-review findings (review run 3, 2026-11-09). A review MUST NOT raise these
again as blocking findings unless the stated reopen condition has changed. Pass this file to the
review as an acceptance artifact (spec) together with the ticket text.

Not fixed, by decision. Each was weighed against the risk of the fix; none is a defect in the
ticket acceptance criteria (verified live, isolated, against baseline `main`).

## D-1 (review CR-001): parent lookup in project folders with more than 200 transcripts

- **Behaviour:** more than 200 sibling `.jsonl` files make `resolveInheritedUuids` return `null`
  ("incomplete"). `ensureInherited` retries an incomplete lookup on every pass. Each pass reads the
  tail of up to the 200 most recently modified siblings and streams larger ones whole (about
  250-270 ms per pass for 252 files / 75 MB; 717-798 ms for 68 files / 189 MB with no parent).
  A parent outside the 200 newest siblings is not found.
- **Decision:** not changed. We do not skip or give up on data: ending the retries (or capping the
  work) would make a missed parent permanent, which is the EPMCDME-16992 double count.
- **Why the suggested fix is rejected:** "locate the parent from the child's copied records" does
  not work on real data: in all 4 real parent/child pairs every copied line already carries the
  child's `sessionId`.
- **Reopen only if:** hook latency from this scan is observed in production, or a skip signal for
  sessions without copied history is available (idea: counted lines dated before the session's own
  `SessionStart`; unproven, `sessionStartedAt` was empty in real saved states).

## D-2 (review CR-002, decision_needed): copies reported before the parent is found

- **Behaviour:** if the parent's `continued-in` record is not on disk when a continued session's
  first pass runs, that pass reports the copied lines. They are not retracted; later passes and the
  summary exclude them (verified: first Stop sends the copies, second Stop only the own request).
- **Decision:** not changed. Could not be reproduced in practice: in the 4 real pairs the record is
  written 3-13 s (once 7.5 min) before the child's first own line. Holding events back until the
  lookup is final would delay or drop data for every ordinary session.
- **Reopen only if:** a real session is seen reporting copies on its first pass.

## D-3 (review CR-003): reopen suppression without saved parse state or with offset 0

- **No saved parse state:** a `resume` is treated as a first start by the handlers. In production the
  transition gate stops a `resume` of a session without an evidence record (`resume_unknown`; checked
  live: `resume`/`Stop`/`SessionEnd` -> `stop`, `startup`/`clear` -> `continue`). The remaining case
  (evidence record present, parse state deleted by hand) is rare; nothing in the plugin deletes
  parse state.
- **Offset 0 (state exists, no Stop ever ran):** not a defect. Nothing was reported before, so
  sending the old transcript is correct, not a duplicate (verified live).
- **Decision:** not changed. The suggested fix (move `mainOffset` to the file size on resume) would
  permanently drop work of a session that crashed before its first Stop.
- **Reopen only if:** parse state is shown to be lost in normal operation.

## D-4 (review run 4, CR-004): copied subagent transcripts

- **Behaviour:** if Claude Code copied a parent's subagent transcripts into the continued session's
  folder, their usage could be counted twice.
- **Decision:** not changed, and not valid as a finding. Checked on the 4 real parent/child pairs: no
  subagent file name appears in both folders (parents have 1/8/7/11 subagent files, children
  1/0/1/0). It was never observed, and a dedup rule would be built without a real example, which
  adds overhead and risks breaking correct counting.
- **Reopen only if:** a real continued session is seen with subagent transcripts copied from its parent.

## D-5 (review run 5): raw passthrough hooks on an idle reopened session

- **Behaviour:** hooks that are not lifecycle events (`Notification`, `InstructionsLoaded`, ...) are
  still forwarded at hook time while a reopened session has no activity of its own. This was the
  behaviour before this change.
- **Decision:** not changed. It is not shown that the backend uses these events to admit a session
  into a day's window, or that Claude Code fires them on a reopen. Gating them without that evidence
  risks dropping legitimate events (a `SubagentStop` already counts as activity by design).
- **Reopen only if:** real data shows a `Notification` (or another passthrough event) on an idle
  reopen putting the session back into the reopen day's analytics.

## Fixed after review run 4 (for reference, not accepted limits)

- CR-001: a reopen no longer moves the env baseline, so a model/permission-mode change made at
  resume is reported by the first active pass.
- CR-002: an idle reopened `SessionEnd` no longer runs the subagent backstop or the env check, so
  subagent usage is still sent once the session is active again.
- CR-003: tests added for the parent lookup when the `continued-in` record lies before the tail window.
- Review run 5 CR-001: an idle reopened `Stop`/`StopFailure`/`PreCompact` no longer settles deferred
  subagents or moves the env baseline.

## Evidence

Isolated harness and results: `C:\Users\OlehPrusak\codemie-eval\` (outside the repo). Related review
verdicts: `docs/superpowers/reviews/2026-11-09-pr779-*/code-review-final.json`.
