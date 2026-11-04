# Technical Research

**Task**: profile setup model selection switch config codemie-cli.config.json providers model picker
**Generated**: 2026-10-06T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Ability to select multiple models during codemie profile setup and switch between them (in the CLI), because right now codemie sets up profile per model

---

## 2. Codebase Findings

### Existing Implementations

**Setup wizard: `src/cli/commands/setup.ts`, 818 lines**
- `runSetupWizard()` (l.52). Offers "Add a new profile / Update an existing profile / Cancel" when profiles exist (l.80-91). It then asks where to store the profile (global or local) and which provider to use (`ProviderRegistry.getAllProviders()`, l.198-211).
- On update, the storage location comes from `hasLocalConfig`, not from where the profile actually lives: `storageLocation = hasLocalConfig ? 'local' : 'global'` (l.112).
- `handlePluginSetup()` (l.229) runs these steps in order:
  1. `setupSteps.getCredentials(isUpdate)` (l.240).
  2. `setupSteps.fetchModels(credentials)` returns `string[]`. If it fails, the result is `[]` (l.247-252).
  3. Optional `setupSteps.selectModel()` auto-pick (l.256-262). If it returns nothing, `promptForModelSelection()` runs (l.264).
  4. Optional `installModel(credentials, selectedModel, models)` for Ollama (l.268-270).
  5. `autoSelectModelTiers(models, selectedModel)`, only when the Claude agent lists this provider in `supportedProviders` (l.272-281).
  6. `setupSteps.buildConfig(credentials, selectedModel)` (l.284). Haiku/sonnet/opus tiers are merged in at l.292-294.
  7. `promptForProfileName()` (l.299 / l.403).
  8. Save: local goes through `ConfigLoader.initProjectConfig` (l.311), global through `ConfigLoader.saveProfile` (l.344). It then offers to switch to the new profile (l.327-339, l.351-364).
  9. `displaySetupSuccess(name, provider, selectedModel)` (l.369).
- `promptForModelSelection()` (l.447-547) is a **single-choice** inquirer `type: 'list'` prompt (l.515-523). Its choices are `getAllModelChoices(...)` plus "Custom model (manual entry)..." plus an optional "Search Ollama library..." entry. When no models are available it falls back to manual text input (l.455-488). Every branch returns one `string`.
- `autoSelectModelTiers(models, selectedModel)` (l.624-700, exported) fills:
  - `haikuModel`: the latest haiku model.
  - `sonnetModel`: the env var if set, otherwise the selected model if it is a sonnet, otherwise the latest sonnet.
  - `opusModel`: the latest opus model.
  - It honours `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` env vars and references EPMCDME-12779.

**Config types: `src/env/types.ts`**
- `ProviderProfile` has `model?: string` (a single scalar), `reasoningEffort?`, the tier fields `haikuModel?`, `sonnetModel?` and `opusModel?`, plus credentials and provider-specific fields.
- `MultiProviderConfig` is `{ version: 2; activeProfile: string; codemieSkills?; codemieAssistants?; userEmail?; workspace?: WorkspaceConfig; profiles: Record<string, ProviderProfile> }`.
- `CodeMieConfigOptions = ProviderProfile & WorkspaceConfig` is the runtime merged shape.
- Type guards: `isMultiProviderConfig` requires `version === 2 && profiles && activeProfile`. `isLegacyConfig` matches flat v1 configs.

**Config loader: `src/utils/config.ts` (`ConfigLoader`, 1573 lines)**
- `load(workingDir, cliOverrides)` (l.91-201) merges, from lowest to highest priority: defaults, then the global profile, then the local profile (only when the profile names match, `applyProjectOnly` l.124-129), then the workspace, then env, then CLI.
  - When `--profile` is given, `CODEMIE_MODEL` from env is dropped unless `--model` was also given (l.164-167).
  - Merging is a field-level `Object.assign`.
