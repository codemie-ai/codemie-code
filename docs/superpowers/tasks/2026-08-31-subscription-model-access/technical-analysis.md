# Technical Research

**Task**: anthropic-subscription providers claude-launcher model-flag version-pin
**Generated**: 2026-08-31T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

The CLI (@codemieai/code) has a dedicated Anthropic Subscription provider (`anthropic-subscription`) that lets `codemie-claude` run on the user's own Claude Code login instead of a CodeMie-issued key. By design it hands model choice to Claude Code: the provider blanks the model and model-tier values it would otherwise export, and the Claude plugin's catalog-driven tier auto-resolution is deliberately skipped for this provider.

Five concrete behaviors this story targets:
1. `-m, --model` is offered on every agent launcher but treated as a CONFIG-ONLY option — consumed by CodeMie's config layer and never forwarded to the `claude` binary. On a subscription profile the value it sets is then blanked, so `codemie-claude --model <id>` has no effect and reports nothing.
2. Setup still asks for a model on this path. The subscription provider returns an empty model list, so setup falls through to "No models found. Enter model name manually:" pre-filled with the family token `sonnet`, saves whatever is typed, and prints `Model: sonnet` in the success summary — a value that never reaches a session.
3. `codemie models list` has no model source registered for `anthropic-subscription` (only LiteLLM, AI/Run SSO, Bedrock, bearer-auth and Ollama providers have one), so it exits with "Model listing is not supported for provider 'anthropic-subscription'".
4. The defect: on a subscription profile, a requested model is accepted then discarded silently; the session always runs on Claude Code's own default.
5. CodeMie pins the Claude Code binary: one verified version, a hard minimum below which the launcher refuses to start, and it disables the binary's auto-updater on every run. When the installed Claude Code is NEWER than the pinned version, the launcher prompts and its DEFAULT choice installs the pinned OLDER version — a downgrade. This must become a warning that defaults to continuing on the installed version; the minimum-version block stays a hard block.

Key design decision already made by the product owner (carry this — do NOT design entitlement logic): on the subscription path CodeMie PASSES the `--model` value straight through to Claude Code and never validates entitlement itself. If a model is unentitled, Claude Code refuses and CodeMie simply SURFACES/RELAYS that refusal (never swallows or substitutes). Building a real entitlement-backed model catalog is explicitly OUT OF SCOPE.

---

## 2. Codebase Findings

### Existing Implementations

