# Technical Research

**Task**: litellm provider cli setup integration validation
**Generated**: 2026-07-20T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

codemie-cli setup must enforce existing LiteLLM integration and prevent configuration without LiteLLM key. When a user runs codemie-cli setup in a project where a LiteLLM integration is already created, the setup flow must enforce usage of that existing LiteLLM integration. The user must not be able to complete CLI configuration without providing or using a LiteLLM key required by that integration. Acceptance criteria: (1) During setup, the system detects when the selected project already has a LiteLLM integration created. (2) If LiteLLM integration exists, the setup flow enforces its usage for CLI configuration. (3) User cannot complete CLI setup without providing the required LiteLLM key. (4) Validation message clearly explains why setup cannot continue without LiteLLM credentials. (5) The enforced flow does not affect projects without LiteLLM integration. (6) No invalid CLI configuration state can be saved.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/setup.ts` — main setup wizard entry point (28 KB). `runSetupWizard()` drives the full flow: profile detection → storage-location prompt → provider selection → `handlePluginSetup()`. `handlePluginSetup()` calls `setupSteps.getCredentials()` → `fetchModels()` → model selection → `buildConfig()` → `ConfigLoader.save*()`. No integration-detection hook exists before the provider-selection prompt today.
- `src/providers/plugins/litellm/litellm.setup-steps.ts` — `LiteLLMSetupSteps.getCredentials()` prompts for proxy URL and an **optional** API key (defaults to the string `'not-required'` when left blank). No enforcement logic whatsoever.
- `src/providers/plugins/litellm/litellm.template.ts` — `LiteLLMTemplate` registered with `requiresAuth: false`, priority 14 (below SSO at 0).
- `src/providers/plugins/litellm/litellm.models.ts` — `LiteLLMModelProxy.listModels()` hits `/v1/models` with optional `Authorization: Bearer <key>` header. Skips the header when `apiKey === 'not-required'`.
- `src/providers/plugins/litellm/index.ts` — auto-registers the template and setup steps with `ProviderRegistry` on import.
- `src/providers/plugins/sso/sso.setup-steps.ts` — `SSOSetupSteps.getCredentials()` already performs integration discovery after SSO auth (lines 79–140). Calls `fetchCodeMieIntegrations()`, filters by project, auto-selects when exactly one integration exists, prompts for choice when multiple exist. Critically: when no integrations are found, or when fetch fails, it proceeds **silently** with `integrationInfo = undefined`. There is no enforcement gate.
- `src/providers/plugins/sso/sso.http-client.ts` — `fetchCodeMieIntegrations(apiUrl, auth, endpointPath?)` paginates `/v1/settings/user?page=N&per_page=50&filters={"type":["LiteLLM"]}`. Validates entries by `credential_type === 'LiteLLM'` and non-empty `alias`. Returns `CodeMieIntegration[]` (id, alias, project_name, credential_type).
- `src/providers/core/codemie-auth-helpers.ts` — `fetchCodeMieIntegrations` re-exported here; `selectCodeMieProject()` fetches user info and surfaces the `applications` list.
- `src/providers/core/registry.ts` — `ProviderRegistry`: static Maps for `providers`, `healthChecks`, `modelProxies`, `setupSteps`. `getSetupSteps(provider)` returns registered steps. No project-context or integration awareness in the registry.
- `src/providers/core/types.ts` — `ProviderSetupSteps` interface. `getCredentials(isUpdate?: boolean)` takes only one optional boolean. `CodeMieIntegration` type has `{id, alias, project_name, credential_type}`. `CodeMieIntegrationInfo` (stored in config) has `{id, alias}` only — no API key field.
- `src/env/types.ts` — `ProviderProfile.codeMieIntegration?: CodeMieIntegrationInfo`. The project-level local config stores `{id, alias}` when integration is already configured.
- `src/utils/config.ts` — `ConfigLoader.load()` merges global → local → env → CLI. `loadLocalConfigProfile()` can read existing `.codemie/` config. `hasLocalConfig()` detects whether a local config exists. `initProjectConfig()` saves local overrides. `loadWithSources()` returns per-field source labels.

### Architecture and Layers Affected

| Layer | Components |
|---|---|
| CLI (entry point) | `src/cli/commands/setup.ts` — `runSetupWizard()`, `handlePluginSetup()` |
| Provider Plugin | `src/providers/plugins/litellm/litellm.setup-steps.ts` — `LiteLLMSetupSteps` |
| Provider Core | `src/providers/core/types.ts` — `ProviderSetupSteps` interface |
| API / HTTP | `src/providers/plugins/sso/sso.http-client.ts` — `fetchCodeMieIntegrations()` |
| Config / Persistence | `src/utils/config.ts` — `ConfigLoader`; `src/env/types.ts` — `ProviderProfile` |

### Integration Points

- `fetchCodeMieIntegrations` in `sso.http-client.ts` is the only existing function that fetches LiteLLM integrations from the backend. It requires an authenticated `apiUrl` and auth credentials (SSO cookies or JWT token). It is already imported and used by `sso.setup-steps.ts`.
- `ConfigLoader.load()` / `loadLocalConfigProfile()` can detect whether a local `.codemie/` config already stores a `codeMieIntegration`. This path does **not** require network access.
- `ProviderRegistry.getSetupSteps('litellm')` returns `LiteLLMSetupSteps`. The registry has no project-awareness hook today.
- `selectCodeMieProject()` in `codemie-auth-helpers.ts` fetches `applications` from `/v1/user` — needed for project identification when no local config exists.

### Patterns and Conventions

- **Plugin setup steps contract**: `ProviderSetupSteps.getCredentials(isUpdate?)` is the standard entry point. Adding an optional second parameter `context?` is the lowest-friction extension: `getCredentials(isUpdate?: boolean, context?: SetupContext): Promise<ProviderCredentials>`. The interface in `src/providers/core/types.ts` must be updated to allow this.
- **Fail-fast on auth errors**: `ConfigurationError` is thrown for missing/invalid keys per `external-integrations.md`. The same pattern should be used for a missing LiteLLM key when an integration is enforced.
- **Integration detection in the SSO flow (existing precedent)**: `sso.setup-steps.ts` lines 79–140 show the established pattern: call `fetchCodeMieIntegrations`, filter by project, auto-select or prompt. This same logic (or a refactored shared helper) should feed the enforcement gate.
- **`inquirer.prompt` for interactive gates**: All blocking prompts in the setup wizard use `inquirer.prompt`. A hard stop (throw) is the correct pattern when enforcement blocks proceed; the `displaySetupError` utility in `setup-ui.ts` can surface the reason.
- **Config validation before save**: The `handlePluginSetup()` function in `setup.ts` saves only after all steps succeed. Throwing inside `getCredentials()` or adding a `validate()` step (optional on `ProviderSetupSteps`) are both clean insertion points.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` — covers LiteLLM integration, SSO auth patterns, `ConfigurationError` usage, and the "Configuration Validation" section (validate at startup; throw on missing API key). Directly relevant.
- `.ai-run/guides/usage/project-config.md` — documents `ConfigLoader` API, local vs. global config schema, `codeMieIntegration` field in config, and the two-level profile merge. Directly relevant.
- `.ai-run/guides/architecture/architecture.md` — referenced from `AGENTS.md` for plugin-based 5-layer architecture.