- `loadFromEnv()` maps `CODEMIE_MODEL` to `model` (l.466-468).
- `saveProfile(name, profile)` (l.650-671) **replaces** `config.profiles[name]` wholesale (l.659) after splitting workspace keys out (`splitProfileAndWorkspace`, l.631). Global config only.
- `initProjectConfig(workingDir, overrides)` (l.929-969) writes a **fresh** local file with a single profile, `activeProfile` set to it, and the workspace only if one was supplied (l.954-968).
- Other profile operations:
  - `switchProfile(name, workingDir)` (l.728-766) only sets `activeProfile`. It writes to the local config when one exists, otherwise to the global config.
  - `listProfiles()` (l.772-836) merges local and global profiles (local wins on name collision).
  - `getProfile()` (l.842).
  - `renameProfile()` (l.863, global only).
  - `deleteProfile()` (l.677).
  - `getActiveProfileName()` (l.891).
- `validate()` (l.1122-1143) throws `CODEMIE_MODEL is required` when `model` is missing (l.1133).
- `loadWithSources()` / `showWithSources()` (l.1253-1385) track the source of each field for `codemie profile status --show-sources`.
- `exportProviderEnvVars(config)` (l.1479-1519):
  - Emits a single `CODEMIE_MODEL` (l.1494).
  - Always emits `CODEMIE_HAIKU_MODEL`, `CODEMIE_SONNET_MODEL` and `CODEMIE_OPUS_MODEL`, even when empty (l.1499-1501, EPMCDME-12779).
  - Then applies the provider template's `exportEnvVars`.

**Profile command: `src/cli/commands/profile/index.ts`, 464 lines**
- Subcommands: default list, `status [--show-sources]`, `login`, `logout`, `refresh`, `switch [profile]`, `delete [profile]`, `rename <old> <new>`.
- `switch` (l.~330) calls `promptProfileSelection()`, which uses `promptProfileSelectionCustom()`. That is a raw-mode stdin selector built on `shared/selection/ui.ts` `buildSingleChoiceRow` and `buildTopLine`. It then calls `ConfigLoader.switchProfile`.
- No model-level switch exists. Changing a profile's model today means re-running `codemie setup` and choosing "Update an existing profile", or passing `--model` on each run.

**Profile display**
- `src/cli/commands/profile/display.ts`: `ProfileDisplay.format()` (l.39) and `formatStatus()` (l.120) render `profile.model || 'N/A'`.
- `src/utils/profile.ts`: `renderProfileInfo()` renders one "Model" row (l.53-55).

**Models command: `src/cli/commands/models.ts`, 117 lines**
- `codemie models` has a single subcommand, `list`. It loads the effective config, then calls `ProviderRegistry.getModelProxy(provider).fetchModels(config)`, which returns `ModelInfo[]`, and prints a table.
- `UNSUPPORTED_PROVIDERS = {'openai','openai-compatible'}`.
- It does not read or write the profile model.

**Provider plugin contract: `src/providers/core/types.ts`**
- `ProviderSetupSteps`:
  - `getCredentials`.
  - `fetchModels(credentials): Promise<string[]>`.
  - `selectModel?(credentials, models, template)`.
  - `searchModel?(credentials)`.
  - `getRecommendedModels?(models, credentials)`.
  - **`buildConfig(credentials, selectedModel: string)`**.
  - `installModel?(credentials, selectedModel, availableModels)`.
  - `validate?`, `postSetup?`, `validateAuth?`, `promptForReauth?`, `getAuthStatus?`.
- `ProviderTemplate` has `recommendedModels`, `modelMetadata`, `exportEnvVars?(config)` and `agentHooks?`.
- `ProviderModelFetcher.fetchModels(config): Promise<ModelInfo[]>`.

**Provider setup-steps (every `buildConfig` writes a single `model: selectedModel`)**
- `sso/sso.setup-steps.ts`: `fetchModels` l.159 (through `SSOModelProxy`), `buildConfig` l.174.
- `litellm/litellm.setup-steps.ts`: `fetchModels` l.37, `buildConfig` l.55.
- `bedrock/bedrock.setup-steps.ts`: l.299 and l.335.
- `jwt/jwt.setup-steps.ts`: l.113 and l.126.
- `ollama/ollama.setup-steps.ts`: `fetchModels` l.190, plus `searchModel`, `getRecommendedModels` and `installModel`; `buildConfig` l.466.
- `anthropic-subscription.setup-steps.ts`: `fetchModels` returns `[]` (l.96), `selectModel` auto-picks on the analytics-linked path (l.102), `buildConfig` l.118.
- `moonshot-subscription.setup-steps.ts`: l.83, `selectModel` l.89, `buildConfig` l.102.

