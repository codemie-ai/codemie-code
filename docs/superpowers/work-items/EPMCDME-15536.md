# EPMCDME-15536 — [CLI Analitics] SSO-proxied session lifecycle prevents analytics collection and reporting

**Link:** https://jiraeu.epam.com/browse/EPMCDME-15536
**Type:** Bug
**External Ticket**: EPMCDME-15536 (synced)
**Story Points**: 3 (Complexity M, 18/36 — re-estimated 2026-10-13 after scope expansion; supersedes initial S/11/2-points claude-only estimate)

## History

- 2026-10-13 — Initial complexity assessment recorded: S (11/36), scoped to `claude.plugin.ts` only. Adapter updated Story Points to 2.
- 2026-10-13 — Scope expanded by explicit user decision to 6 plugins (see Scope For This Fix below). Re-estimated: M (18/36). Adapter updated Story Points field (`customfield_10004`) to 3 on the live ticket, superseding the prior value.
- 2026-10-15 — A related-but-distinct gap reported on this branch: `claude-desktop` sessions (the actual Desktop GUI app, correctly out of scope for the finding above) can also stay `status: "active"` forever after a proxy-daemon restart. Investigated, reproduced against current code, and fixed as an addendum — see "Follow-up: Claude Desktop restart-reconciliation gap" below. Not a re-opening of the Investigation Findings' Desktop dismissal: that section is about the *original ticket's* mistaken "Claude Desktop" framing of what were actually `agentName: "claude"` CLI sessions; this is a genuinely separate failure mode in the real Desktop GUI telemetry path.

## Summary

Sessions routed through the ai-run-sso gateway are not reliably finalized for analytics collection. Long-running `claude`-agent sessions retain `status: "active"` and `endTime: null` indefinitely after activity has stopped.

## Investigation Findings (this run)

Confirmed real and in scope for this fix:

- 10 of 36 local sessions in `~/.codemie/sessions/` are `provider: "ai-run-sso"`, `agentName: "claude"`, `status: "active"`, with no `endTime` — some stuck 13+ days.
- Root cause: finalization for the `claude` plugin depends entirely on Claude Code's own `SessionEnd` hook firing (`hooks.json` → `codemie hook` → `SessionStore.updateSessionStatus`). When the process doesn't exit cleanly, that never fires.
- This codebase already has a fallback for exactly this failure mode — `reconcileStaleSessions` in `src/agents/core/session/stale-session-reconciliation.ts` — wired up for `codex` and `pi` plugins only, via each plugin's `onSessionStart`. `claude.plugin.ts` has no `onSessionStart`/`onSessionEnd` lifecycle hook at all, so it never gets this fallback.

Investigated and found NOT to reproduce on current `main` (and on the CLI version the ticket cites, v0.15.2 — the fix predates that tag):

- The ticket's claim that `codemie analytics --export json` excludes active sessions with real recorded activity. Empirically retested: active sessions with real deltas ARE included; only true zero-activity sessions are excluded (by design, regardless of status). This part of the original ticket description does not hold against current code and is out of scope for this fix.
- "Claude Desktop" framing: the affected sessions are Claude Code CLI sessions (`agentName: "claude"`, correlated to `~/.claude/projects/.../*.jsonl`) launched via `ai-run-sso`, not the Claude Desktop GUI app.

## Scope For This Fix

Decided (user, 2026-10-13): all six plugins with the gap are in scope, not claude-only.

- `claude.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts` — need a NEW `onSessionStart` method each (new method + `buildHookConfig` helper + import), calling ONLY `reconcileStaleSessions` — never duplicating `processEvent(SessionStart)`, since all three plugins' native hook manifests already route `SessionStart` through the shared `codemie hook` → `handleSessionStart` path that reliably creates the session record.
- `codemie-code.plugin.ts`, `opencode/opencode.plugin.ts`, `copilot-cli/copilot-cli.plugin.ts` — already have `onSessionStart`; just need one added call (`void reconcileStaleSessions(...)`) inserted, reusing their existing `buildHookConfig`, mirroring `pi.plugin.ts`'s direct-call style.

## Acceptance Criteria (from original ticket, as applicable to this scoped fix)

- [ ] Long-running sessions for all six plugins are finalized after the session ends or is abandoned, with a valid `endTime`.
- [ ] Session finalization is resilient when no close event arrives — the existing reconciliation fallback now covers claude, gemini, kimi, codemie-code, opencode, and copilot-cli.
- [ ] Regression coverage confirms non-SSO / already-wired (`codex`, `pi`) session finalization and export continue to work unchanged.
- [ ] New wiring-level test coverage asserts `onSessionStart` actually invokes `reconcileStaleSessions` for each of the six plugins (no such assertion exists today, even for codex/pi).

## Follow-up (2026-10-15): Claude Desktop restart-reconciliation gap

Reported by a teammate after the six-plugin fix above shipped, with a precise repro (open a Desktop chat → `kill -9` the daemon before the 5-minute idle timeout → restart it → wait 10+ minutes without touching Desktop). Investigated and reproduced against current code.

**Why the six-plugin fix doesn't cover it**: `reconcileStaleSessions` is wired into `onSessionStart` for CLI agent plugins only (`claude`, `gemini`, `kimi`, `codemie-code`, `opencode`, `copilot-cli`, plus the already-wired `codex`/`pi`). There is no `claude-desktop` agent plugin — the Desktop GUI app has no `AgentLifecycle`/`onSessionStart` to hook into. Its sessions are finalized only by `DesktopTelemetryRuntime` running inside the proxy daemon.

**Root cause**: `DesktopTelemetryRuntime.trackedSessions` is in-memory only and starts empty on every daemon restart. `poll()` only (re)adds a session to that map once new activity is discovered *after* the new process's `startedAt` — a deliberate guard so a restart doesn't replay old untouched chats as live. But a session already idle (or that stays idle) across the restart never satisfies that condition again on its own, so it's never (re)tracked, and the idle-timeout loop — which only iterates `trackedSessions` — never sees it. The session file stays `status: "active"` forever unless the user resumes that exact chat.

**Fix**: `DesktopTelemetryRuntime.start()` now runs a `reconcilePersistedSessions()` step before the first poll — reads persisted `active` `claude-desktop` sessions directly from `~/.codemie/sessions/` (new `SessionStore.findActiveSessions(agentName)`), finalizes anything already past `inactivityTimeoutMs` immediately (`reason: "desktop-daemon-restart-stale"`), and re-seeds `trackedSessions` for anything not yet stale so the existing idle-timeout path still catches it later.

**Files**: `src/agents/core/session/SessionStore.ts`, `src/telemetry/runtime/DesktopTelemetryRuntime.ts`, plus their test files. See Task 8 in `plan.md` and the matching section in `spec.md`/`qa-report.md` under this work item's task directory for full detail.

**Out of scope for this addendum**: no change to any of the six Pattern A/B plugins, `reconcileStaleSessions`, or the acceptance criteria above — this is a distinct code path (daemon-resident poller, not an `AgentLifecycle` hook).
