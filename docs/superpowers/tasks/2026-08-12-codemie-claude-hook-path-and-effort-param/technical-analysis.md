# Technical Research

**Task**: codemie-claude hooks effort proxy-normalizer
**Generated**: 2026-08-12T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Summary: codemie-claude setup fails in new CodeMie version due to missing codemie command and unsupported effort parameter.

The new CodeMie version causes codemie-claude setup/runtime failures in Claude Code. Two distinct failures:

FAILURE 1 — Claude Code reports hook execution errors because the `codemie` command is not found:
```
SessionStart:startup hook error
Failed with non-blocking status code: /usr/bin/bash: line 1: codemie: command not found
UserPromptSubmit hook error
Failed with non-blocking status code: /usr/bin/bash: line 1: codemie: command not found
```
Precondition: user does NOT have admin rights and cannot install/revert to an older CodeMie version.

FAILURE 2 — model requests fail with API 400 because the selected Claude model does not support the `effort` parameter:
```
API Error: 400 {"message":"This model does not support the effort parameter."}
Received Model Group=claude-4-5-sonnet
Available Model Group Fallbacks=None
```

Acceptance criteria:
- The `codemie` command is correctly available to Claude Code hook execution after codemie-claude setup; SessionStart and UserPromptSubmit hooks must not fail with "codemie: command not found".
- Requests to claude-4-5-sonnet must not include unsupported `effort` parameters. If a model does not support a parameter, CodeMie omits or maps the parameter safely before sending the request.
- codemie-claude setup works in a user environment without requiring admin rights to downgrade CodeMie.
- Regression validation confirms Claude Code can start, accept a prompt, and receive a model response without the reported errors.

---

## 2. Codebase Findings

### Existing Implementations

**Hook installation chain:**
- `src/agents/plugins/claude/plugin/hooks/hooks.json` — static template with bare `"command": "codemie hook"` and `"command": "codemie sound <Event>"` strings for all seven hook events (SessionStart, UserPromptSubmit, PermissionRequest, SubagentStop, Stop, SessionEnd, PreCompact). No absolute path. No variable substitution.
- `src/agents/plugins/claude/claude.plugin-installer.ts` — copies the entire `src/agents/plugins/claude/plugin/` source tree to `~/.codemie/claude-plugin/` verbatim via `BaseExtensionInstaller.install()`. No post-copy command-string templating is performed.
- `src/agents/core/extension/BaseExtensionInstaller.ts` — base class for all plugin installers; implements plain directory-tree copy; no hook-command path substitution anywhere in the class.
- `src/providers/core/default-agent-hooks.ts` — calls `installer.install()` before each Claude run, sets `CODEMIE_CLAUDE_EXTENSION_DIR`, and injects `--plugin-dir ~/.codemie/claude-plugin` into Claude Code CLI arguments. This is the wiring point between the installer and the running Claude Code process.
- `src/plugins/loaders/hooks-loader.ts` — expands `${CLAUDE_PLUGIN_ROOT}` tokens in hook command strings, but this loader is scoped to CodeMie's own internal plugin manifest system; it does NOT process the `hooks.json` file that Claude Code consumes from `--plugin-dir`.
- `src/cli/commands/hook.ts` — implements the `codemie hook` CLI handler; reads `CODEMIE_PROFILE_NAME`, `CODEMIE_SESSION_ID`, and `hook_event_name` from environment/stdin and routes to the appropriate lifecycle handler.