**Setup UI helpers: `src/providers/integration/setup-ui.ts`**
- `computeRecommendedModelIds()` (l.144), `formatModelChoice()` (l.175), `getAllModelChoices(models, template, recommendedOverrideIds)` (l.241, recommended models sorted first), `displaySetupSuccess()` (l.269).

**Runtime model consumption (agent launch)**
- `src/agents/core/AgentCLI.ts`:
  - Options `--profile <name>` (l.77) and `-m, --model <model>` (l.79).
  - `ConfigLoader.load(cwd, { name: options.profile, model: options.model, ... })` (l.196-204).
  - Exits with "Configuration incomplete" when `model` is missing (l.263).
  - Sets `CODEMIE_MODEL_SOURCE` to `cli`, `env` or `default` (l.375-379).
  - `validateCompatibility()` (l.663-706) blocks incompatible models and suggests `codemie models list` and `--model <model-id>`.
- `src/agents/core/BaseAgentAdapter.ts`: `transformEnvVars()` maps `CODEMIE_MODEL` onto each agent's `envMapping.model` (l.1171-1173) and handles subagent pinning (EPMCDME-14355).

**Agent plugins with existing model-list or in-session switching behaviour**
- Claude (`claude/claude.plugin.ts` l.384-460, `claude/claude.models.ts`):
  - Per-tier auto-heal from the live CodeMie catalog (`resolveClaudeModel`) rewrites `CODEMIE_MODEL` / `ANTHROPIC_MODEL` when the model is stale.
  - It skips auto-heal when `CODEMIE_MODEL_SOURCE` is in `EXPLICIT_MODEL_SOURCES` (claude.models.ts l.28, l.478-483).
  - A comment notes that Claude Code's own `/model` command switches models mid-session without re-running `beforeRun`.
- Codex (`codex/codex.plugin.ts` l.501-540, `codex-models.ts` l.94-99, 412): `resolveCodexModel(env)` ranks catalog models, and `CODEMIE_CODEX_AVAILABLE_MODELS` exposes the allowed list.
- codemie-code (`codemie-code.plugin.ts` l.268-300):
  - The selected model is `env.CODEMIE_MODEL || config.model || 'gpt-5-2-2025-12-11'`.
  - `fetchDynamicModelConfigs()` puts the whole catalog into the generated OpenCode config.
  - `opencode-model-configs.ts` l.576 says this is "so users can switch models during a session".
- Gemini (`gemini.plugin.ts` l.141-149, `-m config.model`), Pi (`pi.plugin.ts` l.347, `--model`) and copilot-cli (l.215-222) each take one model.

**Other consumers of `config.model`**
- Proxy:
  - `sso/proxy/plugins/header-injection.plugin.ts` l.65 (`X-CodeMie-CLI-Model`).
  - `claude-request-normalizer.plugin.ts` l.214.
  - `codex-request-normalizer.plugin.ts` l.218.
  - `cli/commands/proxy/connect-orchestrator.ts` l.380, 421, 620, 756, 788 (`profileModel`, daemon model pin).
- Health checks: `providers/core/base/BaseHealthCheck.ts` l.68 and `sso/sso.health.ts` l.116 check the configured model against the catalog.
- Doctor: `cli/commands/doctor/checks/AIConfigCheck.ts` l.42 and 118.
- Hooks: `hooks/prompt-executor.ts` l.51.

**Config migrations: `src/migrations/`**
- 001-007 are registered through `src/migrations/index.ts` and tracked in `~/.codemie/migrations.json`.
- `007-decouple-provider-workspace-config.migration.ts` is the latest schema-reshaping precedent. It has an idempotent `migrate(config)` and writes through `ConfigLoader.saveMultiProviderConfig` and `saveLocalMultiProviderConfig`.

