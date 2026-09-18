# Technical Research

**Task**: claude models env-vars registry
**Generated**: 2026-08-19T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

Currently there is functionality that populates models for the Claude agent via env vars. These models are never auto-updated, only manually updated occasionally. There is a need to come up with a way to auto-update these models on the user side when new models become available, so the user always uses the latest models. For example, Sonnet 4.7 is still on the list, but Sonnet 5 is already released/in place.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/plugins/claude/claude.plugin.ts` — `ClaudePluginMetadata` (exported const), consumed by `ClaudePlugin extends BaseAgentAdapter`. Contains:
  - `envMapping`: `model → ['ANTHROPIC_MODEL']`, `haikuModel → ['ANTHROPIC_DEFAULT_HAIKU_MODEL']`, `sonnetModel → ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']`, `opusModel → ['ANTHROPIC_DEFAULT_OPUS_MODEL']`.
  - `recommendedModels: ['claude-sonnet-4-6', 'claude-4-opus', 'gpt-4.1']` — a static, hand-maintained array in agent metadata.
- `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts` — a second, independent set of hardcoded model identifiers:
  - `ANTHROPIC_SUBSCRIPTION_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001'`
  - `ANTHROPIC_SUBSCRIPTION_DEFAULT_OPUS_MODEL = 'claude-opus-4-7'`
  - `ANTHROPIC_SUBSCRIPTION_MODEL_ALIASES` — a static lookup table mapping legacy model names (`claude-4-5-haiku`, `claude-opus-4-6`, `claude-opus-4-6[1m]`) to the current defaults above.
  - `exportEnvVars(config)` normalizes `config.model` / `config.haikuModel` / `config.opusModel` through this alias table before emitting `CODEMIE_MODEL` / `CODEMIE_HAIKU_MODEL` / `CODEMIE_OPUS_MODEL`.
- `src/utils/config.ts:1403` — `ConfigLoader.exportProviderEnvVars(config)` — always emits `CODEMIE_MODEL`, `CODEMIE_HAIKU_MODEL`, `CODEMIE_SONNET_MODEL`, `CODEMIE_OPUS_MODEL` from the resolved profile config (`config.model` / `haikuModel` / `sonnetModel` / `opusModel`), even when a tier is absent (empty string), so stale shell values are overridden.
- `src/agents/core/BaseAgentAdapter.ts:1069` — `transformEnvVars(env)` (called from `run()` before the `beforeRun` lifecycle hook) — projects the generic `CODEMIE_*` vars onto agent-native names using `metadata.envMapping`. This is the shared mechanism for every agent, not Claude-specific.
- Dynamic per-agent model resolution **already exists for other agents** and is the closest in-repo precedent for "auto-update models":
  - `src/agents/plugins/codex/codex-models.ts` — `resolveCodexModel(env)` fetches the live CodeMie model catalog (`fetchCodeMieModelsForCodex`), filters compatible models, ranks them (`rankModel`/`compareRankedModels`, using regex + `extractVersionParts`), and selects the top-ranked model; falls back to the currently configured model if the fetch fails.
  - `src/agents/plugins/kimi/kimi.models.ts` — `resolveKimiModel(env)` — same fetch → filter → rank → select pattern.
  - `src/agents/plugins/copilot-cli/copilot-cli.models.ts` — `resolveCopilotModel(env)` — same pattern, plus `assertExplicitCopilotModelAllowed` for explicit user overrides.
  - `src/agents/plugins/pi/pi.models.ts` — `fetchAndBuildPiModels(env, cwd)` fetches the live catalog and writes a generated `PiModelsConfig` (per-model classification/limits) to disk rather than selecting a single model.
  - There is **no** `src/agents/plugins/claude/claude.models.ts` or equivalent `resolveClaudeModel` — Claude is the one plugin among {codex, kimi, copilot-cli, pi} without a dynamic model-catalog resolver.
- `src/providers/plugins/sso/sso.http-client.ts` — `fetchCodeMieLlmModels` / `fetchCodeMieModels` — the shared HTTP client function all of the above dynamic resolvers call to pull the live model list from the CodeMie backend.
- `src/providers/plugins/sso/sso.models.ts` — `SSOModelProxy extends BaseModelProxy` — fetches the raw model catalog for the setup wizard (`fetchModels`/`listModels`), separate code path from the per-agent resolvers above.
- `src/providers/core/registry.ts` — `ProviderRegistry` — registers provider templates and model proxies (`registerModelProxy`); `src/agents/registry.ts` — `AgentRegistry` — registers agent plugins including `ClaudePlugin`.
- `src/env/manager.ts` — `EnvManager` — generic global key/value config store (`~/.codemie/codemie-cli.config.json`); not tier-model-specific, unrelated to the model catalog.