**Effort / reasoning-effort chain:**
- `src/agents/plugins/claude/claude.plugin.ts` — declares `reasoningEffort: { strategy: 'cli-flag', flag: '--effort', supportedLevels: ['low','medium','high','xhigh','max'] }`. Also records `CLAUDE_SUPPORTED_VERSION = '2.1.218'`. The `--effort` flag is passed to the Claude Code CLI at launch time, not injected into API request bodies by this layer.
- `src/agents/core/reasoning-effort.ts` — `applyReasoningEffort()`: for `cli-flag` strategy, appends `--effort <level>` to the argv array passed to the Claude Code binary. This is the source of the `--effort` flag reaching Claude Code; the new Claude Code version (>=2.1.218) then forwards this to the Anthropic API as `output_config.effort`.
- `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts` — SSO proxy plugin (priority 14); intercepts the API request body before forwarding to Anthropic. Scoped to `codemie-claude`, `codemie-copilot`, and `claude-desktop` agents. Contains two model-capability gating lists:
  - `NO_THINKING_MODEL_PATTERNS` — matches `claude-haiku-3-5` and `claude-haiku-4-5`; strips `thinking` block entirely.
  - `ADAPTIVE_THINKING_MODEL_PATTERNS` — matches `claude-opus-4-7+` and `claude-sonnet-5`; transforms `thinking:{type:'enabled'}` to `thinking:{type:'adaptive'}` plus `output_config.effort` (with `budgetTokensToEffort()` mapping: ≤2048→low, ≤8192→medium, >8192→high).
  - `claude-sonnet-4-5` / `claude-4-5-sonnet` matches **neither list** — the normalizer passes through any `thinking` or `effort` field unchanged.
- `src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts` — strips OpenAI-style `reasoning`, `reasoningSummary`, `reasoning_summary` fields; scoped exclusively to `codemie-code` and `codemie-opencode` agents — does not touch `codemie-claude` traffic at all.

**Binary resolution utilities:**
- `src/utils/processes.ts` — `getCommandPath()` uses `which` (Unix) / `where.exe` (Windows) to resolve binary paths at runtime, with a `~/.local/bin/claude` fallback. This utility is used when spawning the Claude process, but it is NOT invoked during hook-command template construction.
- `src/utils/cli-bin.ts` — checks and restores the `codemie` symlink if another global package's `bin.codemie` has overwritten it; runs on CLI startup, not at hook install time.

### Architecture and Layers Affected

| Layer | Components touched |
|---|---|
| Agent plugin layer | `src/agents/plugins/claude/` — hooks.json, claude.plugin.ts, claude.plugin-installer.ts |
| Core agent adapter layer | `src/agents/core/` — reasoning-effort.ts, BaseExtensionInstaller.ts |
| Provider hooks layer | `src/providers/core/default-agent-hooks.ts` — install orchestration, --plugin-dir injection |
| SSO proxy plugin layer | `src/providers/plugins/sso/proxy/plugins/` — claude-request-normalizer.plugin.ts |
| CLI command layer | `src/cli/commands/hook.ts` — hook event handler |

Bug 1 is entirely within the **Agent plugin layer** (hooks.json content) and the boundary between that layer and the OS shell environment. Bug 2 is within the **SSO proxy plugin layer** (missing model entry in capability gating lists).

### Integration Points

- Claude Code binary (`@anthropic-ai/claude-code`) reads `hooks.json` from the `--plugin-dir` path and spawns each hook command as a shell subprocess — the shell environment at that point may or may not include the npm-prefix bin directory.
- The Anthropic API rejects `output_config.effort` (and top-level `effort`) for models that do not support extended thinking or adaptive thinking — `claude-sonnet-4-5` / `claude-4-5-sonnet` is one such model.
- `default-agent-hooks.ts` is the single orchestration point that calls install and injects `--plugin-dir` — any path-resolution fix for Bug 1 must happen here or in the installer it calls.
- The `--effort` flag flows: `AgentCLI` → `applyReasoningEffort()` → Claude Code argv → Claude Code API request body → SSO proxy → Anthropic API. The proxy normalizer is the last defensive point before the Anthropic API call.

### Patterns and Conventions