### Architecture and Layers Affected
- **CLI layer**:
  - `src/cli/commands/setup.ts` (wizard model step, save path).
  - `src/cli/commands/profile/index.ts` (switch command, selector UI).
  - `src/cli/commands/profile/display.ts` (model rendering).
  - `src/cli/commands/models.ts` (`models list` only).
  - Registration in `src/cli/index.ts` (l.84-85 setup/profile; `createModelsCommand` imported l.33).
- **Agent CLI / core**: `src/agents/core/AgentCLI.ts` (`--profile`, `--model`, `CODEMIE_MODEL_SOURCE`) and `src/agents/core/BaseAgentAdapter.ts` (env transform).
- **Core types**: `src/env/types.ts` (`ProviderProfile`, `MultiProviderConfig`) and `src/providers/core/types.ts` (`ProviderSetupSteps.buildConfig` signature).
- **Utils**: `src/utils/config.ts` (`ConfigLoader` load/save/switch/validate/exportProviderEnvVars) and `src/utils/profile.ts` (`renderProfileInfo`).
- **Provider plugins**: the 7 `*.setup-steps.ts` files (`buildConfig` with a single model) and `src/providers/integration/setup-ui.ts` (model choice formatting).
- **Agent plugins**: claude, codex and codemie-code/opencode model resolution, which reads `CODEMIE_MODEL` / `CODEMIE_MODEL_SOURCE`.
- **Migrations**: `src/migrations/` (precedent for config reshaping).

### Integration Points
- Dependency direction:
  - `setup.ts` → `ConfigLoader`, `ProviderRegistry`, `setup-ui`, `AgentRegistry`.
  - `profile/index.ts` → `ConfigLoader`, `ProviderRegistry`, `shared/selection`.
  - `models.ts` → `ConfigLoader`, `ProviderRegistry.getModelProxy`.
  - `AgentCLI` → `ConfigLoader.load` → `exportProviderEnvVars` → `BaseAgentAdapter.transformEnvVars` → plugin `beforeRun` and `setupProxy` hooks.
- External services:
  - CodeMie API model catalog (SSO/JWT through `SSOModelProxy`; `/v1/llm_models` in `opencode-dynamic-models.ts`).
  - LiteLLM `/models` (`LiteLLMModelProxy`).
  - AWS Bedrock (`@aws-sdk/client-bedrock`).
  - The local Ollama daemon and the ollama.com library.
  - Anthropic and Moonshot subscriptions have no catalog.
- The proxy daemon (`proxy connect`) pins `config.model` into daemon state (connect-orchestrator.ts).

### Patterns and Conventions
- **Layering**: CLI → Registry → Plugin. Providers self-register through `ProviderRegistry.registerSetupSteps()`, `registerModelProxy()` and `registerProvider()`.
- **Persistence**: all config persistence goes through `ConfigLoader` static methods. There are two scopes, `StorageScope.GLOBAL` and `StorageScope.LOCAL`, and both use the `version: 2` schema.
- **Prompt styles** (both are in use):
  - inquirer v9 prompts: `list`, `input`, `confirm`, and `checkbox` in `src/cli/commands/update.ts` l.195-203 and `skills/lib/agent-detection.ts`.
  - A custom raw-mode selector built on `src/cli/commands/shared/selection/` (`buildSingleChoiceRow`, `buildSelectionRow`, `createInteractivePrompt`), used for profile switching.
  - `@clack/prompts` is also a dependency.