### Architectural Decisions

- From `external-integrations.md`: "Missing API key → Throw `ConfigurationError` with env var name." The same class must be used for the LiteLLM key enforcement block.
- From `project-config.md`: the local `.codemie/` config stores `codeMieIntegration: {id, alias}`. This is already the persistence target for integration state — the enforcement logic can read it directly without a network call if a local config exists.
- From `sso.setup-steps.ts` (inline comment, line 106): `"Log error but don't fail setup — integrations are optional"` — this is the current, **non-enforcing** behavior that the ticket explicitly changes.

### Derived Conventions

- The `ProviderSetupSteps` interface is intentionally minimal. Optional fields (`validate?`, `postSetup?`, `installModel?`) are the established extension pattern. A new optional `context` parameter to `getCredentials` fits this style cleanly.
- Error messages in setup use `chalk` for formatting and `displaySetupError()` from `src/providers/integration/setup-ui.ts` for structured display.
- When a required field is absent, the wizard throws an `Error` which `handlePluginSetup()` catches and passes to `displaySetupError()`. This is the approved UX path for hard stops.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/__tests__/model-tier-auto-selection.test.ts` — tests `autoSelectModelTiers` in isolation; no integration coverage.
- `src/providers/integration/__tests__/setup-ui.test.ts` — tests the `setup-ui` helper display functions.
- `src/utils/__tests__/config-project-override.test.ts` — tests `ConfigLoader` project-level config merging, including `codeMieIntegration` fields. Uses `vi.spyOn` to mock `getCodemieHome`.
- `src/providers/plugins/sso/__tests__/sso.auth.test.ts` — tests SSO authentication. Does not cover integration detection logic in `sso.setup-steps.ts`.
- No tests exist for `LiteLLMSetupSteps` in `src/providers/plugins/litellm/`.
- No tests exist for the integration-enforcement logic (which does not exist yet).

### Testing Framework and Patterns

- **Framework**: Vitest with `describe`, `it`, `expect`, `vi.spyOn`, `vi.mock`.
- **Dynamic-import mocking**: Modules with side effects (like `inquirer`) use dynamic `vi.mock` at the top of test files.
- **File system**: Tests mock `getCodemieHome`/`getCodemiePath` via `vi.spyOn(paths, ...)` and create real temp directories (`tmp-test-config/`), cleaned up in `afterEach`.
- **Config fixtures**: Tests write raw JSON to disk and call `ConfigLoader.*` methods against them.

### Coverage Gaps

- `LiteLLMSetupSteps.getCredentials()` — zero test coverage.
- `fetchCodeMieIntegrations()` — no unit tests (integration-level calls only).
- The entire enforcement gate (the new feature) — no tests exist because the feature doesn't exist.
- `sso.setup-steps.ts` integration-detection block (lines 79–140) — no tests verify the auto-select or prompt behavior.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_DEBUG` — when set, `fetchCodeMieIntegrations` prints full URLs and response snippets to stdout (line 261, 326 of `sso.http-client.ts`).
- `CODEMIE_INTEGRATION_ID` — read by `ConfigLoader.loadFromEnv()` and surfaced as `codeMieIntegration.id` (seen in config-project-override test cleanup). Can provide integration ID via env in CI.
- `CODEMIE_PROJECT` — similarly env-sourced project name.
- `CODEMIE_API_KEY` — env override for `apiKey`, which maps to the LiteLLM key in a `litellm` profile.
- No dedicated env var for the LiteLLM key within an integration context exists yet. `CODEMIE_API_KEY` is the closest.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — global multi-provider config (`version: 2`, `profiles` record).
- `.codemie/codemie-cli.config.json` — local project override. The `codeMieIntegration: {id, alias}` field in `ProviderProfile` is the canonical persistence point for an established integration.