- All proxy plugins throw in `createInterceptor()` to self-disable for out-of-scope agents (fail-safe pattern).
- Model-specific normalization is gated by regex pattern lists (`NO_THINKING_MODEL_PATTERNS`, `ADAPTIVE_THINKING_MODEL_PATTERNS`); extending model support requires adding a new regex entry to one of these lists.
- The installer follows a pure-copy convention (no post-install templating) — any dynamic content must either be pre-baked into source files before copy, or resolved at install time by the installer itself.
- `${CLAUDE_PLUGIN_ROOT}` variable expansion exists in `hooks-loader.ts` for CodeMie's own plugin manifest system; this expansion mechanism does NOT apply to the `hooks.json` Claude Code consumes.
- Plugin priority ordering is documented: SSO/JWT auth (10) → ClaudeRequestNormalizer (14) → RequestSanitizer (15) → HeaderInjection (20).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/` — EXISTS. Subdirectories: `architecture/`, `development/`, `integration/`, `security/`, `standards/`, `testing/`, `usage/`; plus `project.md` and `quality-gates.md`.
- `.ai-run/guides/integration/external-integrations.md` — directly covers Claude session processing, SSO proxy plugin architecture, hook pipeline, reasoning-effort normalizer, and provider-to-agent scope rules. This is the primary guide for both bug areas.
- `.ai-run/guides/architecture/architecture.md` — governs the 5-layer plugin architecture and which layer may call which.

### Architectural Decisions

- **ClaudeRequestNormalizerPlugin scoping**: scoped to `codemie-claude`, `codemie-copilot`, and `claude-desktop` — this is the correct plugin for Bug 2 fixes. `RequestSanitizerPlugin` is explicitly excluded from this scope.
- **`effort` is placed in `output_config.effort`** (adaptive thinking API field), not as a top-level request field. `budgetTokensToEffort()` maps `budget_tokens` to `low`/`medium`/`high` enum values.
- **hooks.json uses bare command names**: documented in AGENTS.md as a known failure mode (`command not found: codemie` → `npm install -g @codemieai/code` or `npm link`). The current mitigation is user-level documentation, not code-level resolution.
- **Claude Desktop uses file-discovery, not hook callbacks**: Claude Desktop does not expose CodeMie-managed lifecycle hooks — this decision is recorded in `docs/ARCHITECTURE-PROXY.md` section 6.4.3 and is not affected by this bug.
- **`reasoning.summary` stripping is conservative** and marked as relaxable once confirmed acceptable upstream (`request-sanitizer.plugin.ts:19`).

### Derived Conventions

- To add support for a new model in the proxy normalizer, extend `NO_THINKING_MODEL_PATTERNS` or `ADAPTIVE_THINKING_MODEL_PATTERNS` with a new regex. Do not add ad-hoc conditionals.
- Plugin installers are currently pure-copy; if dynamic path injection is needed, it should be introduced as a post-copy template step in `BaseExtensionInstaller` or as an override in `ClaudePluginInstaller`, not as a side effect in `default-agent-hooks.ts`.
- Hook command strings in `hooks.json` are shell-exec'd verbatim by Claude Code; any absolute-path resolution must produce a POSIX-compatible path string baked into that JSON at install time.

### Todos

- `src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts:19` — `NOTE: stripping reasoning.summary can be relaxed to keep summaries once confirmed desired and accepted by the upstream deployment`
- `src/agents/plugins/claude/sounds-installer.ts:64` — `NOTE: This function violates typical utils layer pattern by handling UI directly`
- `src/agents/plugins/claude/plugin/session-status.mjs:5` — `NOTE: This file is deployed as a standalone script to ~/.claude/ and has no` (imports — standalone constraint)

---

## 4. Testing Landscape

### Existing Coverage

- `src/hooks/__tests__/executor.test.ts` — `HookExecutor` exec dispatch, allow/block decision parsing, deduplication, env var injection; `exec` is fully mocked — real binary resolution is never exercised.
- `src/hooks/__tests__/matcher.test.ts` — hook matcher logic (which hooks fire for which event types).
- `src/hooks/__tests__/decision.test.ts` — hook decision parsing (allow/block/reason).
- `src/agents/plugins/codemie-code-hooks/__tests__/shell-hooks-source.test.ts` — embedded plugin source; transpiles TypeScript at test time, validates handler shape and session ID propagation; uses `cat >> capturePath` as a stand-in for the real `codemie hook` binary — binary resolution is explicitly skipped.
- `src/agents/plugins/kimi/__tests__/kimi.hook-config-injector.test.ts` — verifies `command = "codemie hook"` is written and idempotent for Kimi TOML injection; does not test binary resolution.
- `src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts` — covers haiku thinking stripping, opus-4-7 adaptive transformation with `output_config.effort` boundary values; `claude-sonnet-4-5` appears only as a no-op pass-through case with no assertions about stripping or rejecting unsupported fields.
- `src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts` — strips `reasoningSummary`, `reasoning_summary`, `reasoning` object; preserves `reasoning.effort` on `/v1/responses`; scoped to `codemie-code`/`codemie-opencode` only.
- `src/agents/core/__tests__/reasoning-effort.test.ts` — `applyReasoningEffort()` canonical level normalization and clamping; CLI flag/config/env strategies for all agent types.
- `src/agents/core/__tests__/AgentCLI-effort.test.ts` — `ConfigLoader.exportProviderEnvVars`: verifies `CODEMIE_REASONING_EFFORT` env var emission.
- `src/agents/plugins/claude/__tests__/plugin-installer.test.ts` — `ClaudePluginInstaller` target path, install/already-exists/failure result contract; mocks `fs/promises`; does not inspect command strings written into the installed `hooks.json`.
- `src/cli/commands/__tests__/hook.session-origin.test.ts` — `processEvent` handler; external-resume origin gating; skips start metrics for resumed sessions.
- `src/cli/commands/__tests__/hook.lock.test.ts` — hook concurrency lock.
- `tests/integration/sso-claude-plugin.test.ts` — SSO + Claude plugin integration (real network).

### Testing Framework and Patterns

- Vitest with three project groups: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**` excluding `agent-*`), `agent` (`tests/integration/agent-*.test.ts`, real network, 180 s timeout).
- Coverage via v8 provider; output: text/json/html.
- `vi.spyOn` on module exports for exec/fs calls (not full module mock).
- `vi.mock(module, factory)` at top-level + post-mock `await import(...)` for fresh module state.
- `vi.resetModules()` + `beforeEach` re-import for mutable closure state.
- Inline factory helpers (`createPluginContext`, `createProxyContext`) returning minimal typed objects.
- Real temp-dir fixture (`mkdtempSync` / `rmSync` in `afterAll`) with per-test fresh capture file.
- TypeScript transpile-in-test pattern (`ts.transpileModule`) for embedded plugin source string validation.

