# Live validation: continued and reopened Claude Code sessions

Real hook process -> real proxy daemon and forwarder (built `dist`) -> fake backend, under a temp `CODEMIE_HOME`.
Nothing touches the real `~/.codemie`, `~/.claude` or the real daemon.

Ran: origin/main (no fix) (2026-11-10T19:11:36.606Z); #779 re-applied (what QA tested) (2026-11-10T19:11:30.405Z); this branch (2026-11-10T19:11:29.133Z)

## Result per scenario (all checks of the scenario passed = PASS)

| Scenario | origin/main (no fix) | #779 re-applied (what QA tested) | this branch |
|---|---|---|---|
| S1-ordinary-session | PASS | PASS | PASS |
| S2-continuation-no-own-work | FAIL | FAIL | PASS |
| S3-continuation-uuidless-copies | FAIL | FAIL | PASS |
| S4-continuation-qa-case | FAIL | FAIL | PASS |
| S5-parent-and-child-both-reported-once | FAIL | PASS | PASS |
| S6-late-parent-record | PASS | PASS | PASS |
| S7-reopen-idle-hook-first | FAIL | FAIL | PASS |
| S8-reopen-idle-native-first | FAIL | FAIL | PASS |
| S9-reopen-then-prompt | PASS | PASS | PASS |
| S10-ordinary-resume-sources | PASS | PASS | PASS |
| S11-reopen-after-spool-swept | FAIL | FAIL | PASS |
| S12-two-idle-reopens-then-work | FAIL | FAIL | PASS |

## Failed checks and what was observed

### S1-ordinary-session

_Ordinary session: usage, summary and native records are all forwarded (no regression)_

- **origin/main (no fix)**
  - ok: 6 usage requests forwarded (got 6)
  - ok: summary starts at the first line (got 2026-11-01T17:44:35.647Z)
  - ok: 2 native records forwarded (got 2)
- **#779 re-applied (what QA tested)**
  - ok: 6 usage requests forwarded (got 6)
  - ok: summary starts at the first line (got 2026-11-01T17:44:35.647Z)
  - ok: 2 native records forwarded (got 2)
- **this branch**
  - ok: 6 usage requests forwarded (got 6)
  - ok: summary starts at the first line (got 2026-11-01T17:44:35.647Z)
  - ok: 2 native records forwarded (got 2)

### S2-continuation-no-own-work

_16992: continuation with only copies, synthetic placeholder and /exit lines reports nothing_

- **origin/main (no fix)**
  - **FAIL**: 0 usage requests (got 13)
  - **FAIL**: 0 output tokens (got 12192)
  - **FAIL**: no summary (got {"started_at":"2026-11-01T17:44:35.647Z","ended_at":"2026-11-10T16:23:53.100Z","duration_ms":772757453,"turns":6,"tool_calls":9})
- **#779 re-applied (what QA tested)**
  - **FAIL**: 0 usage requests (got 1)
  - ok: 0 output tokens (got 0)
  - **FAIL**: no summary (got {"started_at":"2026-11-10T16:23:52.000Z","ended_at":"2026-11-10T16:23:53.100Z","duration_ms":1100,"turns":2,"tool_calls":0})
- **this branch**
  - ok: 0 usage requests (got 0)
  - ok: 0 output tokens (got 0)
  - ok: no summary (got null)

### S3-continuation-uuidless-copies

_16992 criterion 2: continuation whose copies include uuid-less lines starts at its own first line_

- **origin/main (no fix)**
  - **FAIL**: only the own request (got 13 / 12513 tokens)
  - **FAIL**: Started = own start 2026-11-10T16:23:52.000Z (got 2026-11-01T17:44:35.647Z)
  - **FAIL**: 1 turn (got 5)
- **#779 re-applied (what QA tested)**
  - ok: only the own request (got 1 / 321 tokens)
  - **FAIL**: Started = own start 2026-11-10T16:23:52.000Z (got 2026-11-01T17:44:35.647Z)
  - ok: 1 turn (got 1)
- **this branch**
  - ok: only the own request (got 1 / 321 tokens)
  - ok: Started = own start 2026-11-10T16:23:52.000Z (got 2026-11-10T16:23:52.000Z)
  - ok: 1 turn (got 1)

### S4-continuation-qa-case

_16992 QA case: uuid-less copies, then only a local /exit; Started must not be the parent's_

- **origin/main (no fix)**
  - **FAIL**: 0 usage requests (got 12)
  - **FAIL**: no summary dated before the continuation (got 2026-11-01T17:44:35.647Z)
- **#779 re-applied (what QA tested)**
  - ok: 0 usage requests (got 0)
  - **FAIL**: no summary dated before the continuation (got 2026-11-01T17:44:35.647Z)
