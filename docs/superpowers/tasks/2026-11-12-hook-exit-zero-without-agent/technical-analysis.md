# Technical Research

**Task**: hook CODEMIE_AGENT initializeLoggerContext exit
**Generated**: 2026-11-12
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16960. `codemie hook` exits non-zero (throws) when CODEMIE_AGENT is unset, which Claude Code surfaces as "SessionEnd hook failed: Hook cancelled". Root cause: initializeLoggerContext() in src/cli/commands/hook.ts (~lines 198-209) throws Error('CODEMIE_AGENT environment variable is required'); the CODEMIE_SESSION_ID check right below throws the same way. It propagates through initializeHookContext() to the generic catch in createHookCommand()'s action handler (~lines 1726-1746) which sets process.exitCode = 1. Expected: exit 0 gracefully when not in a CodeMie-managed session (missing agent OR missing session id), keep a debug log line (logger.debug), no stderr output. Follow the tone of the existing "Missing CODEMIE_AGENT, skipping extraction" (~line 499). Existing tests: src/cli/commands/__tests__/hook.*.test.ts — new test goes next to them. Research: how initializeHookContext/initializeLoggerContext are called, all callers, how other hook paths handle missing env, existing test patterns/mocks for hook command.

---

## 2. Codebase Findings

### Existing Implementations
All in `/Users/mert_efe/codemie-installers/codemie-code/src/cli/commands/hook.ts` (line numbers as of current HEAD; the task's numbers are slightly stale):
- `initializeLoggerContext()` L198-: if `CODEMIE_AGENT` unset, builds a names-only list of `CODEMIE_*` vars (values deliberately excluded, credentials), `logger.debug("[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars: ...")`, then `throw new Error('CODEMIE_AGENT environment variable is required')` (L208). Then `CODEMIE_SESSION_ID` unset -> `throw new Error('CODEMIE_SESSION_ID environment variable is required')` (L214, no debug line). Then sets logger agent/session/profile. Returns sessionId. Private (not exported).
- `initializeHookContext(config?)` L1533: with `config` returns config.sessionId/agentName (no env read); without config calls `initializeLoggerContext()` and `agentName = process.env.CODEMIE_AGENT || 'unknown'`. Private.
- Callers of `initializeHookContext`: exactly two, both in hook.ts: `processEvent()` L1610 (exported; called with optional config) and the CLI action in `createHookCommand()` L1713 (no config). `initializeLoggerContext` has one caller (`initializeHookContext`).
- `createHookCommand()` action L1646-1781: reads stdin, JSON-parses (exit 2 on parse error), early branch for OTLP analytics agents via `AgentRegistry.getAnalyticsAgent(opts.agent!)` (L1687, sets exitCode 0 and returns; never reaches initializeHookContext), validates session_id / hook_event_name (console.error + process.exit(2)), then `initializeHookContext()` L1713, transform, `validateHookEvent`, `routeHookEvent`, `logger.close()`, `process.exitCode = 0`. Generic `catch` L1746-1773: logs `logger.error`, `await logger.close()`, `console.error("codemie hook: <event> failed: <msg>")`, `process.exitCode = 1`. `finally` removes signal listeners.
- Note: the task says "--agent <name>" option exists; the non-OTLP path ignores `opts.agent` and relies solely on env `CODEMIE_AGENT`.
- Precedent for graceful skip: L493-500 (inside the session-processing function): `getConfigValue('CODEMIE_AGENT', config)`; if absent and `config` -> throw `Missing required config: agentName`; if absent and no config -> `logger.warn("[hook:<hookName>] Missing CODEMIE_AGENT, skipping extraction")` and return `{ lockTimedOut: false }`. (Uses warn, whereas the task asks for debug.)
- Other exit-code conventions: `validateHookEvent` (L1487) in CLI mode sets `process.exitCode = 2` (blocking) and in config mode throws; OTLP path forces exitCode 0.

### Architecture and Layers Affected
CLI layer only: `src/cli/commands/hook.ts` (command action + two private helpers). `processEvent` is also a programmatic API used by plugins (see below), so the helper change affects the plugin/in-process layer's observable behavior when called without config.

### Integration Points
- `processEvent` importers (non-test): `src/index.ts`, `src/agents/core/session/stale-session-reconciliation.ts`, `src/agents/plugins/{codemie-code.plugin.ts, codex/codex.plugin.ts, pi/pi.plugin.ts, copilot-cli/copilot-cli.plugin.ts, opencode/opencode.plugin.ts}`. Not verified whether each passes `config` (the config path never touches env, so only config-less calls are affected).
- `src/cli/index.ts` L97 registers `createHookCommand()`.
- Logger: `@/utils/logger.js` (`logger.debug`, `logger.warn`, `logger.close`).

### Patterns and Conventions
- Per-env reads use `getConfigValue(name, config)` in handlers; helper-level reads use `process.env`.
- Exit via `process.exitCode` (not `process.exit`) for graceful shutdown (Windows libuv comment at L1742); `process.exit(2)` used only for blocking input errors.
- Logger secrecy: names-only CODEMIE_* dump retained deliberately (comment L201-203).
- AGENTS.md: ES modules, `.js` import extensions, `logger.debug` not console.log, explicit return types, no `any`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage, project.md, quality-gates.md) — not read in depth (task is a narrow behavior change). Relevant: `development/development-practices.md` (error handling/logging), `testing/testing-patterns.md` (Vitest), `security/security-practices.md` (logging). `docs/HOOKS.md` documents exit codes (0 success, 2 blocking); no mention of missing CODEMIE_AGENT. `docs/ARCHITECTURE-OTLP-PLUGIN.md` covers the OTLP path (unaffected).

