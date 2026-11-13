# Technical Research

**Task**: otlp proxy auto-start ensureOtlpProxy ensureDaemon claude-code-otlp hook baseUrl
**Generated**: 2026-10-22
**Research path**: filesystem (codegraph MCP tool not available in this environment)

---

## 1. Original Context

[CLI Analytics][auto-start] Missing baseUrl triggers proxy startup instead of silently skipping cold start.

Problem: When no daemon state exists and the active profile has no usable baseUrl, the auto-start logic should skip cold start and return silently. Instead, the hook attempts to start the proxy daemon. The startup then fails, and the hook exits with code 1.

Root cause (per Jira ticket EPMCDME-15372): ensureOtlpProxy() loads the active profile and builds the daemon config with targetUrl: config.baseUrl, then proceeds to ensureDaemon(). The guard 'if (!config.baseUrl) return;' that existed previously is missing, so an empty or missing baseUrl reaches the daemon startup path.

Acceptance Criteria:
1. Missing or empty baseUrl is detected before daemon startup.
2. No daemon process is spawned.
3. No daemon state file is created.
4. Hook returns code 0.
5. No user-facing startup failure is produced.
6. A profile with a valid baseUrl continues to cold-start normally.

Linked ticket EPMCDME-15369 covers the related issue that proxy startup failure propagates to the claude-code-otlp hook and returns non-zero exit code — out of scope for this task, but relevant context for how the hook currently handles ensureOtlpProxy() failures.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/connect-orchestrator.ts:399-433` — `ensureOtlpProxy(agentName)`. Reads existing daemon state via `readState()`, and if no live daemon is found, calls `ConfigLoader.load(...)` to resolve the active profile `config`, builds a `daemonConfig` object (including `targetUrl: config.baseUrl` at HEAD), then unconditionally calls `ensureDaemon(daemonConfig, daemonIdentity, config)`. **No `if (!config.baseUrl)` guard exists anywhere in this function.** This is the exact bug described in the ticket.
- `src/cli/commands/proxy/connect-orchestrator.ts:336-397` — `ensureDaemon(requested, identity, config, force?, verbose?)`. Calls `checkStatus()`; when `!running || !state`, logs `Starting proxy...` and calls `spawnDaemon({...})`, which spawns the actual daemon process and writes the daemon state file. This is the path that must never be reached when `baseUrl` is missing.
- `src/cli/commands/proxy/connect-orchestrator.ts:686-775` — `connectTargets(opts)`, the manual `codemie proxy connect` CLI command (sibling flow). At line 726 it already has the correct, analogous guard:
  ```ts
  if (!config.baseUrl) {
    throw new ConfigurationError('No API URL configured. Run: codemie setup');
  }
  ```
  placed before `ensureDaemon` is called (line 763). This is the pattern that is missing from `ensureOtlpProxy`, though the manual flow intentionally throws (interactive command) whereas the hook flow must return silently (non-interactive, background side effect).
- `src/utils/config.ts:1123` — a second, independent `if (!config.baseUrl)` guard elsewhere in the codebase, confirming "load config → validate required field → proceed" is an established convention in this area of the code.
- `src/agents/core/OtlpAgentAdapter.ts:78-120` — `processOtlpEvent(rawHookInput, deps)`. Gated by an `isTracked` allowlist check (lines 98-101), then calls `await ensureOtlpProxy(this.name)` at line 103. No try/catch around this call — any thrown error propagates upward uncaught.
- `src/agents/core/types.ts:735` — `OtlpAdapterDeps.ensureOtlpProxy: (agentName: string) => Promise<void>` — type signature for the injected dependency.
- `src/cli/commands/hook.ts:8` — imports `{ ensureOtlpProxy }` from `./proxy/connect-orchestrator.js`.
- `src/cli/commands/hook.ts:1539-1544` — `hook` command's `action()` resolves `analyticsAgent = AgentRegistry.getAnalyticsAgent(opts.agent!)` and calls `analyticsAgent.processOtlpEvent(input, { ensureOtlpProxy, forwardOtlpEventsToSpool })`. This sits inside a `try` block starting ~line 1521, whose `catch` is at line 1597 — an uncaught throw from `ensureOtlpProxy` lands there and (per out-of-scope ticket EPMCDME-15369) currently produces a non-zero exit code.
- `src/cli/commands/proxy/daemon-manager.ts` — `readState`, `checkStatus`, `spawnDaemon`, `stopDaemon`, `isProcessAlive`, `DaemonState` type. `readState()` + `isProcessAlive(state.pid)` is the existing early-exit mechanism `ensureOtlpProxy` already uses before reaching the (currently unguarded) config/daemon-start path.

### Root Cause Confirmation

Exact current code building the daemon config (`connect-orchestrator.ts`, HEAD/committed version, lines ~415-425):

```ts
const daemonConfig = {
  clientType: agentName,
  port: DEFAULT_DAEMON_PORT,
  profile: config.name ?? 'default',
  project: config.codeMieProject,
  provider: config.provider ?? 'ai-run-sso',
  syncApiUrl: config.ssoConfig?.apiUrl,
  syncCodeMieUrl: config.codeMieUrl,
  targetUrl: config.baseUrl,
  model: normalizeDaemonModel(config.model)
}
```

followed unconditionally by `await ensureDaemon(daemonConfig, daemonIdentity, config);` at line 432. There is no guard between config load (line 410) and this call. This matches the Jira root-cause description exactly.

**Important caveat**: the current working tree (uncommitted, per `git status`) has a `// TEMP LOCAL-DEV OVERRIDE — do not commit` comment hardcoding `targetUrl` to `'http://localhost:8080'` in both `ensureDaemon`'s `spawnDaemon()` call and `ensureOtlpProxy`'s `daemonConfig`. This is unrelated local dev scaffolding and must not be confused with the real bug or carried into the fix. The condition to guard on is `config.baseUrl`, not the literal `targetUrl` field — in HEAD, `targetUrl` is directly `config.baseUrl`. Two other files flagged as modified in git status (`src/providers/plugins/sso/proxy/sso.proxy.ts`, `src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-config.ts`) also carry similar "do not commit" local-dev overrides (a hardcoded sync URL and a shortened spool-send interval, respectively) that are pre-existing, unrelated to this task, and should be left untouched by this fix.

