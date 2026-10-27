# F3 ticket comment drafts (EPMCDME-16441)
All drafts: emulated/inferred from ticket text + repo + read-only backend checkout 48fa31b56, NOT measured from prod. A human with prod access must run the F1 queries (findings-F1.md) and confirm the deployed backend version before posting root causes as confirmed. Nothing posted to Jira.

## P1 - not product defects (list separately, AC4)
Developers with no analytics configured, no SSO auth, CLI < 0.16.0 or stale daemon. Needs Q2/Q3/Q6 from prod; no developer list exists yet.

## P2 - project gate drops
Cause: CLI < 0.16.0 sends no X-CodeMie-Project (gate added in ecab0a11, first in v0.16.0) -> backend 200 + project_context_required (inferred). For >= 0.16.0, multi-project sessions were discarded locally.
Fix: Task 1, commit 8844a322 (pin first-seen project; forwarder rewrites event project to the bound one). Unsendable (non-ASCII/whitespace) names still discarded, now with logger.warn.

## P3 - `claude -p` end-of-session loss
Evidence: findings-T2.md. SessionEnd may be cut at process exit (effective deadline in -p not determinable from code); lost data is agent.session.end and agent.git.snapshot, cost likely survives via Stop (inferred). Sweep is GC only, does not close sessions. No fix within two files; ticket draft in findings-T2.md.

## P4 - subagent identity/cost
Evidence: findings-T3.md. CLI carries parent session_id, pinned project, stable event_id; only agent_type-less check-ins skipped. No CLI gap fixed. Residual risks (inferred): subagent allowlist checked on its own cwd (worktree outside allowlist drops events); SessionEnd backstop lost in -p. Backend: conditional ticket draft (OTel api_request present suppresses subagent totals).

## P5 - backend
Evidence: findings-F2.md. Drops always HTTP 200; /event-hooks body {accepted,dropped,reason}; OTLP routes use partial_success (protobuf). 413 at 5,242,880 bytes; dedup on (type,session,event_id) 14d; six backend ticket drafts in findings-F2.md (not filed). CLI side: Task 4 (uncommitted at time of writing) warns on hooks-stream drops; OTLP protobuf responses not decoded.

## Verification note
Restart the proxy daemon after upgrading to verify Tasks 1 and 4. Findings outside P1-P5: stale tests in otlp-spool/__tests__ (session-project, project-interleave, tick-processor, spool-io, forwarder) expect old conflict behavior; update when tests are requested.
