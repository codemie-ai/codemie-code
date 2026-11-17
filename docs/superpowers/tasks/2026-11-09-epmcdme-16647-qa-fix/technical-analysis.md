# Technical Research

**Task**: claude-code-otlp proxy-connect otlp-endpoint launcher
**Generated**: 2026-11-09
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16647 — [CLI Analytics][Proxy] Claude Code OTel endpoint is not updated when the proxy
daemon respawns on another port, so native telemetry is silently lost for the FIRST session after
the respawn.

Prior fix (already merged, CLI 0.16.5/0.16.6): `ensureOtlpProxy` (in the claude-code-otlp
OtlpAgentAdapter, around `OtlpAgentAdapter.ts:113-115`) now calls `refreshClaudeCodeOtlpEndpoint`
(`connect-orchestrator.ts:460-465`) during the SessionStart hook, which rewrites
`~/.claude/settings.json`'s `OTEL_EXPORTER_OTLP_ENDPOINT` via `claude-code-otlp-endpoint.ts:74-100`
when the daemon has respawned on a different port than what's recorded in settings. This fixed the
case where a *second* session (started after the rewrite already landed) picks up the new endpoint.

QA FAILED (production verification, CLI 0.16.6): the rewrite happens during SessionStart, which is
AFTER Claude Code's own process has already read its settings/initialized its native OTel exporter
for this session. So the CURRENTLY LAUNCHING session — the very first one after a daemon respawn —
still exports its native OTel telemetry to the stale/dead port, even though the hook rewrote the
settings file for the *next* session. Evidence: session dd3392c1 logged "Re-pointed Claude Code
OTLP endpoint from :62380 to :65173" during its own SessionStart hook, but native OTel events were
empty (events: [], active_ms = 0, api_call_count = 0) while hook-based telemetry (220 tool calls,
cost, tokens) was present and correct.

QA's suggested fix direction: configure the correct endpoint BEFORE Claude Code launches — i.e. the
endpoint must be resolved/injected into the launched process's environment (e.g.
`OTEL_EXPORTER_OTLP_ENDPOINT` and related headers) by the `codemie-claude` launcher itself, not only
rewritten into settings.json from inside a hook that fires after the process already started.

The user wants this QA-found gap fixed with MINIMAL impact. If the fix is best placed at a base
adapter/launcher level (shared across agents), the user wants a GENERIC mechanism there (not a
one-off claude-code-only hack) — but kept SIMPLE. Do not assume any particular design; your job is
pure fact-finding so the implementer can choose the smallest correct fix.

Research questions to answer:
1. Where exactly does `OtlpAgentAdapter.ts` call `ensureOtlpProxy`/`refreshClaudeCodeOtlpEndpoint`
   today, and what is the full call chain from hook invocation to settings-file write
   (`claude-code-otlp-endpoint.ts`, `connect-orchestrator.ts`)?
2. How does the `codemie-claude` launcher (bin/codemie-claude.js or similar, and any shared base
   agent-launch code in `src/agents/`) start the actual `claude` process today — does it set/inject
   any env vars into the child process already (e.g. for other providers/proxies)? Is there a
   natural seam where an OTLP endpoint could be resolved and injected into the child env BEFORE
   spawn, instead of (or in addition to) the hook-time settings.json rewrite?
3. Is there an existing "ensure proxy running, get its live URL" primitive (e.g. something
   `ensureOtlpProxy` or `connect-orchestrator.ts` already does) that could be called pre-launch
   from the launcher, so the launch-time env var is always correct even on first launch after a
   respawn?
4. Do other OTLP-capable agent plugins (`copilot-chat-otlp`, `copilot-cli-otlp`, `opencode` via
   `codemie-code-hooks`) have the same launch-time vs. hook-time endpoint problem, or do they not
   rely on native env-var-based OTel export at all (hooks-only ingestion)? Is there a shared base
   adapter class/launcher path across agent plugins where a generic "resolve+inject OTLP endpoint
   before spawning the child process" mechanism could live once, rather than duplicated per plugin?
5. What does `claude-code-otlp-endpoint.ts`'s own docstring/comments say about "takes effect only
   from the next session" — is this a known, documented limitation already, or new information?