- **Env vars**: model values reach agents only through `CODEMIE_*` env vars, never by direct config reads, except where `config.model` is passed into plugin hooks.
- **Schema changes** ship as numbered idempotent migrations registered in `src/migrations/index.ts`.
- **Code conventions**: ES modules with `.js` import suffixes, `logger.debug` instead of `console.log`, specific error classes (`ConfigurationError`), and `sanitizeLogArgs` for secrets.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md` (P0 for config/profile/setup):
  - Config priority `CLI > env > project > global > default`.
  - Global/local file locations, profile resolution rules, the `ConfigLoader` API table and the v2 schema examples (one `model` per profile).
  - CLI commands: `setup` and `profile` `switch`/`delete`/`status`.
- `.ai-run/guides/architecture/architecture.md`: the 5-layer plugin architecture and the CLI → Registry → Plugin rule.
- `.ai-run/guides/integration/exposed-api.md` (section `ConfigLoader`, l.154): `ConfigLoader` is part of the exposed API surface.
- `.ai-run/guides/testing/testing-patterns.md`: Vitest, dynamic-import mocking, lazy-getter override for class statics.
- `.ai-run/guides/security/security-practices.md`: `CredentialStore` (keytar or AES-256-GCM fallback) for tokens.
- `docs/CONFIGURATION.md`, "Multi-Provider Profiles" (l.24-110): one model per profile in the examples (`● work-litellm (litellm) - claude-sonnet-4-6`).
- `docs/COMMANDS.md`: "Profile Management Commands" (l.585) and `codemie profile` (l.1310). The note says "To create or update profiles, use `codemie setup`".
- `docs/ARCHITECTURE-CONFIGURATION.md`: the parameter flow `--model` → `CODEMIE_MODEL` → agent env (l.12, 323).
- `docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md`: tier auto-selection design and the scenarios that depend on the selected model.
- Prior task docs on model resolution:
  - `docs/superpowers/tasks/2026-08-19-claude-model-autoupdate/` (technical-analysis.md, plan.md)
  - `docs/superpowers/tasks/2026-09-17-tenant-model-catalog/plan.md`
- `openwiki/` is a generated index (architecture, concepts, integrations). Per AGENTS.md it must not be hand-edited.

### Architectural Decisions
- **Workspace and profile decoupling (migration 007)**: switching the active profile must not drop workspace context. Identity keys (`codeMieUrl`, `codeMieProject`, `codeMieIntegration`) resolve from the scope of the profile in use.
- **EPMCDME-12779**: tier vars are always emitted, even when empty, so stale shell values are overridden. The sonnet tier is always populated when a sonnet model is provisioned.
- **EPMCDME-14355**: `CLAUDE_CODE_SUBAGENT_MODEL` is pinned only when the fallback equals the session model.
- **`CODEMIE_MODEL_SOURCE`**: an explicitly chosen model (`cli` or `env`) is never auto-healed or substituted by plugin catalog logic. Values from a persisted profile are labelled `default` (AgentCLI.ts l.371-379, claude.models.ts l.478-483).
- **Profile protection**: with an explicit `--profile`, env `CODEMIE_MODEL` is ignored unless `--model` is also given (config.ts l.148-167).

### Derived Conventions
- Interactive commands handle cancel through `KEY.ESC` / `KEY.CTRL_C` in the custom selector, and through an inquirer "Cancel" choice in setup.
- Interactive commands exit with `logger.error` plus `process.exit(1)`.
- Profile-related subcommands take an optional positional argument and prompt interactively when it is omitted (`switch [profile]`, `delete [profile]`).
- No `TODO`, `HACK`, `NOTE:`, `ADR:` or `DECISION:` markers were found in setup.ts, profile/*, config.ts, env/types.ts, models.ts, setup-ui.ts or AgentCLI.ts.
- CHANGELOG.md has no prior entry for multi-model profiles or model switching.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/__tests__/model-tier-auto-selection.test.ts`: `parseModelVersion`, `compareModelVersions` and `autoSelectModelTiers`.
- `src/cli/commands/profile/__tests__/index.test.ts`: profile selector row rendering, `renderProfileSelectionUI`, `ProfileDisplay.format` / `formatStatus` workspace URL, and the list command. It mocks `ConfigLoader` (`listProfiles`, `hasLocalConfig`, `resolveProfileWorkspace`, `getActiveProfileName`, `load`).
- `src/utils/__tests__/config-project-override.test.ts`: `initProjectConfig`, `loadWithSources`, priority `cli > env > project > global > default`, field override behaviour, the `saveProfile` / `initProjectConfig` workspace split, and selected-global plus local-team profile composition.
- `src/utils/__tests__/config.migration.test.ts`: legacy-to-v2 migration.
- `src/utils/__tests__/export-provider-env.test.ts`: `exportProviderEnvVars`.
- `src/env/__tests__/types.test.ts`: `isMultiProviderConfig`, `isLegacyConfig` and `ProviderProfile` shape.
- `src/providers/integration/__tests__/setup-ui.test.ts`: `getAllProviderChoices` ordering only.
- `src/agents/core/__tests__/`:
  - `AgentCLI-model-source.test.ts` (`CODEMIE_MODEL_SOURCE`)
  - `agentcli-flag-env-mapping.test.ts`
  - `model-tier-config.test.ts`
  - `model-tier-transform-edge.test.ts`
