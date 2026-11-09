# Technical Research

**Task**: claude-code-otlp hook, proxy-daemon auto-start, ensureOtlpProxy, analytics proxy, hook exit code
**Generated**: 2026-10-23
**Research path**: filesystem

---

## 1. Original Context

Fix EPMCDME-15369 — in the CodeMie CLI, when the analytics proxy daemon cannot be started (or restarted) during a `claude-code-otlp` hook invocation (`codemie hook --agent claude-code-otlp`), the daemon startup/restart error currently propagates out of the analytics path and causes the hook process to exit with code 1. Per the "Auto-start analytics proxy daemon when not running" requirement (AC4, EPMCDME-15318), analytics proxy startup/restart failures must be non-blocking: swallowed and logged (debug/info level, with enough diagnostic detail), never thrown to the hook caller. Expected behavior: (1) a daemon startup failure does not throw out of the analytics hook path, (2) a daemon restart failure does not throw out of the analytics hook path, (3) hook exit code remains 0 regardless, (4) the error is logged with diagnostic info, (5) no invalid daemon state is left behind on failure, (6) normal successful auto-start/restart behavior is unchanged. Root cause per the ticket: the OTLP hook path awaits daemon startup via `ensureOtlpProxy()` before processing the analytics event, and the startup error is allowed to propagate back to the hook command instead of being caught/swallowed in the analytics-specific code path.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/core/OtlpAgentAdapter.ts:103` — `await ensureOtlpProxy(this.name);` inside `processOtlpEvent()`. **This is the unguarded call site and the primary fix point.** No try/catch exists around it today. The `isTracked()` gate runs before this line (invariant comment at `:91-95`: "An untracked project must produce NO hooks data in the daemon spool, must not start the daemon...") and must continue to gate whether `ensureOtlpProxy` is even reached — the fix changes only how its failure is handled, not when it's called.
- `src/agents/core/types.ts:734-738` — `OtlpAdapterDeps` interface: `ensureOtlpProxy: (agentName: string) => Promise<void>` and `forwardOtlpEventsToSpool`, injected into every OTLP adapter via dependency injection.
- `src/cli/commands/hook.ts:8` — imports `ensureOtlpProxy` from `./proxy/connect-orchestrator.js`.
- `src/cli/commands/hook.ts:1541` — `await analyticsAgent.processOtlpEvent(input, { ensureOtlpProxy, forwardOtlpEventsToSpool });` — the actual call site reached by `codemie hook --agent claude-code-otlp`. Not individually wrapped; sits inside a broader try whose outer catch at `hook.ts:1597-1624` sets `process.exitCode = 1` (line 1624) and prints `codemie hook: ${eventName} failed: ${message}`. **This is exactly how the daemon-start error currently surfaces as exit code 1.**
- `src/cli/commands/hook.ts:1543,1595` — `process.exitCode = 0` on the success path. Comments at `:1593-1594` and `:1622-1623` explicitly state: "Use process.exitCode instead of process.exit() to allow graceful shutdown / prevents Windows libuv UV_HANDLE_CLOSING assertion failures." Any fix must preserve this idiom (set `process.exitCode = 0` explicitly on this path; never call `process.exit()`).
- `src/cli/commands/proxy/connect-orchestrator.ts:399-433` — `export async function ensureOtlpProxy(agentName: string): Promise<void>`. Reads daemon state; returns early if a live process exists (`isProcessAlive(state.pid)`); otherwise loads config and calls `ensureDaemon()` (defined ~line 336), which performs the restart-if-unhealthy/mismatched (`stopDaemon()` then `spawnDaemon()`) and start-if-not-running logic. `ensureOtlpProxy` itself has **no** try/catch — anything `ensureDaemon`/`spawnDaemon`/`stopDaemon` throws propagates straight out.
  - **Important**: `ensureOtlpProxy`/`ensureDaemon` is a generic daemon orchestration primitive. Its only *runtime* caller today is the hook path, but it is architecturally shared machinery also used by the interactive `codemie proxy connect` command via `ensureDaemon`/`runConnect`. Swallowing errors inside `connect-orchestrator.ts` itself would also silence failures for the interactive connect command, which must continue to surface errors to the user. **The fix must not touch `connect-orchestrator.ts` or `daemon-manager.ts`.**
- `src/cli/commands/proxy/daemon-manager.ts:33` — `DEFAULT_STATE_FILE = join(getCodemieHome(), 'proxy-daemon.json')`, the single daemon state file (pid, port, url, profile, gatewayKey, health fields), written atomically via tmp+rename (`writeState`, lines 44-51), deleted via `clearState` (lines 53-58, swallows ENOENT).
- `src/cli/commands/proxy/daemon-manager.ts:89-144` — `spawnDaemon()`: spawns `bin/proxy-daemon.js` detached, polls 5s for state file + alive pid, else `throw new ToolExecutionError('proxy-daemon', 'Daemon failed to start within 5 seconds. Check logs: ~/.codemie/logs/')` (lines 140-143). This is the actual startup-failure throw site.
- `src/cli/commands/proxy/daemon-manager.ts:146-183` — `stopDaemon()`: SIGTERM then SIGKILL escalation; calls `clearState()` in **every** exit branch (graceful success, SIGKILL escalation, already-dead). This means the restart path does not, on its own, leave stale/invalid state behind — state is already cleared before the `spawnDaemon()` re-attempt that might throw.
- `src/cli/commands/proxy/daemon-manager.ts:67-69,151-154` — `checkStatus()`/`readState()` self-heal: a dead-pid state file is detected via `isProcessAlive(state.pid)` and `clearState()` is called automatically on the next read. This self-healing already satisfies AC5 ("no invalid daemon state left behind") for the failure modes in scope — the fix needs no additional explicit cleanup.
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` — concrete OTLP adapter (Claude Code-specific `evaluate()`, allowlist gating via `isTracked`); inherits `processOtlpEvent` unchanged from the base class, so the fix belongs in `OtlpAgentAdapter.ts`, not in this plugin file.
- `bin/proxy-daemon.js` — thin un-compiled JS shim that dynamic-imports `../dist/bin/proxy-daemon.js`; on import rejection it writes to stderr and calls `process.exit(1)` itself (the daemon child process's own fatal path, separate from the hook's exit code). Daemon-side failures surface only via `~/.codemie/logs/` and the detached process's own stdio — relevant to ensuring the hook-side log message is self-sufficient diagnostically.

