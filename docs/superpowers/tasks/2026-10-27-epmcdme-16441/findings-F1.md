# F1 findings (emulated/inferred, not measured from prod)
Labels: [REPO] measured from git/code; [BACKEND-CODE] read-only backend repository checkout, deployed version unconfirmed; [INFERRED]; [NEEDS-HUMAN] prod access required.

## P2 bisect [REPO]
- session-project.ts has one commit (2026-10-21, #653): local project gate + X-CodeMie-Project header.
- Releases before that change lack the header; the first release with it shipped shortly before the window end.
- [INFERRED] A CLI without the project gate sends no X-CodeMie-Project -> backend 200 + project_context_required. Many MRs were likely built on older CLIs.
- Rule: CLI without the project gate => P2 (P1 if daemon stale too); CLI with the gate + restarted daemon => P2 only for unbound/non-ASCII sessions (multi-name sessions are now split per project, one hook request per project).

## Backend gate [BACKEND-CODE]
- Drop reasons: project_context_required (blank header, unknown/deleted project, no access, non-member), project_context_conflict (body vs header differ case-insensitively, or events differ), cli_analytics_disabled. Discards are HTTP 200; /event-hooks body {"accepted":0,"dropped":N,"reason":...}. 413 at ANALYTICS_INGEST_MAX_BODY_BYTES. No enable-history/discard counter found (not found != absent).

## Framework (decision order P1..P5; P1 listed apart, AC4)
P1 no analytics/SSO/old CLI/stale daemon; P2 dropped for project; P3 `claude -p` end-of-session loss; P4 subagent cost not collected; P5 backend drop/mis-aggregation (CLI with the project gate only).

## Queries for a human [NEEDS-HUMAN]
Q0 deployed backend version vs the backend repository checkout; Q1 EPMCDME factory-MR authors 30d; Q2 all-project sessions per author (dev, project, repo, branch, session, CLI version, cost, has session.end, has subagent events); Q3 authors in Q1 absent from EPMCDME; Q4 cli_analytics_enabled history; Q5 drop/413 counts by reason; Q6 CLI version + daemon restart per dev; Q7 subagent usage vs parent cost for 3 sessions.
Result table (Developer, MR/period, CLI, Pattern, Evidence, Product defect?) empty; only one developer (~9 sessions) comes from the ticket text.