6. Are there existing unit tests for `ensureOtlpProxy`, `refreshClaudeCodeOtlpEndpoint`, or the
   `codemie-claude` launcher's env injection that the fix would need to extend?
7. Any related architecture doc (`docs/ARCHITECTURE-OTLP-PLUGIN.md`, `docs/ARCHITECTURE-PROXY.md`)
   guidance on where launch-time vs. runtime endpoint resolution belongs.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose: keep `~/.claude/settings.json`'s OTLP endpoint pointed at the live daemon.**
- `checkClaudeCodeOtlpEndpoint` / `refreshClaudeCodeOtlpEndpoint` (`src/cli/commands/proxy/connectors/claude-code-otlp-endpoint.ts:52-101`) compare/rewrite `env.OTEL_EXPORTER_OTLP_ENDPOINT` + `env.OTEL_EXPORTER_OTLP_HEADERS` in the file, only when CodeMie already owns that key (`isCodemieOwnedEnvValue`, `readOwnedOtlpEnv:16-27`) and the value matches the local-daemon shape (`LOCAL_DAEMON_ENDPOINT` regex). It never touches a foreign/user-owned endpoint.
- Its own doc comment (line 70-73) already states the limitation the ticket re-discovered: *"Claude Code reads settings at startup, so this takes effect from the NEXT session; a running one keeps its old endpoint."* This is pre-existing, documented knowledge, not new information (answers research Q5) — but the merged fix (CLI 0.16.5/0.16.6, work item `docs/superpowers/tasks/2026-11-03-epmcdme-16647-otlp-endpoint-recovery/`) treated "next session" as meaning *"the session whose own SessionStart hook performed the rewrite,"* which QA's production evidence shows is wrong: that session's native OTel exporter already initialized before its SessionStart hook ran.
- Callers: `otlp-cold-start.ts`'s `adoptLiveDaemon()` (line 67-73) and both cold-start branches (`coldStartOnWorkingDirectoryProfile:112`, `ensureOtlpProxy:172`) call `refreshClaudeCodeOtlpEndpoint(live)` unconditionally after the daemon is confirmed/started.
- `readConfiguredOtlpPort` (`claude-code-otlp-endpoint.ts:30-42`) reads the currently-configured port back out, used by `respawnPort()` (`otlp-cold-start.ts:76-78`) to prefer the port Claude Code is already told to use when the daemon has to restart — i.e. the system already tries to *avoid* a port change on respawn when it can.

**Purpose: ensure the proxy daemon is running before a hook event forwards.**
- `ensureOtlpProxy(agentName)` (`src/cli/commands/proxy/otlp-cold-start.ts:131-177`) is the single entry point. Call chain: `codemie hook --agent claude-code-otlp` (`src/cli/commands/hook.ts:6` imports it) → `AgentRegistry.getAnalyticsAgent('claude-code-otlp')` → `OtlpAgentAdapter.processOtlpEvent` (`src/agents/core/OtlpAgentAdapter.ts:91-171`) calls `deps.ensureOtlpProxy(this.name)` at line 118, **before** `evaluate()`/the spool forward, for every tracked hook event (not just `SessionStart`). It wraps the call in try/catch and only logs a warning on failure (line 119-122) — a daemon-start failure never blocks the hook.
- Inside `ensureOtlpProxy`: `adoptLiveDaemon()` short-circuits when a daemon is already alive (seeds the connection record, calls `refreshClaudeCodeOtlpEndpoint`); otherwise it resolves the recorded profile (`readConnectionRecord`/`resolveColdStartProfile`) or falls back to the cwd's active profile, calls `ensureDaemon` (`connect-orchestrator.ts:417-479`, shared with `codemie proxy connect`) to spawn/restart the daemon, then calls `refreshClaudeCodeOtlpEndpoint(live)` once more with the just-spawned state.
- This is a hook-time-only primitive — it runs once per `codemie hook` CLI invocation (a short-lived process), not inside any long-running launcher. **It is the "ensure proxy running, get its live URL" primitive research Q3 asked about**, and it is already callable independent of the hook flow (it only needs an `agentName` string) — nothing structurally prevents calling it from another entry point, but nothing today does.