### Architecture and Layers Affected

- **CLI command layer** — `src/cli/commands/hook.ts`: entry point, owns `process.exitCode`.
- **Agent adapter layer** — `src/agents/core/OtlpAgentAdapter.ts` (base class, shared by all OTLP adapters), `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` (concrete, unaffected): analytics event processing/gating. **This is the layer the ticket says must swallow the error** — it is "the analytics-specific code path."
- **Proxy orchestration layer** — `src/cli/commands/proxy/connect-orchestrator.ts`: daemon start/restart decision logic, shared with interactive `proxy connect`. Must remain unchanged (still throws).
- **Daemon process-management layer** — `src/cli/commands/proxy/daemon-manager.ts`, `bin/proxy-daemon.js`: spawn/poll/stop, state file I/O. Must remain unchanged.
- **Logging/utils** — `src/utils/logger.ts` (logger), `src/utils/security.ts` (`sanitizeLogArgs`, not currently imported by `OtlpAgentAdapter.ts`).

### Integration Points

Call chain: `codemie hook --agent claude-code-otlp` (hook.ts:1501-1545 action) → `AgentRegistry.getAnalyticsAgent(opts.agent)` → `analyticsAgent.processOtlpEvent(input, deps)` (hook.ts:1541) → `OtlpAgentAdapter.processOtlpEvent` (OtlpAgentAdapter.ts:82) → `deps.ensureOtlpProxy(this.name)` (OtlpAgentAdapter.ts:103, **unguarded**) → `ensureOtlpProxy` (connect-orchestrator.ts:399) → `ensureDaemon()` (connect-orchestrator.ts:336) → `spawnDaemon()`/`stopDaemon()` (daemon-manager.ts:89/146) → spawns `bin/proxy-daemon.js`, writes/reads `~/.codemie/proxy-daemon.json`.

