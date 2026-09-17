# Technical Research

**Task**: codex model resolution plugin resolveCodexModel rankModel
**Generated**: 2026-06-17T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

Fix the bug where codemie-codex --model <model> does not honor the explicit model flag. The bug is in resolveCodexModel (src/agents/plugins/codex/codex-models.ts:274-305) which always picks rankedModels[0].id instead of respecting currentModel when it is Codex-compatible and present in the available list. The fix (Option A from the spec) is to check if currentModel is Codex-compatible and present in rankedModels, and if so, select it instead of the top-ranked model. Also need to make the substitution notice user-visible on stderr when a requested model is overridden.

---

## 2. Codebase Findings

### Existing Implementations

**Core fix target**

- `src/agents/plugins/codex/codex-models.ts` — all model-resolution logic for codex
  - `isCodexCompatibleModelName(modelName)` (line 106) — exported predicate; returns true if `modelName` matches `COMPATIBLE_CODEX_MODEL_PATTERNS` (`/codex/i`, `/^gpt[-.]?5/i`, `/^gpt[-.]?6/i`) and does **not** match `INCOMPATIBLE_MODEL_PATTERNS` (claude, sonnet, opus, haiku, anthropic, gemini, qwen, deepseek, llama, mistral, grok).
  - `isCodexCompatibleModel(model: LlmModel)` (line 112) — private; checks `model.enabled` then calls the regex patterns on `getSearchText(model)`.
  - `rankModel(model)` (line 146) — computes a sort key as `[preferredDefaultBonus, ...versionParts, codexBonus, toolBonus, streamingBonus, defaultBonus]`. The first element, `preferredDefaultBonus`, is `1` when the model name matches `/gpt[-.]?5[-.]?4(?:[-.]|\b)/i`, otherwise `0`. This is why `gpt-5.4-*` always sorts first regardless of any user-requested model.
  - `compareRankedModels(a, b)` (line 169) — lexicographic comparison on the score array; tie-broken by `id.localeCompare`.
  - `resolveCodexModel(env)` (line 256) — **the function to change**. Reads `currentModel = env.CODEMIE_MODEL` at line 257, fetches available models, filters/ranks them. Currently selects `selectedModel = rankedModels[0].id` at line 292 unconditionally. `currentModel` is only used in the two fallback branches (fetch failure at line 263, empty model list at line 280). Returns `{ selectedModel, catalogPath, availableModels }`.
  - `assertExplicitCodexModelAllowed(model, availableModels)` (line 308) — exported guard; throws `ConfigurationError` if `model` is not Codex-compatible or not in the available list. Called in `enrichArgs` at codex.plugin.ts:283.
  - Substitution log (lines 295-299): `if (currentModel && currentModel !== selectedModel) { logger.info(...) }` — currently uses `logger.info` which writes to log file only; not visible to users unless `CODEMIE_DEBUG=true`.

**Plugin and CLI layer**

- `src/agents/plugins/codex/codex.plugin.ts`
  - `setupProxy(env)` (line 510) — overrides the base class method. **LiteLLM path** (line 511-521): when `CODEMIE_PROVIDER === 'litellm'`, validates `env.CODEMIE_MODEL` is Codex-compatible, sets `CODEMIE_CODEX_AVAILABLE_MODELS = env.CODEMIE_MODEL`, calls `super.setupProxy(env)` and returns — never calls `resolveCodexModel`. **SSO/default path** (line 524-532): calls `resolveCodexModel(env)`, then overwrites `env.CODEMIE_MODEL = resolution.selectedModel` and sets `CODEMIE_CODEX_AVAILABLE_MODELS` and `CODEMIE_CODEX_MODEL_CATALOG_JSON`.
  - `lifecycle.enrichArgs(args, config)` (line 249) — called after `setupProxy` has already overwritten `env.CODEMIE_MODEL`. Checks for a `--model` in passthrough `args` via `getExplicitModelArg(enriched)` (line 276); if found, validates it via `assertExplicitCodexModelAllowed`. If not found (which is always the case for `--model` from the CLI, since it is consumed by Commander and not included in passthrough args), falls back to `else if (config?.model) { enriched = ['--model', config.model, ...enriched]; }` at line 284-285. At that point `config.model` is the **already-overwritten** value from `setupProxy`.
  - `getExplicitModelArg(args)` (line 427) — scans for `-m`/`--model`/`--model=` in the raw passthrough args. Returns `undefined` when the flag was consumed by Commander — confirming the enrichArgs branch that auto-injects the model always fires for CLI-level `--model`.
  - `CodexPluginMetadata.envMapping.model` (line 133): set to `[]` (empty), so the base `transformEnvVars` never maps `CODEMIE_MODEL` to any agent-specific env var; model reaches Codex exclusively via the injected `--model` CLI arg.