**Purpose: launch the actual `claude`/agent binary.**
- `bin/codemie-claude.js` → `AgentRegistry.getAgent('claude')` → `AgentCLI.run()` → `BaseAgentAdapter.run()`/`runSession()` (`src/agents/core/BaseAgentAdapter.ts:560-1024`). This is the **managed** launch path (`codemie-claude <args>`).
- `runSession` builds `env` from `process.env` + `CODEMIE_*` overrides (line 592-604), calls the `beforeRun` lifecycle hook (line 671, resolved through `lifecycle-helpers.ts`'s provider-chain, landing in `ClaudePluginMetadata.lifecycle.beforeRun` at `src/agents/plugins/claude/claude.plugin.ts:240-...`), then `transformEnvVars` (CODEMIE_* → ANTHROPIC_* mapping, line 667, actually called *before* `beforeRun` at 667/671 — order: transform then beforeRun), then spawns the child at line 924 with that `env` object via Node's `child_process.spawn(..., { env, shell, stdio: 'inherit' })`.
- `beforeRun` (`claude.plugin.ts:240-320+`) already sets several env vars conditionally (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, `CLAUDE_CODE_AUTO_MODE_SERVER`, `CLAUDE_CODE_ENABLE_TELEMETRY='0'` by default, `DISABLE_AUTOUPDATER`, `ENABLE_TOOL_SEARCH`, etc.) — confirming the seam research Q2 asked about does exist structurally (a provider-agnostic, pre-spawn hook with full env write access). **It does not set or reference `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` anywhere** — grep across `src/agents/plugins/claude/` for `OTEL_EXPORTER`/`claude-code-otlp` returned no matches.
- Critically, `claude-code-otlp` is **not scoped to the managed launcher** at all: its hooks and env are written to the user-level `~/.claude/settings.json` (`getClaudeSettingsPath()`), which the native `claude` binary reads at its own startup regardless of how it was started — `codemie proxy connect --claude-code-otlp` explicitly targets "Native GitHub Copilot CLI"-style unmanaged usage (`docs/HOOKS.md:572-582`: *"registers Claude Code hooks in `~/.claude/settings.json`"*), and the evidence-record schema even has a `launch_mode: 'native' | 'managed'` field (`src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.transitions.test.ts:32`) proving both launch modes are tracked by the same adapter. So the "first session after respawn" bug reproduces for a user who just types `claude` directly — a case where **CodeMie never spawns the process at all** and the `codemie-claude` launcher seam is simply not in the path.

### Decisions Already in the Code

- **Settings.json's own `env` block wins over process env at Claude Code's own startup — already discovered and documented for a different variable (`ANTHROPIC_BASE_URL`).** `docs/superpowers/work-items/EPMCDME-10988.md:15` and `docs/superpowers/specs/2026-07-15-epmcdme-10988-settings-conflict-detection-design.md:12`: *"Claude Code reads `~/.claude/settings.json` at its own startup and silently overrides any environment-level `ANTHROPIC_BASE_URL` with the value in that file."* `docs/ARCHITECTURE-OTLP-PLUGIN.md:280` independently states the same precedence rule generally: *"the effective Anthropic endpoint (settings.json `env` over process env)"*. CodeMie's own `settings-conflict.ts` (`src/agents/plugins/claude/settings-conflict.ts`) exists purely to **detect and warn** about this conflict for `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` — the team's prior, recorded decision for this exact class of problem was *detect-and-warn*, not *force-override via spawn env*, because the EPMCDME-10988 design doc's own execution-order trace (quoted in full below) shows `beforeRun`'s env write happens, then Claude Code starts and re-reads settings.json, discarding it for any key settings.json also declares:
  ```
  L537  renderProfileInfo(env.CODEMIE_URL)     // banner: shows profile URL
  L557  transformEnvVars(env)                   // sets env.ANTHROPIC_BASE_URL = CODEMIE_BASE_URL
  L561  executeBeforeRun() → beforeRun(env)     // called with already-transformed env
  L???  Claude Code starts                       // reads ~/.claude/settings.json, overrides ANTHROPIC_BASE_URL
  ```
  This is the single most load-bearing fact for this ticket: **`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` are exactly this kind of key.** `claude-code-otlp.ts`'s fixed `CODEMIE_ENV_KEYS` set (line 84-85, confirmed present in settings.json's `env` whenever `--claude-code-otlp` is connected) already declares them there. A spawn-time env injection at the `codemie-claude`/`BaseAgentAdapter` layer would, by this same precedent, be silently discarded by Claude Code's own settings.json read for any session where `claude-code-otlp` is connected — i.e. injecting the env var at the launcher is not simply unimplemented, it is a mechanism this codebase has direct, documented evidence does not work for this exact variable family, for managed launches. It also cannot apply at all to native (unmanaged) launches, since there is no CodeMie-owned spawn step in that path (see above).