`ensureOtlpProxy` has no other runtime callers besides this hook path (confirmed via grep); `connect-orchestrator.ts`'s `ensureDaemon` is also used by interactive `proxy connect`, but through a separate call path (`connectTargets`/`runConnect`), not through `ensureOtlpProxy` directly in that flow for the analytics case.

### Patterns and Conventions

- **Sibling contract to mirror**: `forwardOtlpEventsToSpool` (the other half of `OtlpAdapterDeps`, injected alongside `ensureOtlpProxy`) is documented in `docs/ARCHITECTURE-OTLP-PLUGIN.md` §2 as: "Never throws. A dead daemon or a non-2xx response makes it return `false`." This is strong architectural precedent — `ensureOtlpProxy`'s *call site* should be made to match this non-throwing contract.
- **Established non-blocking swallow-and-log idiom** (used repeatedly elsewhere in the codebase): `try { ... } catch (error) { const msg = error instanceof Error ? error.message : String(error); logger.error/debug(\`[agent] X failed (non-blocking): ${msg}\`); }` — seen at `pi.plugin.ts:387`, `codex.plugin.ts:208,217,401,419`, `codemie-code.plugin.ts:245,323,342,440,459`, `opencode.plugin.ts:228,483,501`, `copilot-cli.plugin.ts:172,261`, and already **inside `hook.ts` itself** at lines 193-210 and 612 (`[hook:SessionStart] Skill sync failed (non-blocking)`, `[hook:UserPromptSubmit] Auth gate check failed (non-blocking)`).
- `sanitizeLogArgs(...)` is spread into `logger.debug/info/warn(msg, ...sanitizeLogArgs({...}))` whenever structured context (profile, project, clientType, URLs) accompanies a log line — see `daemon-manager.ts:113-129`, `connect-orchestrator.ts:460-469`. `OtlpAgentAdapter.ts` currently only imports `logger`, not `sanitizeLogArgs` — the fix should add this import if logging structured context.
- Proxy's own stated design principle, `docs/ARCHITECTURE-PROXY.md` §4.4 "Error Handling": "Fail-Safe … Plugin errors don't break proxy flow" — try/catch around every plugin hook, log, continue. §7.2 "Reliability": ProxyWatcher restarts up to 3 attempts before giving up and recording `health: 'unhealthy'` in the daemon state file — precedent for "log, give up gracefully, leave consistent state" rather than looping or crashing the caller.
- Debug-level "best-effort telemetry" pattern explicitly documented at `src/cli/commands/skills/lib/skills-metrics.ts:17-18`: "Any failure ... is logged at debug level and swallowed — telemetry must never ...".

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md:270` — one-line pointer to `OtlpAgentAdapter` as the OTLP ingestion plugin base class; delegates to `docs/ARCHITECTURE-OTLP-PLUGIN.md`.
- `.ai-run/guides/integration/external-integrations.md:281-283,319-333` — names `claude-code-otlp` as the reference OTLP implementation; also documents an analogous fail-soft convention elsewhere ("Validate provider config at startup; warn (not throw) on connectivity failures", `:312-317`).
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` — **authoritative doc for this feature area**. Describes `processOtlpEvent`'s fixed flow as `parseHookInput → isTracked → ensureOtlpProxy → evaluate(...)`; quotes the INVARIANT comment at `OtlpAgentAdapter.ts:91-95` gating when `ensureOtlpProxy` runs; documents `forwardOtlpEventsToSpool`'s "never throws" contract (the mirror target for this fix). States no behavior today for `ensureOtlpProxy` failure — confirms this is the documented gap EPMCDME-15369 closes.
- `docs/ARCHITECTURE-PROXY.md` §4.4, §7.2, §9.5 — "Fail-Safe" principle, self-healing/give-up-after-3-attempts precedent, troubleshooting notes on stale state and repeated restart failures.