- `src/agents/core/AgentCLI.ts`
  - `setupProgram()` (line 58) defines `-m, --model <model>` as a Commander option (line 72).
  - `handleRun(args, options)` (line 151): reads `options.model` and passes it to `ConfigLoader.load(cwd, { model: options.model })` at line 182.
  - `collectPassThroughArgs(args, options)` (line 449): the `configOnlyOptions` array at line 455 includes `'model'`. So `--model` from the CLI is **never** forwarded to the agent binary as a passthrough argument — it is only available via `CODEMIE_MODEL` in the env.
  - `providerEnv` is built by `ConfigLoader.exportProviderEnvVars(config)` (line 285). `exportProviderEnvVars` sets `env.CODEMIE_MODEL = config.model` at line 1347 if `config.model` is present. This env dict is passed as `envOverrides` to `this.adapter.run(agentArgs, providerEnv)` at line 318.

- `src/agents/core/BaseAgentAdapter.ts`
  - `run(args, envOverrides)` (line 331): merges env at line 479 as `{ ...process.env, ...envOverrides, CODEMIE_SESSION_ID, ... }`. Then calls `await this.setupProxy(env)` at line 494 — the CodexPlugin override runs here and may overwrite `CODEMIE_MODEL`. The resulting model is then passed into `extractConfig(env)` which yields `config.model = env.CODEMIE_MODEL` — already overwritten at that point. `enrichArgs` receives this modified config.

### Architecture and Layers Affected

| Layer | Component | Change needed |
|---|---|---|
| Plugin — model resolution | `codex-models.ts:resolveCodexModel` (line 292) | Core logic change: select `currentModel` when Codex-compatible and in `rankedModels` |
| Plugin — substitution notice | `codex-models.ts:295-299` | Replace `logger.info` with an additional `console.error` for user visibility |
| Plugin — lifecycle | `codex.plugin.ts:setupProxy` | No change needed; correctly consumes whatever `resolveCodexModel` returns |
| Plugin — lifecycle | `codex.plugin.ts:enrichArgs` | No change needed |
| CLI | `AgentCLI.ts` | No change needed (Option A) |

### Integration Points

- `resolveCodexModel` is called only from `CodexPlugin.setupProxy` (2 call sites verified: SSO path at line 524; LiteLLM path does NOT call it — confirmed).
- `assertExplicitCodexModelAllowed` is called only from `lifecycle.enrichArgs` at codex.plugin.ts:283. It guards passthrough `--model` args in native Codex invocations (not the CodeMie CLI `--model` flag). Unaffected by this fix.
- `isCodexCompatibleModelName` is called from: `resolveCodexModel` (lines 263, 280), `setupProxy` (line 512), `assertExplicitCodexModelAllowed` (line 309). All four usages are read-only; the function itself does not change.
- `fetchCodeMieLlmModels` / `CodeMieSSO` — external SSO model-list API. Called inside `fetchCodeMieModelsForCodex`; behavior unchanged.
- `writeCatalogFile` (line 293) — writes `~/.codex/codemie/models.json`; called unconditionally after model resolution. The catalog is always built from `rankedModels` regardless of which model is selected, so it remains correct after the fix.

### Patterns and Conventions

- User-facing messages go to `console.error` (stderr), not `console.log` (stdout). The task spec cites this rule from the unified-headless-sessions work. The substitution notice must follow the same pattern.
- `logger.*` is file-only (writes to `~/.codemie/logs/`); visible to users only with `CODEMIE_DEBUG=true`.
- `ConfigurationError` (from `src/utils/errors.ts`) is used for user-facing hard errors in this module. The substitution notice is a soft notice (not an error), so it should use `console.error` with an informational tone, not a `throw`.
- `resolveCodexModel` already uses the pattern of consulting `currentModel` in fallback branches (lines 263, 280). The fix extends this pattern to the success path.
- The `rankedModels` array and the `buildCodexCatalog` call are based on all compatible models, independent of the selected model. This separation must be preserved.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — covers the 5-layer plugin architecture. The Codex plugin sits in Layer 3 (Agent Plugin).
- `.ai-run/guides/development/development-practices.md` — covers error handling, async patterns, logging.
- `.ai-run/guides/integration/external-integrations.md` — covers provider plugins.
- `docs/specs/codex-explicit-model/task.md` — the task spec, fully detailed, serves as the primary design document for this change. Read in full during analysis.

### Architectural Decisions