- `src/migrations/__tests__/`: per-migration tests (005, 006, 007, 001-004) and `migration-runner-ordering.test.ts`.
- `src/cli/commands/shared/selection/__tests__/ui.test.ts`: selection row builders.
- Integration tests:
  - `tests/integration/agent-setup.test.ts` (TC-029): a PTY walk of `codemie setup` for SSO. It waits for `/Choose a model.*\(Use arrow keys\)/` (l.112) and asserts the persisted `profile.model` is non-empty (l.178). It needs live SSO.
  - `tests/integration/agent-model.test.ts`: TC-020 (session uses the profile model), TC-021 (metrics record the model), TC-022 (`codemie models list`).
  - `tests/integration/model-tier-e2e.test.ts`.
  - `tests/integration/cli-commands/profile.test.ts`: a smoke test that `codemie profile` does not crash.

### Testing Framework and Patterns
- Vitest ^4.1.5 (`vitest.config.ts`) with three projects:
  - `unit`: `src/**/*.test.ts`, with `CODEMIE_HOME` isolated to `tmpdir()/codemie-test-home-<pid>`.
  - `cli`: `tests/integration/**`, excluding `agent-*`.
  - `agent`: PTY and live-backend tests.
- Patterns:
  - `vi.mock` of `../utils/config.js` with a `ConfigLoader` stub object.
  - `chalk` is mocked to tagged strings for deterministic UI snapshots.
  - Dynamic imports run after mocks.
  - `setupTestIsolation()` and `createCLIRunner()` helpers live in `tests/helpers/`.
  - `spawnPty` drives interactive wizards.
- AGENTS.md policy: tests are written or run only on explicit user request.

### Coverage Gaps
- `setup.ts` `handlePluginSetup`, `promptForModelSelection`, `promptForProfileName` and `runSetupWizard` have no unit tests. Their only coverage is the SSO-gated PTY test TC-029.
- The `profile switch` command action (`createSwitchCommand`) and `ConfigLoader.switchProfile`, `renameProfile` and `deleteProfile` have no dedicated unit tests in the files above.
- `codemie models` (`models.ts`) has no unit test. Its only coverage is the `agent`-project integration TC-022, which needs a live backend.
- `setup-ui.ts` `getAllModelChoices`, `formatModelChoice` and `computeRecommendedModelIds` are not covered by `setup-ui.test.ts`, which only tests provider ordering.
- No per-provider test covers `buildConfig` model handling across the 7 setup-steps. Some plugins have `__tests__` dirs, but they were not inspected for model fields.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_MODEL`:
  - Read into `model` by `loadFromEnv` (config.ts l.466).
  - Exported to agents by `exportProviderEnvVars` (l.1494).
  - Filtered out when `--profile` is given without `--model`.
- `CODEMIE_MODEL_SOURCE` (`cli` | `env` | `default`): set by AgentCLI (l.375-379) and consumed by the claude and codex model resolvers.
- `CODEMIE_HAIKU_MODEL`, `CODEMIE_SONNET_MODEL`, `CODEMIE_OPUS_MODEL`: always exported, possibly empty.
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`: read by `autoSelectModelTiers` during setup.
- `CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_URL`, `CODEMIE_AUTH_METHOD`, `CODEMIE_INTEGRATION_ID` / `_ALIAS`, `CODEMIE_TIMEOUT`, `CODEMIE_DEBUG`: the remaining env overrides (config.ts l.454-494).
- `CODEMIE_PROFILE_NAME` and `CODEMIE_PROFILE_CONFIG`: passed to agent hooks.
- `CODEMIE_CODEX_AVAILABLE_MODELS`: the Codex allowed-model list (codex.plugin.ts l.506-540).
- `CODEMIE_HOME`: overrides the config home and is used for test isolation.