### Architecture and Layers Affected

- **Agent plugin layer** (`src/agents/plugins/claude/`) — `ClaudePluginMetadata.recommendedModels` and `envMapping` live here; this is where a Claude-specific dynamic resolver (mirroring `codex-models.ts`/`kimi.models.ts`) would sit if that pattern is followed.
- **Provider plugin layer** (`src/providers/plugins/anthropic-subscription/`) — a second, independently hardcoded set of Claude model identifiers and an alias table live here, decoupled from the agent-plugin layer's list.
- **Agent core layer** (`src/agents/core/BaseAgentAdapter.ts`) — `transformEnvVars` and the `run()` lifecycle are shared across every agent; any change touching this path affects Codex, Kimi, OpenCode, Pi, Copilot as well as Claude.
- **Config layer** (`src/utils/config.ts` `ConfigLoader`, `src/env/manager.ts` `EnvManager`) — supplies the `CODEMIE_*` env vars that `transformEnvVars` remaps into Claude-native vars.
- **Provider core layer** (`src/providers/core/registry.ts` `ProviderRegistry`, `src/providers/core/base/BaseModelProxy.ts`) — the existing model-catalog-fetch abstraction (`BaseModelProxy`, `ProviderModelFetcher`) used by SSO/LiteLLM/Ollama/Bedrock/JWT model proxies.

### Integration Points

- Dynamic resolvers (`codex-models.ts`, `kimi.models.ts`, `copilot-cli.models.ts`) all depend on `fetchCodeMieLlmModels`/`fetchCodeMieModels` from `src/providers/plugins/sso/sso.http-client.ts`, authenticated via `CodeMieSSO.getStoredCredentials` (`src/providers/plugins/sso/sso.auth.ts`) or `CODEMIE_JWT_TOKEN`.
- `ClaudePluginMetadata.envMapping` is consumed by `BaseAgentAdapter.transformEnvVars`, called inside `BaseAgentAdapter.run()` prior to the `beforeRun` lifecycle hook (`executeBeforeRun`).
- `anthropic-subscription.template.ts` registers `agentHooks['claude'].beforeRun` and `agentHooks['*'].beforeRun` via `registerProvider()`, which runs after `transformEnvVars` and normalizes/overrides `CODEMIE_MODEL`/`CODEMIE_HAIKU_MODEL`/`CODEMIE_OPUS_MODEL` through its own static alias table.
- `ConfigLoader.exportProviderEnvVars` (`src/utils/config.ts`) reads `providerTemplate.exportEnvVars` per active provider (e.g., the anthropic-subscription template above) to layer provider-specific env vars on top of the generic `CODEMIE_*` set.

### Patterns and Conventions

- **Dynamic-fetch-rank-select pattern** (Codex/Kimi/Copilot): fetch live catalog → filter by compatibility predicate → rank via a numeric score array (regex bonuses + `extractVersionParts`) → `compareRankedModels` (descending score, then id) → pick top; fall back to the currently configured model on fetch failure; throw `ConfigurationError` (not generic `Error`) when nothing compatible is available and no valid fallback exists.
- **Declarative `envMapping`** on `AgentMetadata`, generically consumed by `BaseAgentAdapter.transformEnvVars` — any new Claude env var name must be added here to be projected from `CODEMIE_*`.
- **Provider `exportEnvVars(config)` hook** on `ProviderTemplate` — providers can post-process/override the generic `CODEMIE_*` vars before they reach `transformEnvVars` (as `anthropic-subscription` does for model aliasing).
- `BaseModelProxy` / `ProviderModelFetcher` / `ModelInstallerProxy` interfaces (`src/providers/core/base/BaseModelProxy.ts`) — the provider-level model-catalog abstraction used for setup-wizard listing (SSO, LiteLLM, Ollama, Bedrock, JWT); distinct from the per-agent resolver pattern above and not currently wired to Claude's tier env vars.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` was read in full. It documents Claude session processing (conversations processor, drain loop, bash passthrough) in detail but does **not** mention Claude model-catalog resolution, `recommendedModels`, or any auto-update mechanism. It does document the OpenCode dynamic model-config-injection flow (`OPENCODE_CONFIG_CONTENT`) as an analogous but separate mechanism, and lists Codex's proxy/metrics pipelines without covering `codex-models.ts` model selection specifically.
- Guide map references `.ai-run/guides/architecture/architecture.md` (5-layer plugin architecture) and `.ai-run/guides/usage/project-config.md` (profiles/env vars/paths) as relevant P0/P1 guides per `AGENTS.md`'s Task Classifier for `claude`/`session`/`config`/`env` keywords; neither was fetched in this pass since the code-level findings above already surfaced the concrete gap (no `claude.models.ts` resolver) directly on point for this task.

