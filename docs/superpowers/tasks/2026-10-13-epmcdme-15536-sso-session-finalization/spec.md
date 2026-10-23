# Spec — EPMCDME-15536: Wire stale-session reconciliation into all plugins missing it

> **Historical spec note (2026-10-19):** this document captures the original six-plugin rollout. The current implementation has intentionally evolved beyond it: reconciliation is now centralized in `BaseAgentAdapter.run()`, generic hook-managed CLI sessions carry a heartbeat-based liveness lease, and session records persist their original analytics routing context so stale finalization reuses the session's own URLs/profile rather than the current launch's env.

**Ticket:** [EPMCDME-15536](https://jiraeu.epam.com/browse/EPMCDME-15536) — [CLI Analitics] SSO-proxied session lifecycle prevents analytics collection and reporting
**Local work item:** `docs/superpowers/work-items/EPMCDME-15536.md`
**Complexity:** M (18/36), Story Points: 3

## Problem

Sessions for several agent plugins permanently stay `status: "active"` with no `endTime` in `~/.codemie/sessions/{id}.json` when the host process doesn't exit cleanly (killed terminal, crashed process, OS sleep/shutdown, SSH disconnect). Finalization for these plugins depends entirely on the host tool's own `SessionEnd` hook firing and calling `codemie hook` → `SessionStore.updateSessionStatus`. When that never fires, the session is stuck forever, and downstream analytics reporting for that session is incomplete.

Confirmed on this machine: 10 of 36 local sessions, all `provider: "ai-run-sso"`, `agentName: "claude"`, stuck `status: "active"` with no `endTime`, some for 13+ days.

At investigation time, this codebase already had a fallback for exactly this failure mode — `reconcileStaleSessions` (`src/agents/core/session/stale-session-reconciliation.ts`) — which synthesized a `SessionEnd` event with `reason: "interrupted"` for stranded sessions of an agent's own kind, called from that agent's `onSessionStart`. It was then wired only for `codex` and `pi`. Six plugins had the same unaddressed gap:

- `claude.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts` — no `onSessionStart`/`onSessionEnd` lifecycle hooks at all today.
- `codemie-code.plugin.ts`, `opencode/opencode.plugin.ts`, `copilot-cli/copilot-cli.plugin.ts` — already have `onSessionStart`/`onSessionEnd`, but neither calls `reconcileStaleSessions`.

**Explicitly out of scope** (investigated separately, does not reproduce on current code): the claim that `codemie analytics --export json` excludes active sessions with real recorded activity. Active sessions with real deltas are already included; only true zero-activity sessions are excluded, by design, regardless of status.

Review follow-up (2026-10-19): the narrower claim that *short completed sessions with real turns* miss `_metrics.jsonl` also does not reproduce on current code. The SessionEnd path still runs final incremental extraction before completion/rename, and the Claude metrics processor emits one delta per completed assistant message; existing tests already cover both the one-turn delta case and end-to-end metrics-file creation. The remaining no-`_metrics.jsonl` cases are sessions with no completed turn / no extractable delta (e.g. start→exit, prompt before first assistant completion, or no usable transcript path). That boundary is important for AC7 interpretation: if Product considers those intentionally zero-turn sessions, no additional fix is required for this ticket.

## Goal

Every one of the six plugins above gets the same reconciliation safety net `codex` and `pi` already have: a stranded session of that plugin's kind gets finalized (synthetic `SessionEnd`, `reason: "interrupted"`) the next time that plugin starts a new session, instead of staying `active` forever.

## Design

### Pattern A — new `onSessionStart` (`claude`, `gemini`, `kimi`)

Each of these three plugins has no `onSessionStart`/`onSessionEnd` lifecycle method today — their native hook manifests (Claude Code's `hooks.json`, Gemini's `eventNameMapping`, Kimi's `kimi.hook-config-injector.ts`) already route a native `SessionStart` event to the shared `codemie hook` CLI command, which calls `handleSessionStart` and reliably creates the session record on every real launch. So the fix for each plugin is:

1. Add a local `buildHookConfig(env, sessionId): HookProcessingConfig` helper (same shape codex/pi use: reads `CODEMIE_AGENT`, `CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`/`CODEMIE_URL`, `CODEMIE_SYNC_API_URL`, `CODEMIE_CLI_VERSION`, `CODEMIE_PROFILE_NAME`, `CODEMIE_PROJECT`, `CODEMIE_MODEL` from `env`, with `clientType: 'codemie-<agent>'`).
2. Add `onSessionStart(sessionId: string, env: NodeJS.ProcessEnv)` to the plugin's `lifecycle` object, containing **only**:
   ```ts
   void reconcileStaleSessions('<agentName>', env, buildHookConfig).catch((error) => {
     const msg = error instanceof Error ? error.message : String(error);
     logger.debug(`[<agent>] Stale-session reconciliation failed (non-blocking): ${msg}`);
   });
   ```
3. Import `reconcileStaleSessions` from `../../core/session/stale-session-reconciliation.js`.

**Critical constraint**: do NOT also call `processEvent({ hook_event_name: 'SessionStart', ... })` the way codex/pi's `onSessionStart` does. Codex and Pi need that call because their native CLIs lack reliable hook support; claude/gemini/kimi do not — their native hooks already create the session record, and duplicating it would double-fire session creation.

### Pattern B — one added call (`codemie-code`, `opencode`, `copilot-cli`)

Each of these three already has `onSessionStart` (and its own `buildHookConfig`-equivalent, since they call `processEvent(SessionStart)` themselves — these agents are spawned/wrapped directly by codemie-code, not driven by an external native-hook manifest). Each just needs one line added inside the existing `onSessionStart`, after the existing `processEvent(SessionStart)` call, reusing the existing config-builder:

```ts
void reconcileStaleSessions('<agentName>', env, buildHookConfig).catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  logger.debug(`[<agent>] Stale-session reconciliation failed (non-blocking): ${msg}`);
});
```

This mirrors `pi.plugin.ts`'s exact direct-call style (no wrapper module needed, matching the simpler of the two existing precedents).

### Reused, unmodified

- `src/agents/core/session/stale-session-reconciliation.ts` — the generic `reconcileStaleSessions`/`findStaleSessions` utility. No changes; defaults (30 min inactivity threshold, 24h lookback) are relied on as-is, consistent with codex/pi.
- `src/cli/commands/hook.ts` — shared, agent-generic hook routing. Not touched; per-agent reconciliation logic stays in each plugin, as already established by codex/pi.
- Each plugin's native hook manifest / installer (`hooks.json`, Gemini's event mapping, Kimi's config injector). Unaffected — the gap is purely in-process (`AgentLifecycle`), not in these manifests.

## Testing

No existing test, for either already-wired plugin (`codex` or `pi`), asserts that `onSessionStart` actually calls `reconcileStaleSessions` — only indirect coverage of the generic utility exists (`codex.reconciliation.test.ts`). This fix establishes that missing assertion once and applies it to all six new/modified call sites:

- Combine `codex.reconciliation.test.ts`'s fixture/DI style (tmpdir `CODEMIE_HOME`, injected `processEvent`, fixed clock) with `codex.plugin.lifecycle.test.ts`'s `vi.doMock` + dynamic-import style (mock `stale-session-reconciliation.js`, dynamically import the plugin module, invoke `lifecycle.onSessionStart(sessionId, env)`, assert `reconcileStaleSessions` was called with the right `agentName`).
- Apply this pattern to `claude.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts` (asserting the call exists and that no duplicate `processEvent(SessionStart)` call was introduced) and to `codemie-code.plugin.ts`, `opencode.plugin.ts`, `copilot-cli.plugin.ts` (asserting the new call coexists with their existing `processEvent(SessionStart)` call).
- Regression: existing `codex`/`pi` tests continue to pass unmodified — this fix does not touch their files.

## Acceptance Criteria

- [ ] `claude.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts` each have a new `onSessionStart` calling only `reconcileStaleSessions`, with no duplicate `processEvent(SessionStart)`.
- [ ] `codemie-code.plugin.ts`, `opencode.plugin.ts`, `copilot-cli.plugin.ts` each have `reconcileStaleSessions` added into their existing `onSessionStart`, alongside their existing `processEvent(SessionStart)` call.
- [ ] New tests assert the `onSessionStart` → `reconcileStaleSessions` wiring for all six plugins.
- [ ] Existing `codex`/`pi` reconciliation tests and all other existing tests pass unmodified.
- [ ] No changes to `stale-session-reconciliation.ts`, `hook.ts`, or any native hook manifest/installer.

## Out of Scope

- The `codemie analytics --export json` active-session-exclusion claim from the original ticket text — investigated, does not reproduce on current code.
- Any change to the inactivity threshold / lookback defaults in `reconcileStaleSessions`.
- Documentation updates to `.ai-run/guides/integration/external-integrations.md` (currently documents the codex-only path) — flagged as a follow-up for a knowledge-harvester pass, not bundled into this fix.

## Follow-up hardening implemented after this spec

The shipped code now goes beyond the original per-plugin plan:

- reconciliation runs once from `BaseAgentAdapter.run()` with `agentName: null`, sweeping all generic hook-managed sessions instead of relying on six independent plugin hook sites;
- generic hook-managed sessions persist `liveness.lastHeartbeatAt`, refreshed by the owning CLI process, so a quiet-but-still-open terminal is not falsely finalized;
- session records persist `analyticsContext` (`apiBaseUrl`, `ssoUrl`, `syncApiUrl`, `profileName`), and reconciliation prefers that persisted context over the current launch env;
- the synthetic `SessionEnd` event uses the stale session's own `workingDirectory` for `cwd`.
- for `ai-run-sso`, persisted analytics routing is normalized to the canonical upstream CodeMie API URL instead of a transient localhost proxy, and strict reconciled SessionEnd delivery now applies: if the end metric or pending sync cannot be delivered for a stale session that has trusted stored routing, local completion is rolled back and the session stays retryable rather than being renamed to `completed_*`.

These changes intentionally drift from the original "don't modify `stale-session-reconciliation.ts` / `hook.ts`" constraint because review uncovered correctness gaps the initial rollout did not address.

### Follow-up (2026-10-19): ai-run-sso reconciliation routed to a dead or wrong-profile proxy

The `analyticsContext.apiBaseUrl` persisted above was, for `ai-run-sso`, the per-launch *local proxy* address (`setupProxy()` rewrites `CODEMIE_BASE_URL` to it before spawn) — not a CodeMie URL. Reconciling a stranded `ai-run-sso` session therefore either hit a dead port (the launching wrapper already exited) or, for records predating `analyticsContext`/`clientType`/`model`, silently fell back field-by-field to whichever *different* profile/agent happened to launch next, sending the end metric under that profile's cookies, `clientType`, and model. See the matching qa-report.md follow-up for the full repro and fix (`CODEMIE_TARGET_API_URL` captured pre-rewrite, canonical URL derivation from `ssoUrl`, `skipRemoteSync` for untrusted legacy records).

## Follow-up (2026-10-15): Claude Desktop restart-reconciliation gap

Reported after this fix shipped, and confirmed by reproduction against current code: `claude-desktop` sessions have no agent plugin and no `onSessionStart`, so none of Patterns A/B above reach them (see Investigation Findings in the work item for why Desktop was called out of scope originally). They are finalized only by `DesktopTelemetryRuntime` inside the proxy daemon, whose session tracking is in-memory only and does not survive a hard `kill -9` + restart — a session already idle at kill time is never rediscovered through the normal poll path and stays `status: "active"` forever.

Fixed as an addendum (Task 8 in `plan.md`): `DesktopTelemetryRuntime.start()` now reconciles persisted `active` sessions for its client type from `~/.codemie/sessions/` before the first poll, finalizing anything already past `inactivityTimeoutMs` immediately (`reason: "desktop-daemon-restart-stale"`) and re-seeding `trackedSessions` for anything not yet stale. Backed by a new `SessionStore.findActiveSessions(agentName)`. This is additive — it does not change the Pattern A/B plugins, `reconcileStaleSessions`, or any of the acceptance criteria above.