- **`ensureOtlpProxy` already prefers the currently-configured port on respawn** (`respawnPort()`, `otlp-cold-start.ts:76-78`), so a port change on respawn is the exception, not the common case — relevant to how often this bug actually bites.
- **The daemon-start failure from `ensureOtlpProxy` is explicitly non-blocking** (`OtlpAgentAdapter.ts:116-122`) — any fix that moves/duplicates this call must preserve that a proxy-readiness failure never stops a hook or (by extension) a launch.

### Task Statements Checked Against the Code

- *"the `codemie-claude` launcher ... start the actual `claude` process today — does it set/inject any env vars into the child process already"* — **holds**: `BaseAgentAdapter.runSession` + `ClaudePluginMetadata.lifecycle.beforeRun` do inject env vars pre-spawn (`CLAUDE_CODE_ENABLE_TELEMETRY`, `DISABLE_AUTOUPDATER`, etc.), confirming the seam exists for the *managed* path.
- *"the endpoint must be resolved/injected into the launched process's environment ... by the `codemie-claude` launcher itself"* — **unverified / likely ineffective as stated**: see "Decisions Already in the Code" above — settings.json's own `env` block (already written by `claude-code-otlp` connect) takes precedence over spawn-time process env for this same variable family, by the codebase's own prior, documented finding for `ANTHROPIC_BASE_URL`. No test or doc in this repo shows the reverse (process env winning over a settings.json-declared key) for any Claude-Code-read variable. Whether this precedence is literally true for `OTEL_EXPORTER_OTLP_ENDPOINT` specifically (as opposed to `ANTHROPIC_BASE_URL`) is not verified against Claude Code's own source/docs in this repo — the implementer should confirm Anthropic's documented settings-vs-env precedence for OTel variables specifically before relying on either lever.
- *"Is there a natural seam where an OTLP endpoint could be resolved and injected into the child env BEFORE spawn"* — **holds for the managed path only** (`beforeRun`/`runSession`, pre-`spawn()`), **contradicted/inapplicable for the native path** (no CodeMie-owned pre-spawn moment exists when the user runs `claude` directly, which `claude-code-otlp`'s own design explicitly supports per `docs/HOOKS.md:572-582` and the `launch_mode: 'native'` evidence field).
- *"Is there an existing 'ensure proxy running, get its live URL' primitive ... that could be called pre-launch"* — **holds**: `ensureOtlpProxy(agentName)` (`otlp-cold-start.ts:131`) is exactly this primitive, already decoupled from the hook transport (it only needs an agent name string) and already shared with `codemie proxy connect`'s `ensureDaemon`.
- *"the rewrite happens during SessionStart, which is AFTER Claude Code's own process has already read its settings"* — **holds**, and is consistent with: (a) the EPMCDME-10988 precedent above showing settings.json is read once at Claude's own startup, and (b) `claude-code-otlp-endpoint.ts`'s own doc comment already warning the rewrite only helps "the next session."

### Consumers of Changed Contracts

- **`ensureOtlpProxy(agentName: string)`** — currently called from exactly one place, `OtlpAgentAdapter.processOtlpEvent` (`OtlpAgentAdapter.ts:118`), itself invoked only from `hook.ts`'s `codemie hook` dispatch. No other adapter or launcher calls it. A fix that calls it from a second place (e.g. a launcher) must keep its existing non-blocking, no-console-output contract (hook stdout is sometimes a JSON-RPC-adjacent channel) and its idempotency (`adoptLiveDaemon()` short-circuits a live daemon) — both already true, so a second caller is structurally safe, but no code anywhere depends on it being called at most once.
- **`refreshClaudeCodeOtlpEndpoint(state)`** — called from `otlp-cold-start.ts`'s `adoptLiveDaemon`/`coldStartOnWorkingDirectoryProfile`/`ensureOtlpProxy` only. Tested extensively via `ensureOtlpProxy`'s own test suite in `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` (lines ~1130-1636: cold start, live-daemon adoption, respawn-port preference, and the literal "re-points the settings at an already-running daemon without spawning" case at line 1554). No test exercises a second call site.
- **`~/.claude/settings.json`'s `env` block** — read by the native `claude` binary at its own startup (outside this codebase's control), and separately read/compared by `checkClaudeCodeOtlpEndpoint`/`detectSettingsConflict`. Any fix that writes this file earlier must stay inside the existing ownership guard (`isCodemieOwnedEnvValue`/`LOCAL_DAEMON_ENDPOINT`), or it risks clobbering a user's own OTel destination — the existing code already guards against this for the hook-time rewrite.

