# Technical Research

**Task**: analytics claude-code-otlp hook session subagent
**Generated**: 2026-10-27
**Research path**: filesystem

---

## 1. Original Context

task_context (verbatim, EPMCDME-16441, Bug):
[CLI Analytics][Production] SDLC Factory sessions from most developers are missing from analytics

Summary: On production, over the last 30 days, EPMCDME analytics shows about 9 sessions that used the SDLC Factory, and only Vadym Vlasenko has live factory sessions. In the same period several developers merged MRs produced with the factory. Their factory sessions are not collected at all, so factory adoption and cost are understated. Separate from sessions collected but labelled Pure chat.

Environment: Production, Analytics → CLI Analytics → Sessions, project EPMCDME, last 30 days.
Steps: 1. Take EPMCDME MRs from last 30 days produced with SDLC Factory by >=3 developers. 2. For each, search CLI Analytics sessions by developer, repository, branch and the MR's working period.
Expected: Every session that produced factory work is present, attributed to developer, repository and branch, with cost.
Actual: Only Vadym Vlasenko's factory sessions appear. Others missing.

Causes to Check:
- Analytics not configured on the developer's machine, or an older CLI version.
- Sessions dropped for having no project (fixed in latest CLI release; check CLI version).
- Unattended runs (`claude -p`) losing their end-of-session events.
- Subagent work during a factory run not collected.

Acceptance Criteria:
1. Given a factory MR by a developer with analytics configured on latest CLI, sessions that produced it are present with developer, repository, branch and cost.
2. Given an unattended factory run (`claude -p`), the session is collected in full, including end-of-session data and cost.
3. Given a factory run that uses subagents, their work and cost are part of the parent session.
4. (Negative) Given a developer without analytics configured, no session is expected; the investigation separates these cases from product defects.
5. Root cause of each missing-session pattern is recorded on the ticket, and each product defect is fixed here or filed separately.

---

## 2. Codebase Findings

### Existing Implementations
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` (499 lines): `OtlpAgentAdapter` subclass; `evaluate()` dispatches Stop, StopFailure, SessionEnd, SubagentStart/Stop, etc. SessionEnd handler (`onSessionEndEvent`, ~l.277) builds `agent.git.snapshot` plus a session-summary pass and returns `retryOnce: true` (one in-process resend, 3s abort per forward). SubagentStop (`onSubagentStopEvent`, ~l.372) skips Claude's internal check-ins (no transcript), reads the subagent transcript via `openSubagentPass`, emits `agent.subagent.usage`/`stop`.
- `claude-code-otlp.allowlist.ts`: per-project allowlist read from `~/.claude/settings.json` env `CODEMIE_ANALYTICS_PROJECT_FILTER` (states absent/valid/invalid). Untracked project means hooks are never forwarded to the daemon.
- `transcript/` (`orchestrator.ts`, `subagent-usage.ts` with `findSubagentFiles`, `session-summary.ts`, `session-signals.ts`): derive usage/summary events from transcripts under a commit-after-send lock.
- `src/agents/core/event-fields/identity-fields.ts` resolves `codemie_project_name`; `src/agents/core/session-project-pin.ts` pins it per session (24h TTL). Resolution order: `CODEMIE_PROJECT` env, pin, nearest `.codemie` walking up from `CLAUDE_PROJECT_DIR`, global active profile.
- `src/providers/plugins/sso/proxy/plugins/otlp-spool/`: daemon side. `forwarder.ts` (POST to 4 streams with `X-CodeMie-Project`, marks session ended on `agent.session.end`), `completeness-gate.ts` (hooks+OTEL send; hooks-only forced after `OTLP_SEND_MAX_ATTEMPTS`=3 ticks x 2 min; OTEL-only is NEVER sent, "skip"), `session-project.ts` (project gate: unbound, blank, non-ASCII or multiple-name sessions are conflict and discarded locally, with a sealed hooks prefix exception), `sweep.ts`, `auth-state.ts` (401/403/302 leaves cursors untouched).
- `src/cli/commands/hook.ts`: separate legacy hook path with `handleSessionEnd` and a bounded API sync (`resolveSessionEndSyncBudgetMs`; "Claude Code kills the hook" comment) that is skipped when analytics auth is not configured.
- `src/cli/commands/proxy/connectors/claude-code-otlp.ts`, `connect-orchestrator.ts`: the connector that writes hooks, env and allowlist into `~/.claude/settings.json`.

### Architecture and Layers Affected
CLI command (`codemie hook --agent claude-code-otlp`, `codemie proxy connect`), agent plugin (claude-code-otlp), core agent base (`OtlpAgentAdapter`, identity/project fields), provider/proxy plugin (SSO proxy daemon otlp-spool), backend analytics API (out of repo).

### Integration Points
Hook process (short-lived, per event) to daemon spool (HTTP 202) to forwarder to backend analytics API. Backend answers 200 and drops irreversibly when project context is missing or ambiguous (`.ai-run/guides/integration/cli-analytics-events.md`, "Project gate", cited by the architecture doc; not opened here).

### Patterns and Conventions
One handler per native event, no switch, single forward call site; deterministic `event_id` dedup key; session-end and subagent events content-hashed so resends are safe. See `docs/ARCHITECTURE-OTLP-PLUGIN.md` (sections 3, 6, project gate, rollout).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, integration, usage, etc.). `docs/ARCHITECTURE-OTLP-PLUGIN.md` is the authoritative contract; `docs/ANALYTICS-REPORT.md` also present (not read).

### Architectural Decisions
- OTEL-only sessions are never forwarded (INVARIANT in `completeness-gate.ts`).
- A project-conflicted or unbound session loses its unsent backlog; "a session that changes project loses OTLP-derived metrics ... accepted limitation".
- Rollout: the daemon outlives CLI upgrades; an old daemon keeps old behaviour (no project header/gate) until restarted. Documented known limitation (3): `ensureOtlpProxy`/allowlist gate keys off hook `cwd`, unwalked, so a cwd with no `.codemie` above it can gate on the wrong profile.
- The proxy daemon's `X-CodeMie-Project` on model traffic can diverge from `codemie_project_name` on analytics.

### Derived Conventions
Docs claim contract details; code wins on facts.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/claude-code-otlp/__tests__/` (plugin, allowlist, event-id, types, client-version-cache, command-fields) and `transcript/__tests__`.
- `otlp-spool/__tests__/` (auth-state, completeness-gate, forwarder, project-interleave, session-project, spool-io, tick-processor).