### Architectural Decisions

No formal ADR files exist (no `docs/adr/` or `docs/decisions/` directory). De facto decisions are folded into architecture markdown:
1. Fail-Safe plugin/proxy error handling principle (`ARCHITECTURE-PROXY.md` §1.2, §4.4, §7.2).
2. `forwardOtlpEventsToSpool` "never throws" contract — the sibling function in the same `OtlpAdapterDeps` object as `ensureOtlpProxy`, the natural contract to mirror.
3. The base-class INVARIANT comment (`OtlpAgentAdapter.ts:91-95`) gating when `ensureOtlpProxy` is called — must not be weakened or bypassed by this fix.
4. ProxyWatcher's "give up after 3 attempts, record `health: 'unhealthy'`" pattern as precedent for not looping or leaving ambiguous state on repeated restart failure.

No TODO/HACK/ADR/DECISION markers found in `OtlpAgentAdapter.ts` or `hook.ts` via grep. `CHANGELOG.md` has no mentions of EPMCDME-15318 or EPMCDME-15369. The task run directory (`docs/superpowers/tasks/2026-10-23-proxy-startup-failure-otlp-hook-exit-code/`) is untracked and contains only a `.state.json` (sdlc-light flow, phase "main") — no prior spec/plan artifacts to reconcile against.

### Derived Conventions

- Mirror the sibling `forwardOtlpEventsToSpool` contract: never throw past this point; log and return a benign result so callers can't accidentally propagate.
- Follow the proxy's own "Fail-Safe" principle (try/catch, log, continue) rather than inventing a new idiom.
- Preserve the `hook.ts` idiom of setting `process.exitCode` rather than calling `process.exit()` (Windows libuv constraint, noted inline).
- Respect the `OtlpAgentAdapter.ts:91-95` INVARIANT — change only how `ensureOtlpProxy`'s failure is handled, never when it's called.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/__tests__/hook.analytics-wiring.test.ts` — verifies `createHookCommand()` delegates to `AgentRegistry.getAnalyticsAgent('claude-code-otlp').processOtlpEvent(input, { ensureOtlpProxy, forwardOtlpEventsToSpool })`. `ensureOtlpProxy` mocked as `vi.fn()` that always resolves; no failure path, no exit-code assertion. Drives the real `createHookCommand().parseAsync([...])` with stdin replaced via `Readable.from(...)` — the closest existing pattern for exit-code testing, but no test currently reads `process.exitCode` after invocation.
- `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` — unit tests `processOtlpEvent` via a `FakeAdapter`; `ensureOtlpProxy` injected as `vi.fn(async () => {})`, always resolves. Covers `isTracked` gate ordering and `ensureOtlpProxy` → `forwardOtlpEventsToSpool` call order via `invocationCallOrder`. **No test makes `ensureOtlpProxy` reject.**
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` — exercises the concrete adapter with `ensureOtlpProxy = vi.fn(async () => {})` in every describe block; same gap, never rejects.
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — tests `daemonMatchesRequest`/`deriveDaemonIdentity`/`connectTargets`, mocking `daemon-manager.js` (`checkStatus`, `readState`, `spawnDaemon`, `stopDaemon`). **Does not import or test `ensureOtlpProxy` at all.**
- `src/cli/commands/proxy/__tests__/daemon-manager.test.ts` — unit tests `spawnDaemon`/`stopDaemon`/`checkStatus` directly; useful reference for simulating daemon failures at the lower layer, not wired to the hook/analytics path.
- `tests/integration/proxy-daemon-lifecycle.test.ts` — real-process integration test for `codemie proxy start/stop`; unrelated to the hook invocation flow.

### Testing Framework and Patterns