### Architecture and Layers Affected

- **CLI/hook layer**: `src/cli/commands/hook.ts` (dispatch), `src/cli/commands/proxy/otlp-cold-start.ts` (`ensureOtlpProxy`), `src/cli/commands/proxy/connect-orchestrator.ts` (`ensureDaemon`, shared daemon lifecycle), `src/cli/commands/proxy/connectors/claude-code-otlp-endpoint.ts` (settings.json read/compare/write), `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (initial connect, writes the fixed `CODEMIE_ENV_KEYS` incl. the two OTEL vars).
- **Agent/adapter layer**: `src/agents/core/OtlpAgentAdapter.ts` (abstract hook-ingestion base, calls `ensureOtlpProxy`), `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` (concrete adapter), `src/agents/core/BaseAgentAdapter.ts` + `src/agents/plugins/claude/claude.plugin.ts` (the unrelated **managed-launcher** layer — only relevant if the fix is placed there).
- **Proxy daemon layer**: `src/cli/commands/proxy/daemon-manager.ts` (`spawnDaemon`, `checkStatus`, `readState`) — out of scope for the endpoint-rewrite fix itself, already stable.

### Integration Points

- `codemie hook --agent claude-code-otlp` is wired into `~/.claude/settings.json`'s `hooks` block by `connectors/claude-code-otlp.ts` for all 16 Claude Code hook events (`HOOK_EVENTS`), each a synchronous subprocess Claude Code waits on (except `PostCompact`, which is `async: true`).
- `codemie-claude` (managed launch) and plain `claude` (native launch) both ultimately read the same `~/.claude/settings.json`; only the managed path additionally goes through `BaseAgentAdapter`'s spawn/env-injection machinery before the child starts.

### Patterns and Conventions

- `OtlpAgentAdapter` subclasses never call `forwardOtlpEventsToSpool` or write files directly from `evaluate()`; all side effects funnel through the base class's fixed flow (see `docs/ARCHITECTURE-OTLP-PLUGIN.md` §1-3). Any fix inside this layer should keep that shape.
- `BaseAgentAdapter`'s lifecycle hooks (`beforeRun`, `onSessionStart`, etc., `lifecycle-helpers.ts`) are the established pattern for "provider/agent-agnostic pre-spawn env mutation" — matches research Q4's ask for "a shared base adapter class/launcher path across agent plugins," but note this path only exists for *managed* launches, not native ones.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` — authoritative on the `OtlpAgentAdapter` pattern, the `ensureOtlpProxy`/`refreshClaudeCodeOtlpEndpoint` call chain, and (§7.2) the settings-vs-process-env precedence note.
- `docs/HOOKS.md` §"Claude Code OTLP Hook Filter" — confirms `claude-code-otlp` targets `~/.claude/settings.json` directly, independent of launch mode.
- `docs/superpowers/specs/2026-07-15-epmcdme-10988-settings-conflict-detection-design.md` and `docs/superpowers/work-items/EPMCDME-10988.md` — the directly analogous prior investigation (settings.json overriding spawn-time env for `ANTHROPIC_BASE_URL`), including the exact `BaseAgentAdapter.run()` execution-order trace.
- `docs/superpowers/tasks/2026-11-03-epmcdme-16647-otlp-endpoint-recovery/code-review.md` — the code review of the already-merged prior fix (CLI 0.16.5/0.16.6) this ticket is a QA follow-up to; confirms the fix shape (`connectors/claude-code-otlp-endpoint.ts` extraction) and that it passed review/tests on its own terms (hook-time rewrite, not launch-time).

