# Technical Research

**Task**: proxy connect vscode desktop cli commander flags daemon
**Generated**: 2026-08-12
**Research path**: codegraph

---

## 1. Original Context

Implement the approved story at docs/stories/2026-08-12-unified-proxy-connect.md — unify `codemie proxy connect` into a single command with orthogonal target flags (--claude-desktop, --vscode, --vscode-claude-code), keep `connect desktop`/`connect vscode` as deprecated aliases with highlighted deprecation notices, and make bare `connect` print a user-friendly target list. Work on the current branch feature/vscode-claude-noauth-desktop-connect.

The full approved story is at docs/stories/2026-08-12-unified-proxy-connect.md (read it for the acceptance criteria). Key facts already known: the proxy command tree is in src/cli/commands/proxy/index.ts (connect group @336, connect desktop @340, connect vscode @553, --vscode-claude-code flag @345). Three config writers exist: writeDesktopConfig (connectors/desktop.ts), writeVsCodeLanguageModelsConfig (connectors/vscode.ts), writeVsCodeClaudeCodeConfig (connectors/vscode-claude-code.ts). The desktop and vscode subcommands share daemon/health helpers (daemon-manager.ts, health-check.ts) but have separate action bodies differing in telemetryMode/clientType.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/index.ts` — the proxy Commander tree. `createProxyCommand()` builds `proxy` and its subcommands. The `connect` group is created at `index.ts:336`; `connect desktop` action body spans `index.ts:339-550`; `connect vscode` action body spans `index.ts:552-706`. `connect` is attached via `proxy.addCommand(connect)` at `index.ts:724`. Both actions are self-contained `.action(async (opts) => { ... })` closures.
- Local option interfaces at the top of the file: `DesktopConnectOptions` (`index.ts:37` — `profile`, `verbose`, `force`, `vscodeClaudeCode`, `insiders`) and `VsCodeConnectOptions` (`index.ts:45` — `profile`, `insiders`, `verbose`, `force`).
- `--vscode-claude-code` is currently a sub-flag of `connect desktop` (`index.ts:345`). Its body (`index.ts:504-533`) runs only after the Desktop config is written and reuses the Desktop daemon's `state.url`/`state.gatewayKey`; it cannot run without also writing the Desktop config.
- Three independent config writers (content is Out of Scope to change per story):
  - `writeDesktopConfig()` — `connectors/desktop.ts`; writes Claude Desktop `claude_desktop_config.json` under `getDesktopBaseDir()`, reconciles managed MCP servers via `reconcileManagedMcpServers()` + `mapCanonicalToDesktop()`, fetches models via `fetchClaudeModels()`.
  - `writeVsCodeLanguageModelsConfig(proxyUrl, insiders)` — `connectors/vscode.ts`; writes Copilot BYOK `User/chatLanguageModels.json`; returns `{ configPath, requiresSecretConfiguration }`.
  - `writeVsCodeClaudeCodeConfig(gatewayUrl, gatewayKey, insiders)` — `connectors/vscode-claude-code.ts`; writes the Claude Code extension `User/settings.json` (`claudeCode.disableLoginPrompt`, managed `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` env vars); returns `{ written, path }`.
- Shared daemon lifecycle — `src/cli/commands/proxy/daemon-manager.ts`: `spawnDaemon(SpawnOptions)`, `stopDaemon()`, `checkStatus()`, `readState()`, `writeState()`, `clearState()`, `isProcessAlive()`, and the `DaemonState` interface. `SpawnOptions` carries both `telemetryMode?: 'none' | 'claude-desktop'` and `clientType?: string`.
- Shared health — `src/cli/commands/proxy/health-check.ts`: `checkProxyHealth({ port, gatewayKey, deep })` returns `ProxyHealthResult` (`healthy`, `level`, `code`, `reason`); never throws.
- Matching helpers already extracted in `index.ts`: `getEffectiveClientType(state)` (`index.ts:74`) and `daemonMatchesRequest(state, requested)` (`index.ts:80`) plus `RequestedDaemonConfig` (`index.ts:52`).

### Architecture and Layers Affected

- **CLI layer** (`src/cli/commands/proxy/`) — primary. The Commander command tree, option definitions, action orchestration, and user-facing console/`chalk` output all live here. Per the architecture guide the CLI layer parses args and routes; business logic lives below it.
- **Connectors sub-layer** (`src/cli/commands/proxy/connectors/`) — the three config writers plus `vscode-models.ts` (model catalog). The writers are invoked by the CLI actions; their content is out of scope.
- **Daemon-lifecycle helpers** (`daemon-manager.ts`, `health-check.ts`, `inspect-desktop.ts`) — shared scaffolding both actions call; the `DaemonState` shape and `telemetryMode`/`clientType` fields live here.
- **Provider/proxy layer** (indirect) — actions call `resolveSsoProxyConfig()`, `verifySsoCredentials()`, and `ProviderRegistry.getProvider()` (asserting `authType === 'sso'`), then `spawnDaemon()` which launches `bin/proxy-daemon.js`.
- **Telemetry layer** (indirect) — `DaemonState.telemetryMode`/`clientType` drive `DesktopTelemetryRuntime` and `ClaudeDesktopTelemetryAdapter` (`clientType = 'claude-desktop'`) and the `vscode-byok` client-type attribution consumed by metrics.

### Integration Points

- `connect desktop` → `checkStatus` → `checkProxyHealth` → `stopDaemon`/`spawnDaemon({ telemetryMode: 'claude-desktop' })` → `fetchManagedMcpServers` + `mapCanonicalToDesktop` → `writeDesktopConfig` → (optional) `writeVsCodeClaudeCodeConfig`.
- `connect vscode` → `resolveSsoProxyConfig` → `verifySsoCredentials` → `checkStatus` → `matchesRequestedDaemon` (inline) → `checkProxyHealth` → `stopDaemon`/`spawnDaemon({ clientType: 'vscode-byok' })` → `writeVsCodeLanguageModelsConfig` → `displaySetupInstructions` on `requiresSecretConfiguration`.
- Both actions call `syncRegisteredSkills` + `syncPluginSkills` (fire-and-forget `Promise.allSettled`) and funnel failures through `printProxyError(error, ...)`.
- `spawnDaemon` locates `bin/proxy-daemon.js` relative to the compiled file and passes `--telemetry-mode` / `--client-type` / `--sync-api-url` / `--sync-codemie-url` flags.

### Patterns and Conventions

- Commander construction: `new Command('connect')` → `.command('<name>')` → chained `.option(...)` → `.action(async (opts: T) => {...})` → `proxy.addCommand(connect)`. Bare-group behavior is set on the `connect` Command itself.
- Startup rollback: a `let startedInThisRun = false` flag flips true after `spawnDaemon`; the `catch` calls `stopDaemon()` only when the daemon was started this run.
- Health gate before reuse: `checkStatus()` → decide `wrongMode`/`matchesRequestedDaemon` → `checkProxyHealth({ deep: true })` → restart on `wrongMode || unhealthy || force`.
- Atomic writes everywhere: tmp-file + `rename` (`writeState`, `writeManagedMcpState`, `writeAtomically` in `vscode.ts`), and idempotent merge writers that preserve unrelated keys/entries.
- Output conventions: `chalk.green('✓ ...')` for success, `chalk.yellow(...)` for follow-up actions, `verbose`-gated detail lines, `ConfigurationError`/`ToolExecutionError` from `src/utils/errors.ts`, `logger.info(..., ...sanitizeLogArgs({...}))` for secret-bearing logs.
- Edition selection: `getVsCodeProductDir(insiders)` maps `--insiders` → `Code - Insiders` vs `Code`; both VS Code writers throw a `ConfigurationError` if the product user-data dir is absent.
- Daemon-match helpers `getEffectiveClientType` / `daemonMatchesRequest` / `RequestedDaemonConfig` already exist but are currently only partially used (the vscode body inlines its own match check rather than calling `daemonMatchesRequest`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — plugin-based 5-layer model (`CLI → Registry → Plugin → Core → Utils`). CLI layer handles argument parsing/prompts/routing and must not embed business logic; kebab-case module names; unit tests co-located in `__tests__/`, integration tests in `tests/`.
- `.ai-run/guides/integration/exposed-api.md` — documents `CodeMieProxy` (`ProxyConfig` with `clientType`, `provider`, `sessionId`), `CodeMieSSO`, and `ConfigLoader` priority chain (CLI args → env → project config → global config → defaults). Confirms `clientType` examples like `'vscode-codemie'`.
- `docs/ARCHITECTURE-PROXY.md` — referenced by AGENTS.md for proxy-plugin internals (not required for the CLI-surface change; noted as available).
- The named story `docs/stories/2026-08-12-unified-proxy-connect.md` was read in full: it carries the 10 acceptance criteria, the Out-of-Scope list (no writer-content changes, no disconnect, no `--all`, no interactive picker, no new target types), and three Open Questions (multi-target telemetry attribution; `--insiders` with only `--claude-desktop`; help-text wording).
- Prior planning artifacts referenced by the story sit under `docs/superpowers/tasks/2026-08-11-vscode-claude-noauth-desktop-connect/`; the story explicitly supersedes that spec's "don't touch `connect vscode`" non-goal.

### Architectural Decisions

- The `--vscode-claude-code` flag is unreleased on this branch, so the story records an explicit decision that moving it to a standalone target carries **no backward-compatibility cost**.
- `daemon-manager.ts` records the decision (inline) to escalate `SIGTERM`→`SIGKILL` and always `clearState()` so a wedged daemon can never block the next connect — relevant because a unified single-daemon lifecycle must preserve this.
- The `--all` convenience flag is explicitly declined in the story (explicit target flags only).

### Derived Conventions

- Multiple targets are expected to compose over **one** daemon-lifecycle setup (story AC4), but the current code starts a daemon per action body; there is no existing "orchestrate N writers over one daemon" helper to reuse — the closest reusable primitives are `checkStatus`/`checkProxyHealth`/`spawnDaemon`/`stopDaemon` and the `startedInThisRun` rollback idiom.
- Per-target success/failure summary and non-zero exit (AC7/AC4) have no existing analogue: today both actions swallow errors through `printProxyError` and never set `process.exitCode`.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts` — covers the BYOK writer (`writeVsCodeLanguageModelsConfig` / `VsCodeApiType`).
- `src/cli/commands/proxy/__tests__/daemon-manager.test.ts` — covers `DaemonState` / daemon-manager state handling.
- `src/cli/commands/proxy/__tests__/watcher.test.ts` — covers `ProxyHealthResult` / the in-daemon watcher.
- `tests/integration/vscode-models.live.test.ts` and `tests/integration/vscode-byok.test.ts` — integration/live certification of the VS Code model catalog. The live test hard-codes the string `codemie proxy connect vscode` and asserts the running proxy's `clientType === 'vscode-byok'`.

