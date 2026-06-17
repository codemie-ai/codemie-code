# Kimi Code Agent Integration Design

**Date:** 2026-06-13  
**Status:** Approved, ready for implementation planning  
**Decision:** Adopt Approach A — full Claude-style plugin parity for MoonshotAI Kimi Code CLI.

---

## 1. Context

CodeMie Code already wraps several external coding agents (Claude, Claude ACP, Codex, OpenCode, Gemini) and a built-in whitelabel agent (`codemie-code`). Each agent is implemented as a plugin in `src/agents/plugins/` and registered in `src/agents/registry.ts`.

The request is to add first-class support for [MoonshotAI Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (`kimi` binary) so that:

- Users can install and run it via `codemie-kimi`.
- It uses the user's own Moonshot subscription (native `kimi /login`), not a CodeMie-managed API key.
- Metrics and analytics still sync to the CodeMie backend.
- Capability parity matches the existing Claude plugin (install, run, hooks, sessions, extensions, ACP).

## 2. Goals

1. Add a `kimi` agent plugin with the same runtime contract as existing agents.
2. Add a `moonshot-subscription` provider that enables native subscription login while preserving metrics sync.
3. Collect metrics via Kimi's lifecycle hooks, with session-file parsing as a reconciliation fallback.
4. Support cross-platform native installation (macOS/Linux install script + Windows PowerShell script).
5. Provide a separate `kimi-acp` adapter for ACP/IDE integration.
6. Keep all changes within existing architecture boundaries; reuse `BaseAgentAdapter`, `AgentCLI`, `BaseExtensionInstaller`, and the metrics pipeline.

## 3. Non-Goals

- No changes to the core agent architecture, registry, or CLI framework.
- No new backend API endpoints; reuse existing `/v1/metrics` and analytics commands.
- No manual verification steps; all validation is automated.
- Do not ship Kimi-specific features (video input, subagents, marketplace) until the core integration is verified end-to-end.

## 4. Decisions from Brainstorming

| Topic | Decision |
|---|---|
| Authentication | User's own Moonshot subscription via native `kimi /login`. |
| Installation | Cross-platform native installers (macOS/Linux `install.sh`, Windows `install.ps1`). |
| Capabilities | Full parity with the Claude plugin for the first version. |
| Metrics source | Primary: Kimi lifecycle hooks. Secondary: native session-file parsing for reconciliation. |
| Verification | Fully automated; analyze Kimi Code CLI format before implementing metrics extraction. |

## 5. Architecture

The new agent follows the established 5-layer flow:

```
bin/codemie-kimi.js  →  AgentCLI  →  AgentRegistry  →  KimiPlugin  →  BaseAgentAdapter  →  kimi binary
```

New components:

- `src/agents/plugins/kimi/kimi.plugin.ts` — main adapter and metadata.
- `src/agents/plugins/kimi/kimi-acp.plugin.ts` — ACP variant.
- `src/agents/plugins/kimi/kimi.session.ts` — session adapter.
- `src/agents/plugins/kimi/session/processors/kimi.metrics-processor.ts` — metrics extraction from session files.
- `src/agents/plugins/kimi/kimi.hook-config-injector.ts` — idempotent injection of CodeMie hooks into Kimi's `config.toml`.
- `src/agents/plugins/kimi/kimi.hook-transformer.ts` — transforms Kimi hook payloads to the internal format used by `codemie hook`.
- `src/agents/plugins/kimi/kimi.extension-installer.ts` — skills/plugins installer.
- `src/providers/plugins/moonshot-subscription/` — subscription provider.
- `bin/codemie-kimi.js` and `bin/codemie-kimi-acp.js` — thin CLI entry points.

Registry/CLI wiring:

- Register `KimiPlugin` and `KimiAcpPlugin` in `src/agents/registry.ts`.
- Add `codemie-kimi` and `codemie-kimi-acp` to `package.json` `bin` map.

Existing core abstractions are reused without modification:

- `BaseAgentAdapter` for install/run/env/flag transforms.
- `AgentCLI` for command-line parsing and validation.
- `BaseSessionAdapter` / `BaseProcessor` for session parsing.
- `MetricsWriter` / `SessionSyncer` / `MetricsSyncProcessor` for metrics sync.
- `BaseExtensionInstaller` for skills/plugins.

## 6. Components

### 6.1 `KimiPlugin`

- Extends `BaseAgentAdapter`.
- Metadata:
  - `name: 'kimi'`
  - `displayName: 'Kimi Code'`
  - `cliCommand: 'kimi'`
  - `npmPackage: '@moonshot-ai/kimi-code'` (used for npm fallback / version checks)
  - `supportedVersion` / `minimumSupportedVersion` derived from Kimi's release cadence
  - `installerUrls` for macOS/Linux shell script and Windows PowerShell script
  - `supportedProviders: ['moonshot-subscription']` for the first version; additional providers (`ai-run-sso`, `bearer-auth`, `litellm`) require writing credentials into `~/.kimi-code/config.toml` and are deferred.
  - `ssoConfig` configured like other agents; proxy is skipped at runtime for `moonshot-subscription` because its `authType` is `'none'`
  - `envMapping` limited to non-credential values such as `KIMI_CODE_HOME`; credentials are **not** passed via environment variables (Kimi reads API keys only from `config.toml`)
  - `flagMappings`: map CodeMie `--task <value>` → Kimi `-p <value>` / `--prompt <value>`; CodeMie `--model <value>` → Kimi `-m <value>` / `--model <value>`
  - `hookConfig.eventNameMapping`: map Kimi event names to internal event names handled by `codemie hook`
- `isInstalled()` checks `commandExists('kimi')` and falls back to `~/.local/bin/kimi`.
- `install()` / `installVersion()` call `installNativeAgent()` with platform-specific URLs; npm fallback uses `@moonshot-ai/kimi-code` only when Node.js is ≥ 22.19.0 (Kimi's documented npm requirement), otherwise it produces a typed `AgentInstallationError` guiding the user to the native installer.
- `getSessionAdapter()` returns `KimiSessionAdapter`.
- `getExtensionInstaller()` returns `KimiExtensionInstaller`.
- `getHookTransformer()` returns `KimiHookTransformer`.

### 6.2 `MoonshotSubscriptionProvider`

Mirrors the `anthropic-subscription` provider pattern:

- `authType: 'none'`, `requiresAuth: false`.
- `defaultBaseUrl: 'https://api.moonshot.ai/v1'` and `recommendedModels` for Kimi models.
- Does **not** inject API keys or base URLs into Kimi — Kimi reads credentials only from `~/.kimi-code/config.toml` (written by native `/login`), not from shell environment variables.
- `exportEnvVars` returns:
  - `CODEMIE_API_KEY: ''` (consistent with `anthropic-subscription`; no CodeMie-managed key is used)
  - `CODEMIE_URL` / `CODEMIE_SYNC_API_URL` when `config.codeMieUrl` is set
  - `CODEMIE_PROJECT` when `config.codeMieProject` is set
- `agentHooks['*'].beforeRun` follows the `anthropic-subscription` wildcard pattern:
  - Early return if `config.agent !== 'kimi'`.
  - Deletes any `KIMI_MODEL_API_KEY` / `KIMI_MODEL_BASE_URL` / `KIMI_MODEL_NAME` environment variables so they do not override the user's native subscription.
  - Dynamically imports `AgentRegistry` to get the `kimi` agent, then calls `KimiHookConfigInjector` to idempotently inject CodeMie `[[hooks]]` entries into `~/.kimi-code/config.toml` (dynamic import avoids the circular dependency created by static imports at registry load time).
- `setupInstructions` guides the user to authenticate Kimi via `/login` and optionally enable CodeMie analytics sync.
- **Open improvement:** relax `AgentCLI.validateCompatibility()` to skip `baseUrl`/`model` requirements when the provider `authType` is `'none'` (agent-native auth). Not required for the first version because `MoonshotSubscriptionProvider` supplies safe defaults.

### 6.3 `KimiSessionAdapter`

- Extends `BaseSessionAdapter`.
- `discoverSessions()` scans `$KIMI_CODE_HOME/sessions/` (default `~/.kimi-code/sessions/`), grouped by `wd_<slug>_<sha256>` working-directory buckets.
- `parseSessionFile()` reads `agents/main/wire.jsonl` (and `agents/agent-*/wire.jsonl` for subagents) and converts the Wire event stream into `ParsedSession`.
- Registers `KimiMetricsProcessor`.

### 6.4 `KimiHookConfigInjector`

- New component (not based on `BaseExtensionInstaller` because it edits a TOML config rather than copying files).
- Reads `~/.kimi-code/config.toml`.
- Idempotently adds `[[hooks]]` entries with `command = "codemie hook"` for the events already handled by `src/cli/commands/hook.ts`: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStop`, and `PreCompact`.
- **Explicit decision:** Kimi's `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` events are **not** configured as hooks because `codemie hook` has no handlers for them. Tool-usage metrics are extracted from `wire.jsonl` during the `Stop` incremental sync (transcript parsing as the primary tool-metrics source, hooks as the trigger).
- Backs up the original config before first modification.
- On uninstall, removes CodeMie-managed hook entries and restores the backup if no other changes were made.

### 6.5 `KimiHookTransformer`

- Implements the existing `HookTransformer` interface (same pattern as `GeminiHookTransformer`).
- Returned by `KimiPlugin.getHookTransformer()`.
- Transforms the raw Kimi hook JSON payload to the internal `BaseHookEvent` format expected by `src/cli/commands/hook.ts`:
  - Passes through `hook_event_name`, `session_id`, `cwd`, `source`, `reason`.
  - Computes and adds `transcript_path` pointing to the session's `agents/main/wire.jsonl` so `codemie hook` can perform incremental sync.
  - Adds `permission_mode: 'default'` (Kimi does not expose this field).
- Event-name normalization is handled separately by `metadata.hookConfig.eventNameMapping` (e.g. `PostCompact` → `PreCompact`, `Notification` → `PermissionRequest` if needed).

### 6.6 `KimiMetricsProcessor`

- Extends `BaseProcessor`.
- Extracts from `ParsedSession`:
  - Tool usage counts and status
  - File operations (read/write/edit/delete with path/language/line counts)
  - Model names
  - Skill/agent/command invocations
  - User prompts for title derivation
- Appends `MetricDelta` records via `MetricsWriter`.

### 6.7 `KimiExtensionInstaller`

- Extends `BaseExtensionInstaller`.
- Copies bundled CodeMie Kimi skills into Kimi's extension directory (`~/.kimi-code/skills/` or project-local `.kimi-code/skills/`).
- Overrides `getSourcePath()`, `getTargetPath()`, `getManifestPath()`, `getCriticalFiles()`.

### 6.8 `KimiAcpPlugin`

- Extends `KimiPlugin`.
- `cliCommand: 'kimi'` (same binary as the main agent; `commandExists()` and version checks must not include the space).
- `silentMode: true` so stdout remains JSON-RPC.
- `enrichArgs` prepends `acp` to the argument list so the spawned process is `kimi acp ...`.
- Reuses the same subscription provider and session adapter.

## 7. Data Flow

Example: `codemie-kimi --task "refactor auth"`

1. **CLI launch** — `bin/codemie-kimi.js` resolves `AgentRegistry.getAgent('kimi')`, constructs `AgentCLI`, and collects pass-through args.
2. **Config load** — `AgentCLI` loads profile. For `moonshot-subscription`, `apiKey` is not required; `baseUrl` and `model` are required by `AgentCLI.validateCompatibility()` but are satisfied by `MoonshotSubscriptionProvider.defaultBaseUrl` and `recommendedModels`.
3. **Version check** — `KimiPlugin.checkVersionCompatibility()` runs `kimi --version` and blocks/warns based on supported version ranges.
4. **Proxy decision** — `BaseAgentAdapter.shouldUseProxy()` returns `false` because the provider `authType` is `'none'`.
5. **Env transform** — `transformEnvVars()` applies `metadata.envMapping`; `CODEMIE_URL` / `CODEMIE_SYNC_API_URL` / `CODEMIE_PROJECT` remain for metrics sync.
6. **Lifecycle hooks** — `beforeRun` resolves the provider wildcard hook:
   - `MoonshotSubscriptionProvider.agentHooks['*'].beforeRun` checks `config.agent === 'kimi'`, deletes any `KIMI_MODEL_API_KEY` / `KIMI_MODEL_BASE_URL` / `KIMI_MODEL_NAME` environment variables, and calls `KimiHookConfigInjector` to ensure `~/.kimi-code/config.toml` contains CodeMie-managed `[[hooks]]` entries with `command = "codemie hook"`.
7. **Argument enrichment and spawn**:
   - `enrichArgs` maps CodeMie flags to Kimi flags: `--task <value>` → `-p <value>`; `--model <value>` → `-m <value>`.
   - `kimi` binary is spawned with `stdio: 'inherit'`.
8. **Runtime metrics** — Kimi reads its config and invokes `codemie hook` for configured events. `src/cli/commands/hook.ts` loads `KimiPlugin.getHookTransformer()`, transforms the raw Kimi payload to internal format (adding `transcript_path`), normalizes the event name via `metadata.hookConfig.eventNameMapping`, and routes to the existing handlers (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`). Tool-usage metrics are extracted during the `Stop` incremental sync from `wire.jsonl` via `KimiSessionAdapter`.
9. **Exit** — `onSessionEnd` / `afterRun` flush final metrics and exit with the `kimi` process code.
10. **Remote sync** — `MetricsSyncProcessor` / `SessionSyncer` sends pending deltas via `POST /v1/metrics`.
11. **Offline analytics** — `codemie analytics` discovers native Kimi sessions via `KimiSessionAdapter.discoverSessions()` and reconciles any gaps.

## 8. Error Handling

| Failure | Handling |
|---|---|
| Native install fails | Wrap in `AgentInstallationError`; log platform/context; offer npm fallback if available. |
| `kimi` not in PATH | `isInstalled()` checks `~/.local/bin/kimi` fallback; prompt user to restart shell if still missing. |
| Installed version below minimum | Hard block with upgrade prompt. |
| Installed version above supported | Warning; allow run. |
| User not logged in | Kimi itself prompts; CodeMie does not intercept. Metrics sync proceeds if `CODEMIE_URL` is set. |
| Injected API key in subscription mode | `MoonshotSubscriptionProvider.agentHooks['*'].beforeRun()` clears `KIMI_MODEL_*` environment variables for the Kimi agent. |
| Malformed hook payload | Log with `logger.debug()`, skip delta, continue session. |
| Metrics sync failure | Deltas remain `pending` in `~/.codemie/sessions/`; retried by next run or `codemie analytics`. |
| Session parsing failure | Catch, return empty `ParsedSession`, warn via `logger.warn()`, do not crash analytics. |

All errors use typed error classes from `src/utils/errors.ts` and sanitize sensitive values before logging.

## 9. Pre-Implementation Analysis

The public Kimi Code CLI documentation has already been reviewed and the following are known:

- **Package:** `@moonshot-ai/kimi-code` on npm; `kimi` executable.
- **Task flag:** `-p` / `--prompt <prompt>`.
- **Model flag:** `-m` / `--model <alias>`.
- **Config:** `~/.kimi-code/config.toml`; overridable via `KIMI_CODE_HOME`.
- **Sessions:** `$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/` with `state.json` and `agents/*/wire.jsonl`.
- **Hook events:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `Notification`, `PermissionRequest`, `PermissionResult`, `Interrupt`.
- **Hook payload:** base fields `hook_event_name`, `session_id`, `cwd`; event-specific fields such as `tool_name`, `tool_input`, `tool_output`, `error`, `prompt`, `agent_name`, etc.
- **Credentials:** Kimi reads API keys only from `config.toml` (`[providers.<name>]`), not from shell environment variables.

Remaining unknowns to verify against a real `kimi` binary or the source repo before finalizing the implementation:

1. **Wire event schema** — Exact JSON shape of entries in `agents/main/wire.jsonl` for tool calls, file operations, and model usage.
2. **Hook payload samples** — Real JSON examples for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `SessionEnd`.
3. **Model detection** — How to determine which model alias was used for a session when `KIMI_MODEL_NAME` is not set.
4. **ACP mode** — Exact `kimi acp` CLI behavior and whether it emits the same hooks.
5. **Skills directory** — Whether user-level skills live only under `~/.kimi-code/skills/` or also under `~/.agents/skills/`.

The analysis output will be appended to the implementation plan and may refine the exact mappings and processor logic.

## 10. Automated Verification Plan

No manual steps are required from the user. Verification runs automatically after implementation:

1. `npm run build` passes with zero TypeScript errors.
2. `npm run lint` passes with zero warnings.
3. Registry unit test (`src/agents/__tests__/registry.test.ts`) updated and passing for `kimi` and `kimi-acp`.
4. Mocked end-to-end run:
   - Install a placeholder `kimi` binary.
   - Run `codemie-kimi --task "hello"`.
   - Verify correct env vars are passed.
   - Verify hook events are received and metrics JSONL is produced.
5. Session parsing test:
   - Parse a real/sample Kimi transcript.
   - Verify expected `MetricDelta` fields.
6. `codemie doctor` recognizes `kimi` as installed when the binary is present.

Implementation continues until all verifications pass.

## 11. Files to Create / Modify

### New files

- `src/agents/plugins/kimi/kimi.plugin.ts`
- `src/agents/plugins/kimi/kimi-acp.plugin.ts`
- `src/agents/plugins/kimi/kimi.session.ts`
- `src/agents/plugins/kimi/session/processors/kimi.metrics-processor.ts`
- `src/agents/plugins/kimi/kimi.hook-config-injector.ts`
- `src/agents/plugins/kimi/kimi.hook-transformer.ts`
- `src/agents/plugins/kimi/kimi.extension-installer.ts`
- `src/agents/plugins/kimi/kimi.paths.ts`
- `src/providers/plugins/moonshot-subscription/index.ts`
- `src/providers/plugins/moonshot-subscription/moonshot-subscription.template.ts`
- `src/providers/plugins/moonshot-subscription/moonshot-subscription.setup-steps.ts`
- `bin/codemie-kimi.js`
- `bin/codemie-kimi-acp.js`

### Modified files

- `src/agents/core/AgentCLI.ts` — add `kimi` and `kimi-acp` to `getAgentMetadata()` metadata map (or refactor the map to read from `this.adapter.metadata`).
- `src/agents/registry.ts` — register `KimiPlugin` and `KimiAcpPlugin`.
- `src/providers/index.ts` — import moonshot-subscription provider for side-effect registration.
- `package.json` — add `codemie-kimi` and `codemie-kimi-acp` to `bin`.
- `src/agents/__tests__/registry.test.ts` — assert new agents are registered.

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Kimi hook schema differs from documentation | Validate against real `kimi` binary; `KimiHookTransformer` is isolated and easy to adjust. |
| Editing `~/.kimi-code/config.toml` corrupts user config | Backup before first write; use a TOML-preserving parser/writer; idempotent updates; restore on uninstall. |
| No stable npm package for fallback | Keep native installer as the primary path; npm fallback checks Node version and fails with a typed error if incompatible. |
| Kimi `wire.jsonl` format is opaque or changes frequently | Tool-usage metrics are extracted from `wire.jsonl`; if the format is inaccessible, the integration degrades to session-level metrics only. |
| Windows installer differs significantly from macOS/Linux | Validate install script behavior during pre-implementation analysis. |
| TOML library not already in project | Verify existing dependencies; add a small, well-tested TOML parser if needed. |
| AgentCLI metadata map not updated | Add `kimi`/`kimi-acp` to `getAgentMetadata()` or refactor it to read from `this.adapter.metadata`. |

## 13. Open Questions / Remaining Unknowns

The Kimi Code CLI public documentation has answered config location, hook event list, CLI flags, package name, and skills directories. The following must still be verified against a real `kimi` binary or the source repository before finalizing the implementation:

1. **Wire event schema** — Exact JSON shape of entries in `agents/main/wire.jsonl` for tool calls, file operations, and model usage.
2. **Hook payload samples** — Real JSON examples for `SessionStart`, `Stop`, `UserPromptSubmit`, and `SessionEnd`.
3. **Model detection** — How to determine which model alias was used for a session when `KIMI_MODEL_NAME` is not set.
4. **ACP mode** — Exact `kimi acp` CLI behavior and whether it emits the same hooks.
5. **Work-dir key encoding** — Confirm the `wd_<slug>_<first-12-chars-of-sha256>` algorithm used in the sessions directory so `KimiHookTransformer` can compute `transcript_path` reliably.