- **ADR implicit in spec §6**: the LiteLLM path must not be touched. It already honors `env.CODEMIE_MODEL` correctly. The fix scope is strictly the SSO/default path in `resolveCodexModel`.
- **`model` env mapping is empty** (`envMapping.model: []` in CodexPluginMetadata): Codex receives the model exclusively via the `--model` CLI arg injected by `enrichArgs`. This is a deliberate decision (see the inline comment about `auth.json` priority at codex.plugin.ts:8-13); it remains unchanged.
- **`configOnlyOptions` in AgentCLI**: `model` is consumed by Commander and never forwarded as a passthrough arg. This is the core reason `getExplicitModelArg` always returns `undefined` for CLI-level `--model`, and why the fix must live in `resolveCodexModel` (called from `setupProxy`, before `enrichArgs`) rather than in `enrichArgs`.

### Derived Conventions

- The `catalog` (`buildCodexCatalog(rankedModels)`) is always built from all compatible models and does not reflect the selected model. This is correct and must not change: the catalog tells Codex what models are available to offer the user, not which one was selected.
- Substitution logging pattern: the existing `if (currentModel && currentModel !== selectedModel) { logger.info(...) }` block at lines 295-299 is the right structural location. After the fix it needs a companion `console.error` (or `process.stderr.write`) for the cases where a requested Codex-compatible model is silently substituted.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/codex/__tests__/codex.plugin.lifecycle.test.ts` — covers `onSessionStart`/`onSessionEnd` timer wiring only. Does NOT test `resolveCodexModel`, `enrichArgs`, `assertExplicitCodexModelAllowed`, or `rankModel`.
- `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` — covers version compatibility checks.
- `src/agents/plugins/codex/__tests__/codex.metrics-processor.test.ts`, `codex.paths.test.ts`, `codex.incremental-sync.test.ts`, `codex.reconciliation.test.ts`, `codex.conversations-processor.test.ts` — cover other concerns unrelated to model resolution.
- `src/agents/core/__tests__/AgentCLI-effort.test.ts` — covers `ConfigLoader` and `exportProviderEnvVars`; does not test codex model resolution.
- `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — covers `shouldUseProxy` and base adapter mechanics.

### Testing Framework and Patterns

- Vitest is the test runner. Test files live in `__tests__/` subdirectories.
- Mocks use `vi.mock` / `vi.doMock` with dynamic imports for isolation.
- Logger is always mocked via `vi.mock('../../../../utils/logger.js', ...)`.

### Coverage Gaps

- **`resolveCodexModel`** — zero test coverage. All branches (fetch-failure, no-compatible-models, normal selection, currentModel honored, currentModel substituted) are untested.
- **`rankModel` / `compareRankedModels`** — zero test coverage.
- **`isCodexCompatibleModelName`** — zero test coverage.
- **`assertExplicitCodexModelAllowed`** — zero test coverage.
- **`enrichArgs` model injection** — zero test coverage.
- **`CodexPlugin.setupProxy`** — zero test coverage.

These gaps are noted here for completeness; tests are only to be written on explicit user request per project policy.

---

## 5. Configuration and Environment

### Environment Variables

| Variable | Set by | Read by | Role |
|---|---|---|---|
| `CODEMIE_MODEL` | `exportProviderEnvVars` (from `config.model`) | `resolveCodexModel` (as `currentModel`), `setupProxy` (LiteLLM check), `enrichArgs` (via `extractConfig`) | User-requested or profile-default model name |
| `CODEMIE_CODEX_AVAILABLE_MODELS` | `CodexPlugin.setupProxy` (after `resolveCodexModel`) | `enrichArgs` (line 277) | Comma-separated list of ranked available model IDs; used by `assertExplicitCodexModelAllowed` |
| `CODEMIE_CODEX_MODEL_CATALOG_JSON` | `CodexPlugin.setupProxy` (from `resolution.catalogPath`) | `enrichArgs` (line 301) | Path to `~/.codex/codemie/models.json`; injected as `--config model_catalog_json="..."` |
| `CODEMIE_PROVIDER` | `exportProviderEnvVars` | `CodexPlugin.setupProxy` (LiteLLM branch guard), `BaseAgentAdapter.shouldUseProxy` | Provider name (e.g. `ai-run-sso`, `litellm`) |
| `CODEMIE_JWT_TOKEN` / `CODEMIE_BASE_URL` | Config load / CLI `--jwt-token` | `fetchCodeMieModelsForCodex` | JWT auth path for model list fetch |
| `CODEMIE_URL` | Config | `fetchCodeMieModelsForCodex` | SSO auth path for model list fetch |
| `CODEX_HOME` | `lifecycle.beforeRun` | Codex binary | Isolates codemie-codex state from native Codex (`~/.codex/codemie/home`) |
| `CODEMIE_CODEX_BIN` | User env (optional) | `CodexPluginMetadata.cliCommand` | Override for the `codex` binary path |