### Architecture and Layers Affected

- **CLI hook entrypoint layer** — `src/cli/commands/hook.ts` (`hook` command action, dispatches to agent adapters)
- **Agent adapter layer** — `src/agents/core/OtlpAgentAdapter.ts` (`processOtlpEvent`: allowlist gate → `ensureOtlpProxy` → `evaluate` → spool forward)
- **Proxy orchestration layer** — `src/cli/commands/proxy/connect-orchestrator.ts` (`ensureOtlpProxy`, `ensureDaemon`, `connectTargets` — this is where the fix belongs)
- **Daemon lifecycle layer** — `src/cli/commands/proxy/daemon-manager.ts` (`readState`, `spawnDaemon`, `stopDaemon`, `checkStatus`, `DaemonState`)
- **Config/profile layer** — `src/utils/config.ts` (`ConfigLoader.load`, `ConfigLoader.getActiveProfileName`, profile/baseUrl resolution, env override handling)
- **Provider/SSO proxy runtime layer** — `src/providers/plugins/sso/proxy/sso.proxy.ts`, `.../otlp-spool/spool-config.ts` — the actual spawned proxy process; not touched by this fix, but currently carries unrelated local-dev-only diffs that should not be conflated with this change.

Only one layer requires a code change: **Proxy orchestration layer**, specifically `ensureOtlpProxy` in `connect-orchestrator.ts`. This is a small, single-function, single-file fix.

### Integration Points