### Feature Flags and Deployment Concerns

- No existing feature flags cover this flow.
- The enforcement gate must be **conditional**: AC5 explicitly says "does not affect projects without LiteLLM integration." This is a local-config read before any prompt — no deployment or env-var flag needed.
- `requiresAuth: false` on `LiteLLMTemplate` must remain unchanged for the standalone LiteLLM case (without project integration). The enforcement is context-driven, not template-driven.

---

## 6. Risk Indicators

- **Current `getCredentials` signature does not support context injection.** `ProviderSetupSteps.getCredentials(isUpdate?: boolean)` has no parameter for passing integration context from the wizard into the plugin. Extending the interface (adding an optional `context?` parameter) is the cleanest path, but it touches `src/providers/core/types.ts` — a shared interface used by all seven registered provider plugins. All implementations must remain backward-compatible (optional parameter).
- **LiteLLM API key is not stored in `CodeMieIntegration`.** The backend integration object (`{id, alias, project_name, credential_type}`) does not carry a LiteLLM API key. The key must be provided by the user at setup time. This is correct per the acceptance criteria ("providing the required LiteLLM key") but means the key has no pre-fill source from the integration record — the user always enters it manually.
- **Integration detection requires auth for the live path.** If the project has no pre-existing local `.codemie/` config, detecting integrations requires a live API call with SSO or JWT credentials. For the standalone `litellm` provider path (not SSO), this is an untethered call — the setup wizard has no authenticated session to reuse. Implementation must handle both paths: (a) local config already stores `codeMieIntegration` — detect offline; (b) no local config — require auth to fetch integrations, which adds SSO/JWT dependency to what was previously a credential-free LiteLLM setup.
- **SSO integration detection is in `sso.setup-steps.ts`, not in a shared helper.** The fetching + filtering + auto-select logic (lines 79–140) is embedded inside the SSO plugin. If the LiteLLM setup needs the same detection, it must either (a) duplicate that logic, (b) extract it to a shared helper in `src/providers/core/` or `src/utils/`, or (c) route detection through the wizard layer in `setup.ts`. Option (c) is least invasive for the plugin interface; option (b) is cleanest architecturally.
- **`sso.setup-steps.ts` line 106 comment explicitly marks integrations as optional.** The existing SSO flow will also need updating to enforce the LiteLLM key when an integration is detected — not only the `litellm` provider path. If the user selects SSO as their provider in a project with an integration, the same enforcement AC applies.
- **No test coverage for `LiteLLMSetupSteps` at all.** Adding enforcement logic to an untested function increases regression risk. Tests should be written alongside the feature.
- **`handlePluginSetup()` throws errors caught by `displaySetupError()`.** Enforcement that throws will surface through the existing error path correctly, but the error message must be clear (AC4). The `displaySetupError` function accepts an `Error` and optional `setupInstructions` string — the message needs to explicitly reference the LiteLLM integration and explain why setup cannot proceed.
- **Seven registered provider plugins implement `ProviderSetupSteps`.** Any signature change (even optional) must be verified across all seven to confirm no TypeScript compile errors.

