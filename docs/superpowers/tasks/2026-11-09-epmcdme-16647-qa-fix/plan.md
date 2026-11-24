# EPMCDME-16647 QA Fix: Pre-Spawn OTLP Endpoint Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first Claude Code session after a proxy-daemon port respawn export native OTel telemetry correctly, by refreshing `~/.claude/settings.json`'s OTLP endpoint before Claude Code's own process starts, not only during its `SessionStart` hook.

**Architecture:** Call the existing, unchanged `ensureOtlpProxy('claude-code-otlp')` primitive (`src/cli/commands/proxy/otlp-cold-start.ts:131`) from the claude plugin's pre-spawn `lifecycle.beforeRun` hook (`src/agents/plugins/claude/claude.plugin.ts:240`), which runs strictly before `BaseAgentAdapter` spawns the child. Gate the call on a new `isClaudeCodeOtlpConnected()` check so unconnected users never start the proxy daemon as a side effect. No other module changes.

**Tech Stack:** TypeScript, Vitest (dynamic-import-after-mock pattern per `.ai-run/guides/testing/testing-patterns.md`).

## Global Constraints

- Reuse `ensureOtlpProxy` and `refreshClaudeCodeOtlpEndpoint` exactly as they exist today — no contract changes (ownership guard, non-blocking-on-failure, idempotency) (spec Decisions, Non-goals).
- The existing `SessionStart` hook-time rewrite stays in place, unchanged (spec Non-goals).
- No env-var injection into the spawned child's process env for `OTEL_EXPORTER_OTLP_*` (spec Non-goals — settings.json wins over spawn-time env for this variable family, EPMCDME-10988 precedent).
- No generic `BaseAgentAdapter`-level mechanism; scope to the claude plugin only (spec Non-goals).
- No native (unmanaged) launch fix, no watchdog/background infrastructure (spec Non-goals).
- A pre-spawn daemon-start or endpoint-refresh failure must never block or fail the launch (spec AC3).

Commit per task using the repository's existing convention.

---

## Negative-Constraint Pass (spec Non-goals)

1. **No fix for native (unmanaged) `claude` launches** — honored: both tasks touch only `claude.plugin.ts`'s `beforeRun` (managed-launch path) and its own connector/cold-start dependencies; nothing in this plan runs when a user types `claude` directly.
2. **No new standing/background infrastructure (e.g. a watchdog)** — honored: Task 2 adds a single call to an existing primitive inside an existing lifecycle hook; no new process, timer, or daemon is introduced.
3. **No injecting OTEL env vars directly into the spawned child's process env** — honored: Task 2's `beforeRun` call writes `~/.claude/settings.json` via the unchanged `ensureOtlpProxy` → `refreshClaudeCodeOtlpEndpoint` chain; it does not set `env.OTEL_EXPORTER_OTLP_ENDPOINT`/`env.OTEL_EXPORTER_OTLP_HEADERS` on the `beforeRun` env parameter.
4. **No generic cross-adapter `BaseAgentAdapter`-level mechanism** — honored: the new call lives in `claude.plugin.ts`'s own `lifecycle.beforeRun`, not in `BaseAgentAdapter.ts`; `claude-acp` inherits it only because it already spreads `ClaudePluginMetadata.lifecycle` (no new shared code written).
5. **No change to `ensureOtlpProxy`'s or `refreshClaudeCodeOtlpEndpoint`'s existing contract, and no change to the `SessionStart` hook-time rewrite** — honored: Task 1 adds a new, separate exported function (`isClaudeCodeOtlpConnected`) rather than modifying either function; Task 2 imports both unchanged; neither task touches `OtlpAgentAdapter.ts` or the hook wiring in `connectors/claude-code-otlp.ts`.

---

### Task 1: Export a connected-check from the OTLP endpoint connector

