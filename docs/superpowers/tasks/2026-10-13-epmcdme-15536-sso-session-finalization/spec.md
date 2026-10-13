# Spec — EPMCDME-15536: Wire stale-session reconciliation into all plugins missing it

**Ticket:** [EPMCDME-15536](https://jiraeu.epam.com/browse/EPMCDME-15536) — [CLI Analitics] SSO-proxied session lifecycle prevents analytics collection and reporting
**Local work item:** `docs/superpowers/work-items/EPMCDME-15536.md`
**Complexity:** M (18/36), Story Points: 3

## Problem

Sessions for several agent plugins permanently stay `status: "active"` with no `endTime` in `~/.codemie/sessions/{id}.json` when the host process doesn't exit cleanly (killed terminal, crashed process, OS sleep/shutdown, SSH disconnect). Finalization for these plugins depends entirely on the host tool's own `SessionEnd` hook firing and calling `codemie hook` → `SessionStore.updateSessionStatus`. When that never fires, the session is stuck forever, and downstream analytics reporting for that session is incomplete.

Confirmed on this machine: 10 of 36 local sessions, all `provider: "ai-run-sso"`, `agentName: "claude"`, stuck `status: "active"` with no `endTime`, some for 13+ days.

This codebase already has a fallback for exactly this failure mode — `reconcileStaleSessions` (`src/agents/core/session/stale-session-reconciliation.ts`) — which synthesizes a `SessionEnd` event with `reason: "interrupted"` for stranded sessions of an agent's own kind, called from that agent's `onSessionStart`. It is currently wired up only for `codex` and `pi`. Six plugins have the same unaddressed gap:

- `claude.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts` — no `onSessionStart`/`onSessionEnd` lifecycle hooks at all today.
- `codemie-code.plugin.ts`, `opencode/opencode.plugin.ts`, `copilot-cli/copilot-cli.plugin.ts` — already have `onSessionStart`/`onSessionEnd`, but neither calls `reconcileStaleSessions`.

**Explicitly out of scope** (investigated separately, does not reproduce on current code): the claim that `codemie analytics --export json` excludes active sessions with real recorded activity. Active sessions with real deltas are already included; only true zero-activity sessions are excluded, by design, regardless of status.

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