### Coverage Gaps

1. **Bug 1 — hook binary resolution:** No test constructs hook command strings with an absolute binary path, calls `which codemie`, or guards against `command not found` when `codemie` is absent from PATH. The `ClaudePluginInstaller` test does not inspect the content of the installed `hooks.json`. `HookExecutor` mocks `exec` entirely. Gap is total across all three Vitest project groups.

2. **Bug 2 — effort stripping for claude-sonnet-4-5 in codemie-claude:** `ClaudeRequestNormalizerPlugin` test treats `claude-sonnet-4-5` as a pass-through with no assertions about removal of `effort` or `output_config.effort`. No test verifies that a request carrying `effort` or `output_config.effort` to `claude-sonnet-4-5` is sanitized before forwarding. `RequestSanitizerPlugin` does not cover `codemie-claude` at all.

3. **Full hook installation verification:** No test validates the complete flow: `ClaudePluginInstaller.install()` → file on disk → command string content in installed `hooks.json`. There is no assertion anywhere that the installed command is path-absolute or resolves correctly.

4. **`codemie hook` absolute vs relative invocation:** No unit or integration test covers the difference between bare `codemie hook` (shell-relative) and an absolute path to the binary (path-safe). This is the structural root of Bug 1 and has zero test coverage.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_BASE_URL` — overrides `baseUrl` from profile config at runtime
- `CODEMIE_API_KEY` — overrides `apiKey` from profile config at runtime
- `CODEMIE_MODEL` — overrides model; propagated to `ANTHROPIC_MODEL`
- `CODEMIE_PROFILE_NAME` — profile name passed into `codemie hook` invocations
- `CODEMIE_PROFILE_CONFIG` — full profile JSON passed to hook subprocess; parsed for `claudeAutocompactPct`, `userEmail`
- `CODEMIE_SESSION_ID` — session ID passed into hook invocations
- `CODEMIE_CLAUDE_EXTENSION_DIR` — set by `default-agent-hooks.ts` after install; used by `enrichArgs` to inject `--plugin-dir`
- `CODEMIE_REASONING_EFFORT` — propagated from `AgentCLI` via `ConfigLoader.exportProviderEnvVars`
- `CODEMIE_STATUS` — set to `'1'` to activate statusline setup before Claude run
- `CODEMIE_AUTO_UPDATE` — controls CLI auto-update on start
- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` — set by CodeMie before spawning Claude
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` / `CLAUDE_CODE_ENABLE_TELEMETRY` / `DISABLE_AUTOUPDATER` / `ENABLE_TOOL_SEARCH` / `ENABLE_PROMPT_CACHING_1H` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — injected by `ClaudePluginMetadata.lifecycle.beforeRun`
- `CODEMIE_NPM_PREFIX` / `CODEMIE_INSTALL_MODE` / `CODEMIE_REGISTRY_URL` / `CODEMIE_SCOPE_REGISTRY_URL` / `CODEMIE_PACKAGE_VERSION` — installer-only vars read by `install/macos/install.sh`

### Configuration Files

- `config.example.json` — top-level profile config template: `provider`, `baseUrl`, `apiKey`, `model` (default `claude-sonnet-4-6`), `timeout`, `debug`, `allowedDirs`, `ignorePatterns`. No `effort` or reasoning fields.
- `src/agents/plugins/claude/plugin/hooks/hooks.json` — installed to `~/.codemie/claude-plugin/hooks/hooks.json`; governs all seven Claude Code hook event commands. Root of Bug 1.
- `src/agents/plugins/claude/plugin/.claude-plugin/plugin.json` — plugin manifest, version `1.0.25`; no binary-path field.

### Feature Flags and Deployment Concerns

- No feature flags identified in the hooks or normalizer domain.
- **Deployment concern — user-prefix install without admin rights:** `install/macos/install.sh` supports `npm config set prefix ~/.codemie/npm-prefix` (user-prefix mode) for environments without admin rights. After install, the bin directory (`~/.codemie/npm-prefix/bin`) must be added to `PATH` manually by the user. The installer prints a message but does not enforce this. When Claude Code fires hook subprocesses in a new shell environment (e.g., launched via GUI), this directory may not be on PATH, causing `codemie: command not found`. This is the exact environment described in Bug 1's precondition.
- **Deployment concern — Claude Code version sensitivity:** `CLAUDE_SUPPORTED_VERSION = '2.1.218'` is pinned in `claude.plugin.ts`. The new CodeMie version references this version or a newer one that may forward `--effort` as `output_config.effort` to the API. The proxy normalizer is the last defensive line, and it currently has no handling for `claude-sonnet-4-5`.

---

## 6. Risk Indicators

- **Bug 1 — bare command in hooks.json with no path resolution:** `src/agents/plugins/claude/plugin/hooks/hooks.json` uses `"command": "codemie hook"` verbatim for all seven events. The installer copies this file as-is. No code in the installer, the hooks-loader, or the provider hooks layer resolves the binary path at install time. This is a structural gap: the only mitigation currently documented is user-level shell profile editing (`AGENTS.md`), which does not work for GUI-launched Claude Code.

- **Bug 2 — claude-sonnet-4-5 missing from both model pattern lists:** `claude-sonnet-4-5` / `claude-4-5-sonnet` is absent from `NO_THINKING_MODEL_PATTERNS` and `ADAPTIVE_THINKING_MODEL_PATTERNS` in `claude-request-normalizer.plugin.ts`. The new Claude Code version forwards `output_config.effort` for models that receive `--effort` via CLI; the normalizer allows this through unchanged; Anthropic API returns HTTP 400.

- **No test for hook binary path after installation:** `plugin-installer.test.ts` mocks `fs/promises` and checks install result contract, but never asserts what command string is written to the installed `hooks.json`. A regression could reintroduce a bare command with no test failure.

- **No test for effort stripping from claude-sonnet-4-5 in codemie-claude scope:** The normalizer test treats `claude-sonnet-4-5` as a no-op and makes no assertions about field removal. A fix without a corresponding test is regression-vulnerable.

- **Model name spelling variant:** The API error reports `claude-4-5-sonnet` (reversed word order) while the codebase and config reference `claude-sonnet-4-5`. Both spellings must be handled by any regex added to the pattern lists.

- **hooks-loader.ts expansion mechanism is NOT used for Claude Code hooks.json:** There is an existing template variable system (`${CLAUDE_PLUGIN_ROOT}`) in `hooks-loader.ts` but it only applies to CodeMie's internal plugin manifests, not to the file Claude Code reads from `--plugin-dir`. Any fix that attempts to use this mechanism for Bug 1 will not work without extending the installation flow.

- **`getCommandPath()` utility exists but is not plumbed into hook construction:** `src/utils/processes.ts` has a `which`-based resolver that could provide the absolute binary path, but it is currently used only for resolving the Claude Code binary itself, not for constructing hook command strings.

- **RequestSanitizerPlugin does not cover codemie-claude traffic:** If effort-related fields reach the SSO proxy for `codemie-claude` requests, `RequestSanitizerPlugin` will not intercept them. The `ClaudeRequestNormalizerPlugin` is the only defensive point, and it currently passes `claude-sonnet-4-5` through unchanged.

- **No integration test for the full codemie-claude hook install flow:** `tests/integration/sso-claude-plugin.test.ts` exists but covers SSO+plugin integration, not hook installation and binary resolution. There is no end-to-end test that runs install → checks hooks.json → fires a mock SessionStart event → verifies `codemie hook` is invoked successfully.

- **User-prefix install PATH gap is a known issue but unmitigated in code:** AGENTS.md documents `command not found: codemie` as a known failure with a manual workaround. The fix acceptance criteria explicitly require this to work without admin rights and without manual shell configuration.

---

## 7. Summary for Complexity Assessment

This task repairs two independent but co-located bugs in the `codemie-claude` plugin layer. Bug 1 (hook binary path) touches the **Agent plugin layer** and the **Provider hooks layer**: the change surface is narrow — the hook command string template in `src/agents/plugins/claude/plugin/hooks/hooks.json` and the install logic in `ClaudePluginInstaller` / `BaseExtensionInstaller`. The fix requires resolving the absolute path to the `codemie` binary at install time (e.g., via `process.argv[1]`, `which`, or reading `npm bin -g` / npm-prefix) and writing it into the installed `hooks.json`. The sound commands (`codemie sound <Event>`) have the same issue and must be fixed alongside the hook commands. No new architectural patterns are required; this is an augmentation of the existing pure-copy installer with a post-copy rewrite step or pre-baked path substitution. Complexity is low-to-medium: the logic is straightforward, but it must handle both global install and user-prefix install paths correctly and the `getCommandPath()` utility in `processes.ts` may be reusable.

Bug 2 (effort parameter stripping) touches only the **SSO proxy plugin layer**: the change is a two-line addition of `claude-sonnet-4-5` and `claude-4-5-sonnet` regex patterns to `NO_THINKING_MODEL_PATTERNS` in `claude-request-normalizer.plugin.ts`. The existing pattern-list convention is well-established and the fix follows exactly the same pattern used for haiku models. The complexity of the code change is very low. However, the fix requires a clear product decision: should `claude-sonnet-4-5` receive the same treatment as haiku (strip thinking entirely), or should it receive adaptive thinking support if that is future-supported? The current evidence — HTTP 400 from Anthropic — indicates no extended thinking support, so `NO_THINKING_MODEL_PATTERNS` is the correct target. The model name spelling variant (`claude-4-5-sonnet`) must also be covered.

Test coverage posture for both bugs is poor: the two critical gaps are (a) no test asserting that the installed `hooks.json` contains a path-absolute command string, and (b) no test asserting that `claude-sonnet-4-5` requests via `codemie-claude` have `thinking`/`effort` fields stripped by the normalizer. New unit tests must be written for both fixes before merge; the existing Vitest infrastructure (`createPluginContext` helpers, `mkdtempSync` fixtures, `vi.mock` for fs) makes adding these tests straightforward. The mandatory `make test-harness` gate must pass. Overall implementation effort is low-to-medium; the primary risk is ensuring the binary path resolution is robust across all install modes (global, user-prefix, npm link, local dev) without hardcoding paths.
