# Technical Research

**Task**: model registry claude selector model-id provider
**Generated**: 2026-07-08T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Bug EPMCDME-12779 — The CodeMie Claude model selector displays the same Anthropic model ID `claude-opus-4-6-20260205` twice: once as "Custom Opus model" and once as "Custom Sonnet model". This creates confusion because two different labels point to the same Opus model ID.

Expected behavior:
- Each model label should map to a unique, provisioned model ID
- Duplicate model IDs should not appear under different labels
- If Sonnet is not provisioned, it should not be listed
- If Opus is listed, it should appear only once under the correct label
- Configuration should be validated against tenant/model-provisioning config

---

## 2. Codebase Findings

### Existing Implementations

**Core bug location — model tier assignment:**
- `src/cli/commands/setup.ts` — `autoSelectModelTiers()` (lines 577–651): assigns `result.sonnetModel = selectedModel` unconditionally at line 629 without checking whether `selectedModel` is an opus-family model. This is the confirmed root cause.

**Model data source:**
- `src/providers/plugins/sso/sso.http-client.ts` — `fetchCodeMieModels()` (lines 140–169): fetches model IDs from the gateway endpoint `/v1/llm_models?include_all=true`, mapping each entry to `model.id || model.base_name || model.deployment_name || model.label || 'unknown'`. The results are sorted but **not deduplicated**. If the backend returns two entries with identical resolved IDs (same `deployment_name`) but different `label` values, both are passed through.

**Desktop proxy model selector (separate code path, already guarded):**
- `src/cli/commands/proxy/connectors/desktop.ts` — `PREFERRED_CLAUDE_MODELS` (lines 53–59), `selectPreferredClaudeModels()` (lines 154–194), `selectDesktopClaudeModels()` (lines 206–218): the desktop path already has a single-opus guard (`opusKept` flag). Not the focus of this bug, but documents the prior fix for a related symptom (EPMCDME referenced in the `2026-06-26-proxy-desktop-opus-4.8` task directory).

**Model display in OpenCode and Codex agents:**
- `src/agents/plugins/opencode/opencode-dynamic-models.ts` line 111: `name: model.label || id` — the raw gateway `label` field is used directly as the display name.
- `src/agents/plugins/codex/codex-models.ts` line 182: `display_name: entry.model.label || entry.id` — same pattern.

**SSO model list transformation:**
- `src/providers/plugins/sso/sso.models.ts` — `fetchModelsFromAPI()` (lines 162–187): converts string IDs from `fetchCodeMieModels` to `ModelInfo[]` using `{ id, name: id }`. No deduplication.

**Provider templates (static model lists):**
- `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts` — `recommendedModels: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001']`. Contains an alias table that remaps `claude-opus-4-6 → claude-opus-4-7` but has no entry for `claude-opus-4-6-20260205`.
- `src/providers/plugins/jwt/jwt.template.ts` — `recommendedModels` includes `claude-opus-4-6` and `claude-sonnet-4-6`.
- `src/providers/plugins/jwt/jwt.setup-steps.ts` lines 116–123 — static hardcoded model list for JWT setup.

**Env-var mapping:**
- `src/agents/plugins/claude/claude.plugin.ts` lines 82–89: `envMapping` maps `sonnetModel → ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']` and `opusModel → ['ANTHROPIC_DEFAULT_OPUS_MODEL']`.
- `src/agents/core/BaseAgentAdapter.ts` — `transformEnvVars()`: routes `CODEMIE_SONNET_MODEL → ANTHROPIC_DEFAULT_SONNET_MODEL` and `CODEMIE_OPUS_MODEL → ANTHROPIC_DEFAULT_OPUS_MODEL` at agent runtime.

**Type definitions:**
- `src/env/types.ts` lines 60–63: `haikuModel?: string; sonnetModel?: string; opusModel?: string` — optional fields, no schema validation on model ID string values.
- `src/providers/core/types.ts` — `CodeMieModel` shape with `id`, `base_name`, `deployment_name`, `label`, `enabled` fields.

**Documentation:**
- `docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md` — records the design intent: "Sonnet Tier: Use the model the user selected during setup / This is the default/main model for the profile." This decision document explicitly describes the bug scenario without providing a guard.

### Architecture and Layers Affected