**Provider layer — anthropic-subscription:**
- `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts` — The provider template. `exportEnvVars()` (lines 109–138) sets `CODEMIE_MODEL = ''`, `CODEMIE_HAIKU_MODEL = ''`, `CODEMIE_SONNET_MODEL = ''`, `CODEMIE_OPUS_MODEL = ''` — the blanking mechanism. `agentHooks['*'].beforeRun()` (lines 36–93) additionally deletes `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, and `CLAUDE_CODE_SUBAGENT_MODEL` to prevent stale shell values from pinning the binary. `agentHooks.claude.enrichArgs()` injects `--plugin-dir` for the CodeMie extension but does NOT inject `--model`. The `CODEMIE_PROVIDER` env var is set to `'anthropic-subscription'` here and acts as the global discriminator downstream.
- `src/providers/plugins/anthropic-subscription/anthropic-subscription.setup-steps.ts` — Setup steps. `fetchModels()` (lines 96–99) unconditionally returns `[]`. `selectModel()` returns `null` unless a CodeMie analytics URL is set; in either case no model is auto-selected. `buildConfig()` stores whatever model the user typed into the profile but the template's `exportEnvVars` neutralizes it at runtime.
- `src/providers/plugins/anthropic-subscription/index.ts` — Barrel re-export.
- `src/providers/plugins/moonshot-subscription/moonshot-subscription.setup-steps.ts` — Parallel subscription pattern: `fetchModels()` returns `[]`, `selectModel()` returns `null`. Both subscription providers share the same blanking convention.

**Agent plugin layer — ClaudePlugin:**
- `src/agents/plugins/claude/claude.plugin.ts` — `CLAUDE_SUPPORTED_VERSION = '2.1.218'` (line ~39, pinned verified version). `CLAUDE_MINIMUM_SUPPORTED_VERSION = '2.1.208'` (line ~49, hard minimum; always 10 patch versions below supported). `DISABLE_AUTOUPDATER = '1'` set unconditionally in `lifecycle.beforeRun` (lines 183–186). The catalog tier resolution block is entirely gated at line 315 behind `if (env.CODEMIE_PROVIDER !== 'anthropic-subscription')` — the single divergence point for all model-catalog logic. `envMapping.model` maps to `['ANTHROPIC_MODEL']` but is never reached for the subscription path.
- `src/agents/plugins/claude/claude.models.ts` — `resolveClaudeModel(env, tier)`: live-catalog-based model selector for all four tiers (haiku/sonnet/opus/plus). Added in prior task EPMCDME-13xxx (2026-08-19). Skipped entirely for `anthropic-subscription`.

**Core adapter layer:**
- `src/agents/core/BaseAgentAdapter.ts` — `run()` method is the shared launch pipeline for all providers. Version compatibility checked at line ~394: `compat.isNewer` branch (line 440–481) shows a list prompt with `default: 'install'` — this installs the OLDER pinned version by default; `'Continue with current version'` is option index 1 and is NOT the default. Welcome message (line 564): `const model = env.CODEMIE_MODEL || 'unknown'` — for subscription this always resolves to `'unknown'` after blanking. `transformEnvVars()` (line 1130–1134) maps `CODEMIE_MODEL → ANTHROPIC_MODEL`; since `CODEMIE_MODEL` is blank for subscription, `ANTHROPIC_MODEL` is never set in the child process. Session-end analytics at line 908 reads the actual model from conversation transcripts, not from `CODEMIE_MODEL`, so it does record the true model used even when the env var is absent. `extractConfig()` (line 1051) passes `model: env.CODEMIE_MODEL` to hooks; empty for subscription.
- `src/agents/core/AgentCLI.ts` — `-m/--model <model>` option defined at line 78. `'model'` is listed in `configOnlyOptions` (line 598), which causes `collectPassThroughArgs()` to skip it — the value NEVER appears in the `claude` binary's argv for any provider. At line 198–203 the model is passed only to `ConfigLoader.load()` as `options.model`.

**Config layer:**
- `src/utils/config.ts` — `ConfigLoader.exportProviderEnvVars()` (line ~1425): sets `CODEMIE_MODEL = config.model` from the loaded profile+CLI-override before calling the provider's `exportEnvVars`. The provider template then overwrites it to `''` for subscription. This is the correct sequencing point where `--model` from the CLI reaches `CODEMIE_MODEL` and where subscription-specific passthrough logic should be inserted.

**CLI commands:**
- `src/cli/commands/setup.ts` — `promptForModelSelection()` (lines 617–632): when `models.length === 0`, shows `'No models found. Enter model name manually:'` with `default: providerTemplate?.recommendedModels?.[0] || 'gpt-5.5'`. For `anthropic-subscription`, `recommendedModels[0]` is `'sonnet'`.
- `src/cli/commands/models.ts` — `createModelsCommand`: checks `ProviderRegistry.getModelProxy(provider)` at lines 73–77; if null, exits with `"Model listing is not supported for provider '${provider}'"` and `process.exit(1)`. No model proxy is registered for `anthropic-subscription`.
- `src/providers/integration/setup-ui.ts` — `displaySetupSuccess()` (line 273): prints `Model: ${model}` in the setup success summary.

### Architecture and Layers Affected

| Layer | Component | Change scope |
|---|---|---|
| CLI parse | `AgentCLI.ts:78, 598` | `-m/--model` is already parsed; `configOnlyOptions` membership stays; passthrough to `claude` argv is the new behavior for subscription only |
| Config export | `ConfigLoader.exportProviderEnvVars` (`config.ts:1425`) | Shared pipeline; must not change shared behavior |
| Provider template | `anthropic-subscription.template.ts:109-138` (exportEnvVars), `36-93` (beforeRun), `enrichArgs` | Primary change site: conditional model carry-through instead of unconditional blank |
| Agent plugin | `claude.plugin.ts:315` | Guard already correct; no change needed to guard logic itself |
| Core adapter | `BaseAgentAdapter.ts:440-481` | `compat.isNewer` default flip: `'install'` → `'continue'` |
| Setup wizard | `setup.ts:617-632`, `setup-ui.ts:273` | Inform user that model is passed through; may update messaging |

### Integration Points

**Internal module dependency chain (model path):**
```
AgentCLI.ts:78 (parse --model)
  → ConfigLoader.load() [options.model override]
    → ConfigLoader.exportProviderEnvVars() [sets CODEMIE_MODEL]
      → ProviderTemplate.exportEnvVars() [subscription: blanks CODEMIE_MODEL → to change]
        → BaseAgentAdapter.transformEnvVars() [maps CODEMIE_MODEL → ANTHROPIC_MODEL]
          → claude binary spawn [enrichArgs adds --model if subscription path]
