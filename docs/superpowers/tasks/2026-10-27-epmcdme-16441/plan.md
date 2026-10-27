# EPMCDME-16441 Plan: SDLC Factory sessions missing from CLI Analytics

**Goal:** Record the root cause of each missing-session pattern (P1 to P5) and fix the CLI-side defects.
**Conventions:** Commit per task using the repository's existing convention. Repo policy: tests are written or run only on explicit user request, so every task says `Test-first: no — tests not requested`. Backend checkout `/Users/vponkratina/work/ai/codemie` is read-only. Findings tasks (F*) produce ticket comments, not code. Findings reference: spec Investigation procedure and `technical-analysis.md`.

---

### Task F1 — Prod query and pattern classification (P1 to P5)
Test-first: no — findings task, no code.
- Run by the ticket assignee, who has analytics-backend access (an agent cannot reach prod). List EPMCDME factory-MR authors for the last 30 days and their CLI Analytics sessions (developer, repository, branch, MR period, CLI version). Also read the `cli_analytics_enabled` history for EPMCDME and any discarded-request counts the backend keeps.
- Assign each missing developer to exactly one of P1 to P5. P1 (no analytics, no SSO auth, old CLI, stale daemon) is listed apart from product defects (AC4). For P2, bisect the project-gate fix with `git log -- src/providers/plugins/sso/proxy/plugins/otlp-spool/session-project.ts` against each developer's CLI version.
- Confirm the deployed backend version before concluding anything from the sibling checkout.

### Task F2 — Backend trace for P5 (read-only)
Test-first: no — findings task, no code.
- In `/Users/vponkratina/work/ai/codemie`, read `rest_api/routers/cli_analytics.py`, `service/analytics/cli_analytics_project_gate.py`, `repository/cli_analytics/postgres/{ingestor,rollups,dirty}.py`, and the guides `cli-analytics-events.md` and `cli-analytics-storage.md`.
- Compare against what the CLI sends (`X-CodeMie-Project`, `codemie_project_name`, `event_id`, subagent session id). Record on the ticket: the gate drop reasons and what the 200 body reports, the 413 limit, dedup collisions, developer/repository/branch attribution, and the subagent roll-up (`agent.subagent.usage` counted only when the session has no own `usage_requests`).
- For every backend defect found, file a separate backend ticket and link it. Make no backend change.

### Task 1 — Pin multi-project sessions instead of discarding them
Files: `src/providers/plugins/sso/proxy/plugins/otlp-spool/session-project.ts`, `.../forwarder.ts`, `src/agents/core/event-fields/identity-fields.ts`, `src/agents/core/session-project-pin.ts`, `docs/ARCHITECTURE-OTLP-PLUGIN.md`.
Test-first: no — tests not requested (would be: a session with two sendable project names binds the first and is forwarded, not discarded).
1. First confirm from `identity-fields.ts` and `session-project-pin.ts:45-62` that hook-time events already carry the pinned project for the whole session. Where a path bypasses the pin (subagent cwd, worktree, OTEL records), route it through `readPinnedProjectName`/`pinProjectName`.
2. `session-project.ts:39-57` (`decideProject`): when there are several distinct sendable names, return `bind`/`noop` on the first-bound project (`status.project`, else the first candidate) and no longer return `conflict`. Keep `conflict` for blank, unbound and non-ASCII names, which stay unsendable.
3. `forwarder.ts` (the post path around l.111-114): make the `X-CodeMie-Project` header and every outgoing event's `codemie_project_name` equal the bound project, rewriting a diverging event value, so the backend `project_context_conflict` cannot fire.
4. Add a visible diagnostic for unsendable names: a `logger.warn` with `sanitizeLogArgs` at the point where the session is marked conflicted (`applyProjectDecision`, l.64-77). Add a `codemie doctor` line only if an existing doctor check already reads the spool or session status; skip it otherwise.
5. Replace the "conflict, discard backlog / accepted limitation" text in `docs/ARCHITECTURE-OTLP-PLUGIN.md` with the pin-first-seen behavior. Leave the sealed-prefix logic alone unless it becomes unreachable, and then remove it.

### Task 2 — `claude -p` end-of-session loss (decide by code reading)
Files (read first): `claude-code-otlp.plugin.ts` (`onSessionEndEvent` ~l.277, `retryOnce`), `src/cli/commands/hook.ts` (`handleSessionEnd`, sync budget), `otlp-spool/{completeness-gate,sweep}.ts`.
Test-first: no — tests not requested (would be: a session with no `agent.session.end` is closed by the sweep and its hooks-only data is sent).
1. Trace what happens to a headless run: is SessionEnd delivered before the process exits, does the 3s forward abort plus one resend lose it, and does the sweep close a session after `OTLP_ABANDONED_SESSION_GRACE_MINUTES` without `agent.session.end`?
2. Record the evidence on the ticket. If a fix fits in at most two files (for example the sweep closing sessions that never got `agent.session.end`), make it. Otherwise file a linked ticket with the evidence. Do not change the OTEL-only "never send" invariant in `completeness-gate.ts`.

### Task 3 — Subagent identity and cost carry-through
Files (read first): `claude-code-otlp.plugin.ts` (`onSubagentStopEvent` ~l.372), `transcript/subagent-usage.ts` (`findSubagentFiles`), `transcript/orchestrator.ts`.
Test-first: no — tests not requested (would be: a subagent stop event carries the parent `session_id` and a non-zero usage).
1. Verify that `agent.subagent.usage` and `agent.subagent.stop` events carry the parent session id, the same pinned `codemie_project_name`, a stable `event_id` and the cost fields, and that internal check-ins are the only skipped subagents.
2. Fix any CLI-side gap in place. Record the roll-up result for the backend (from F2) on the ticket, and file a linked backend ticket if the roll-up drops or double-counts subagent cost.

### Task 4 — Surface silent backend drops in the CLI
Files: `otlp-spool/forwarder.ts` (response handling l.130-139 and `postToBackend`).
Test-first: no — tests not requested (would be: a 200 response whose body reports `dropped` logs a warning with the reason).
1. After F2 confirms the 200 body shape, read it on `response.ok` and, when it reports `dropped` or a drop reason (`cli_analytics_disabled`, `project_context_required`, `project_context_conflict`), emit a sanitized `logger.warn` with the session id, stream and reason. Keep the result `'ok'`, so spool deletion is unchanged.
2. If the body carries no such field, skip the code change and record that on the ticket together with a backend ticket asking for one.

### Task F3 — Record root causes on the ticket
Test-first: no — findings task, no code.
- Post one comment per pattern P1 to P5 with the cause, the evidence, and either the fix (commit or MR) or the linked ticket. List P1 developers separately as not product defects. Note the daemon-restart requirement for verifying the Task 1 to 4 fixes, and anything found outside P1 to P5 as a separately filed ticket.

---
negative-constraints (checked): no backend edits (F2 read-only; backend defects get tickets); no backfill or re-ingest; no `cli_analytics_enabled` change (recorded only); OTEL-only invariant untouched (Task 2); "Pure chat" labeling excluded; no test tasks (policy); no whole-suite gate or manual verification tasks.