**Files:**
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp-endpoint.ts` (add exported function, after `readConfiguredOtlpPort`, around line 42)
- Test: `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts` (new `describe('isClaudeCodeOtlpConnected', ...)` block, reusing the file's existing `beforeEach`/`afterEach` tmp-dir + mock harness at lines 123-141)

**Interfaces:**
- Produces: `export async function isClaudeCodeOtlpConnected(): Promise<boolean>` — true iff CodeMie owns the `OTEL_EXPORTER_OTLP_ENDPOINT`/`HEADERS` pair in `~/.claude/settings.json` (same ownership check the private `readOwnedOtlpEnv()` at lines 16-27 already performs); false when unconnected, foreign, or unreadable. Consumed by Task 2.

Test-first: yes — a fresh `homeDir` with no `~/.claude/settings.json` written resolves `isClaudeCodeOtlpConnected()` to `false`; after calling the suite's existing `writeClaudeCodeOtlpConfig()` fixture (which writes a codemie-owned OTLP endpoint/headers pair, per the "happy paths" tests already in this file) it resolves to `true`.

- [ ] **Step 1: Write the failing test** in `claude-code-otlp.test.ts`, inside a new `describe('isClaudeCodeOtlpConnected', ...)` nested under the existing `describe('claude-code-otlp connector', ...)`: one `it` asserting `false` on the untouched tmp `homeDir` from `beforeEach`, one `it` that first calls `writeClaudeCodeOtlpConfig()` then asserts `true`. Import the new name alongside the existing `checkClaudeCodeOtlpEndpoint`/`refreshClaudeCodeOtlpEndpoint` import at line 22-26.
- [ ] **Step 2: Run it and confirm it fails** — `npm test -- claude-code-otlp.test.ts` — expected failure: `isClaudeCodeOtlpConnected is not a function` / TS "has no exported member".
- [ ] **Step 3: Implement** — in `claude-code-otlp-endpoint.ts`, add:

```ts
/** Whether CodeMie currently owns the OTLP endpoint/headers pair in `~/.claude/settings.json`. */
export async function isClaudeCodeOtlpConnected(): Promise<boolean> {
  return (await readOwnedOtlpEnv()) !== null;
}
```

- [ ] **Step 4: Run it and confirm it passes** — `npm test -- claude-code-otlp.test.ts` — both new assertions PASS; no existing test in the file regresses.
- [ ] **Step 5: Commit.**

---

### Task 2: Call the pre-spawn refresh from the claude plugin's `beforeRun`

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts` (import block near lines 1-28; body of `lifecycle.beforeRun`, lines 240-...; insert after the existing env-default block, before the function's closing lines)
- Test: `src/agents/plugins/claude/__tests__/claude.plugin.otlp-preflight.test.ts` (new file, modeled on `claude.plugin.auto-update.test.ts`)

**Interfaces:**
- Consumes: `isClaudeCodeOtlpConnected(): Promise<boolean>` (Task 1), `ensureOtlpProxy(agentName: string): Promise<void>` (`src/cli/commands/proxy/otlp-cold-start.ts:131`, unchanged, can throw per lines 173-176).
- Produces: no new exported symbol — `beforeRun`'s behavior is the deliverable, asserted via its mocked dependencies.

Test-first: yes — with `isClaudeCodeOtlpConnected` mocked to resolve `true`, calling `ClaudePluginMetadata.lifecycle.beforeRun(env)` awaits a call to `ensureOtlpProxy('claude-code-otlp')`; with it mocked to resolve `false`, `ensureOtlpProxy` is never called; with it `true` and `ensureOtlpProxy` mocked to reject, `beforeRun` still resolves (does not throw) and the mutated `env` object is still returned unchanged by the rest of the hook.

- [ ] **Step 1: Write the failing test** in the new file:
  - `vi.mock('../../../cli/commands/proxy/connectors/claude-code-otlp-endpoint.js', () => ({ isClaudeCodeOtlpConnected: vi.fn() }))`
  - `vi.mock('../../../cli/commands/proxy/otlp-cold-start.js', () => ({ ensureOtlpProxy: vi.fn() }))`
  - Import `ClaudePluginMetadata` from `../claude.plugin.js` and the two mocked functions, following the `runBeforeRun(env)` helper shape already in `claude.plugin.auto-update.test.ts:38-43`.
  - Three `it`s: (a) connected → `ensureOtlpProxy` called once with `'claude-code-otlp'`; (b) not connected → `ensureOtlpProxy` not called; (c) connected + `ensureOtlpProxy` rejecting → `beforeRun(env)` resolves without throwing.
- [ ] **Step 2: Run it and confirm it fails** — `npm test -- claude.plugin.otlp-preflight.test.ts` — expected failure: `ensureOtlpProxy` mock never called (case a) because `beforeRun` does not yet reference it.
- [ ] **Step 3: Implement** — add the two imports near the top of `claude.plugin.ts` (matching the file's existing relative-import style, e.g. `../../../cli/commands/proxy/otlp-cold-start.js` and `../../../cli/commands/proxy/connectors/claude-code-otlp-endpoint.js`), then inside `beforeRun`, after the existing env-default block (after line ~318 area), add a guarded, non-blocking pre-spawn refresh:

```ts
      // Pre-spawn OTLP endpoint refresh (EPMCDME-16647 QA fix): rewrite
      // ~/.claude/settings.json's endpoint before Claude Code's own process
      // reads it, not only during the SessionStart hook that runs after.
      // Gated on claude-code-otlp already being connected so an unconnected
      // launch never starts the proxy daemon as a side effect. Mirrors
      // OtlpAgentAdapter.ts's own non-blocking contract: a failure here must
      // never fail the launch.
      if (await isClaudeCodeOtlpConnected()) {
        try {
          await ensureOtlpProxy('claude-code-otlp');
        } catch (error) {
          logger.warn(
            '[claude] pre-spawn OTLP endpoint refresh failed (non-blocking)',
            ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) })
          );
        }
      }
```

  (`logger` and `sanitizeLogArgs` are already imported in this file, lines 20-21.)
- [ ] **Step 4: Run it and confirm it passes** — `npm test -- claude.plugin.otlp-preflight.test.ts` — all three assertions PASS; also re-run `claude.plugin.auto-update.test.ts` and the other existing `claude.plugin.*.test.ts` files to confirm no regression from the new imports/call.
- [ ] **Step 5: Commit.**

---

## Spec Coverage Check

- AC1 (correct endpoint written before Claude Code reads it) — Task 2.
- AC2 (no side effect when not connected) — Task 1 (gate) + Task 2 (gate usage), test case (b).
- AC3 (pre-spawn failure never blocks launch) — Task 2, test case (c).
- AC4 (`SessionStart` hook-time rewrite still runs) — no task touches it; confirmed in the Negative-Constraint Pass, item 5.
- AC5 (native launches unchanged) — no task touches the native path; confirmed in the Negative-Constraint Pass, item 1.
- `claude-acp` inherits the fix via `ClaudePluginMetadata.lifecycle.beforeRun` spread (`claude-acp.plugin.ts:16-18`) — no separate task needed, nothing in `claude-acp.plugin.ts` changes.