```

**Version-pin path:**
```
BaseAgentAdapter.run()
  → checkVersionCompatibility(installedVersion, CLAUDE_SUPPORTED_VERSION, CLAUDE_MINIMUM_SUPPORTED_VERSION)
    → compat.isNewer → prompt with default: 'install' [to change to 'continue']
    → compat.isBelowMinimum → hard block [stays]
  → lifecycle.beforeRun sets DISABLE_AUTOUPDATER='1'
```

**External services:**
- `@anthropic-ai/claude-code` binary — the spawned process; receives env vars and argv from the above pipeline.
- Claude Code's own model entitlement checking — opaque; CodeMie will surface its refusal messages unchanged.

### Patterns and Conventions

- **Subscription blanking pattern**: both `anthropic-subscription` and `moonshot-subscription` use `fetchModels() → []`, `selectModel() → null`, and `exportEnvVars` that blank `CODEMIE_*_MODEL`. The new passthrough logic will be the first departure from this pattern and must be subscription-specific without affecting moonshot-subscription.
- **`configOnlyOptions` guard**: `AgentCLI.collectPassThroughArgs()` excludes `'model'` for all providers universally. The fix does NOT change this; instead, the subscription provider's `enrichArgs` injects `--model <value>` into the Claude binary's args directly, which is the established mechanism (used for `--plugin-dir`, `--task → -p`, `--resume → -r`).
- **`enrichArgs` injection**: the `agentHooks.claude.enrichArgs(args, env)` function in the provider template receives the full args array and the env object. It can check `env.CODEMIE_MODEL` and prepend `['--model', env.CODEMIE_MODEL]` to args. This is the correct insertion point — it fires just before the binary is spawned and is already provider-scoped.
- **`ConfigurationError` convention**: all errors in provider/adapter code use `ConfigurationError` from `src/utils/errors.ts`, never generic `Error`.
- **`resolve<Agent>Model` naming**: model resolvers live in `src/agents/plugins/<agent>/<agent>.models.ts`. Not applicable to this story (no new resolver needed).
- **Version-pin comment**: `CLAUDE_SUPPORTED_VERSION` and `CLAUDE_MINIMUM_SUPPORTED_VERSION` carry inline comments "UPDATE THIS WHEN BUMPING CLAUDE VERSION" and "always 10 patch versions below supported". No automation enforces the gap — manual discipline required.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — 5-layer plugin architecture (CLI → Registry → Plugin → Core → Utils); documents `src/providers/plugins/` and `src/agents/plugins/` layout. Directly relevant to understanding which layer owns the fix for each story target.
- `.ai-run/guides/development/development-practices.md` — Mandates `ConfigurationError` (never generic `Error`) for all new error paths. Relevant to the `codemie models list` unsupported message path if refactored.
- `.ai-run/guides/integration/external-integrations.md` — Claude session processing, drain loop, bash passthrough. Does NOT cover model-catalog resolution or the subscription-specific env var lifecycle.
- `.ai-run/guides/usage/project-config.md` — Profiles, env vars, paths. Relevant to `CODEMIE_*` var layering and how `config.model` propagates.
- `.ai-run/guides/quality-gates.md`, `.ai-run/guides/standards/`, `.ai-run/guides/testing/` — Process/quality gates, not feature-specific.

### Architectural Decisions

- **2026-08-19 prior task (EPMCDME-13xxx, `docs/superpowers/tasks/2026-08-19-claude-model-autoupdate/`)**: Added `claude.models.ts` with `resolveClaudeModel()`. The `anthropic-subscription` skip guard at `claude.plugin.ts:315` was added deliberately in that task. `CR-004`: no `modelSource` signal guard; explicit decision to keep current behavior, documented inline at `claude.models.ts:214-224`. `CR-005`: no tests added (policy: tests only on explicit request).
- **EPMCDME-12779**: `ConfigLoader.exportProviderEnvVars` always emits even-empty `CODEMIE_*` vars to overwrite stale shell values; anthropic-subscription must explicitly blank them. This decision is the root of the current blanking mechanism — the new passthrough fix must keep the blank for all vars EXCEPT the `CODEMIE_MODEL` path when a user model is supplied.
- **EPMCDME-14355**: `CLAUDE_CODE_SUBAGENT_MODEL` removed from sonnet tier's `envMapping` to avoid silencing per-subagent model params on multi-tier tenants. This affects only the non-subscription path.
- **EPMCDME-13734**: Per-agent supported-version constants removed then re-added per the version management spec. Current constants are authoritative.
- **Product owner decision (this story)**: No entitlement validation on subscription path. CodeMie passes `--model` through; Claude Code owns the refusal. This is OUT OF SCOPE to implement entitlement logic.

### Derived Conventions

- `enrichArgs` is the canonical injection point for binary CLI args in provider templates. It receives the pre-built args array and can prepend or append. Guard deduplication is expected (see `--plugin-dir` guard pattern in existing `enrichArgs`).
- Model passthrough via CLI arg (`--model`) is preferred over env var (`ANTHROPIC_MODEL`) for the subscription path: the env var path goes through `transformEnvVars` which is shared with all providers, while `enrichArgs` is already provider-scoped.
- The `exportEnvVars` blanking for `CODEMIE_MODEL` exists specifically to prevent the `transformEnvVars` shared pipeline from setting `ANTHROPIC_MODEL` to a CodeMie-catalog model that is meaningless for the subscription path. The fix must preserve this intent while adding a conditional: if a user-requested model is present (non-empty `CODEMIE_MODEL` before blanking), carry it to `enrichArgs` instead.

---

## 4. Testing Landscape

### Existing Coverage

- `src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.template.test.ts` — Covers: template metadata (`name`, `authType`, `defaultBaseUrl`, `recommendedModels`), `beforeRun` hook (auth env var stripping, model-tier env var stripping, `CODEMIE_CLAUDE_EXTENSION_DIR` set/skip), `enrichArgs` (`--plugin-dir` injection), `exportEnvVars` (model blanking, codeMieUrl/Project export). Does NOT test `enrichArgs` behavior when a `--model` arg is present.
- `src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.setup-steps.test.ts` — Covers: `selectModel` (auto-select with codeMieUrl, null for no-analytics, empty-list fallback), `fetchModels` (always returns `[]`), `buildConfig` (provider/model fields, codeMieUrl/Project passthrough, defaultBaseUrl fallback).
- `src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.auth.test.ts` — Covers: `parseClaudeAuthStatus` JSON parsing, error handling for invalid/empty input.
- `tests/integration/proxy-routing-guard.test.ts` — Covers: proxy bypass for `anthropic-subscription`; `exportProviderEnvVars` emits `CODEMIE_AUTH_METHOD=manual`; `shouldUseProxy` returns false even with stale JWT env.
- `tests/integration/model-tier-e2e.test.ts` — Covers: Config→Export→Transform pipeline for non-subscription providers, `ClaudePlugin` `envMapping` for haiku/sonnet/opus, `ANTHROPIC_*` env var transformation, CLI model override while preserving tier config.
- `src/agents/plugins/__tests__/flag-transform-contract.test.ts` — Covers per-agent flag contracts: `claude: --task → -p`, `claude: --resume → -r`. No assertion for `--model` behavior on `claude` launcher.
- `src/agents/core/__tests__/flag-transform.test.ts` — `transformFlags` utility unit tests.
- `tests/integration/agent-model.test.ts` (agent, real network) — TC-020 (profile model selection), TC-021 (metrics records model), TC-022 (`codemie models list` via SSO/JWT only), TC-024 (in-session `/model` switch via PTY).
- `tests/integration/agent-setup.test.ts` (agent, real network) — TC-029 setup wizard SSO profile creation and model persistence (SSO provider only, not `anthropic-subscription`).

### Testing Framework and Patterns

- **Framework**: Vitest 3.x; three project configs: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**/*.test.ts` excluding agent-*), `agent` (`tests/integration/agent-*.test.ts` with real network/auth).
- **Module mocking**: `vi.hoisted()` + `vi.mock()` for hoisting before ESM imports; `vi.fn()` / `vi.restoreAllMocks()` in `beforeEach`/`afterEach`.
- **Filesystem isolation**: `mkdtempSync` per suite, cleaned in `afterAll`; `CODEMIE_HOME` env override for full profile isolation.
- **Process env isolation**: `process.env` saved/restored in `beforeEach`/`afterEach` pairs.
- **Conditional gates**: `describe.runIf(process.env.SSO_AVAILABLE !== 'false')` for auth-required cases.
- **Interactive flows**: PTY session helper (`spawnPty` from `tests/helpers/pty-session.ts`) for prompt-driven flows; `spawnSync` for headless CLI subprocess invocations.
- **Auth helpers**: `tests/helpers/sso-auth.ts`, `tests/helpers/jwt-auth.ts`, `tests/helpers/sso-claude-plugin.test.ts`.

