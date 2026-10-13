# EPMCDME-15536 — [CLI Analitics] SSO-proxied session lifecycle prevents analytics collection and reporting

**Link:** https://jiraeu.epam.com/browse/EPMCDME-15536
**Type:** Bug
**External Ticket**: EPMCDME-15536 (synced)
**Story Points**: 3 (Complexity M, 18/36 — re-estimated 2026-10-13 after scope expansion; supersedes initial S/11/2-points claude-only estimate)

## History

- 2026-10-13 — Initial complexity assessment recorded: S (11/36), scoped to `claude.plugin.ts` only. Adapter updated Story Points to 2.
- 2026-10-13 — Scope expanded by explicit user decision to 6 plugins (see Scope For This Fix below). Re-estimated: M (18/36). Adapter updated Story Points field (`customfield_10004`) to 3 on the live ticket, superseding the prior value.

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