### Testing Framework and Patterns

- Vitest (per AGENTS.md / `.ai-run/guides/testing/testing-patterns.md`). Unit tests co-located in `__tests__/`; integration tests under `tests/integration/`. `describe.runIf(...)` gates live tests behind env vars (`CODEMIE_VSCODE_LIVE_URL`, `CODEMIE_VSCODE_LIVE_API_KEY`, `CODEMIE_VSCODE_PROJECT`). `tests/helpers/temp-workspace.ts` provides isolated temp dirs and JSON read/write helpers.

### Coverage Gaps

- The `connect` orchestration itself — both action bodies in `index.ts` (`createProxyCommand`) — has **no unit test coverage**. This is the exact code the unification rewrites.
- `writeVsCodeClaudeCodeConfig` (`connectors/vscode-claude-code.ts`) — flagged "no covering tests found".
- `writeDesktopConfig` and `DesktopGatewayConfig` (`connectors/desktop.ts`) — flagged "no covering tests found".
- `spawnDaemon` and `stopDaemon` (`daemon-manager.ts`) — flagged "no covering tests found" (only the state-file helpers are tested).

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_VSCODE_LIVE_URL`, `CODEMIE_VSCODE_LIVE_API_KEY`, `CODEMIE_VSCODE_PROJECT` — used by the live VS Code certification test to target a running proxy.
- `CODEMIE_DEBUG` — toggles console debug output (`logger.isDebugMode()`).
- `APPDATA` / `XDG_CONFIG_HOME` — consulted by `getVsCodeProductDir()` to resolve VS Code user-data dirs per platform.
- Daemon env passed via `spawnDaemon` argv (not process env): `--telemetry-mode`, `--client-type`, `--sync-api-url`, `--sync-codemie-url`, `--gateway-key`, `--target-url`, `--provider`, `--profile`, `--project`, `--port`.

### Configuration Files

- Daemon state: `~/.codemie/proxy-daemon.json` (`DEFAULT_STATE_FILE`) holding `DaemonState` (`pid`, `port`, `url`, `profile`, `gatewayKey`, `telemetryMode`, `clientType`, `targetUrl`, `provider`, `project`, `syncApiUrl`, `syncCodeMieUrl`, health fields).
- CLI config: `~/.codemie/codemie-cli.config.json` (global) and `.codemie/codemie-cli.config.json` (project), read via `EnvManager` / `ConfigLoader`.
- Managed-MCP marker: `~/.codemie/proxy/desktop-managed-mcp-state.json` (`getManagedMcpStatePath()`).
- Target config files written by the connectors: Claude Desktop `claude_desktop_config.json`; VS Code `User/chatLanguageModels.json` (BYOK); VS Code `User/settings.json` (Claude Code extension). All resolved per edition via `getVsCodeProductDir(insiders)` → `Code` vs `Code - Insiders`.

### Feature Flags and Deployment Concerns

- No runtime feature flags gate this command. `--force`, `--verbose`, `--insiders`, `--profile` are per-invocation CLI options; `--vscode-claude-code` is currently a `connect desktop` sub-flag.
- The daemon distinguishes clients via `telemetryMode` (`'none' | 'claude-desktop'`) and `clientType` (free-form string; `'vscode-byok'` for VS Code BYOK, `'claude-desktop'` effective for Desktop). These two fields are set independently by the two action bodies and are currently mutually exclusive in practice.

---

## 6. Risk Indicators

- **Untested orchestration under rewrite.** The `connect` action bodies in `src/cli/commands/proxy/index.ts` have no unit tests, yet they are the exact code the unification restructures (daemon gate, rollback, per-target writes). No safety net exists for regressions.
- **Divergent daemon-match logic between the two bodies.** `connect desktop` gates only on `telemetryMode !== 'claude-desktop'` (`index.ts:354`); `connect vscode` uses a full inline match on profile/project/provider/targetUrl/`getEffectiveClientType === 'vscode-byok'` (`index.ts:594`). Unifying one daemon-lifecycle must reconcile these two match strategies (the existing `daemonMatchesRequest` helper is used by neither today).
- **Multi-target daemon attribution is an unresolved Open Question.** Desktop spawns with `telemetryMode: 'claude-desktop'`; VS Code BYOK spawns with `clientType: 'vscode-byok'`. A single invocation writing several targets (AC4) has no defined `telemetryMode`/`clientType` — the story defers this to engineering. This is a design decision, not a discovered constraint.
- **`--vscode-claude-code` has no daemon-mode of its own.** As a `connect desktop` sub-flag it piggybacks on the Desktop daemon's `state.url`/`state.gatewayKey`. Promoted to a standalone target it needs a daemon posture defined; nothing in the current code specifies one.
- **Partial-failure exit semantics do not exist yet.** AC7 requires a non-zero exit when one target write fails while another succeeds, plus a per-target summary. Today both actions route errors through `printProxyError` and never set `process.exitCode`; the summary/exit behavior is new.
- **Integration test couples to old surface.** `tests/integration/vscode-models.live.test.ts` hard-codes `codemie proxy connect vscode` and asserts `clientType === 'vscode-byok'`. Deprecation-alias rewiring must keep that string valid and that client-type intact, or the live cert breaks.
- **Writer coverage gaps compound the above.** `writeVsCodeClaudeCodeConfig`, `writeDesktopConfig`, `spawnDaemon`, and `stopDaemon` all lack covering tests, so changes flowing through them are unverified by the suite.
- **Speculative (design, not discovered):** unifying likely adds three `--claude-desktop`/`--vscode`/`--vscode-claude-code` boolean options on the `connect` Command, a shared daemon-lifecycle helper wrapping `checkStatus`/`checkProxyHealth`/`spawnDaemon`/rollback, a per-target result accumulator, and two thin deprecated `desktop`/`vscode` alias actions that delegate plus print a highlighted notice. The bare-`connect` target list is print-only (no daemon). None of these are required by existing code — the spec and plan decide the final shape; this is listed only to bound scope, not as an existing constraint.

---

## 7. Summary for Complexity Assessment

This task is concentrated in one CLI-layer file, `src/cli/commands/proxy/index.ts`, which holds the `connect` Commander group and its two ~200-line action bodies. The surrounding pieces it composes already exist and are stable: three config writers (`connectors/desktop.ts`, `connectors/vscode.ts`, `connectors/vscode-claude-code.ts` — content explicitly out of scope), shared daemon lifecycle (`daemon-manager.ts`), and shared health checks (`health-check.ts`). The primary layer touched is the CLI layer; the connectors and daemon/telemetry layers are touched only through orchestration, not signature changes. File change surface is therefore narrow (predominantly `index.ts`, with likely deprecation-notice/help-text edits), but the logic being restructured is dense: daemon gating, health-based restart, startup rollback, and per-writer invocation.

Technical novelty is moderate and localized. The building blocks (Commander options, `chalk` output, `spawnDaemon`/`stopDaemon`/`checkStatus`/`checkProxyHealth`, the `startedInThisRun` rollback idiom, atomic idempotent writers) are all established patterns to reuse. What is genuinely new is composing several targets over a single daemon-lifecycle with a per-target success/failure summary and a non-zero exit on partial failure — behavior with no current analogue, since today each action starts its own daemon and swallows errors through `printProxyError` without setting an exit code. The two action bodies also use different daemon-match logic that must be reconciled into one path.

Test coverage posture is the main risk multiplier: the exact orchestration being rewritten (the `connect` action bodies) has no unit tests, and `writeVsCodeClaudeCodeConfig`, `writeDesktopConfig`, `spawnDaemon`, and `stopDaemon` are all uncovered. A live integration test hard-codes `codemie proxy connect vscode` and the `vscode-byok` client-type, so the deprecation aliases must preserve those exactly. Two open questions carry real design weight — multi-target `telemetryMode`/`clientType` attribution, and the standalone daemon posture for `--vscode-claude-code` (currently it only piggybacks on the Desktop daemon) — and both are engineering decisions the story defers rather than constraints already encoded in the codebase.