### Configuration Files
- `~/.codemie/codemie-cli.config.json`: the global v2 config (`activeProfile`, `profiles{}`, `workspace`, `codemieSkills`, `codemieAssistants`, `userEmail`), resolved through `getCodemiePath` / `GLOBAL_CONFIG`.
- `<repo>/.codemie/codemie-cli.config.json`: the local v2 config, with the same schema. Its `activeProfile` takes precedence.
- `~/.codemie/migrations.json`: the migration tracker.
- `config.example.json` at the repo root: a **legacy v1 flat** example (`provider`, `baseUrl`, `apiKey`, `model`, ...).
- `.codemie/credentials.json` and the `CredentialStore` (keychain or `~/.codemie/.credentials.enc`) hold SSO tokens. The project-config guide says not to commit this file.

### Feature Flags and Deployment Concerns
- No feature flags or runtime toggles exist for profiles or model selection.
- The package ships as npm `@codemieai/code` 0.15.7.
- Config migrations run automatically at CLI startup (`src/migrations/runner.ts`).
- Secrets:
  - `apiKey` is stored in plaintext inside profile objects for api-key providers (LiteLLM, etc.).
  - SSO and JWT credentials go through `CredentialStore`.
  - `--show-sources` masks key, token and password fields (`maskSensitive`, config.ts l.1390).

---

## 6. Risk Indicators

- **Requirements ambiguity.** "Switch between them (in the CLI)" could mean any of three things:
  1. A `codemie` subcommand that changes the persisted model of a profile.
  2. A per-launch choice (the existing `--model` flag on `codemie-<agent>`).
  3. In-session switching.

  Several agents already offer in-session switching: Claude Code `/model` over the haiku/sonnet/opus tiers, and codemie-code/opencode, whose generated config contains the full catalog (opencode-model-configs.ts l.576). The intended surface is not stated.
- **Wide `model` scalar surface.** `ProviderProfile.model` is a single string read in about 20 places: AgentCLI validation (l.263, l.663-706), `ConfigLoader.validate` (l.1133), `exportProviderEnvVars`, 7 provider `buildConfig`s, `ProfileDisplay`, doctor `AIConfigCheck`, the proxy header/normalizers, connect-orchestrator `profileModel`, health checks and `prompt-executor`.
  - Speculative: adding a model list next to `model` (rather than replacing it) would keep these consumers working, while any reshaping of `model` itself would touch all of them.
- **Fixed signature in the provider contract.** `ProviderSetupSteps.buildConfig(credentials, selectedModel: string)` and `installModel(credentials, selectedModel, ...)` are typed for one model, and all 7 setup-steps implement them.
  - Speculative: multi-model selection is likely to touch either this interface or the wizard's post-processing of `buildConfig` output.
- **Single-value wizard branches.** `promptForModelSelection` has three paths that each return one value: the list prompt, "Custom model (manual entry)" and "Search Ollama library". The `selectModel` auto-pick path (anthropic-subscription, moonshot-subscription) skips the picker entirely. Ollama `installModel` installs one model.
  - Speculative: a multi-select would have to reconcile custom entry, search and auto-pick with a checkbox UI.
- **Tier coupling.** `autoSelectModelTiers(models, selectedModel)` derives `sonnetModel` from the selected model. Claude `transformEnvVars` subagent pinning compares the session model to the fallback tier (EPMCDME-14355).
  - Speculative: switching the active model without recomputing tiers could leave tiers inconsistent with the new model.
- **Auto-heal of switched models.** Models persisted in a profile are labelled `CODEMIE_MODEL_SOURCE=default` and are subject to Claude catalog auto-heal (claude.plugin.ts l.384-460) and Codex ranking (`resolveCodexModel`). Only `cli` and `env` sources are protected.
  - Speculative: a model the user "switched to" and persisted could be silently replaced at launch unless its source is distinguished.
- **Existing write-path hazards in setup.**
  - On update, the storage location comes from `hasLocalConfig` (setup.ts l.112), so a global profile updated inside a repo with a local config is written to local.
  - `initProjectConfig` overwrites the whole local file with a single profile (config.ts l.954-968).
  - `saveProfile` replaces the profile object wholesale (config.ts l.659), dropping fields such as `reasoningEffort` that `buildConfig` does not return.

  Any change that persists more model data through these paths inherits these behaviours.
