# Technical Research

**Task**: codemie-code CLI setup profile model selection agent harness codex claude gemini model compatibility validation
**Generated**: 2026-10-06
**Research path**: filesystem

---

## 1. Original Context

Ability to set up models in the CodeMie CLI properly matching the given agentic harness. Right now a codex harness can be configured with Claude models and vice versa; that fails at runtime, but the problem is that it is possible to configure it that way in the first place.

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/setup.ts` (~30k) - `codemie setup` wizard. Flow: pick provider (`ProviderRegistry.getAllProviders`, `getAllProviderChoices`) -> `handlePluginSetup` -> credentials -> `setupSteps.fetchModels` -> `setupSteps.selectModel` (optional auto) or `promptForModelSelection` (~L447, uses `getAllModelChoices`, optional `getRecommendedModels`, search, manual entry; manual default `providerTemplate.recommendedModels[0] || 'gpt-5.5'`) -> `autoSelectModelTiers` (Claude haiku/sonnet/opus, ~L624) -> `setupSteps.buildConfig`. The wizard has NO notion of an agent/harness: the profile is provider + model only. The only agent reference is `AgentRegistry.getAgent('claude')` to decide on Claude tier selection.
- `src/providers/integration/setup-ui.ts` - `getAllModelChoices`, `computeRecommendedModelIds`, `matchesAnyRecommendedPattern` (model picker rendering/recommendation, provider-template based, not agent based).
- `src/providers/plugins/*/<p>.setup-steps.ts`, `*.models.ts`, `*.template.ts` (sso, jwt, litellm, bedrock, ollama, anthropic-subscription, moonshot-subscription) - per-provider model listing and `recommendedModels`.
- `src/agents/core/types.ts` L269-270 - `AgentMetadata.blockedModelPatterns?: RegExp[]`, `recommendedModels?: string[]`.
- `src/agents/core/AgentCLI.ts` - launch path. `validateCompatibility(config)` (~L663) checks `supportedProviders` and `blockedModelPatterns` only; called at ~L344 and does `process.exit(1)`. Also `isSetupCapableAgent` (L658, claude|codex|gemini). Sets `CODEMIE_MODEL_SOURCE` = `cli`/`env`/default (L355, L375).
- Per-agent metadata declaring blocked patterns:
  - `src/agents/plugins/claude/claude.plugin.ts` L157: `blockedModelPatterns: []`, `recommendedModels: ['sonnet']` - Claude harness does not reject GPT/Gemini names in the metadata check.
  - `src/agents/plugins/codex/codex.plugin.ts` L139: `blockedModelPatterns: []`, recommended `gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.2-codex`. So the metadata check never fires for codex either.
  - `src/agents/plugins/gemini/gemini.plugin.ts` L49: `[/^claude/i, /^gpt/i]`.
  - `copilot-cli` blocks embedding/rerank/whisper/tts/image; kimi and openwiki: `[]`.
- Real per-agent compatibility logic lives in runtime-only agent model modules:
  - `src/agents/plugins/codex/codex-models.ts`: `INCOMPATIBLE_MODEL_PATTERNS` (claude, sonnet, opus, haiku, anthropic, gemini, qwen, deepseek, llama, mistral, grok), `COMPATIBLE_CODEX_MODEL_PATTERNS` (codex, gpt-5, gpt-6, `gpt-*router`), exported `isCodexCompatibleModelName` (L139), `rankCodexModelIdsByRecency`, `resolveCodexModel` (L411), `assertExplicitCodexModelAllowed` (L499). Handles router entries via catalog `is_router`.
  - `src/agents/plugins/gemini/gemini.models.ts`: `isGeminiCompatibleModelName` (L43), `getGeminiModelIds`, `assertGeminiModelAllowed`, `validateGeminiModel(env)` (called gemini.plugin.ts L177).
  - `src/agents/plugins/claude/claude.models.ts`: tier resolution (`resolveClaudeModel` L455, `listRouterModelIds`, `buildModelPickerOptions`); comment at L303 says it mirrors codex compatibility for LiteLLM routers. No exported name-based `isClaudeCompatibleModelName` was found.
  - `copilot-cli.models.ts` (`assertExplicitCopilotModelAllowed`), `kimi.models.ts` (`isKimiCompatibleModelName`, `assertExplicitKimiModelAllowed`), `pi.models.ts`.
- `codex.plugin.ts` L286 (explicit model assert), L526 (litellm provider: throws ConfigurationError "not compatible with codemie-codex"), L500-540 `setupProxy`.

### Architecture and Layers Affected
- CLI command layer (`src/cli/commands/setup.ts`, `profile/index.ts`, `shared/agent-targets.ts` with `TargetAgent = 'claude'|'codex'|'gemini'`).
- Provider plugin layer (setup-steps / models / templates) and `providers/integration/setup-ui.ts`.
- Agent plugin layer (metadata + `*-models.ts` compatibility predicates) and `AgentCLI` launch validation.
- Config layer: `src/utils/config.ts` (`ConfigLoader`, profiles, `exportProviderEnvVars`), `src/env/types.ts` (profile fields: `model`, `haikuModel`, `sonnetModel`, `opusModel`, ...).

### Integration Points
- `setup.ts` -> `AgentRegistry` (`src/agents/registry.ts`); `AgentCLI` -> agent metadata; agent plugins -> `sso.http-client.ts` (`fetchCodeMieLlmModels`, `buildModelLabelIndex`, `orderModelsForPicker`). Agent-compat predicates are currently imported only by the owning plugin (grep: `isCodexCompatibleModelName` used only in codex.plugin.ts; `validateGeminiModel` only in gemini.plugin.ts). Importing them into `setup.ts` would add a cli -> agents/plugins dependency (setup already imports `AgentRegistry`).
- `docs/stories/2026-10-06-multi-model-profiles/` exists but is empty; a sibling story that may touch the same profile/model shape.

### Patterns and Conventions
- Per-agent `*.models.ts` with name-regex predicates plus catalog-based assert/resolve at launch; `ConfigurationError` for failures; `CODEMIE_MODEL_SOURCE` distinguishes explicit vs profile model (explicit choices honoured, saved profile models re-resolved).
- Provider plugins self-register in `ProviderRegistry`; agents in `AgentRegistry`; setup-steps interface in `src/providers/core/types.ts`.
- ESM with `.js` import suffixes; `@/` alias used in some cli files.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` present with subdirs architecture, development, integration, security, standards, testing, usage plus `project.md` and `quality-gates.md` (not read in depth).
- `docs/ARCHITECTURE-CONFIGURATION.md`, `docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md`, `docs/AUTHENTICATION.md` are the relevant references.

### Architectural Decisions
- Stories under `docs/stories/` (e.g. `2026-08-18-codex-desktop-proxy-connect.md`) record prior decisions; none found specifically about harness/model matching.

### Derived Conventions
- Compatibility is enforced at launch, per agent, in `*-models.ts`; setup is agent-agnostic by design today.

---

## 4. Testing Landscape

### Existing Coverage
- Unit: `src/agents/plugins/codex/__tests__/codex-models.test.ts`, `gemini/__tests__/gemini.models.test.ts`, `claude/__tests__/claude.models.test.ts`, `claude.plugin.model-swap-warning.test.ts`, `copilot-cli.models.test.ts`, `kimi.models.test.ts`, `pi.models.test.ts`; `src/cli/commands/profile/__tests__/index.test.ts`; `src/cli/commands/__tests__/` (setup-related tests e.g. model-tier-auto-selection.test.ts).
- Integration: `tests/integration/agent-setup.test.ts` (PTY wizard, SSO, browser auth), `agent-model.test.ts`, `model-tier-e2e.test.ts`, `agent-gemini.test.ts`.

### Testing Framework and Patterns
- Vitest with projects `unit`, `cli`, `agent`; PTY helper `tests/helpers/pty-session.js`; temp `CODEMIE_HOME` isolation.

### Coverage Gaps
- No test found asserting that setup restricts or validates models per harness (setup has no agent input). No test for the `validateCompatibility` path with codex/claude (their blocklists are empty).

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_MODEL`, `CODEMIE_PROVIDER`, `CODEMIE_MODEL_SOURCE`, `CODEMIE_CODEX_AVAILABLE_MODELS`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`; Claude tier vars (`ANTHROPIC_DEFAULT_*_MODEL`, haiku/sonnet/opus envs read in `autoSelectModelTiers`).

### Configuration Files
- Profiles in `~/.codemie/codemie-cli.config.json` (global/local storage location chosen in setup), `config.example.json`; types in `src/env/types.ts`, loader `src/utils/config.ts`. Profile schema contains no agent field (grep of config.ts/env types showed none).

### Feature Flags and Deployment Concerns
- None found specific to this area.

---

## 6. Risk Indicators

- Speculative: the profile has no harness field, so tying model choice to a harness may need either a new profile/setup input or a per-launcher setup entry point; this is a design decision with config-compat implications (existing profiles).
- Compatibility rules are scattered: codex and gemini have exported predicates, Claude has none, and `blockedModelPatterns` is empty for claude and codex, so the generic `AgentCLI.validateCompatibility` provides no protection for exactly the reported case (codex+Claude, claude+GPT).
- Heuristic name regexes (e.g. `gpt-*router`, switchyard aliases like `sy-signal-gpt-...` detected only via catalog `is_router`) can misclassify; setup has only model id strings (`fetchModels` returns `string[]`), not catalog metadata, so router detection would not be available at that layer without extra plumbing.
- Providers without catalogs (ollama, litellm, manual entry/custom model) bypass list filtering; manual entry default is hard-coded `gpt-5.5`.
- One profile may serve several harnesses (codemie-claude, codemie-codex, codemie-gemini share profiles; Claude tier fields coexist with GPT models), so strict filtering at setup could conflict with the multi-harness use; the sibling `multi-model-profiles` story is empty and may overlap.
- Layering: importing agent-plugin predicates into the CLI setup creates new coupling; `setup.ts` is large (30k) with PTY-based integration tests.

---

## 7. Summary for Complexity Assessment

The change touches the CLI setup layer (`setup.ts`, `setup-ui.ts`, possibly `profile/index.ts`), the agent plugin layer (compatibility predicates in `codex-models.ts`, `gemini.models.ts`, `claude.models.ts`, and agent metadata) and potentially config/profile typing. Today setup is harness-agnostic (provider + model only), while compatibility is enforced only at launch time and inconsistently: codex and gemini have name predicates and runtime asserts, Claude has none, and the generic `blockedModelPatterns` check is empty for claude and codex. Likely file surface is modest (about 6-10 source files plus tests), but the design question of how a profile relates to a harness is open.

Technical novelty is low-to-moderate: the predicates exist and can be reused, but a shared harness-to-model compatibility abstraction and a decision about where the harness is known (profile field, launcher-specific setup, or filtering at launch/picker) is new. Providers expose models as plain id strings, which limits catalog-aware checks (routers).

Test posture is reasonable for the per-agent model modules (unit tests exist for each) but there is nothing covering setup-time model/harness validation, and the wizard integration test is a PTY/SSO test that is costly to extend. Key risks: shared profiles across harnesses, heuristic name matching, catalog-less providers, and existing profiles that already hold mismatched models.

---

## 8. External References

None named by the task.
