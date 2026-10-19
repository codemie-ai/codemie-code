# EPMCDME-15536 — [CLI Analitics] SSO-proxied session lifecycle prevents analytics collection and reporting

**Link:** https://jiraeu.epam.com/browse/EPMCDME-15536
**Type:** Bug
**External Ticket**: EPMCDME-15536 (synced)
**Story Points**: 3 (Complexity M, 18/36 — re-estimated 2026-10-13 after scope expansion; supersedes initial S/11/2-points claude-only estimate)

## History

- 2026-10-13 — Initial complexity assessment recorded: S (11/36), scoped to `claude.plugin.ts` only. Adapter updated Story Points to 2.
- 2026-10-13 — Scope expanded by explicit user decision to 6 plugins (see Scope For This Fix below). Re-estimated: M (18/36). Adapter updated Story Points field (`customfield_10004`) to 3 on the live ticket, superseding the prior value.
- 2026-10-15 — A related-but-distinct gap reported on this branch: `claude-desktop` sessions (the actual Desktop GUI app, correctly out of scope for the finding above) can also stay `status: "active"` forever after a proxy-daemon restart. Investigated, reproduced against current code, and fixed as an addendum — see "Follow-up: Claude Desktop restart-reconciliation gap" below. Not a re-opening of the Investigation Findings' Desktop dismissal: that section is about the *original ticket's* mistaken "Claude Desktop" framing of what were actually `agentName: "claude"` CLI sessions; this is a genuinely separate failure mode in the real Desktop GUI telemetry path.
- 2026-10-19 — Follow-up hardening: generic hook-managed reconciliation no longer relies on per-plugin `onSessionStart` wiring. It now runs centrally from `BaseAgentAdapter`, uses a per-session heartbeat so an idle-but-still-open terminal is not falsely finalized as `interrupted`, and persists each session's original analytics routing context (`apiBaseUrl`, `ssoUrl`, `syncApiUrl`, `profileName`) plus `workingDirectory` so a stale session is finalized under its own profile/project context rather than whichever profile happened to launch later.

## Summary

Sessions routed through the ai-run-sso gateway are not reliably finalized for analytics collection. Long-running `claude`-agent sessions retain `status: "active"` and `endTime: null` indefinitely after activity has stopped.

## Investigation Findings (this run)

Confirmed real and in scope for this fix:

- 10 of 36 local sessions in `~/.codemie/sessions/` are `provider: "ai-run-sso"`, `agentName: "claude"`, `status: "active"`, with no `endTime` — some stuck 13+ days.
- Root cause: finalization for the `claude` plugin depends entirely on Claude Code's own `SessionEnd` hook firing (`hooks.json` → `codemie hook` → `SessionStore.updateSessionStatus`). When the process doesn't exit cleanly, that never fires.
- This codebase already had a fallback for exactly this failure mode — `reconcileStaleSessions` in `src/agents/core/session/stale-session-reconciliation.ts` — but at investigation time it was wired only for `codex` and `pi` via per-plugin `onSessionStart` hooks. That original gap is now closed by a later centralization in `BaseAgentAdapter.run()`, which sweeps all generic hook-managed sessions once per launch and preserves each stale session's own persisted agent/profile context.

Investigated and found NOT to reproduce on current `main` (and on the CLI version the ticket cites, v0.15.2 — the fix predates that tag):

- The ticket's claim that `codemie analytics --export json` excludes active sessions with real recorded activity. Empirically retested: active sessions with real deltas ARE included; only true zero-activity sessions are excluded (by design, regardless of status). This part of the original ticket description does not hold against current code and is out of scope for this fix.
- "Claude Desktop" framing: the affected sessions are Claude Code CLI sessions (`agentName: "claude"`, correlated to `~/.claude/projects/.../*.jsonl`) launched via `ai-run-sso`, not the Claude Desktop GUI app.

## Scope For This Fix

> Historical note: the 2026-10-13 implementation plan below reflects the first landed approach. The current code has since been hardened further (2026-10-19) by centralizing reconciliation in `BaseAgentAdapter`, adding CLI heartbeats, and persisting analytics routing context on session records.

Decided (user, 2026-10-13): all six plugins with the gap are in scope, not claude-only.

- `claude.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts` — need a NEW `onSessionStart` method each (new method + `buildHookConfig` helper + import), calling ONLY `reconcileStaleSessions` — never duplicating `processEvent(SessionStart)`, since all three plugins' native hook manifests already route `SessionStart` through the shared `codemie hook` → `handleSessionStart` path that reliably creates the session record.
- `codemie-code.plugin.ts`, `opencode/opencode.plugin.ts`, `copilot-cli/copilot-cli.plugin.ts` — already have `onSessionStart`; just need one added call (`void reconcileStaleSessions(...)`) inserted, reusing their existing `buildHookConfig`, mirroring `pi.plugin.ts`'s direct-call style.