- **this branch**
  - ok: 0 usage requests (got 0)
  - ok: no summary dated before the continuation (got undefined)

### S5-parent-and-child-both-reported-once

_16992: the parent keeps its own figures when the child is reported too_

- **origin/main (no fix)**
  - ok: parent keeps its 12 requests (got 12)
  - **FAIL**: child reports its own request only (got 13 / 12269)
- **#779 re-applied (what QA tested)**
  - ok: parent keeps its 12 requests (got 12)
  - ok: child reports its own request only (got 1 / 77)
- **this branch**
  - ok: parent keeps its 12 requests (got 12)
  - ok: child reports its own request only (got 1 / 77)

### S6-late-parent-record

_16992 (accepted D-2): parent record lands after the first pass; later passes send only own work_

- **origin/main (no fix)**
  - ok: second pass adds only the own request (6 -> 7)
- **#779 re-applied (what QA tested)**
  - ok: second pass adds only the own request (6 -> 7)
- **this branch**
  - ok: second pass adds only the own request (6 -> 7)

### S7-reopen-idle-hook-first

_16993: reopen without a prompt; native startup records arrive AFTER the SessionStart(resume) hook_

- **origin/main (no fix)**
  - **FAIL**: nothing stamped at or after the reopen reaches the backend (got 11)
  - ok: usage unchanged: 6 requests (got 6)
- **#779 re-applied (what QA tested)**
  - **FAIL**: nothing stamped at or after the reopen reaches the backend (got 6)
  - ok: usage unchanged: 6 requests (got 6)
- **this branch**
  - ok: nothing stamped at or after the reopen reaches the backend (got 0)
  - ok: usage unchanged: 6 requests (got 6)

### S8-reopen-idle-native-first

_16993 race: native startup records arrive BEFORE the SessionStart(resume) hook has marked the reopen_

- **origin/main (no fix)**
  - **FAIL**: nothing stamped at or after the reopen reaches the backend (got 13)
- **#779 re-applied (what QA tested)**
  - **FAIL**: nothing stamped at or after the reopen reaches the backend (got 6)
- **this branch**
  - ok: nothing stamped at or after the reopen reaches the backend (got 0)

### S9-reopen-then-prompt

_16993: a reopened session that then does real work reports that work and its held records_

- **origin/main (no fix)**
  - ok: the new request is reported: 7 requests (got 7)
  - ok: native records of the active reopen are forwarded (got hook_registered,plugin_loaded,managed_settings_resolved,mcp_server_connection,hook_execution_start,hook_execution_complete,user_prompt,api_request)
- **#779 re-applied (what QA tested)**
  - ok: the new request is reported: 7 requests (got 7)
  - ok: native records of the active reopen are forwarded (got hook_registered,plugin_loaded,managed_settings_resolved,mcp_server_connection,hook_execution_start,hook_execution_complete,user_prompt,api_request)
- **this branch**
  - ok: the new request is reported: 7 requests (got 7)
  - ok: native records of the active reopen are forwarded (got hook_registered,plugin_loaded,managed_settings_resolved,mcp_server_connection,hook_execution_start,hook_execution_complete,user_prompt,api_request)

### S10-ordinary-resume-sources

_startup/clear sources: native records of a session that was not reopened are never held_

- **origin/main (no fix)**
  - ok: all 6 native records forwarded (got 6)
  - ok: usage reported once: 6 (got 6)
- **#779 re-applied (what QA tested)**
  - ok: all 6 native records forwarded (got 6)
  - ok: usage reported once: 6 (got 6)
- **this branch**
  - ok: all 6 native records forwarded (got 6)
  - ok: usage reported once: 6 (got 6)

### S11-reopen-after-spool-swept

_16993: reopen days later, after the sweep has already removed the spool of the session (the reporter case)_

- **origin/main (no fix)**
  - **FAIL**: nothing stamped at or after the reopen reaches the backend (got 13)
- **#779 re-applied (what QA tested)**
  - **FAIL**: nothing stamped at or after the reopen reaches the backend (got 6)
- **this branch**
  - ok: nothing stamped at or after the reopen reaches the backend (got 0)

### S12-two-idle-reopens-then-work

_16993: two prompt-less reopens in a row change nothing; real work afterwards is reported once_

- **origin/main (no fix)**
  - **FAIL**: idle reopens change nothing (forwarded 26, usage 6)
  - ok: the new request is reported once (got 7)
- **#779 re-applied (what QA tested)**
  - **FAIL**: idle reopens change nothing (forwarded 12, usage 6)
  - ok: the new request is reported once (got 7)
- **this branch**
  - ok: idle reopens change nothing (forwarded 0, usage 6)
  - ok: the new request is reported once (got 7)