### Configuration Files

- `~/.codex/codemie/models.json` — written by `writeCatalogFile` at runtime; contains the model catalog injected into Codex via `--config model_catalog_json`. Not a source file.
- `~/.codemie/agents/codex/` — agent install location; not relevant to the fix.

### Feature Flags and Deployment Concerns

No feature flags gate the model resolution logic. The fix is a pure logic change in `resolveCodexModel` with no deployment dependencies.

---

## 6. Risk Indicators

- **Zero test coverage for `resolveCodexModel`** — the central function being modified has no unit tests. The fix must be validated manually or via the reproduction command in spec §8.1 until tests are written.
- **`rankModel` `preferredDefaultBonus` for gpt-5.4** (`codex-models.ts:149`) — this hardcoded preference is the root cause of gpt-5.4 winning. The fix changes selection logic but does not touch ranking. If `currentModel` is absent or non-Codex-compatible, gpt-5.4 will still win via ranking. This is the intended behavior per spec §4 (and out of scope per spec §10).
- **`setupProxy` overwrites `env.CODEMIE_MODEL`** (`codex.plugin.ts:526`) — after the fix, `resolveCodexModel` returns the honored model; `setupProxy` still overwrites the env var. This is correct behavior (the welcome message at `BaseAgentAdapter.run:504` reads `env.CODEMIE_MODEL` and should show the actual model in use). No side effects expected.
- **`buildCodexCatalog` is always built from all ranked models, not the selected model** — catalog correctness is independent of selection; verified safe.
- **LiteLLM path isolation** — `CodexPlugin.setupProxy` guards the LiteLLM path with an early return (lines 511-522) before calling `resolveCodexModel`. The fix in `resolveCodexModel` cannot affect the LiteLLM path. Verified structurally.
- **`console.error` for substitution notice** — the spec calls for stderr output. `console.error` writes to stderr in Node.js, matching the pattern used elsewhere in the codebase for user-facing warnings. Chalk styling (yellow/info-toned) is consistent with other non-error notices.
- **`currentModel` is the model name string, not an `LlmModel` object** — `isCodexCompatibleModelName` takes a `string | undefined` and `rankedIds.includes(currentModel)` does a string equality check. The `id` field in `RankedModel` comes from `getModelId(model)` which returns `model.deployment_name || model.base_name || model.label`. When the user passes `gpt-5.3-codex-2026-02-24`, the API must return an entry whose `deployment_name`/`base_name`/`label` exactly matches that string for the `includes` check to succeed. This is the known-good case from the spec's reproduction (the model is confirmed in `CODEMIE_CODEX_AVAILABLE_MODELS`).
- **No covering tests for `isCodexCompatibleModelName`** — the regex patterns (`/^gpt[-.]?5/i`, `/^gpt[-.]?6/i`, `/codex/i`) have not been tested; however, they are unchanged by this fix.

---

## 7. Summary for Complexity Assessment

This is a surgical, low-risk bug fix confined to a single function (`resolveCodexModel`) in one file (`src/agents/plugins/codex/codex-models.ts`). The change involves replacing two lines (line 292: `const selectedModel = rankedModels[0].id;` plus the surrounding substitution log at lines 295-299) with approximately six lines that first check whether `currentModel` is Codex-compatible and present in the ranked set, select it if so, otherwise fall back to `rankedModels[0].id`, and emit a `console.error` notice when a Codex-compatible requested model cannot be honored. No other files require modification under Option A (the recommended approach). `setupProxy`, `enrichArgs`, `AgentCLI`, and the LiteLLM path are all architecturally correct as written; they consume `resolveCodexModel`'s return value and `env.CODEMIE_MODEL` unchanged.

The layers touched are: Plugin Model Resolution (single function in `codex-models.ts`) and indirectly the Plugin Lifecycle layer (via `setupProxy` reading the return value — no code change there). The effective file change surface is one file, one function, approximately 6-8 lines replaced. The fix follows an established pattern already used in the fallback branches of the same function (`currentModel` is already consulted at lines 263 and 280).

Test coverage posture for this area is weak — `resolveCodexModel`, `rankModel`, `isCodexCompatibleModelName`, and `assertExplicitCodexModelAllowed` have zero automated coverage. The fix correctness will rely on manual verification (the reproduction command in spec §8.1) until unit tests are added on explicit request. The risk of regression in the LiteLLM path or `enrichArgs` is structurally ruled out by code structure (LiteLLM early return, `enrichArgs` consuming the already-resolved value). The primary risk factor is the string-identity match between `currentModel` and the `rankedModels` IDs — verified safe via the spec's confirmed reproduction where the model appears in `CODEMIE_CODEX_AVAILABLE_MODELS`.