1. **CLI / Setup layer** (`src/cli/commands/setup.ts`): `autoSelectModelTiers()` — this is where the bug originates. Tier assignment logic resides here.
2. **HTTP Client / Data-access layer** (`src/providers/plugins/sso/sso.http-client.ts`): `fetchCodeMieModels()` — returns model IDs without deduplication; a backend misconfiguration with two entries sharing the same `deployment_name` would not be filtered here.
3. **Provider Model Proxy layer** (`src/providers/plugins/sso/sso.models.ts`): transforms IDs into `ModelInfo[]`, also without deduplication.
4. **Agent Plugin layer** (`src/agents/plugins/claude/claude.plugin.ts`): declares the env-var mapping from profile tier fields to `ANTHROPIC_DEFAULT_*_MODEL` vars — the path that produces the visible "Custom Opus / Custom Sonnet model" labels in Claude Code's UI.
5. **Agent Core layer** (`src/agents/core/BaseAgentAdapter.ts`): applies the env-var mapping at runtime.

The bug is fully within layers 1–2; the downstream layers (3–5) faithfully propagate whatever invalid state is written in layer 1.

### Integration Points

- Gateway API at `/v1/llm_models?include_all=true` — authoritative provisioned model list. The `label` field on each entry is used by `opencode-dynamic-models.ts` and `codex-models.ts` as the display name. The `deployment_name` / `base_name` / `id` fields are used by `fetchCodeMieModels` to produce model ID strings.
- Claude Code binary — receives `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` as process environment variables and renders them as "Custom Sonnet model" and "Custom Opus model" in its own UI. The labels "Custom Opus/Sonnet" are generated by the Claude Code binary, not by this codebase.
- Anthropic direct subscription path (`anthropic-subscription` provider): separate static model list; does not use the gateway API for model discovery. Not affected by this bug.

### Patterns and Conventions

- **Tier assignment is keyword-based, not type-safe**: haiku and opus are identified by substring match (`includes('haiku')`, `includes('opus')`). Sonnet has no keyword filter and falls through to the raw `selectedModel` assignment.
- **No profile validation for cross-tier uniqueness**: `ConfigLoader.validate()` checks only `baseUrl`, `apiKey`, `model` for non-emptiness. `sonnetModel`, `opusModel`, `haikuModel` are optional strings with no semantic constraints.
- **Model alias normalization exists only for `anthropic-subscription`**: `normalizeAnthropicSubscriptionModel()` rewrites `claude-opus-4-6 → claude-opus-4-7`. The `ai-run-sso` and `bearer-auth` providers have no equivalent normalization.
- **Desktop proxy has the single-opus guard, setup wizard does not**: `selectDesktopClaudeModels()` has an explicit `opusKept` flag preventing two opus entries. The analogous guard is absent in `autoSelectModelTiers()`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md`: Describes the 5-layer plugin architecture (CLI → Registry → Plugin → Core → Utils). Relevant for understanding the layer responsible for the fix (CLI layer, `setup.ts`).
- `.ai-run/guides/integration/external-integrations.md`: Documents the `profile → CODEMIE_*_MODEL → ANTHROPIC_DEFAULT_*_MODEL → Claude Code` data-flow chain. Directly describes the bug propagation path.
- `docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md`: Records the original design decision for `autoSelectModelTiers()`. Explicitly states "Sonnet Tier = user's selected model" as the intended behavior but does not account for the case where the user selects an opus model.
- `docs/superpowers/tasks/2026-06-26-proxy-desktop-opus-4.8/`: Documents the prior related bug (two opus entries in Claude Desktop) and the fix applied via `selectDesktopClaudeModels()`. Records that the `setup.ts` / profile-tier path was explicitly deferred as out of scope for that fix.

### Architectural Decisions

- **ADR (implicit)**: `autoSelectModelTiers()` was designed with the assumption that the user's selected model is always a sonnet-class model (since sonnet is the typical default). This assumption breaks when a tenant only provisions opus models or when the user explicitly selects an opus model.
- **ADR (explicit, 2026-06-26)**: The desktop proxy single-opus guard was introduced to address a prior symptom in the desktop config path. The companion fix for the profile/setup path was deferred.
- **ADR (anthropic-subscription)**: Model aliases (`claude-opus-4-6 → claude-opus-4-7`) normalize old IDs at the provider layer but only for the `anthropic-subscription` provider. The SSO provider has no equivalent normalization.

### Derived Conventions

- Tier-family classification throughout the codebase uses string matching: `includes('haiku')`, `includes('opus')`, `includes('sonnet')`. A fix for the bug should follow the same pattern to remain consistent.
- The setup wizard's model list does not use the gateway's `label` field; model display names come from `template.modelMetadata[modelId].name` (if defined) or the raw ID. The "Custom Opus model" / "Custom Sonnet model" labels are entirely generated by the external Claude Code binary from the env var names it receives.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/model-tier-config.test.ts`: Tests `BaseAgentAdapter.transformEnvVars` — verifies that `CODEMIE_OPUS_MODEL = 'claude-opus-4-6-20260205'` is correctly propagated to `ANTHROPIC_DEFAULT_OPUS_MODEL`. This test is orthogonal to the bug; it verifies the transformation layer, not the selection logic.
- `src/cli/commands/__tests__/model-tier-auto-selection.test.ts`: Tests `parseModelVersion`, `compareModelVersions`, `selectLatestModel` — these are version-sorting helpers duplicated from `setup.ts` (the actual functions in `setup.ts` are not exported and thus not directly tested). Does not cover the scenario where `selectedModel` is an opus model.
- `tests/integration/model-tier-e2e.test.ts`: End-to-end test covering `ConfigLoader → ClaudePlugin → env vars`. Uses `sonnetModel: 'claude-4-5-sonnet'` and `opusModel: 'claude-opus-4-6-20260205'` as distinct values — the passing scenario only. Does not exercise the failing case where both are identical.
- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`: Covers `fetchClaudeModels`, `selectPreferredClaudeModels`, `selectDesktopClaudeModels` including the opus-dedup guard. Unrelated to `autoSelectModelTiers`.
- `src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.template.test.ts`: Covers the alias normalization (`claude-opus-4-6 → claude-opus-4-7`) and `recommendedModels` assertions.

### Testing Framework and Patterns

- **Framework**: Vitest with three partitions: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**/*.test.ts` excluding agent tests), `agent` (real-network integration).
- **Mock strategy**: `vi.fn()` and `vi.mock()` for stubs; `vi.hoisted()` for module mock hoisting. Fixtures are inline literal objects or JSON files.
- **Coverage assertion style**: Plain `describe/it/expect` — no BDD syntax.
- `autoSelectModelTiers` is NOT exported from `setup.ts`. The test file `model-tier-auto-selection.test.ts` works around this by duplicating the algorithm locally. To add a direct regression test, either export the function or test via the command-level flow.