**Call chain** (hook → `ensureOtlpProxy` → `ensureDaemon`):
1. `src/cli/commands/hook.ts:1501` — `hook` command `.action(async (opts) => {...})` entrypoint.
2. `src/cli/commands/hook.ts:1539-1541` — resolves `analyticsAgent` and calls `analyticsAgent.processOtlpEvent(input, { ensureOtlpProxy, forwardOtlpEventsToSpool })`.
3. `src/agents/core/OtlpAgentAdapter.ts:82-103` — `processOtlpEvent` parses input, checks `isTracked`, then at line 103 calls `await ensureOtlpProxy(this.name)`.
4. `src/cli/commands/proxy/connect-orchestrator.ts:399-432` — `ensureOtlpProxy`: `readState()` → (if no live daemon) `ConfigLoader.load(...)` → builds `daemonConfig` with `targetUrl: config.baseUrl` → **[missing guard point]** → `await ensureDaemon(daemonConfig, daemonIdentity, config)`.
5. `src/cli/commands/proxy/connect-orchestrator.ts:336-394` — `ensureDaemon`: `checkStatus()` → since no state exists, `!running || !state` is true → logs `Starting proxy...` → `spawnDaemon({...})` — the unwanted daemon-startup path when `baseUrl` is missing.
6. Back in `src/cli/commands/hook.ts:1597` — if `spawnDaemon`/startup throws, it's caught by the outer `catch`, logs, and (per out-of-scope ticket EPMCDME-15369) leads to non-zero exit — the user-visible symptom in the bug report.

**Config resolution**: `ConfigLoader.getActiveProfileName(cwd)` (`src/utils/config.ts:891`) reads local `.codemie/codemie-cli.config.json` if present, else falls back to the global `~/.codemie/codemie-cli.config.json`, returning `config.activeProfile`. `ConfigLoader.load(cwd, { name: activeProfileName })` then merges profile fields (incl. `baseUrl`) with workspace config and env overrides (`CODEMIE_BASE_URL`, `CODEMIE_SYNC_API_URL`, `CODEMIE_TARGET_API_URL`) into the returned `config` object.

**Type**: `ProviderProfile.baseUrl?: string` (`src/env/types.ts:54`) — optional, no required/validation decorator; same optional shape in `LegacyConfig.baseUrl` (`src/env/types.ts:151`). Nothing upstream guarantees `baseUrl` is populated — this is exactly why a guard is needed at the point of use.

**Daemon state file**: `~/.codemie/proxy-daemon.json` (`DEFAULT_STATE_FILE`, `daemon-manager.ts:33`, via `getCodemieHome()`), written atomically (`.tmp` + rename). Must not be created when `baseUrl` is missing (AC3).

### Patterns and Conventions