### Architectural Decisions

- No ADR or guide entry documents *why* Codex/Kimi/Copilot/Pi got dynamic model resolvers while Claude did not. The inline comment on `ClaudePluginMetadata.supportedVersion` ("**UPDATE THIS WHEN BUMPING CLAUDE VERSION**") shows the project's existing convention is manual, human-driven updates for Claude Code CLI *version* pinning — a parallel, but not identical, problem to model *catalog* freshness.

### Derived Conventions

- Every dynamic resolver function is named `resolve<Agent>Model` and lives in `src/agents/plugins/<agent>/<agent>-models.ts` or `<agent>.models.ts`, exporting `resolve<Agent>Model(env)` plus an `assertExplicit<Agent>ModelAllowed(model, availableModels)` guard for explicit user overrides — a naming/shape convention a Claude equivalent would be expected to follow.
- All dynamic resolvers throw `ConfigurationError` from `src/utils/errors.ts`, never a generic `Error`, matching the repo-wide error-handling convention (`AGENTS.md` → `.ai-run/guides/development/development-practices.md`).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/model-tier-config.test.ts` — covers `transformEnvVars` tier mapping (haiku/sonnet/opus → agent env vars) generically via a `TestAgentAdapter extends BaseAgentAdapter`; not Claude-specific and does not touch model-catalog freshness.
- `src/agents/plugins/copilot-cli/__tests__/copilot-cli.models.test.ts` — covers Copilot's dynamic resolver (`isCopilotCompatibleModelName`, ranking).
- `src/agents/plugins/claude/__tests__/claude.plugin.statusline.test.ts` and `claude.plugin.conflict.test.ts` — cover statusline and settings-conflict lifecycle hooks, not model resolution.

### Testing Framework and Patterns

- Vitest, per `.ai-run/guides/testing/testing-patterns.md` (not fetched in this pass but referenced by `AGENTS.md`) and confirmed by the `__tests__` directory conventions and dynamic-import mocking style visible in `BaseAgentAdapter.ts` (`maybeWriteSessionReport` dynamically imports modules under test).

### Coverage Gaps

- No test file exists for a Claude model resolver because no such resolver exists yet (`src/agents/plugins/claude/claude.models.ts` is absent).
- `ClaudeAcpPlugin`, `ClaudeFileOperation`, and `ClaudeSessionAdapter` are flagged by codegraph as having **no covering tests** — relevant if any auto-update implementation touches Claude session/plugin wiring.
- `anthropic-subscription.template.ts`'s static alias table (`ANTHROPIC_SUBSCRIPTION_MODEL_ALIASES`) has no dedicated test file found in this pass.

---

## 5. Configuration and Environment

### Environment Variables

- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` (+ `CLAUDE_CODE_SUBAGENT_MODEL`), `ANTHROPIC_DEFAULT_OPUS_MODEL` — Claude-native vars, populated via `ClaudePluginMetadata.envMapping` from the generic vars below.
- `CODEMIE_MODEL`, `CODEMIE_HAIKU_MODEL`, `CODEMIE_SONNET_MODEL`, `CODEMIE_OPUS_MODEL` — generic vars emitted by `ConfigLoader.exportProviderEnvVars` from profile config (`config.model`, `config.haikuModel`, `config.sonnetModel`, `config.opusModel`); always emitted (even as `''`) to overwrite stale shell values, per an inline comment referencing ticket `EPMCDME-12779`.
- `CODEMIE_JWT_TOKEN`, `CODEMIE_BASE_URL`, `CODEMIE_URL` — used by every dynamic resolver (`fetchCodeMieModelsForCodex`/`ForKimi`/`ForCopilot`) to authenticate the live-catalog fetch.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — read/written by `EnvManager` (generic key/value store) and by `ConfigLoader`'s global config layer.
- Profile config layering in `ConfigLoader.loadWithSources` (`src/utils/config.ts`): default → global → project → env → CLI overrides, last-wins per key.