- **Local/global merge semantics.** `ConfigLoader.load` overlays a same-named local profile with field-level `Object.assign` (l.115-129).
  - Speculative: an array-valued profile field would be replaced wholesale by a local overlay, not merged, which the project-config guide's override table does not cover.
- **Schema and migration precedent.** `isMultiProviderConfig` gates on `version === 2`. Prior reshaping (007) shipped as an idempotent migration with dedicated tests.
  - Speculative: an additive optional field may not need a migration, while a renamed or restructured `model` field would.
- **Weak test coverage on touched code.** There are no unit tests for the setup wizard flow, `profile switch`, `models.ts` or `getAllModelChoices`. The only wizard coverage is the SSO-gated PTY test TC-029, which asserts the "Choose a model ... (Use arrow keys)" prompt text (agent-setup.test.ts l.112), so any change to that prompt will break it.
- **Docs to keep consistent.** `docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `.ai-run/guides/usage/project-config.md` and `docs/ARCHITECTURE-CONFIGURATION.md` all describe one model per profile. `config.example.json` is a legacy v1 example. `openwiki/` is generated and must not be hand-edited.
- **Two UI paradigms.** Profile switching uses a custom raw-mode selector (`promptProfileSelectionCustom`), while setup uses inquirer; inquirer `checkbox` exists in `update.ts`. There is no shared multi-select model picker yet.

---

## 7. Summary for Complexity Assessment

The task touches these layers:
- **CLI**: `src/cli/commands/setup.ts` (model step and save path), `src/cli/commands/profile/index.ts` (the only switch command, which today switches whole profiles via `ConfigLoader.switchProfile`), `profile/display.ts`, and `src/cli/commands/models.ts` (currently `list` only).
- **Core config types**: `ProviderProfile.model?: string` in `src/env/types.ts`.
- **Utils**: `ConfigLoader` in `src/utils/config.ts`, which handles load/merge, `saveProfile`, `initProjectConfig`, `validate` and `exportProviderEnvVars`.
- **Provider plugin contract**: `ProviderSetupSteps.buildConfig(credentials, selectedModel: string)`, implemented by 7 provider setup-steps.

At launch, the model flows as a single value: `--model` / `CODEMIE_MODEL`, then `ConfigLoader.load`, then `CODEMIE_MODEL`, then `BaseAgentAdapter.transformEnvVars`, then the agent plugins. The Claude and Codex plugins run catalog auto-heal and ranking, which only spares models whose `CODEMIE_MODEL_SOURCE` is `cli` or `env`.

The building blocks for a multi-select mostly exist:
- Live model catalogs per provider (`fetchModels`, `getModelProxy`).
- Enriched choice rendering (`getAllModelChoices`).
- An inquirer `checkbox` precedent (`update.ts`).
- A custom raw-mode selector (`shared/selection`).
- A numbered idempotent migration framework (007 is the latest reshaping precedent).

The novelty is semantic, not infrastructural. A profile would go from one model to many, and the "switch" surface has to be decided: a persisted-model subcommand, a per-launch choice, or relying on the in-session switching that Claude Code `/model` and codemie-code/opencode already offer. The switch also has to interact correctly with Claude tier auto-selection (`autoSelectModelTiers`, EPMCDME-12779/14355) and with catalog auto-heal.

Test coverage on the touched code is thin:
- Config merging, workspace split, env export and tier selection have good unit coverage.
- The setup wizard flow, `profile switch`, `models.ts` and `getAllModelChoices` have no unit tests. The only wizard coverage is an SSO-gated PTY test that pins the "Choose a model" prompt text.

Key risk factors:
- The ambiguous meaning of "switch".
- The wide read surface of the scalar `model` field (about 20 consumers, including proxy and doctor).
- Existing write-path hazards in setup: the local-vs-global update decision, `initProjectConfig` overwriting the whole file, and `saveProfile` replacing profiles wholesale.
- The possible need for a config migration.
- Four user-facing docs plus the guide that state "one model per profile".

---

## 8. External References

None named by the task.