### Architectural Decisions
- Detect-and-warn (not force-override) was the recorded decision for the structurally identical `ANTHROPIC_BASE_URL` conflict (EPMCDME-10988) — the closest precedent in this codebase for "a settings.json value and a spawn-time env value disagree."
- `ensureOtlpProxy`'s daemon-start failure is explicitly non-blocking by design (`OtlpAgentAdapter.ts` comment at line 258-262).

### Derived Conventions
- No guide prescribes where "launch-time vs. runtime endpoint resolution" belongs; this is undocumented ground, consistent with the ticket's framing of this as new territory.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — extensive coverage of `ensureOtlpProxy` (cold start, live-daemon adoption, respawn-port preference, settings rewrite call assertions) in a `describe('ensureOtlpProxy', ...)` block (~line 1133-1636).
- `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts` — covers `checkClaudeCodeOtlpEndpoint`/`refreshClaudeCodeOtlpEndpoint` behavior via the connector's own test suite (ownership guard, foreign-endpoint non-clobber, backup/restore of OTEL env keys).
- `tests/integration/analytics-secret-egress.test.ts` — exercises `OtlpAgentAdapter` with a stubbed `ensureOtlpProxy`.

### Testing Framework and Patterns
Vitest, dynamic-import-after-mock pattern (`vi.resetModules()` + `await import(...)` inside each test), consistent with `.ai-run/guides/testing/testing-patterns.md`.

### Coverage Gaps
- **No test proves (or can easily prove) the actual failure mode**: that Claude Code's *own, external* OTel SDK initialization happens before the SessionStart hook subprocess runs. This is inherently outside unit-test reach (it requires the real `claude` binary); QA's production log evidence is the only proof on record.
- No test exists for any launcher-side env injection for OTLP endpoints, because no such code exists yet.
- No test covers the native (unmanaged) launch path's pre-spawn moment, because there is none to test.

---

## 5. Configuration and Environment