### Coverage Gaps

- **`--model` passthrough for `anthropic-subscription`**: no test in `flag-transform-contract.test.ts` or `anthropic-subscription.template.test.ts` asserts that a user-supplied `--model <id>` is injected into the `claude` binary's argv by `enrichArgs` on the subscription path. This is the core new behavior.
- **`codemie models list` with subscription profile**: TC-022 tests SSO/JWT only. No unit or CLI integration test asserts that `codemie models list` prints `"Model listing is not supported for provider 'anthropic-subscription'"` and exits non-zero.
- **Version-pin downgrade prompt default**: no test covers `BaseAgentAdapter.run()` behavior when `compat.isNewer` is true. The default flip from `'install'` to `'continue'` is untested.
- **`enrichArgs` deduplication when `--model` already in user args**: no test for the case where the user passes `--model` as an unknown arg that passes through Commander's `.allowUnknownOption()` AND the subscription enrichArgs also injects `--model`.
- **Setup wizard for `anthropic-subscription`** (integration): no TC-029 equivalent for the full wizard flow with this provider; the unit test covers `selectModel`/`buildConfig` but not the wizard prompt chain end-to-end.
- **Welcome message model display on subscription profile**: no test asserts that `renderProfileInfo` shows `'unknown'` (current) or a model name (after fix) for subscription sessions.