### Testing Framework and Patterns
Vitest; dynamic-import mocking per `.ai-run/guides/testing/testing-patterns.md`. Tests only on explicit request (AGENTS.md).

### Coverage Gaps
Not verified. No test file name targets `claude -p` (headless) SessionEnd behaviour or end-to-end subagent cost roll-up into the parent session; not confirmed by content grep.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_ANALYTICS_PROJECT_FILTER` (in Claude settings env), `CODEMIE_PROJECT`, `CLAUDE_PROJECT_DIR`, `OTLP_SEND_INTERVAL_MINUTES` (2), `OTLP_SWEEP_INTERVAL_MINUTES` (15), `OTLP_SEND_MAX_ATTEMPTS` (3), `OTLP_ALLOW_HOOKS_ONLY_FORWARD` (true), `OTLP_ENDED_SESSION_GRACE_MINUTES` (15), `OTLP_ABANDONED_SESSION_GRACE_MINUTES` (60).

### Configuration Files
`~/.claude/settings.json` (hooks, env, allowlist, written by the connector); `.codemie/codemie-cli.config.json` profiles; spool at `getCodemiePath('proxy','otlp-spool')`; pins at `getCodemiePath('otlp-session-project')`.

### Feature Flags and Deployment Concerns
Daemon restart needed after CLI upgrade. Analytics works only when connected (`codemie proxy connect`) with valid SSO auth.

---

## 6. Risk Indicators

- Speculative: `claude -p` is short-lived; SessionEnd hook process budget (3s forward abort, hook kill by Claude Code, `hook.ts` sync budget) may drop end-of-session events before the daemon gets them.
- Speculative: a headless run outside a repo containing `.codemie` (cwd without profile, or CI) yields blank project, so the gate discards the session (the "no project" cause); the ticket says this is fixed in the latest CLI, so version bisecting is needed (git log for the project-gate commits).
- Speculative: factory runs in worktrees or subagent cwds with different `.codemie`/profile may produce multiple `codemie_project_name` values, giving a conflict and a discarded backlog.
- Speculative: non-ASCII project names or repo paths are conflicts by `isSendableProjectName`.
- Speculative: hooks-only sessions depend on `OTLP_ALLOW_HOOKS_ONLY_FORWARD`; OTEL-only sessions (hooks absent because of allowlist or an invalid allowlist) are silently skipped; an invalid allowlist state needs checking.
- Stale daemon after upgrade keeps old behaviour (documented).
- Auth stale (401/403/302) leaves cursors untouched; an unauthenticated developer produces no data (AC 4 negative case).
- Subagent: `findSubagentFiles` and `SubagentStop` skip internal check-ins; parent-session cost roll-up path across the backend is out of repo and unverified.
- Much of the root-cause work is data and environment investigation (backend/prod data, dev machines) not reproducible from the repo.
- Subagent path and `claude -p` behaviour not exercised by named tests (unverified).

---

## 7. Summary for Complexity Assessment

Layers touched: CLI hook command, the claude-code-otlp agent plugin (hook handlers, transcript passes, allowlist, project resolution), and the SSO proxy daemon otlp-spool (project gate, completeness gate, forwarder). Code surface is large and mature (~1600 lines plugin, ~1600 lines spool, ~750 lines of types) with detailed documentation in `docs/ARCHITECTURE-OTLP-PLUGIN.md`. Any fix would most likely land in a small number of files, but which ones is not yet known.

The ticket is primarily an investigation: four candidate causes, each needing evidence (CLI versions, config state, production data) largely outside the repo. Technical novelty is low (existing patterns), but the gating logic is subtle (project gate, hooks/OTEL completeness, per-session pinning, deadlines in short-lived hook processes) and interacts across processes. Deliverables include recording root causes on the ticket and filing or fixing defects, so scope is open-ended.

Test posture: good unit coverage of spool gating and plugin handlers; no confirmed coverage of headless `claude -p` termination or subagent-to-parent cost rollup. Key risks: unobservable prod data, timing in short-lived hooks, and project resolution outside a `.codemie` tree.

---

## 8. External References

None named by the task. (The task mentions `.ai-run/guides/integration/cli-analytics-events.md` only indirectly via the architecture doc; not read.)