---

## 7. Summary for Complexity Assessment

The task adds an enforcement gate to the `codemie-cli setup` wizard that blocks completion when the project has a LiteLLM integration configured but the user has not provided a LiteLLM API key. The architectural layers affected are: CLI wizard (`setup.ts`), the LiteLLM provider plugin (`litellm.setup-steps.ts`), the shared provider types interface (`src/providers/core/types.ts`), and indirectly the SSO setup steps which need the same enforcement applied. The file change surface is 4–6 files: `setup.ts` (integration detection before provider selection, or context threading into `handlePluginSetup`), `litellm.setup-steps.ts` (key enforcement), `types.ts` (optional context parameter on `ProviderSetupSteps`), `sso.setup-steps.ts` (enforcement gate in the existing integration selection block), and potentially a new shared helper in `src/providers/core/` to avoid duplicating integration-fetch logic.

Technical novelty is moderate. The integration detection logic (`fetchCodeMieIntegrations`) already exists in `sso.http-client.ts` and is already used in the SSO setup steps — this is not new territory. The new element is the enforcement gate: detecting the integration first (from existing local config or via live API), then blocking `buildConfig`/save until a key is provided and validated. The key challenge is architectural: the current `ProviderSetupSteps.getCredentials(isUpdate?)` interface carries no project context, so either the interface is extended with an optional parameter or the wizard layer (`setup.ts`) detects the integration before calling `getCredentials` and redirects the flow. The second approach (wizard-level detection) is simpler for the plugin interface and avoids touching all seven provider implementations.

Test coverage posture is weak for the affected area: `LiteLLMSetupSteps` has zero existing tests, the integration-detection block in `sso.setup-steps.ts` is untested, and the enforcement gate is entirely new. The config-level helpers (`ConfigLoader`) are well-tested and can be leveraged for the offline detection path. Key risk factors are: (1) the LiteLLM API key has no pre-fill source from the integration object, so the UX must clearly guide the user to retrieve it externally; (2) the online detection path requires authenticated access, adding SSO/JWT dependency to a flow that previously needed none; (3) a shared helper extraction would be the cleanest architecture but adds scope. Complexity is medium — the logic is well-bounded but spans multiple layers and requires careful handling of the "no local config" case.