---

## 5. Configuration and Environment

### Environment Variables

**Set by `anthropic-subscription.template.ts` `beforeRun` (deleted from child process env):**
- `ANTHROPIC_AUTH_TOKEN` — deleted; native Claude Code login takes over
- `ANTHROPIC_API_KEY` — deleted
- `ANTHROPIC_BASE_URL` — deleted
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` — deleted; prevents stale shell value from pinning haiku tier
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — deleted
- `ANTHROPIC_DEFAULT_OPUS_MODEL` — deleted
- `CLAUDE_CODE_SUBAGENT_MODEL` — deleted

**Set by `anthropic-subscription.template.ts` `exportEnvVars` (blanked in CODEMIE namespace):**
- `CODEMIE_MODEL` — set to `''` (the primary change target for the passthrough fix)
- `CODEMIE_HAIKU_MODEL` — set to `''`
- `CODEMIE_SONNET_MODEL` — set to `''`
- `CODEMIE_OPUS_MODEL` — set to `''`
- `CODEMIE_API_KEY` — set to `''`

**Set by `claude.plugin.ts` `lifecycle.beforeRun` (unconditional for all Claude sessions):**
- `DISABLE_AUTOUPDATER` — `'1'`; prevents Claude Code binary self-update. Overridable if already set in shell.
- `ENABLE_TOOL_SEARCH` — `'0'`; workaround for Claude Code ≥2.1.69 startup failure when proxied
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` — `'1'` unless already set
- `CLAUDE_CODE_ENABLE_TELEMETRY` — `'0'`; prevents 404s on CodeMie backend
- `ENABLE_PROMPT_CACHING_1H` — `'1'` unless already set
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — default `'85'`; overridable via `CODEMIE_PROFILE_CONFIG.claudeAutocompactPct`