- **"Load config → validate required field → proceed" pattern**: validation done inline immediately after `ConfigLoader.load(...)`, matching `connectTargets` (line 726) and the independent occurrence at `src/utils/config.ts:1123`.
- **Fail-loud vs fail-silent convention** (documented in `.ai-run/guides/integration/external-integrations.md`, "Configuration Validation" table): missing required config → throw `ConfigurationError`; connectivity/runtime failure once config is present → `logger.warn` only, don't block. The manual `connectTargets` path follows "throw" (interactive CLI command). The hook-driven `ensureOtlpProxy` path must follow "return silently" per this task's acceptance criteria, since it runs as a side effect inside every tracked-project hook invocation, not as a user-facing command — throwing would break every hook call for a user with no profile configured.
- **Early-exit style already present**: `ensureOtlpProxy` already short-circuits via `readState()` + `isProcessAlive(state.pid)` before doing any work. The missing `baseUrl` guard should be added in that same early-return style, placed right after `config` is loaded and before `daemonConfig`/`ensureDaemon` are reached — i.e. `if (!config.baseUrl) return;` immediately after the `ConfigLoader.load(...)` call (~line 413-414).
- `ConfigurationError` is the canonical error class for "required configuration missing" in this codebase (both guides and the sibling manual-connect code path use it) — but per the acceptance criteria and the fail-silent/fail-loud distinction above, this particular guard should **return**, not throw.
- Local-dev-only scratch edits in this codebase are marked with `// TEMP LOCAL-DEV OVERRIDE — do not commit` comments — these are pre-existing uncommitted changes unrelated to this bug and must not be touched or conflated with the fix.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — plugin-based 5-layer architecture (CLI → Registry → Plugin → Core → Utils); notes `OtlpAgentAdapter` as a non-chat plugin type, pointing to `docs/ARCHITECTURE-OTLP-PLUGIN.md`.
- `.ai-run/guides/integration/external-integrations.md` — documents OTLP hook ingestion (`codemie hook --agent <adapter-name>`) and contains the Configuration Validation convention table referenced above (missing required config → throw; connectivity failure → warn-and-continue).
- `.ai-run/guides/development/development-practices.md` — establishes `ConfigurationError` as the canonical class for missing-required-config situations; no proxy/OTLP-specific content.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` — full `OtlpAgentAdapter` dispatch pattern (`parseHookInput` → `isTracked` → `ensureOtlpProxy` → `evaluate` → forward/block). §3.5 states proxy readiness is explicitly "the adapter's own responsibility" — i.e. the base class intentionally defers baseUrl/readiness validation to `ensureOtlpProxy()`'s own implementation, which is exactly the gap being fixed here.
- `docs/ARCHITECTURE-PROXY.md` — §9.1/§3.1 describe `targetApiUrl`/`targetUrl` as a required `ProxyConfig` parameter with no documented fallback, consistent with the assumption that the caller (not the daemon) validates the target URL before starting.

### Architectural Decisions

No formal ADR/DECISION-tagged entries exist for this specific bug. The closest recorded precedent is the already-correct guard in `connectTargets` (connect-orchestrator.ts:726-728) using `ConfigurationError`. There is a legitimate tension worth flagging for the implementer: the documented "missing config → throw" convention is designed for interactive commands, but `ensureOtlpProxy` runs inside every hook invocation as a background side effect — throwing would regress every hook call for unconfigured profiles, which is exactly the opposite of what this task's acceptance criteria require (silent skip, exit code 0). The task's own framing ("silently skipping cold start") confirms the intended behavior is a silent `return`, not a throw.

EPMCDME-15369 (explicitly out of scope) separately tracks how `ensureOtlpProxy()` failures should affect the hook's own exit code — not to be addressed here.

### Derived Conventions

- Guard-before-use for required config fields, placed immediately after config load.
- Silent return for non-interactive/background paths vs. throw-with-user-message for interactive CLI commands.
- Local-dev scratch changes are explicitly comment-marked and must be left alone.

No `.ai-run/guides/` content specifically covers this exact function; conventions above are derived from the sibling `connectTargets` guard and the external-integrations.md validation table.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — tests `deriveDaemonIdentity`, `daemonMatchesRequest`, and `connectTargets` (including its baseUrl-missing-throw path indirectly via fixtures). **Does not import or exercise `ensureOtlpProxy` at all.**
- `src/cli/commands/proxy/__tests__/daemon-manager.test.ts` — `readState`/`writeState` round-trip against a temp state file, with `spawnDetached` stubbed.
- `src/cli/commands/proxy/__tests__/daemon-status-contract.test.ts` — state file round-trip, `checkStatus`, `isProcessAlive`, `daemonMatchesRequest` matrix. No daemon-spawn-with-missing-baseUrl case.
- `src/cli/commands/__tests__/hook.analytics-wiring.test.ts` — mocks `ensureOtlpProxy` wholesale via `vi.mock('../proxy/connect-orchestrator.js', () => ({ ensureOtlpProxy: vi.fn() }))`; the real implementation is never executed here.
- `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` — passes `ensureOtlpProxy = vi.fn(async () => {})` as an injected dependency; asserts only call-order, never the real implementation.
- No test file exists for `spool-config.ts` or `sso.proxy.ts` directly (not relevant to this fix).

### Testing Framework and Patterns

- Vitest `^4.1.5`, multi-project config (`--project unit/cli/agent`).
- Module mocking via `vi.mock(path, factory)` for `ConfigLoader`, `daemon-manager.js` (`checkStatus`/`readState`/`spawnDaemon`/`stopDaemon`), etc.
- Fixture factories: `setupHappyMocks(overrides)` builds a canned `ConfigLoader.load` result (`{ name, provider, baseUrl, codeMieUrl, codeMieProject, ...overrides }`) — this is the natural seam to add a "config with blank/undefined baseUrl" case.
- `spyConsole()` wraps console spies and makes `process.exit` throw (`process.exit:${code}`), with `process.exitCode` asserted directly in tests — reusable for asserting exit code 0 behavior.
- No test currently calls the real, un-mocked `spawnDaemon` → `spawnDetached` path end-to-end; it's always stubbed at a module boundary.

### Coverage Gaps

- **Core gap matching the bug**: no test exercises the real `ensureOtlpProxy` function body at all — every test referencing it stubs it out entirely with `vi.fn()`.
- No test asserts behavior when `baseUrl` is missing/empty specifically for `ensureOtlpProxy` (the `connectTargets` sibling does have an equivalent throw-path test).
- No test asserts `spawnDaemon`/`ensureDaemon` is **not** called when `baseUrl` is missing.
- No test drives the hook (`hook.ts`) with a real (unmocked) `ensureOtlpProxy` to confirm exit code 0 and no daemon spawn when `baseUrl` is absent.
- No test asserts daemon state file creation is skipped when `baseUrl` is missing.

The natural location for new coverage is `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`, importing the real `ensureOtlpProxy` (not mocked), mocking `ConfigLoader.load`/`getActiveProfileName` to return profiles with `baseUrl: undefined` and `baseUrl: ''`, mocking `daemon-manager.js` collaborators, and asserting `spawnDaemon` is never called, no state file is written, and the function resolves without throwing — reusing the existing `setupHappyMocks`/`daemonState` fixture style.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides CodeMie home dir (`~/.codemie`); used for all state/config paths.
- `CODEMIE_BASE_URL` — env override for the active profile's `baseUrl` (`src/cli/first-time.ts:31`, multiple `hook.ts` call sites via `getConfigValue('CODEMIE_BASE_URL', config)`).
- `CODEMIE_SYNC_API_URL` / `CODEMIE_TARGET_API_URL` — take precedence over `CODEMIE_BASE_URL` in specific `hook.ts` call sites.
- `CODEMIE_DEBUG` / `MCP_PROXY_DEBUG` — verbose logging; unrelated to baseUrl validation.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (or `<cwd>/.codemie/codemie-cli.config.json` as a local override) — `MultiProviderConfig` (`activeProfile`, `profiles`, `workspace`), loaded by `ConfigLoader`.
- `~/.codemie/proxy-daemon.json` (`DEFAULT_STATE_FILE`) — daemon state file; must not be written when `baseUrl` is missing (AC3).
- `getCodemiePath(...)` (`src/utils/paths.ts:385`) is the general path-join helper used for all proxy state files.

### Feature Flags and Deployment Concerns

- No feature flags gate OTLP proxy auto-start/cold-start/skip behavior. The only pre-existing gate is the analytics project allowlist (`isTracked`), which runs before `ensureOtlpProxy` and is unrelated to `baseUrl`.
- No CI/build/husky hooks execute this path; it only runs at runtime when the `claude-code-otlp` Claude Code hook fires on a tracked project.
- Real-world deployment risk being fixed: any user/profile without `baseUrl` set (fresh install, incomplete `codemie setup`) currently triggers a proxy spawn attempt on every tracked-project hook invocation instead of a silent no-op.
- Reminder: the three git-status-modified files (`connect-orchestrator.ts`, `sso.proxy.ts`, `spool-config.ts`) all currently carry unrelated "do not commit" local-dev overrides that must be excluded from the eventual fix commit.

---

## 6. Risk Indicators

- No existing test exercises the real `ensureOtlpProxy` implementation at all — every current reference to it is fully mocked (`hook.analytics-wiring.test.ts`, `OtlpAgentAdapter.test.ts`). This is the central coverage gap the fix should close.
- The working tree currently contains unrelated "TEMP LOCAL-DEV OVERRIDE — do not commit" scratch edits in all three git-status-modified files (`connect-orchestrator.ts`, `sso.proxy.ts`, `spool-config.ts`). Care must be taken to isolate the real fix's diff from these pre-existing local changes when committing.
- Behavioral tension between the documented "missing config → throw `ConfigurationError`" convention and this task's "return silently" requirement — the fix intentionally departs from the sibling `connectTargets` pattern; this should be called out explicitly in the implementation (e.g. a one-line comment) so it isn't "corrected" back to a throw by a future reviewer unfamiliar with the acceptance criteria.
- Linked ticket EPMCDME-15369 (hook exit-code propagation on `ensureOtlpProxy` failure) is explicitly out of scope — do not conflate fixing the guard with fixing exit-code handling for other failure modes.
- `ensureOtlpProxy`'s config resolution via `ConfigLoader.load`/`getActiveProfileName` depends on `cwd`-based profile detection; `docs/ARCHITECTURE-OTLP-PLUGIN.md` separately flags (as a known, distinct limitation) that `ensureOtlpProxy` keys off the hook's own unwalked `cwd` for allowlist/profile gating — not part of this fix, but adjacent context worth being aware of.
- The fix surface is very small (likely a single added line/guard in one function in one file, plus one new test block) — low implementation risk once isolated from the unrelated local-dev diffs.

---

## 7. Summary for Complexity Assessment

This task touches exactly one architectural layer — the proxy orchestration layer (`src/cli/commands/proxy/connect-orchestrator.ts`) — and the fix is a single missing guard clause inside `ensureOtlpProxy()` (lines ~399-433), to be inserted immediately after `config` is loaded and before `daemonConfig`/`ensureDaemon` are reached: `if (!config.baseUrl) return;`. The analogous, already-correct pattern exists two hundred lines away in the sibling `connectTargets` function, so this is a well-precedented fix, not a novel pattern — the only design nuance is that the hook path must return silently rather than throw `ConfigurationError` (as the sibling does), because `ensureOtlpProxy` runs as a background side effect inside every tracked-project hook invocation rather than as a user-facing CLI command. Expected file change surface is 1 source file (one small edit) plus 1 test file (new test cases added to the existing `connect-orchestrator.test.ts` suite, reusing its established `setupHappyMocks`/mock-module conventions).

Test coverage posture for this exact code path is a clean gap rather than mixed: every existing test that references `ensureOtlpProxy` replaces it entirely with `vi.fn()`, so no test currently exercises its real body or would catch the regression described in this ticket. New tests should assert: `spawnDaemon` is not called, no daemon state file is written, the function resolves without throwing, and (via a hook-level test if desired) exit code 0 is preserved — mirroring patterns already established in `daemon-manager.test.ts` and `daemon-status-contract.test.ts` for state-file assertions.

Key risk factors for complexity scoring: the fix itself is low-risk and low-surface-area, but the working tree currently contains unrelated "do not commit" local-dev scratch edits in the exact files this fix touches (`connect-orchestrator.ts`) and in two adjacent files (`sso.proxy.ts`, `spool-config.ts`), which must be carefully excluded from the fix's diff to avoid accidentally shipping debug-only code. There is also a legitimate behavioral-convention tension (silent-return vs. documented throw-on-missing-config convention) that should be explicitly justified in the implementation rather than silently deviated from. Overall this should score as low-to-medium complexity: small, well-precedented, single-layer change with a clear test gap to close, offset slightly by the surrounding noise from unrelated uncommitted changes in the same files.