- Vitest (`describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll`).
- `vi.mock('<path>.js', () => ({...}))` at module top + dynamic `await import(...)` inside tests for typed mock access.
- Call-order assertions via `vi.fn().mock.invocationCallOrder[0]` comparisons — reusable to assert "ensureOtlpProxy still runs, or its rejection doesn't block forwardOtlpEventsToSpool/exit code."
- `logger` mocked as `{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }` in `OtlpAgentAdapter.test.ts` — ready seam for asserting diagnostic logging on the swallow path.

### Coverage Gaps

- No test exercises `ensureOtlpProxy` throwing/rejecting anywhere in the chain (`OtlpAgentAdapter.test.ts`, `claude-code-otlp.plugin.test.ts`, `hook.analytics-wiring.test.ts`).
- No unit test for `ensureOtlpProxy` itself (`connect-orchestrator.ts:399-433`) — daemon-start failure (`spawnDaemon` rejecting) and daemon-restart failure (`stopDaemon`/`spawnDaemon` rejecting in the restart branch) have zero coverage.
- No test asserts `process.exitCode` stays `0` when the hook is invoked with `--agent claude-code-otlp` and the analytics path fails — this is the central missing assertion for this ticket.
- No test confirms "no invalid daemon state left behind" after a failed start/restart in the OTLP hook path specifically.
- No regression test guarding that normal successful auto-start/restart behavior is unchanged once a try/catch is added.
- No dedicated AC4/EPMCDME-15318 test file; closest coverage is the generic ordering tests, happy-path only.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — relocates `~/.codemie` (and thus `proxy-daemon.json`) — `src/utils/paths.ts:367-373`.
- `OTLP_SEND_INTERVAL_MINUTES`, `OTLP_SWEEP_INTERVAL_MINUTES`, `OTLP_SEND_MAX_ATTEMPTS`, `OTLP_ALLOW_HOOKS_ONLY_FORWARD`, `OTLP_ENDED_SESSION_GRACE_MINUTES`, `OTLP_ABANDONED_SESSION_GRACE_MINUTES` — all in `src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-config.ts` (noted as already modified per git status). Govern spool send/sweep/retention timing, **not** daemon-ensure retry behavior — no env var currently controls retry/backoff for `ensureOtlpProxy`/`ensureDaemon`/`spawnDaemon`.

### Configuration Files

- `~/.codemie/proxy-daemon.json` (`DEFAULT_STATE_FILE`, `daemon-manager.ts:33`) — single JSON daemon state file (pid, port, url, profile, gatewayKey, health fields), atomic tmp+rename writes, deleted via `clearState`.
- No separate pidfile/lockfile/socket beyond this state JSON.

### Feature Flags and Deployment Concerns

- No "auto-start" feature flag exists (grepped repo-wide; only doc/comment references to the *behavior*, no config toggle). Auto-start is unconditional whenever `ensureOtlpProxy` is invoked from a tracked-project hook event — the fix adds its own try/catch rather than toggling an existing flag.
- `bin/proxy-daemon.js` is a thin shim; its own fatal path (`process.exit(1)` on import rejection) is separate from the hook's exit code but is the daemon's only other diagnostic trail (`~/.codemie/logs/`) — the hook-side swallow-and-log message should carry enough detail (error message/stack, phase: fresh-start vs restart) since this is otherwise the only signal an operator sees.
- `stopDaemon()` guarantees `clearState()` in every exit branch, so a restart failure (stop succeeds, subsequent spawn fails) does not leave a stale pid behind — AC5 is already satisfied by existing `daemon-manager.ts` behavior without additional cleanup code in the fix.

---

## 6. Risk Indicators