### Feature Flags and Deployment Concerns

- No feature flag currently gates model-catalog freshness for Claude. The closest control point is the resolvers' fetch-failure fallback (keep currently configured model) versus a hard `ConfigurationError` when nothing compatible is available and no valid override exists — the same fallback/error trade-off would need to be decided for any Claude equivalent.

---

## 6. Risk Indicators

- Speculative: the most direct implementation path — adding a `resolveClaudeModel`/`claude.models.ts` mirroring `codex-models.ts`/`kimi.models.ts` — would need to reconcile with the **second, independent** hardcoded model source in `anthropic-subscription.template.ts` (`ANTHROPIC_SUBSCRIPTION_DEFAULT_*_MODEL` constants and alias table), which applies only when the `anthropic-subscription` provider is active and Claude talks directly to Anthropic (not through the CodeMie proxy) — a live CodeMie-catalog fetch is not meaningful for that code path, so a single unified fix is unlikely to cover both.
- `BaseAgentAdapter.transformEnvVars` and `run()` are shared across every agent plugin (Claude, Codex, Kimi, OpenCode, Pi, Copilot) — any change to the shared lifecycle/env-transform path risks regressing other agents; changes should stay Claude-plugin-local where possible.
- No existing test covers `ClaudePluginMetadata.recommendedModels`, `ClaudeSessionAdapter`, or `ClaudeAcpPlugin` — the surrounding surface has thin test coverage.
- No guide or ADR documents the intended long-term strategy for model-catalog freshness; the closest precedent (Codex/Kimi/Copilot dynamic resolvers) is undocumented in `.ai-run/guides/` and was found only via direct code exploration — the pattern is real but institutionally unrecorded, so any implementation choice here has no written authority to defer to.
- Speculative: distinguishing "explicit user override" from "stale default" for Claude's `haikuModel`/`sonnetModel`/`opusModel` tiers will likely require the same `modelSource` (`default`/`global`/`project`/`env`/`cli`) tracking that `resolveCopilotModel` already uses (`ConfigSource` type, `CODEMIE_MODEL_SOURCE` env var) — confirm this env var's plumbing for the Claude env path specifically before assuming it is already wired end-to-end.

---

## 7. Summary for Complexity Assessment

This task touches the agent plugin layer (`src/agents/plugins/claude/claude.plugin.ts`), the provider plugin layer (`src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts`), and potentially the shared agent core layer (`src/agents/core/BaseAgentAdapter.ts` env-transform/lifecycle path used by every agent). Two independent, hardcoded Claude model sources exist today: a static `recommendedModels` array in Claude's agent metadata, and a separate static default/alias table in the Anthropic-subscription provider template — neither is currently backed by a live-catalog fetch. The codebase already contains a proven, repeated pattern for exactly this kind of problem — Codex, Kimi, and Copilot CLI each have a dynamic `resolve<Agent>Model` function that fetches the live CodeMie model catalog, ranks candidates, and falls back gracefully — giving strong precedent for how a Claude equivalent would likely be shaped, without prescribing that shape as a requirement.

Technical novelty is moderate: the fetch/rank/select mechanics are not new to this codebase, but no such mechanism currently exists for Claude, and the two separate hardcoded sources (agent-plugin vs. provider-plugin) are not obviously reconcilable under one fix since the Anthropic-subscription path bypasses the CodeMie model proxy entirely. Test coverage in the affected area is thin — no tests exist for Claude's model list, `ClaudeSessionAdapter`, or `ClaudeAcpPlugin`, and the existing `model-tier-config.test.ts` only covers the generic env-transform mechanism, not model freshness or selection logic. Key risk factors are: (1) the shared `BaseAgentAdapter.transformEnvVars`/`run()` path affecting all agents if touched, (2) the undocumented nature of the dynamic-resolver convention (no guide references it), and (3) the two-hardcoded-sources split requiring a design decision on scope (CodeMie-proxied Claude usage only, vs. also covering native Anthropic-subscription usage) before implementation size can be estimated with confidence.