### Architectural Decisions
None recorded for this behavior. Prior task analyses touching hook.ts: `docs/superpowers/tasks/2026-11-02-sso-hook-profile-subfolder/` and `2026-08-20-investigate-claude-hooks-logging/`.

### Derived Conventions
The L1767-1770 comment shows stderr one-liner on failure was added intentionally so agents don't show "No stderr output"; the ticket explicitly wants no stderr for the not-managed case.

---

## 4. Testing Landscape

### Existing Coverage
In `/Users/mert_efe/codemie-installers/codemie-code/src/cli/commands/__tests__/`: `hook-routing-contract.test.ts`, `hook.analytics-wiring.test.ts`, `hook.auth-gate-wait.test.ts`, `hook.inject-event-name.test.ts`, `hook.legacy-metrics-gate.test.ts`, `hook.lock.test.ts`, `hook.session-delivery.test.ts`, `hook.session-origin.test.ts`.

Tests that currently ASSERT THE OLD BEHAVIOR (will need updating/reconciling):
- `hook.lock.test.ts` ~L355-365 (`describe('processEvent')`): with CODEMIE_AGENT and CODEMIE_SESSION_ID deleted, `await expect(processEvent(event)).rejects.toThrow()` (comment: "initializeLoggerContext requires CODEMIE_AGENT and CODEMIE_SESSION_ID"). This exercises `processEvent` without config, so it is affected if the fix is placed inside `initializeLoggerContext`/`initializeHookContext` rather than in the CLI action.
- `/Users/mert_efe/codemie-installers/codemie-code/tests/integration/hook-stdout.test.ts` ~L416-430: spawns `codemie hook` with `CODEMIE_AGENT: ''`, `CODEMIE_DEBUG: '1'`; expects `res.code === 1`, one stderr line `codemie hook: SessionStart failed: CODEMIE_AGENT environment variable is required`, and file log containing `[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars: `. Directly contradicts the ticket's expected behavior (exit 0, empty stderr); the debug-log assertion remains valid if that line is kept.

