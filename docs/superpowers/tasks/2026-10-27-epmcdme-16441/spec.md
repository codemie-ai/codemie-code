# EPMCDME-16441: SDLC Factory sessions missing from CLI Analytics

## Problem
Over 30 days production shows ~9 factory sessions (one developer) while several developers merged factory MRs. Factory adoption and cost are understated. "Pure chat" mislabeling is a separate problem and not covered here.

## Scope
Investigation of five candidate patterns across CLI and backend, plus in-repo CLI fixes. Backend investigation is in scope and is read-only; backend defects are filed as separate tickets, never fixed here.

Evidence sources:
- CLI code: `docs/ARCHITECTURE-OTLP-PLUGIN.md`, `src/agents/plugins/claude-code-otlp/`, `src/providers/plugins/sso/proxy/plugins/otlp-spool/`, `src/cli/commands/hook.ts`.
- Backend code (sibling checkout `/Users/vponkratina/work/ai/codemie`, read-only): `src/codemie/rest_api/routers/cli_analytics.py` (routes `/logs`, `/metrics`, `/traces`, `/event-hooks`), `src/codemie/service/analytics/cli_analytics_project_gate.py`, `src/codemie/repository/cli_analytics/postgres/{ingestor,rollups,dirty}.py`, guides `.ai-run/guides/integration/cli-analytics-events.md` and `cli-analytics-storage.md`.
- A production analytics query run by a person.

## Backend facts already established (to verify, not assume)
- Every ingest route checks the project named in `X-CodeMie-Project` first. The sender needs access to the project and the project must have `cli_analytics_enabled`, which is `false` for every project until a global administrator or maintainer sets it.
- A request that fails the gate is discarded as a whole with HTTP 200 (reasons `cli_analytics_disabled`, `project_context_required`, `project_context_conflict`). The CLI treats 2xx as done and deletes its spool, so the loss is final and silent. `project_context_conflict` also fires when an event's `codemie_project_name` differs from the header, or two events differ.
- Retry behavior: 403 suspends forwarding, 503 is retried; a body above 5,242,880 bytes is refused with 413 on every retry.
- Dedup is by `event_id` across `event-hooks` and `logs`. Subagent totals come from `agent.subagent.usage` and are counted in rollups only when the session has no `usage_requests` of its own (`rollups.py`, subagent token source).

## Investigation procedure
1. Prod query (owner: ticket assignee, with analytics-backend access): list EPMCDME MR authors from the last 30 days that used the factory; for each, list CLI Analytics sessions by developer, repository, branch and MR working period, with CLI version. Also read, for the EPMCDME project, the `cli_analytics_enabled` history and any discarded-request counts or logs the backend keeps. Record results on the ticket.
2. Classify each missing developer into exactly one pattern:
   - P1 No analytics configured, no valid SSO auth, or old CLI/stale daemon. Not a product defect (AC4); record as such.
   - P2 CLI dropped for no project or project conflict. Bisect the project-gate fix by git log against the developer's CLI version.
   - P3 `claude -p` unattended: end-of-session events lost (SessionEnd forward abort 3s, one resend, hook killed by Claude Code, OTEL-only sessions never sent).
   - P4 Subagent work or cost not collected by the CLI.
   - P5 Dropped or mis-aggregated by the backend: project gate discards (`cli_analytics_enabled` off for the project, sender without access, header project differs from event project, e.g. factory runs under a project other than EPMCDME), 413 on large bodies, dedup collisions, session aggregation or attribution to developer, repository and branch, and subagent roll-up into the parent session.
3. For P5, trace in backend code: the endpoint the otlp-spool forwarder posts to, gate, dedup ledger, session completeness and aggregation, attribution fields, and subagent roll-up. Compare against what the CLI sends (header, `codemie_project_name`, `event_id`, session id on subagent events).
4. Record the root cause per pattern on the ticket. Developer-machine checks (`codemie doctor`, `~/.claude/settings.json`) are a follow-up for affected developers only.

## Required changes (in this repo)
- **Multi-project sessions.** A session whose events resolve to more than one `codemie_project_name` (worktrees, subagent cwds, different `.codemie` profiles) must be pinned to a single project (the one resolved first for the session, via the existing session pin) and never discarded. Events and header must carry the same pinned project, so the backend `project_context_conflict` cannot fire for it. The current "conflict, discard backlog" behavior and its accepted-limitation note are replaced. Unbound, blank or non-ASCII names stay unsendable but become a visible diagnostic (log, and `codemie doctor` where it fits).
- **`claude -p` end-of-session.** Confirm by code reading whether end-of-session data can be lost. Fix here only if the change is small (at most two files), for example closing sessions that never got `agent.session.end`. Otherwise file a ticket with evidence.
- **Subagents.** Verify that `agent.subagent.usage` and `stop` events carry the parent session identity and cost, and fix CLI-side gaps here.
- **Backend-caused loss.** Where the backend discards silently, check whether the CLI can surface it (for example a diagnostic when the response body reports `dropped`). Backend changes themselves are filed separately.

## Acceptance criteria
1. A factory MR by a developer with analytics configured on the latest CLI yields sessions with developer, repository, branch and cost, verified by prod query.
2. An unattended `claude -p` factory run is collected with end-of-session data and cost, or a ticket is filed and linked if the fix exceeds the small-change bound.
3. A factory run with subagents has its work and cost in the parent session in CLI Analytics, verified by reading the backend roll-up code (`rollups.py`) plus the prod query. If the roll-up drops or double-counts subagent cost, a backend ticket is filed and linked.
4. Developers without analytics configured are listed separately from product defects, with no session expected.
5. A session spanning several `.codemie` projects is stored under one project and not dropped.
6. The root cause of each pattern (P1 to P5) is recorded on the ticket; each product defect is fixed here (CLI) or has a linked ticket (backend or oversize CLI work).

## Non-goals
- "Pure chat" labeling of collected sessions.
- Any change to the backend repo, and backfill or re-ingest of already lost sessions.
- Enabling `cli_analytics_enabled` on projects (a data and admin action, recorded as a finding only).
- Developer-machine audits beyond the follow-up for affected developers.
- Changing the OTEL-only "never send" invariant.
- Writing tests, unless the user requests them (repo policy).

## Risks
- Root causes are unverified and depend on the prod query; a pattern outside P1 to P5 is recorded and filed separately.
- Backend gate discards are HTTP 200 and irreversible; lost sessions cannot be recovered without a backfill, which is out of scope.
- Pinning to the first-seen project may attribute cost to a project other than the main repo's.
- Backend reading is read-only against a checkout that may differ from the deployed production version; confirm the deployed version before concluding.
- A stale daemon after a CLI upgrade can hide the effect of a fix; verify the daemon was restarted.