### Coverage Gaps

- **`autoSelectModelTiers()` with opus-as-selectedModel**: No test covers the scenario `selectedModel = 'claude-opus-4-6-20260205'`, `models = ['claude-opus-4-6-20260205']`, expected result `sonnetModel !== opusModel`.
- **Cross-tier uniqueness invariant**: No test asserts that `sonnetModel` and `opusModel` are never identical when the available model list contains the same opus ID.
- **`promptForModelSelection` / `getAllModelChoices` / `formatModelChoice`**: Zero test coverage. These functions in `src/providers/integration/setup-ui.ts` render the model list shown to the user.
- **`fetchCodeMieModels` deduplication**: No test for the scenario where the gateway returns two entries with the same `deployment_name` but different `label` values.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SONNET_MODEL` — read by `ConfigLoader.loadFromEnv()` → stored as `config.sonnetModel` → exported as `ANTHROPIC_DEFAULT_SONNET_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` at agent runtime.
- `CODEMIE_OPUS_MODEL` — same flow → exported as `ANTHROPIC_DEFAULT_OPUS_MODEL`.
- `CODEMIE_HAIKU_MODEL` — same flow → exported as `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — read by `autoSelectModelTiers()` at setup time (line 583) as `envSonnet` to skip auto-selection if already set.
- `ANTHROPIC_DEFAULT_OPUS_MODEL` — same pattern (line 584 as `envOpus`).
- If all three `ANTHROPIC_DEFAULT_*_MODEL` vars are set in the environment at setup time, `autoSelectModelTiers()` bypasses all auto-selection and uses the env values directly (lines 587–598).

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (global profile store): `{ version: 2, activeProfile: string, profiles: { [name]: { haikuModel?, sonnetModel?, opusModel?, ... } } }`. The duplicate model ID is persisted here after a buggy `codemie setup` run.
- `.codemie/codemie-cli.config.json` (project-local overlay): same schema, higher priority than global.
- `config.example.json`: uses `"model": "claude-sonnet-4-6"` as the default example.

### Feature Flags and Deployment Concerns

- No feature flags or runtime toggles govern model tier selection.
- No deployment manifests reference model tier env vars directly; they are set at runtime by `BaseAgentAdapter.transformEnvVars()` per agent invocation.
- The `CODEMIE_*_MODEL` vars can be set in shell before running `codemie setup` to force specific tier values, bypassing auto-selection entirely. This is a documented workaround but not a controlled feature gate.

