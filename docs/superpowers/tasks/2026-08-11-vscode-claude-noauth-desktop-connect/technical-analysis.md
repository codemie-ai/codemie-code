# Technical Research

**Task**: proxy connect desktop claude
**Generated**: 2026-08-11T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

Extend `codemie proxy connect desktop` so that, in addition to whatever it already configures for the CLI/terminal, it also configures the VS Code Claude Code extension to work without requiring a Claude.ai browser OAuth login. Concretely: write/update VS Code user settings.json with `claudeCode.disableLoginPrompt: true` and `claudeCode.environmentVariables` (mirroring whatever proxy/Bedrock env vars the desktop-connect flow already sets for the terminal — e.g. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for a gateway/proxy, or CLAUDE_CODE_USE_BEDROCK / AWS_PROFILE / AWS_REGION for Bedrock) so the bundled Claude Code CLI inside the VS Code extension picks up the same auth-bypassing configuration the terminal already gets, since the VS Code extension does not inherit shell environment variables and has its own settings surface. User-supplied research citing Anthropic's documented settings: `claudeCode.disableLoginPrompt`, `claudeCode.environmentVariables`, ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY for gateways, CLAUDE_CODE_USE_BEDROCK/AWS_PROFILE/AWS_REGION/ANTHROPIC_BEDROCK_BASE_URL/CLAUDE_CODE_SKIP_BEDROCK_AUTH for Bedrock. Need to find and modify the `codemie proxy connect desktop` command implementation in this repo (src/) to add this VS Code settings.json write step.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/index.ts` — `createProxyCommand()` registers all `codemie proxy *` subcommands via Commander. `proxy connect desktop` action (lines 330-508) is the actual implementation the task must modify: resolves an SSO-backed profile (`resolveSsoProxyConfig`), starts/reuses the local proxy daemon in `'claude-desktop'` telemetry mode (`spawnDaemon`/`checkStatus`/`stopDaemon` from `./daemon-manager.js`), fetches org-managed MCP servers, then calls `writeDesktopConfig(state.url, state.gatewayKey, getDesktopBaseDir(), orgMcpServers)`.
- `proxy connect vscode` action (lines 510-664) is a **separate, already-shipped** subcommand — it does not touch `settings.json`; it calls `writeVsCodeLanguageModelsConfig(state.url, insiders)` which writes VS Code's native Copilot Chat BYOK provider file `chatLanguageModels.json`, unrelated to the third-party Claude Code extension's `claudeCode.*` settings keys.
- `src/cli/commands/proxy/connectors/desktop.ts` — connector module for the `desktop` subcommand: `writeDesktopConfig()` (writes `configLibrary/<uuid>.json` + `_meta.json` under Claude Desktop's (3P native app) base dir), `buildGatewayConfig()` (produces `{ inferenceProvider: 'gateway', inferenceGatewayBaseUrl, inferenceGatewayApiKey, inferenceGatewayAuthScheme: 'bearer' }`), `fetchClaudeModels()`, `selectDesktopClaudeModels()`, `reconcileManagedMcpServers()`, `getDesktopBaseDir()` (delegates to `getClaudeDesktopBaseDir()`).
- `src/cli/commands/proxy/connectors/vscode.ts` — connector for `proxy connect vscode`: `getVsCodeProductDir(insiders)` (private, per-OS VS Code user-data dir resolver: darwin → `~/Library/Application Support/Code[-Insiders]`, win32 → `%APPDATA%\Code[-Insiders]`, linux → `$XDG_CONFIG_HOME/Code[-Insiders]`), `getVsCodeLanguageModelsPath(insiders)` (→ `<productDir>/User/chatLanguageModels.json`), `writeVsCodeLanguageModelsConfigAtPath()` (atomic write via `writeAtomically()` — temp file + `rename`), `mergeManagedProviders()` (preserves user-set fields, replaces CodeMie-managed provider entry).
- `src/cli/commands/proxy/daemon-manager.ts` — `spawnDaemon`, `checkStatus`, `stopDaemon`, `readState`, `writeState`, `DaemonState` type. Runs/tracks the local gateway daemon (`src/bin/proxy-daemon.ts`) that exposes an OpenAI/Anthropic-compatible endpoint at `state.url` guarded by `state.gatewayKey` (bearer token) — this is the "gateway" pattern, not a raw `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` pass-through.
- `src/agents/core/BaseAgentAdapter.ts` — `run()` (CLI terminal launch path for agents, e.g. `codemie claude`) builds env via `buildProxyConfig()`/`setupProxy()`/`transformEnvVars()` from `metadata.envMapping`, and has a reusable `ensureJsonFile(filePath, defaultContent)` helper that deep-merges defaults into an existing JSON settings file (create-if-missing, merge-preserve otherwise) — this is a generic, already-proven pattern for writing/merging a settings file, though it is scoped to the agent's own `dataPaths.home`, not VS Code's user-data dir.
- `src/env/types.ts` — `ProviderProfile` interface carries `awsProfile`, `awsRegion`, `awsSecretAccessKey` fields (commented "AWS Bedrock-specific fields") and `maxOutputTokens`/`maxThinkingTokens` (commented "Token configuration (for Claude Code with Bedrock)") — confirms Bedrock-aware profile config exists elsewhere in the system, but no reference to these fields was found inside `proxy/connectors/desktop.ts`, `proxy/connectors/vscode.ts`, or `proxy/index.ts`.

### Architecture and Layers Affected

- **CLI command layer** — `src/cli/commands/proxy/index.ts` (Commander subcommand registration/orchestration for `proxy connect desktop`).
- **Connector/config-writer layer** — `src/cli/commands/proxy/connectors/` (`desktop.ts`, `vscode.ts`, `vscode-models.ts`, `managed-mcp-remote.ts`) — the layer responsible for writing third-party client config files (Claude Desktop app config, VS Code BYOK config).
- **Local proxy daemon layer** — `src/cli/commands/proxy/daemon-manager.ts`, `src/bin/proxy-daemon.ts`, `src/providers/plugins/sso/proxy/` (the actual gateway serving `state.url` + `state.gatewayKey`) — supplies the URL/key any new settings writer would need to reference.
- **Utility layer** — `src/utils/errors.ts` (`ConfigurationError`), `src/utils/security.ts` (`sanitizeLogArgs`), `src/utils/paths.ts` (`getCodemiePath`) — used throughout the connectors for error reporting, safe logging of secrets, and CodeMie-owned state paths.

### Integration Points

- `proxy connect desktop` → `daemon-manager.spawnDaemon/checkStatus/stopDaemon` (internal) → local gateway daemon (`src/bin/proxy-daemon.ts`, `src/providers/plugins/sso/proxy/`).
- `proxy connect desktop` → `connectors/managed-mcp-remote.fetchManagedMcpServers()` → backend MCP catalog (external HTTP call, SSO-authenticated).
- `connectors/desktop.ts` → `fetchClaudeModels()` → gateway's own `/v1/llm_models?include_all=true` endpoint (through the just-started local daemon, not directly to Anthropic).
- `connectors/vscode.ts` → filesystem only (`chatLanguageModels.json` under the VS Code user-data dir); no external HTTP calls.
- No integration point in this area currently reaches the third-party Claude Code VS Code extension or its `claudeCode.*` settings namespace, and none references AWS Bedrock APIs directly.

### Patterns and Conventions

- Config-file writers follow a **read-existing → merge/reconcile → write** shape that preserves unrelated/user-set keys (`writeDesktopConfig`'s `existing`-spread merge; `vscode.ts`'s `mergeManagedProviders`; `BaseAgentAdapter.ensureJsonFile`'s `deepMerge`).
- Atomic writes for config files that a running application may read concurrently: temp file + `rename()` (`vscode.ts:writeAtomically`, `desktop.ts:writeManagedMcpState`).
- User-facing failures use `ConfigurationError` from `@/utils/errors.js`; connector functions throw rather than `console.error` directly, leaving formatting to `printProxyError()` in `index.ts`.
- Secrets (`gatewayKey`, `inferenceGatewayApiKey`) are always logged through `sanitizeLogArgs(...)`, never interpolated raw into a log message.
- Per-OS user-data-dir resolution is a small `if (process.platform === ...)` switch (`vscode.ts:getVsCodeProductDir`), not abstracted behind a shared cross-connector utility — each connector currently owns its own path logic (`desktop.ts` delegates to `getClaudeDesktopBaseDir()` in the telemetry module instead).
- `connect vscode` already supports an `--insiders` flag threaded through to path resolution; `connect desktop` does not have an analogous per-target flag today.

---

## 3. Documentation Findings

### Guides and Architecture Docs

`.ai-run/guides/integration/external-integrations.md` (P1 guide for this task per the Task Classifier's `provider`/`sso` and `claude` keyword rows) was read in full: it documents LangGraph/LangChain, generic provider-plugin contract, LiteLLM, OpenCode, MCP server integration, Codex cost pipelines, and Claude session processing (`ConversationsProcessor` drain loop) — it contains **no section on `proxy connect desktop`, `proxy connect vscode`, or any VS Code Claude Code extension integration**. `.ai-run/guides/architecture/architecture.md` is the P0 guide (per the `claude` keyword row) but was not needed beyond what code exploration already surfaced (CLI → Registry → Plugin flow described in AGENTS.md's Common Pitfalls table applies to agent plugins, not to the `proxy connect` connector modules, which sit outside the agent-plugin registry entirely).

### Architectural Decisions

None found specific to this feature area. `AGENTS.md` itself flags a comparable gap for another feature ("Neither `external-integrations.md` nor `docs/AGENTS.md` covers Pi yet") — the same is true here for `proxy connect desktop`/`vscode`, which postdate the guide content.

### Derived Conventions

All conventions in Section 2 ("Patterns and Conventions") were derived directly from reading `desktop.ts`, `vscode.ts`, and `BaseAgentAdapter.ts` verbatim, since no guide documents this connector layer.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts` — unit tests (Vitest, `@group unit`) for `writeVsCodeLanguageModelsConfigAtPath`, using an isolated `mkdtemp()` fixture directory and asserting on the written JSON structure (allowlisted model IDs, provider shape, `requiresSecretConfiguration`).
- `src/cli/commands/proxy/connectors/desktop.ts` has **no covering tests** — codegraph's blast-radius check explicitly flags `DesktopGatewayConfig`, `ManagedMcpServerEntry`, `writeDesktopConfig`, and related exports as untested.
- `src/cli/commands/proxy/inspect-desktop.ts` (`DesktopInspectionResult`, `DesktopSessionInspection`, `inspectDesktopProxy`) is also flagged with no covering tests.

### Testing Framework and Patterns

Vitest, with `describe`/`it`/`beforeEach`/`afterEach` and real-filesystem fixtures under `os.tmpdir()` (`mkdtemp`/`rm({recursive:true, force:true})`) rather than mocking `fs` — the established pattern for any new connector-level file-writing test in this directory.

### Coverage Gaps

- The `desktop.ts` connector this task must modify has zero existing tests to extend or use as a regression baseline.
- No test exists anywhere in the repo that exercises a VS Code generic `settings.json` (as opposed to `chatLanguageModels.json`) — this would be new test surface, not an extension of existing coverage.

---

## 5. Configuration and Environment

### Environment Variables

- Env vars observed in the connector/daemon flow for `proxy connect desktop`: none directly — the daemon communicates its address/key to connectors via the in-memory `DaemonState` object (`state.url`, `state.gatewayKey`), not via process env vars set on a spawned `claude` CLI.
- Broader CLI-launch env vars (`CODEMIE_BASE_URL`, `CODEMIE_PROFILE_CONFIG`, `CODEMIE_SESSION_ID`, etc.) are built in `BaseAgentAdapter.buildProxyConfig()`/`run()` for agents launched via `codemie claude`, a different code path from `proxy connect desktop`.
- No occurrence of `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`, `AWS_REGION`, `ANTHROPIC_BEDROCK_BASE_URL`, or `CLAUDE_CODE_SKIP_BEDROCK_AUTH` was found anywhere in the explored code — these are the exact variable names the task expects to mirror, and they do not currently appear in this codebase's proxy/connect flow.

### Configuration Files

- Claude Desktop (3P app) config: `<desktopBaseDir>/configLibrary/<uuid>.json` + `_meta.json` (written by `writeDesktopConfig`).
- VS Code BYOK config: `<VS Code user-data dir>/User/chatLanguageModels.json` (written by `writeVsCodeLanguageModelsConfigAtPath`).
- No file in this codebase currently reads or writes a generic VS Code `<user-data dir>/User/settings.json`.
- CodeMie-owned marker state: `getCodemiePath('proxy', 'desktop-managed-mcp-state.json')`.

### Feature Flags and Deployment Concerns

- `--force`, `--verbose`, `--profile` flags exist on `connect desktop`; `--insiders` additionally exists on `connect vscode` only.
- No feature flag currently gates VS Code extension configuration.

---

## 6. Risk Indicators

- **Task premise vs. observed code**: the task states `proxy connect desktop` "already configures... for the CLI/terminal." The code shows `connect desktop` configures the Claude Desktop (3P) *native app* config file and starts the local gateway daemon — it does not write any env vars for a terminal-launched CLI process. This mismatch should be resolved (with the requester) before scoping the change, since "mirror what the terminal already gets" has no existing terminal-env-var artifact in this command to mirror.
- **Distinct integration surface**: `connect vscode` already exists but targets VS Code's *native* Copilot Chat BYOK language-model API (`chatLanguageModels.json`), not the third-party Claude Code extension's `claudeCode.*` settings namespace. A `settings.json` writer for `claudeCode.disableLoginPrompt`/`claudeCode.environmentVariables` is new code, not an extension of `writeVsCodeLanguageModelsConfigAtPath`.
- **Zero references to the target keys**: `claudeCode.disableLoginPrompt`, `claudeCode.environmentVariables`, and the full Bedrock env var list (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH`) return no hits anywhere in this repository across multiple targeted `codegraph_explore` queries.
- **Untested connector**: `src/cli/commands/proxy/connectors/desktop.ts` (the file this task modifies) has no existing test coverage — any change here starts from zero regression safety net, unlike `vscode.ts` which has `vscode.test.ts`.
- **Private, unexported helper**: `getVsCodeProductDir(insiders)` in `vscode.ts` (the only existing per-OS VS Code user-data-dir resolver) is not exported — reusing it for a settings.json path requires either exporting it or duplicating the platform-switch logic.
- **Gateway-only pattern today**: the local daemon models auth as a bearer-token gateway (`inferenceGatewayApiKey`/`state.gatewayKey`), never as `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` or a Bedrock passthrough — deciding which of the task's env var sets (gateway vs. Bedrock) applies, and how, is a design decision with no existing precedent in this connector layer to follow.
- **No guide coverage**: `external-integrations.md` and `architecture.md` do not document the `proxy/connectors/` layer at all — conventions here were derived entirely from code, so there is no recorded architectural intent to check a design against.

---

## 7. Summary for Complexity Assessment

The task targets the CLI command layer and the connector layer under `src/cli/commands/proxy/` — specifically `index.ts` (the `connect desktop` Commander action) and `connectors/desktop.ts` (the config-writer it calls). A sibling connector, `connectors/vscode.ts`, already establishes precedent for writing a VS Code configuration file (atomic write, per-OS user-data-dir resolution, merge-preserve-existing-keys), but it targets a different file (`chatLanguageModels.json`) and a different integration surface (VS Code's native BYOK language-model API) than the one this task describes (`settings.json`, third-party Claude Code extension's `claudeCode.*` namespace). No file in the repository currently reads or writes VS Code's generic `settings.json`, and none references the specific setting keys or Bedrock/gateway env vars named in the task — this is new integration surface, not an extension of tested, existing code.

Novelty is elevated by two factors independent of raw file count: first, the task's framing assumes `connect desktop` already sets terminal env vars to mirror, but the code shows it configures a native desktop app and a gateway daemon instead — the actual "source of truth" env vars/values to write into `claudeCode.environmentVariables` are not present anywhere in this command today and would need to be derived by design, not copied. Second, the task names two alternative auth modes (gateway vs. Bedrock) with six candidate env vars total, and the existing connector only ever produces the gateway shape (`inferenceGatewayBaseUrl`/`inferenceGatewayApiKey`) — there is no existing Bedrock branch in this code path to extend.

Test posture is a further risk multiplier: `connectors/desktop.ts`, the file most directly in scope, has zero existing test coverage per codegraph's blast-radius analysis, while the one directly analogous precedent (`vscode.ts`) does have Vitest coverage using an `mkdtemp`-based real-filesystem fixture pattern that any new settings.json writer should follow. Combined with the absence of guide documentation for this connector layer, the design and plan stages should treat the target env var source, the Bedrock-vs-gateway branch, and the settings.json merge strategy as open design questions rather than settled facts inherited from this research.