**Routing/discriminator vars:**
- `CODEMIE_PROVIDER` — set to `'anthropic-subscription'`; gates `claude.plugin.ts:315` catalog skip
- `CODEMIE_JWT_TOKEN` / `CODEMIE_BASE_URL` — used by `claude.models.ts` catalog fetch for non-subscription paths
- `CODEMIE_REASONING_EFFORT` — if set, `applyReasoningEffort()` injects `--effort` into binary args

### Configuration Files

- `config.example.json` — Profile shape: `provider`, `baseUrl`, `apiKey`, `model`, `timeout`, `debug`, `allowedDirs`, `ignorePatterns`. The `model` field is the stored placeholder that `exportEnvVars` currently discards for subscription.

### Feature Flags and Deployment Concerns

- **`DISABLE_AUTOUPDATER`**: Set unconditionally by `claude.plugin.ts`. If a shell sets `DISABLE_AUTOUPDATER=0`, it is respected — a potential escape hatch that bypasses version control. Not directly related to this story but noted.
- **Version constant update discipline**: `CLAUDE_SUPPORTED_VERSION` and `CLAUDE_MINIMUM_SUPPORTED_VERSION` in `claude.plugin.ts` are manually maintained. The 10-patch-version gap is convention, not enforced. Any bump requires updating both constants.
- **`enrichArgs` deduplication risk**: if a user passes `--model claude-haiku-4-5` as an unknown arg (Commander passes it through via `.allowUnknownOption()`) AND `enrichArgs` also injects `--model <value>`, the Claude binary receives `--model` twice. The fix must deduplicate — check whether `--model` is already present in `args` before injecting, following the existing `--plugin-dir` guard pattern.
- **`ANTHROPIC_MODEL` vs `--model` arg**: both mechanisms exist; `ANTHROPIC_MODEL` env var is the non-subscription path (set by `transformEnvVars`). For subscription the fix should use `--model` in argv via `enrichArgs` rather than `ANTHROPIC_MODEL` env var to stay within the subscription-scoped code path and avoid changing the shared `transformEnvVars` logic.

---

## 6. Risk Indicators