- Zero test coverage today for any `ensureOtlpProxy` failure path (startup or restart) — the fix is effectively untested terrain; new tests are required to prove AC1-AC3 and AC6.
- The generic `ensureOtlpProxy`/`ensureDaemon` primitive is shared with the interactive `codemie proxy connect` command — a fix applied at the wrong layer (inside `connect-orchestrator.ts` or `daemon-manager.ts`) would silently break error visibility for that unrelated, user-facing command. The fix must be scoped to `OtlpAgentAdapter.ts:103` (or equivalently `hook.ts:1541`, but the adapter layer is the more targeted, uniformly-applied choice across all OTLP adapters).
- `OtlpAgentAdapter.ts` does not currently import `sanitizeLogArgs`; if the new catch block logs structured context (agent name, error), it should use the project's established sanitization helper to avoid leaking any sensitive daemon state (profile, gatewayKey) that might appear in error messages.
- No existing test reads `process.exitCode` after `createHookCommand().parseAsync(...)` in `hook.analytics-wiring.test.ts` — the exact assertion this ticket needs is not just missing coverage for the new behavior, it's a blind spot in the whole test file's existing design.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md`'s documented pipeline (`parseHookInput → isTracked → ensureOtlpProxy → evaluate(...)`) does not mention failure handling for `ensureOtlpProxy` — this doc will likely need a follow-up update once the fix lands, though updating generated/architecture docs is out of scope unless explicitly requested.
- Design decision required from the implementer: when `ensureOtlpProxy` fails, should `evaluate()`/`forwardOtlpEventsToSpool` still run afterward (best-effort continue) or should the event be skipped entirely for that invocation? The research threads note this is unresolved and should be confirmed during planning — the sibling contract (`forwardOtlpEventsToSpool` never throws) suggests "continue and let forward fail silently" is consistent, but it's a product decision, not purely technical.

---

## 7. Summary for Complexity Assessment

This is a narrowly-scoped, single-conceptual-change fix confined almost entirely to one layer: the primary edit is a try/catch wrapped around one `await` statement at `src/agents/core/OtlpAgentAdapter.ts:103`, following an error-handling idiom (swallow, log via `logger.error`/`debug` with a "(non-blocking)" message, continue) that is already used repeatedly elsewhere in this same codebase (`hook.ts` itself, and five other agent plugins). No new dependencies, no schema/migration changes, no new config or env vars are needed. The daemon state-cleanup concern (AC5) is already satisfied by existing `daemon-manager.ts` behavior (`stopDaemon` always clears state; `checkStatus`/`readState` self-heal stale pids), so the fix requires no additional cleanup logic — only the catch-and-log wrapper itself. Estimated file change surface for the implementation: 1 primary source file (`OtlpAgentAdapter.ts`), possibly a one-line `sanitizeLogArgs` import addition, with no changes needed to `connect-orchestrator.ts` or `daemon-manager.ts` (those must stay unchanged to preserve correct throwing behavior for the interactive `codemie proxy connect` command that shares the same underlying primitive).

Technical novelty is low — this follows an established, well-precedented pattern (non-blocking swallow-and-log) and an explicit architectural contract already documented for the sibling dependency (`forwardOtlpEventsToSpool` "never throws," per `docs/ARCHITECTURE-OTLP-PLUGIN.md`). The main judgment call, not a technical unknown, is a design decision: whether `evaluate()`/`forwardOtlpEventsToSpool` should still attempt to run after a swallowed `ensureOtlpProxy` failure, or whether the event should be skipped for that invocation — this should be resolved explicitly in planning/spec rather than left implicit in the implementation.

Test coverage posture for this exact failure mode is currently zero: none of the four most relevant test files (`OtlpAgentAdapter.test.ts`, `claude-code-otlp.plugin.test.ts`, `hook.analytics-wiring.test.ts`, `connect-orchestrator.test.ts`) ever makes `ensureOtlpProxy` reject, and no test reads `process.exitCode` after a hook invocation — meaning the acceptance criteria (exit code 0, non-throwing, diagnostic logging) require net-new test cases rather than extensions of well-trodden assertions. This elevates the effective complexity slightly above what the one-line code change alone would suggest: expect at least 3-4 new/modified test cases across `OtlpAgentAdapter.test.ts` and `hook.analytics-wiring.test.ts` to adequately cover AC1-AC4 and AC6, plus care to avoid scope creep into the shared `connect-orchestrator.ts`/`daemon-manager.ts` layer which must remain untouched and still-throwing for its other caller.