### Testing Framework and Patterns
Vitest; `@group unit` docblocks; `vi.mock` / `vi.hoisted`; CLI tests drive the command in-process via `await createHookCommand().parseAsync(['--agent','claude'], { from: 'user' })` after replacing `process.stdin` with `Readable.from([JSON.stringify(event)])` via `Object.defineProperty(process,'stdin',{value, configurable:true})` and restoring afterwards (see `hook.analytics-wiring.test.ts` L62-100 and `hook-routing-contract.test.ts` `runHookProcess` L~464-475). Env is saved/restored per test (`HOOK_ENV` list pattern, L432). `process.exitCode` is saved in `beforeEach`/`afterEach` and asserted (`expect(process.exitCode).toBe(0)`). `vi.spyOn(AgentRegistry,'getAnalyticsAgent')` is used to steer the OTLP branch; for the new test it must return undefined/non-analytics (real registry for `claude` is fine as in routing-contract). Stderr could be observed with `vi.spyOn(console,'error')`; debug lines with `vi.spyOn(logger,'debug')`. Note: `hook.lock.test.ts` `afterEach` assigns `process.env = originalEnv` (shares reference).
The out-of-process spawn pattern lives in `tests/integration/hook-stdout.test.ts` (`run(home, ['hook'], stdin, envOverrides)`, `freshHome()`, `fileLog(home)`).

### Coverage Gaps
No unit test for missing CODEMIE_SESSION_ID in the CLI action; no test asserting exit 0 / silent stderr when not in a managed session.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_AGENT`, `CODEMIE_SESSION_ID` (required by initializeLoggerContext), `CODEMIE_PROFILE_NAME` (optional logger profile), `CODEMIE_DEBUG` (enables debug output to file log), `CODEMIE_PROVIDER`, `CODEMIE_SESSION_END_SYNC_BUDGET_MS`, `CODEMIE_WRAPPER_PID`.

### Configuration Files
None specific. Hook registration for Claude lives in the Claude plugin settings (not investigated).

### Feature Flags and Deployment Concerns
None found. Hooks are installed globally in Claude Code settings, which is why a plain `claude` run outside CodeMie (no CODEMIE_* env) invokes `codemie hook` and fails.

---

## 6. Risk Indicators

- Speculative: placement decides blast radius. Fixing inside `initializeLoggerContext`/`initializeHookContext` also changes `processEvent(event)` (no config) behavior used by in-process plugin callers and the `hook.lock.test.ts` L355-365 test; fixing in the CLI action only (before/around `initializeHookContext()` L1713) leaves `processEvent` throwing.
- Two existing tests assert the old behavior (`hook.lock.test.ts` ~L364; `tests/integration/hook-stdout.test.ts` ~L421, expects exit 1 and a stderr line) and will fail unless updated.
- Speculative: the early `session_id`/`hook_event_name` validation (L1697-1709, exit 2 with stderr) runs BEFORE initializeHookContext; a non-managed hook with a malformed payload still exits 2. Order matters if "exit 0 when not managed" must win.
- Existing precedent uses `logger.warn` (L499) while ticket asks for `logger.debug`; `logger.warn` may reach console depending on logger config, risking stderr output.
- The OTLP analytics branch (L1687) already returns before this path; no change needed there.
- Session-id missing branch currently has no debug log line at all.
- Process-level: `logger.close()` and `process.exitCode = 0` should be preserved on the skip path; signal listeners are cleaned in `finally`.

---

## 7. Summary for Complexity Assessment

The change is confined to one CLI-layer file, `src/cli/commands/hook.ts`: the two throws in `initializeLoggerContext()` (L198-215), its single caller `initializeHookContext()`, and the two call sites (`processEvent` L1610 and the command action L1713, whose generic catch L1746 sets exitCode 1 and prints to stderr). The code change is small and pattern-aligned (precedent: the "Missing CODEMIE_AGENT, skipping extraction" graceful skip at L499), but the design choice of where to short-circuit (helper return value vs CLI action only) affects the exported `processEvent` used by several agent plugins.

No new technology is involved. Test posture is good for the hook command (Vitest, in-process `createHookCommand().parseAsync` with stdin replacement, env save/restore), but two existing tests encode the old failing behavior (`hook.lock.test.ts` and `tests/integration/hook-stdout.test.ts`) and must be reconciled; there is no test for the missing-session-id case.

Key risks: contradictory existing assertions, `processEvent` semantics for in-process callers, ordering relative to the payload validation that exits 2, and ensuring no stderr output (warn vs debug level). Overall a small, low-complexity change with a moderate test-update footprint.

---

## 8. External References

None named by the task