---

## 6. Risk Indicators

- **Primary bug — no guard on opus-as-sonnet**: `src/cli/commands/setup.ts` line 629 assigns `result.sonnetModel = selectedModel` with no check that `selectedModel` does not contain `'opus'`. When the only provisioned model is an opus-class model, both `sonnetModel` and `opusModel` receive the same ID.
- **`autoSelectModelTiers` is not exported**: The function cannot be directly unit-tested without a code change (export it or test indirectly). The existing test file `model-tier-auto-selection.test.ts` duplicates the algorithm locally rather than importing it, so the actual implementation is untested.
- **No cross-tier uniqueness validation at save time**: `ConfigLoader.validate()` does not assert `sonnetModel !== opusModel`. A profile with identical values can be written and read without error.
- **No deduplication in `fetchCodeMieModels`**: `src/providers/plugins/sso/sso.http-client.ts` lines 161–166 returns a sorted array with no `Set`-based deduplication. A backend misconfiguration returning two entries with the same `deployment_name` (and different `label` values) would pass through as two identical strings.
- **Gateway `label` field trusted as display name without ID-level deduplication**: `opencode-dynamic-models.ts` line 111 and `codex-models.ts` line 182 use `model.label || id` as the display name. If two entries share the same deployment ID but have labels "Custom Opus model" and "Custom Sonnet model", both appear in those agents' model configs with distinct display names despite having the same underlying ID.
- **Design document describes the bug scenario**: `docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md` explicitly states "Sonnet Tier = user's selected model" without any qualification for the case where the selected model is opus-class. The design document needs updating alongside the code.
- **Prior fix explicitly deferred this path**: The `2026-06-26-proxy-desktop-opus-4.8` plan document recorded "Out of scope: setup.ts / parsers.ts opus references". This confirms the fix is overdue but was intentionally left for a future ticket — now EPMCDME-12779.
- **`anthropic-subscription` alias normalization does not cover `claude-opus-4-6-20260205`**: The alias table maps `claude-opus-4-6 → claude-opus-4-7` but not the dated variant. A profile saved with the dated ID under `sonnetModel` would not be normalized for this provider.
- **Requirements clarity**: The ticket does not specify the desired behavior when no sonnet-class model is provisioned by the tenant — whether `sonnetModel` should be left unset, set to the opus model, or set to a configurable default. This ambiguity should be resolved before implementation.

---

## 7. Summary for Complexity Assessment

The bug has a confirmed single-function root cause in `src/cli/commands/setup.ts` within `autoSelectModelTiers()` at line 629. The function unconditionally assigns the user's selected model as the sonnet tier without checking whether that model is opus-class. When a tenant only provisions opus models (or when a user selects an opus model as their primary model during setup), both `sonnetModel` and `opusModel` in the saved profile receive the same opus ID. The Claude Code binary then surfaces both `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` with their respective tier labels ("Custom Sonnet model", "Custom Opus model"), both pointing to the same ID. The secondary contributing factor is the absence of cross-tier uniqueness validation when writing the profile. The fix requires changes in 1–2 files: add a keyword guard (`!selectedModel.toLowerCase().includes('opus')`) before assigning `sonnetModel`, and optionally add a validation assertion in `ConfigLoader.validate()`. A secondary cleanup is to add deduplication in `fetchCodeMieModels()` (`src/providers/plugins/sso/sso.http-client.ts`) to guard against backend misconfiguration returning duplicate model IDs with different labels.

The task follows an established pattern (keyword-based tier classification already used for haiku and opus) and introduces no architectural novelty. The change surface is small: 1 core file (`setup.ts`), optionally 1 supporting file (`sso.http-client.ts`), and 1 test file (`model-tier-auto-selection.test.ts` for regression coverage). The `autoSelectModelTiers` function is not exported, which is a minor friction for testing — it should be exported or tested via the command flow. Test coverage for the affected code path is currently absent: no existing test exercises the "opus selected as primary model" scenario, meaning a regression test must be written alongside the fix.

Key risk factors for complexity scoring: the fix itself is low-risk (additive guard, no interface change, no migration needed), but the untested state of `autoSelectModelTiers` means there is no automated safety net currently. One requirements ambiguity exists: the ticket does not specify what should happen to `sonnetModel` when the tenant has no sonnet-class models at all (leave unset vs. inherit the opus model). This should be clarified before implementation to avoid introducing a different failure mode (sonnet tier empty causing Claude Code to fail subagent spawning).