### Environment Variables
- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` — written into `~/.claude/settings.json`'s `env` block by `connect --claude-code-otlp`, kept in sync by `refreshClaudeCodeOtlpEndpoint` at hook time. Never set by `BaseAgentAdapter`/`claude.plugin.ts` today.
- `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_EXPORTER`, `OTEL_LOG_TOOL_DETAILS` — the rest of the fixed `CODEMIE_ENV_KEYS` set (`connectors/claude-code-otlp.ts:84-97` area) connect writes/strips alongside the two endpoint vars. Note `claude.plugin.ts`'s `beforeRun` separately defaults `CLAUDE_CODE_ENABLE_TELEMETRY` to `'0'` in the spawned process env for the *managed* path, unless already set — by the settings.json-wins precedent this is likely overridden by connect's `'1'`-ish value whenever `claude-code-otlp` is connected, but this repo has no test proving that interaction either way.

### Configuration Files
- `~/.claude/settings.json` (`getClaudeSettingsPath()`) — the single file both the native and managed launch paths' Claude Code process reads at its own startup; the only file the endpoint fix can act on.
- `~/.codemie/proxy-connection.json` (`readConnectionRecord`) — records the profile/clientType the daemon should restart with; consulted by `ensureOtlpProxy`'s cold-start path.

### Feature Flags and Deployment Concerns
None beyond the existing `--scope user|project` allowlist switch for `claude-code-otlp`; not relevant to this bug.

---

## 6. Risk Indicators

- The task's own suggested fix direction (inject the OTLP endpoint into the `codemie-claude` launcher's spawn env) runs into a directly-precedented obstacle already recorded in this codebase for `ANTHROPIC_BASE_URL`: Claude Code's own settings.json `env` block wins over spawn-time process env, and `claude-code-otlp` already declares `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` in that same file whenever it is connected — see "Decisions Already in the Code." An implementer should confirm Anthropic's own precedence rule for OTel variables specifically before betting the fix on env injection.
- The suggested fix direction is also structurally inapplicable to **native** (unmanaged `claude`) launches, which `claude-code-otlp` explicitly supports (`launch_mode: 'native'`) — there is no CodeMie-owned pre-spawn moment to inject into in that case, so a launcher-only fix would, at best, cover a subset of affected sessions.
- No test harness in this repo can directly reproduce or verify the actual bug (Claude Code's own OTel SDK init timing vs. its hook subprocess timing) — any fix's effectiveness is ultimately only confirmable against the real binary / production evidence, as QA already demonstrated.
- `ensureOtlpProxy` is currently a single-call-site primitive; adding a second caller (e.g., pre-launch) is structurally safe (idempotent, non-blocking) but untested in that shape.
- Other OTLP adapters (`copilot-chat-otlp`, `copilot-cli-otlp`) are hooks-only by explicit design comment ("no OTel settings") and do not share this problem; no generic cross-adapter mechanism exists yet, so "shared base class" work would be new, not a refactor of something already duplicated.

---

## 7. Summary for Complexity Assessment

This is a narrowly-scoped proxy/analytics bug confined to two small, already-tested modules (`src/cli/commands/proxy/otlp-cold-start.ts` and `src/cli/commands/proxy/connectors/claude-code-otlp-endpoint.ts`) plus their single caller, `OtlpAgentAdapter.processOtlpEvent`. The prior merged fix (CLI 0.16.5/0.16.6) already built the full ensure-daemon/refresh-endpoint machinery; this ticket is about *when* that machinery runs relative to Claude Code's own process startup, not about building new daemon or settings-file plumbing.

The main complexity driver is not code volume but a structural fact the research surfaced: the task's suggested fix (inject the endpoint into the `codemie-claude` launcher's spawn env) is directly contradicted by this codebase's own prior finding (EPMCDME-10988) that Claude Code's settings.json `env` block overrides spawn-time process env for exactly this kind of variable, and the same connector already declares `OTEL_EXPORTER_OTLP_ENDPOINT` there. It is also inapplicable to native (unmanaged) `claude` launches, which this feature explicitly supports and which have no CodeMie-owned pre-spawn moment at all. Any viable fix therefore likely has to act on `~/.claude/settings.json` itself, earlier than today's SessionStart-hook rewrite — a design decision outside this document's scope, but one the implementer should make with the above precedent in hand rather than following the launcher-env-injection premise as given.

Test coverage for the existing machinery (`ensureOtlpProxy`, `refreshClaudeCodeOtlpEndpoint`) is thorough at the unit level, but the actual failure mode (Claude Code's own OTel SDK init timing) is unverifiable by any test in this repo — confirmation will again rest on manual/production verification, as it did for QA's failing report.

---

## 8. External References

None named by the task. The task references two prior CodeMie work items by ticket/description rather than by filesystem/URL path; both were located and read as part of this research: the already-merged prior fix's review record at `docs/superpowers/tasks/2026-11-03-epmcdme-16647-otlp-endpoint-recovery/code-review.md`, and the directly analogous precedent at `docs/superpowers/specs/2026-07-15-epmcdme-10988-settings-conflict-detection-design.md` / `docs/superpowers/work-items/EPMCDME-10988.md`.

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- `ClaudeAcpPluginMetadata` is defined at `src/agents/plugins/claude/claude-acp.plugin.ts:16-57`, as
- `ClaudeAcpPlugin` (`claude-acp.plugin.ts:65-100`) extends `ClaudePlugin` (`claude.plugin.ts`), and
- Yes, by direct reference. `ClaudePluginMetadata.lifecycle` (`claude.plugin.ts:238-...`, containing
- `cliCommand: 'claude-agent-acp'` (`claude-acp.plugin.ts:27`) is consumed by the generic