## Acceptance Criteria (from original ticket, as applicable to this scoped fix)

- [ ] Long-running sessions for all six plugins are finalized after the session ends or is abandoned, with a valid `endTime`.
- [ ] Session finalization is resilient when no close event arrives — the reconciliation fallback now covers all generic hook-managed CLI agents via the centralized `BaseAgentAdapter` sweep, and Desktop sessions via `DesktopTelemetryRuntime.reconcilePersistedSessions()`.
- [ ] Regression coverage confirms non-SSO / already-wired (`codex`, `pi`) session finalization and export continue to work unchanged.
- [ ] Regression coverage guards the real failure modes discovered during review: old sessions are not excluded by age, synthetic `SessionEnd` uses the native `agentSessionId` when present, end time threads the true last activity (not reconciliation time), idle live terminals are protected by heartbeat/liveness tracking, and reconciliation reuses the session's own analytics routing context.

## Follow-up (2026-10-15): Claude Desktop restart-reconciliation gap

Reported by a teammate after the six-plugin fix above shipped, with a precise repro (open a Desktop chat → `kill -9` the daemon before the 5-minute idle timeout → restart it → wait 10+ minutes without touching Desktop). Investigated and reproduced against current code.

**Why the six-plugin fix doesn't cover it**: `reconcileStaleSessions` is wired into `onSessionStart` for CLI agent plugins only (`claude`, `gemini`, `kimi`, `codemie-code`, `opencode`, `copilot-cli`, plus the already-wired `codex`/`pi`). There is no `claude-desktop` agent plugin — the Desktop GUI app has no `AgentLifecycle`/`onSessionStart` to hook into. Its sessions are finalized only by `DesktopTelemetryRuntime` running inside the proxy daemon.

**Root cause**: `DesktopTelemetryRuntime.trackedSessions` is in-memory only and starts empty on every daemon restart. `poll()` only (re)adds a session to that map once new activity is discovered *after* the new process's `startedAt` — a deliberate guard so a restart doesn't replay old untouched chats as live. But a session already idle (or that stays idle) across the restart never satisfies that condition again on its own, so it's never (re)tracked, and the idle-timeout loop — which only iterates `trackedSessions` — never sees it. The session file stays `status: "active"` forever unless the user resumes that exact chat.

**Fix**: `DesktopTelemetryRuntime.start()` now runs a `reconcilePersistedSessions()` step before the first poll — reads persisted `active` `claude-desktop` sessions directly from `~/.codemie/sessions/` (new `SessionStore.findActiveSessions(agentName)`), finalizes anything already past `inactivityTimeoutMs` immediately (`reason: "desktop-daemon-restart-stale"`), and re-seeds `trackedSessions` for anything not yet stale so the existing idle-timeout path still catches it later.

**Files**: `src/agents/core/session/SessionStore.ts`, `src/telemetry/runtime/DesktopTelemetryRuntime.ts`, plus their test files. See Task 8 in `plan.md` and the matching section in `spec.md`/`qa-report.md` under this work item's task directory for full detail.

**Out of scope for this addendum**: no change to any of the six Pattern A/B plugins, `reconcileStaleSessions`, or the acceptance criteria above — this is a distinct code path (daemon-resident poller, not an `AgentLifecycle` hook).

## Follow-up (2026-10-19): CLI stale-session hardening

Subsequent review found two correctness gaps in the original per-plugin rollout:

1. **False stale on idle live terminals** — a second launch could finalize an older session that was still open but quiet for 30+ minutes, because generic hook-managed sessions had no liveness signal beyond transcript/sync activity.
2. **Wrong routing/profile context on reconciliation** — `provider`/`project`/`model` were already preserved, but URL/profile-level routing (`apiBaseUrl`, `ssoUrl`, `syncApiUrl`, `profileName`) and the synthetic `SessionEnd.cwd` still came from the *current* launch, not the stranded session's persisted context.

**Fix**:

- `BaseAgentAdapter.run()` now starts a per-session heartbeat for generic hook-managed CLI sessions and stores it in the session JSON (`session.liveness.lastHeartbeatAt`).
- `findStaleSessions()` treats the latest trustworthy sign of life as `max(real last activity, last heartbeat)`, so an idle-but-open terminal is not reconciled as abandoned.
- `createSessionRecord()` / `ensureSessionFile()` now persist `analyticsContext` (`apiBaseUrl`, `ssoUrl`, `syncApiUrl`, `profileName`) on the session record.
- `buildReconciliationHookConfig()` now prefers the stranded session's persisted routing/profile context over the current launch env.
- Synthetic `SessionEnd.cwd` now uses the stale session's own `workingDirectory`.

**Files**: `src/agents/core/BaseAgentAdapter.ts`, `src/agents/core/session/{types.ts,SessionStore.ts,ensure-session.ts,stale-session-reconciliation.ts}`, `src/cli/commands/hook.ts`, plus targeted session/reconciliation tests.