- **Shared env pipeline (`transformEnvVars`, `exportProviderEnvVars`)**: these functions run for ALL providers. Any change to them (rather than to the subscription template's `exportEnvVars` / `enrichArgs`) risks breaking SSO, LiteLLM, Bedrock, and bearer-auth model resolution. Changes must be confined to `anthropic-subscription.template.ts` and `BaseAgentAdapter.ts:440-481` (version prompt only).

- **Double `--model` injection**: Commander's `.allowUnknownOption()` + `[args...]` passes user-supplied unknown args to the `claude` binary. If a user types `codemie-claude --model claude-opus-4-5` and the new `enrichArgs` also injects `--model`, the binary receives the flag twice. The fix must check `args.includes('--model')` before injecting — same pattern as the `--plugin-dir` deduplication already in `enrichArgs`.

- **`moonshot-subscription` must not change**: it shares the blanking convention. The fix is scoped only to `anthropic-subscription.template.ts`. Confirm `moonshot-subscription.template.ts` is not touched.

- **Welcome message regression**: `BaseAgentAdapter.ts:564` reads `env.CODEMIE_MODEL || 'unknown'`. After the fix, for subscription sessions with a `--model` flag, `CODEMIE_MODEL` may no longer be blank (if the fix chooses not to blank it in `exportEnvVars`). This changes the welcome message from `'unknown'` to the user's requested model — a UI improvement but a behavioral change that should be explicitly verified. If the fix injects `--model` via `enrichArgs` without changing `exportEnvVars`, then `CODEMIE_MODEL` remains `''` and the welcome message stays `'unknown'` — this is arguably acceptable since the model display at launch for subscription profiles is already acknowledged as non-functional.

- **`DISABLE_AUTOUPDATER` shell override**: setting `DISABLE_AUTOUPDATER=0` in the shell bypasses CodeMie's version control. This is a pre-existing gap, not introduced by this story.

- **Version-pin default change scope**: `BaseAgentAdapter.ts:440-481` is in the shared adapter; changing `default: 'install'` to `default: 'continue'` affects all agents and all providers that use `BaseAgentAdapter`. The version-pin prompt logic is agent-agnostic, so this is correct — but verify no other agent (Codex, Gemini, Kimi, etc.) has its own version-pin prompt in a separate adapter that also needs the same fix.

- **No test gate for downgrade default**: `CR-005` from the prior task established a repo policy of "tests only on explicit request." The version-pin default flip and the model passthrough are new behaviors with zero existing test coverage. The implementation must be careful since there is no automated safety net. The `model-tier-e2e.test.ts` test is the closest regression guard for the non-subscription env var pipeline.

- **`codemie models list` messaging**: the exit path at `models.ts:73-77` uses `process.exit(1)` which is acceptable but untested for `anthropic-subscription`. If the story requires a more informative message (e.g., "This provider uses your Claude Code subscription; model selection is managed by Claude Code"), the change is in `models.ts` which is shared — scope it to the `anthropic-subscription` branch only.

- **Session analytics model recording**: `BaseAgentAdapter.ts:908` reads the model from conversation transcripts, not from `CODEMIE_MODEL`. This means end-of-session reporting will correctly record the actual model Claude Code used, regardless of whether `CODEMIE_MODEL` is blank. No change needed here — but the story's acceptance criteria should note that launch-time model reporting (welcome banner) and session-end reporting have different sources.

- **`CODEMIE_PROVIDER` guard dependency**: `claude.plugin.ts:315` is the single guard between subscription and non-subscription catalog resolution. Any future provider that also sets `CODEMIE_PROVIDER !== 'anthropic-subscription'` but should also skip catalog resolution will need a more general guard. Not a risk for this story but worth noting for future-proofing.

---

## 7. Summary for Complexity Assessment

This story touches four discrete change sites across two architectural layers, with no structural rearchitecting required. The implementation surface is narrow and well-isolated: the primary model-passthrough fix lives entirely in `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts` (the `enrichArgs` function and the conditional blank in `exportEnvVars`), and the version-pin default flip is a single-line change at `BaseAgentAdapter.ts` line ~461 (`default: 'install'` → `default: 'continue'`). The `configOnlyOptions` guard in `AgentCLI.ts` and the `claude.plugin.ts:315` guard are already correct and need no modification. The `codemie models list` unsupported message and the setup wizard messaging are documentation/UX improvements with no logic change required unless the story demands richer error text.

The task follows established patterns: `enrichArgs` injection is the existing mechanism for provider-specific arg injection; the deduplication guard is already exemplified by `--plugin-dir`. The only design novelty is the decision to carry `CODEMIE_MODEL` (or a captured snapshot of it before blanking) into `enrichArgs` for the subscription path — no prior provider does this because all other providers set `ANTHROPIC_MODEL` via the env var pipeline instead. This means the implementer must decide whether to (a) capture the model value before `exportEnvVars` blanks it and pass it via closure or a side-channel to `enrichArgs`, or (b) not blank `CODEMIE_MODEL` in `exportEnvVars` for the subscription path when a model is set (relying on the `beforeRun` deletion of `ANTHROPIC_DEFAULT_*_MODEL` as the auth-env guard), or (c) read `config.model` directly in `enrichArgs` from the env object. Option (c) is cleanest: `env.CODEMIE_MODEL` should be populated before `exportEnvVars` runs (it is set by `ConfigLoader.exportProviderEnvVars`), so capturing it in `enrichArgs` via `env.CODEMIE_MODEL` before the blank occurs is possible only if `enrichArgs` runs before `exportEnvVars`. Confirming the exact call order of `enrichArgs` vs `exportEnvVars` in the adapter pipeline is the one code-reading task remaining before implementation begins.

Test coverage posture: the anthropic-subscription provider has meaningful unit tests (`template.test.ts`, `setup-steps.test.ts`, `auth.test.ts`) that cover the existing blanking behavior. The new passthrough behavior must extend `template.test.ts` with an `enrichArgs` test case for the `--model` injection path and a case for deduplication. The version-pin prompt flip has zero test coverage and must be verified manually or by adding a Vitest unit test using `vi.fn()` to mock the inquirer prompt. The `codemie models list` unsupported path also has no test. Total new test additions needed: 2–4 unit test cases and potentially 1 CLI integration test for `models list`. This is low-risk scope.
