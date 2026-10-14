# Multi-Model Profiles and Model Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `ProviderProfile` hold several models (`models?: string[]`) alongside the existing active `model`, add `codemie models switch` to change the active model in place, and limit the Claude/Codex/OpenCode/Pi in-session model menus to the profile's list — without a config migration and without changing any existing single-model profile's behavior.

**Architecture:** Additive optional field, normalized at read time (`resolveProfileModels`: missing `models` → `[model]`). `ProviderSetupSteps.buildConfig`/`installModel` signatures are unchanged; the wizard merges `models` into the built config the same way it already merges Claude tiers. A new `CODEMIE_PROFILE_MODELS` env var is the sole signal each agent plugin uses to intersect its own full-catalog menu down to the profile's list; its absence means "behave as today."

**Tech Stack:** TypeScript/ESM, Node >=20, Vitest, commander, inquirer v9, the project's raw-mode `shared/selection` picker.

**Spec:** `docs/superpowers/tasks/2026-10-13-epmcdme-15639/spec.md` (see also `story.md` for the 22 numbered ACs and `technical-analysis.md` for exact file/line references reused below).

Commit per task using the repository's existing convention.

## Global Constraints

- `ProviderProfile.model` keeps its current meaning (the active model) and stays readable by all ~20 existing consumers; `models` is additive and optional.
- No config schema migration. A profile with no `models` field is read as `[model]` everywhere, never persisted as such.
- `ProviderSetupSteps.buildConfig(credentials, selectedModel: string)` and `installModel(credentials, selectedModel, availableModels)` keep their current signatures — no provider `*.setup-steps.ts` file changes its contract.
- `codemie models switch` only ever touches the active profile (no `--profile` flag) and only writes `model` (+ Claude tier fields when applicable) — never `models`, credentials, `reasoningEffort`, or workspace.
- `CODEMIE_PROFILE_MODELS` is exported only when the active profile has 2+ models; its absence is the fallback signal for every agent-menu integration.
- Non-goals (do not build): `models add`/`remove` commands, per-agent active models, in-session switching outside each agent's own menu, `models switch --profile`, Anthropic/Moonshot multi-select, separate Claude tier selection, showing the full catalog in `models switch`.

## Review Focus

- An unknown `<model-id>` passed to `codemie models switch` must fail loudly (non-zero exit, lists the real `models`, points to `codemie setup`) rather than silently writing a bad value — Task 6.
- A legacy/single-model profile must produce byte-identical `exportProviderEnvVars` output (no `CODEMIE_PROFILE_MODELS` key at all) and an unmodified setup/switch experience — Tasks 2, 4, 6.
- `codemie setup` → "Update an existing profile" removing the active model must force the new-default prompt before saving, not after — Task 5.
- Agent-menu filtering must degrade to "show the full catalog" (not crash the launch) when the live catalog fetch fails, matching AC22's intent — Tasks 8–11.
- `ConfigLoader.switchActiveProfileModel` must preserve `reasoningEffort`, credentials and workspace, and must write to whichever scope (local/global) the active profile already lives in, not always global — Task 3.

---

### Task 1: `ProviderProfile.models` type + `resolveProfileModels` normalization helper

**Files:**
- Modify: `src/env/types.ts:51-58` — add `models?: string[];` under the existing `model?: string;` line, with a comment that it is additive and, when present, always includes `model`.
- Modify: `src/utils/config.ts` — add and export `resolveProfileModels(profile: Pick<ProviderProfile, 'model' | 'models'>): string[]` near the top-level exports (after the imports, before the `ConfigLoader` class), returning `profile.models?.length ? profile.models : profile.model ? [profile.model] : []`.
- Test: `src/utils/__tests__/resolve-profile-models.test.ts` (new).

**Interfaces:**
- Produces: `resolveProfileModels(profile): string[]`, imported as `import { resolveProfileModels } from '../utils/config.js'` by every later task that needs the normalized list (Tasks 2, 4, 5, 6, 7, 8–12).

- [ ] Write failing tests for `resolveProfileModels`: `{ model: 'a', models: ['a','b'] }` → `['a','b']`; `{ model: 'a' }` (no `models`) → `['a']`; `{}` → `[]`.
- [ ] Add the `models?: string[]` field and the exported helper.
- [ ] Run `src/utils/__tests__/resolve-profile-models.test.ts` and confirm it passes.

Test-first: yes — `resolveProfileModels` treats a missing `models` as `[model]` and an empty profile as `[]`.

---

### Task 2: Export `CODEMIE_PROFILE_MODELS`

**Files:**
- Modify: `src/env/types.ts` — add `models?: string[];` is already covered by Task 1; `CodeMieConfigOptions` picks it up automatically since it's `ProviderProfile & WorkspaceConfig`.
- Modify: `src/utils/config.ts:1494` (inside `exportProviderEnvVars`) — after the existing `if (config.model) env.CODEMIE_MODEL = ...` line, add: when `resolveProfileModels(config).length >= 2`, set `env.CODEMIE_PROFILE_MODELS = resolveProfileModels(config).join(',')`.
- Test: `src/utils/__tests__/export-provider-env.test.ts` (extend existing file).

**Interfaces:**
- Consumes: `resolveProfileModels` (Task 1).
- Produces: `CODEMIE_PROFILE_MODELS` env var — comma-separated model ids — consumed by Tasks 8–11.

- [ ] Add a failing test: a config with `models: ['a','b']` exports `CODEMIE_PROFILE_MODELS: 'a,b'`; a config with only `model` (no `models`, or `models: ['a']`) exports no `CODEMIE_PROFILE_MODELS` key at all.
- [ ] Implement the export.
- [ ] Run the extended test file and confirm it passes.

Test-first: yes — a single-model profile's env snapshot gains no new key; a 2+-model profile gains `CODEMIE_PROFILE_MODELS`.

---

### Task 3: `ConfigLoader.switchActiveProfileModel` — in-place active-model write

**Files:**
- Modify: `src/utils/config.ts` — add `static async switchActiveProfileModel(modelId: string, workingDir: string = process.cwd(), tierOverrides?: { haikuModel?: string; sonnetModel?: string; opusModel?: string }): Promise<{ profileName: string }>`, placed near `switchProfile` (l.728-766).
- Test: `src/utils/__tests__/switch-active-profile-model.test.ts` (new), following the `CODEMIE_HOME`-isolated pattern used in `config-project-override.test.ts`.

**Interfaces:**
- Consumes: nothing new; reuses `ConfigLoader.listProfiles`, `ConfigLoader.getActiveProfileName`, `ConfigLoader.hasLocalConfig`, `isMultiProviderConfig` the same way `switchProfile` does.
- Produces: `switchActiveProfileModel(modelId, workingDir?, tierOverrides?): Promise<{ profileName }>`, consumed by Task 6.

Implementation shape (mirrors `switchProfile`'s local/global detection at l.728-766, but patches one profile's fields in place instead of swapping `activeProfile`): resolve the active profile name and its scope (local config exists → local, else global), load that scope's raw `MultiProviderConfig`, mutate `config.profiles[activeName].model = modelId` and, when `tierOverrides` is given, the three tier fields, then write back with the same `fs.writeFile`/`saveMultiProviderConfig` call `switchProfile` already uses for that scope. Throw if there is no active profile.

- [ ] Write a failing test: starting from a profile with `model: 'a'`, `models: ['a','b']`, `reasoningEffort: 'high'`, call `switchActiveProfileModel('b')`, then re-load the config and assert `model === 'b'`, `models` unchanged, `reasoningEffort` unchanged, and (for a local-scoped active profile) the global file untouched.
- [ ] Write a second failing test: `tierOverrides` is supplied → `haikuModel`/`sonnetModel`/`opusModel` are overwritten; omitted → tier fields unchanged.
- [ ] Implement `switchActiveProfileModel`.
- [ ] Run the new test file and confirm both tests pass.

Test-first: yes — switching the model in place must leave every other profile field and the storage scope untouched.

---

### Task 4: Setup wizard — multi-select model picker with default-model prompt

**Files:**
- Modify: `src/cli/commands/setup.ts:448-548` — replace the single-choice `promptForModelSelection` with an exported `promptForModelsSelection(models: string[], providerTemplate?: ProviderTemplate, setupSteps?: ProviderSetupSteps, credentials?: ProviderCredentials, preselected?: string[]): Promise<{ models: string[]; activeModel: string }>`. Keep the empty-catalog manual/search branch (l.456-489) as-is but return `{ models: [result], activeModel: result }`. For the non-empty branch, replace the `type: 'list'` prompt (l.516-524) with `type: 'checkbox'` over the same `getAllModelChoices(...)` choices plus the existing "Custom model" and "Search Ollama library" entries, `default: preselected` (pre-checks on update), looped re-prompt when the confirmed selection is empty (AC5). Selecting "Custom model" or "Search Ollama library" adds that one id to the checked set and re-shows the checkbox rather than returning immediately. After confirmation: if exactly one model is selected, that is `activeModel`; if 2+, run one more `type: 'list'` prompt ("Which model should be active?") defaulting to the first already-active id in `preselected` when present, else the first selected id.
- Test: `src/cli/commands/__tests__/prompt-for-models-selection.test.ts` (new), mocking `inquirer.prompt` the way existing setup/profile tests mock dependencies.

**Interfaces:**
- Produces: `promptForModelsSelection(...): Promise<{ models: string[]; activeModel: string }>`, consumed by Task 5.

- [ ] Write failing tests: (a) 2+ models checked → second prompt asked, its answer becomes `activeModel`; (b) exactly 1 model checked → no second prompt, that model is `activeModel`; (c) empty confirmation re-prompts before returning; (d) choosing "Custom model (manual entry)" adds the typed id to the returned `models` array alongside any already-checked ids.
- [ ] Implement `promptForModelsSelection`.
- [ ] Run the new test file and confirm it passes.

Test-first: yes — see the four cases above.

---

### Task 5: Wire the multi-select into `handlePluginSetup` (install loop, update pre-check, config merge)

**Files:**
- Modify: `src/cli/commands/setup.ts:229` — change `handlePluginSetup` from a private `async function` to `export async function`, so it is directly unit-testable (mirrors the existing export of `autoSelectModelTiers`).
- Modify: `src/cli/commands/setup.ts:255-266` — when `preselectedModel` is undefined (i.e. not an Anthropic/Moonshot auto-pick), fetch the existing profile's models for pre-check (`isUpdate && profileName ? resolveProfileModels(await ConfigLoader.getProfile(profileName) ?? {}) : undefined`) and call `promptForModelsSelection(models, providerTemplate, setupSteps, credentials, existingModels)` instead of `promptForModelSelection`. Set `selectedModel = activeModel`; keep a new local `selectedModels = result.models`.
- Modify: `src/cli/commands/setup.ts:268-271` — loop `installModel` once per entry in `selectedModels` (not just `selectedModel`) when `providerTemplate?.supportsModelInstallation`.
- Modify: `src/cli/commands/setup.ts:292-295` — alongside the existing tier merge, add `config.models = selectedModels.length > 1 ? selectedModels : undefined;` (never persist a single-entry `models` array, keeping legacy shape for single-model profiles).
- Modify: `src/cli/commands/setup.ts:447-548` — delete the now-unused single-choice `promptForModelSelection` (superseded by Task 4's function) once nothing else calls it; confirm via grep before deleting.
- Modify: `tests/integration/agent-setup.test.ts:112` — update the PTY wait pattern from the single-choice `/Choose a model.*\(Use arrow keys\)/` text to whatever the checkbox prompt's message says (match the literal `message:` string set in Task 4), and assert a key press (e.g. space to check, then enter) instead of an arrow-key list selection.
- Test: `src/cli/commands/__tests__/handle-plugin-setup.test.ts` (new).

**Interfaces:**
- Consumes: `promptForModelsSelection` (Task 4), `resolveProfileModels` (Task 1).
- Produces: `handlePluginSetup(...)` now persists `config.models` (array or `undefined`) alongside the unchanged `config.model`.

- [ ] Write a failing test: mock `setupSteps` with `fetchModels` returning 3 ids and no `selectModel`; mock `promptForModelsSelection` to return `{ models: ['a','b'], activeModel: 'a' }`; assert `setupSteps.installModel` (when `supportsModelInstallation` is true) is called once per selected model, and the saved config has `models: ['a','b']`, `model: 'a'`.
- [ ] Write a second failing test: same setup but `isUpdate: true` with an existing profile `{ model: 'x', models: ['x','y'] }` — assert `promptForModelsSelection` is called with `preselected: ['x','y']`.
- [ ] Implement the changes above.
- [ ] Run the new unit test and confirm it passes; update the PTY assertion in `agent-setup.test.ts` (SSO-gated, not run here, but must compile and match the new prompt text).

Test-first: yes — see the two cases above.

---

### Task 6: `codemie models switch` subcommand

**Files:**
- Modify: `src/cli/commands/models.ts` — add an exported `export async function runModelsSwitch(modelIdArg: string | undefined, workingDir: string = process.cwd()): Promise<void>` and register it as `command.addCommand(createSwitchCommand())` (or a `switchCommand` sibling to `listCommand`, l.115) whose `.action()` calls `runModelsSwitch(modelIdArg, process.cwd())`.
- Create: `src/cli/commands/models-switch-prompt.ts` — a small raw-mode picker `promptModelSwitchSelection(models: string[], activeModel: string): Promise<string>`, built the same way `promptProfileSelectionCustom` is (`src/cli/commands/profile/index.ts:241-302`) on top of `buildSingleChoiceRow`/`buildTopLine` (`src/cli/commands/shared/selection/ui.ts`) and `ANSI`/`KEY` (`src/cli/commands/shared/selection/constants.ts`), but rendering model ids instead of `ProfileInfo` rows.
- Test: `src/cli/commands/__tests__/models-switch.test.ts` (new), mocking `ConfigLoader` the way `src/cli/commands/profile/__tests__/index.test.ts` does.

**Interfaces:**
- Consumes: `resolveProfileModels` (Task 1), `ConfigLoader.getActiveProfileName`/`getProfile` (existing), `ConfigLoader.switchActiveProfileModel` (Task 3), `autoSelectModelTiers` (existing, `src/cli/commands/setup.ts:625`), `ProviderRegistry.getModelProxy` (existing, as used in `models.ts:89-98`).
- Produces: `runModelsSwitch(modelIdArg, workingDir?): Promise<void>` — importable by tests without going through commander.

`runModelsSwitch` logic:
1. Load the active profile (`getActiveProfileName` + `getProfile`); if none, error and exit 1.
2. `const ids = resolveProfileModels(profile)`.
3. If `ids.length <= 1`: print "Profile '<name>' has a single model (<model>). Run `codemie setup` → Update an existing profile to add more." — for `profile.provider` in `{'anthropic-subscription','moonshot-subscription'}` use the alternate wording "the <provider> provider doesn't support multiple models." Exit 0, write nothing.
4. If `modelIdArg` is given and not in `ids`: print the error listing `ids` and pointing to `codemie setup`; exit 1, write nothing.
5. Resolve `targetModel` = `modelIdArg` if given, else `await promptModelSwitchSelection(ids, profile.model!)`.
6. If the active agent's Claude metadata supports `profile.provider` (same condition as `setup.ts:275-281`, reusing `AgentRegistry.getAgent('claude')`), fetch the live catalog via `ProviderRegistry.getModelProxy(profile.provider).fetchModels(config)` (ids via `.map(m => m.id)`) and compute `tierOverrides = await autoSelectModelTiers(catalogIds, targetModel)`; otherwise `tierOverrides = undefined`.
7. `await ConfigLoader.switchActiveProfileModel(targetModel, workingDir, tierOverrides)`.
8. Print `Switched <profileName> to <targetModel>`.

- [ ] Write a failing test for each path: (a) arg matches a profile model → writes without prompting, prints the confirmation; (b) arg absent from `profile.models` → exits non-zero, lists the real models, no write; (c) no arg, 2+ models → `promptModelSwitchSelection` is called and its answer is written; (d) single-model profile → prints the "single model" message, no write, exit 0; (e) anthropic-subscription single-model profile → prints the provider-specific wording.
- [ ] Implement `runModelsSwitch`, `promptModelSwitchSelection`, and the `switch` subcommand registration.
- [ ] Run the new test file and confirm all five cases pass.

Test-first: yes — the five cases above.

---

### Task 7: AgentCLI compatibility-hint addition

**Files:**
- Modify: `src/agents/core/AgentCLI.ts:702-710` (inside the `isBlocked` branch of `validateCompatibility`) — after the existing `codemie models list` / `--model <model-id>` suggestions, add: when `resolveProfileModels(config).length >= 2`, print `console.log(chalk.white('  Or run: ') + chalk.cyan('codemie models switch') + chalk.white(' to pick a compatible model from this profile.'))`; omit the line otherwise.
- Test: `src/agents/core/__tests__/agentcli-compatibility-hint.test.ts` (new).

**Interfaces:**
- Consumes: `resolveProfileModels` (Task 1).

- [ ] Write a failing test: a config with `models: ['gpt-x']` (1 entry) launching `codemie-claude` with a blocked model prints no `codemie models switch` line; a config with `models: ['gpt-x','gpt-y']` prints it.
- [ ] Implement the addition.
- [ ] Run the new test file and confirm it passes.

Test-first: yes — the suggestion appears only when the active profile has 2+ models.

---

### Task 8: Claude `/model` picker — intersect with `CODEMIE_PROFILE_MODELS`

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts:482-495` — after `const options = await buildModelPickerOptions(env);`, when `env.CODEMIE_PROFILE_MODELS` is set, filter `options` to `allowed = new Set(env.CODEMIE_PROFILE_MODELS.split(','))` (keep an option whose `model` id, stripped of the `[1m]` suffix, is in `allowed`); if the filtered list is empty, keep the unfiltered `options` and log one `logger.warn` line that the menu still shows the full catalog (AC22 fallback). The existing `catch` block (l.490-495) already covers the "catalog fetch failed" fallback.
- Test: `src/agents/plugins/claude/__tests__/claude.models-menu-filter.test.ts` (new), or extend `src/agents/plugins/claude/__tests__/claude.models.test.ts` if `buildModelPickerOptions` itself gains the filter instead of the call site (either placement is acceptable; keep the filter next to the catalog data, not duplicated).

**Interfaces:**
- Consumes: `CODEMIE_PROFILE_MODELS` (Task 2).

- [ ] Write a failing test: `buildModelPickerOptions` returns 4 options; with `CODEMIE_PROFILE_MODELS=a,b` set, only the options whose id matches `a` or `b` reach `env.CODEMIE_CLAUDE_MODEL_PICKER_SETTINGS`; with the var unset, all 4 reach it unchanged.
- [ ] Write a second failing test: `CODEMIE_PROFILE_MODELS` set to ids that match none of the live options → the full unfiltered list is still written (fallback), and a warning is logged.
- [ ] Implement the filter.
- [ ] Run the test(s) and confirm they pass.

Test-first: yes — the two cases above.

---

### Task 9: Codex model catalog — intersect with `CODEMIE_PROFILE_MODELS`

**Files:**
- Modify: `src/agents/plugins/codex/codex.plugin.ts:545-551` (the SSO/JWT/Bedrock branch) — after `env.CODEMIE_CODEX_AVAILABLE_MODELS = resolution.availableModels.join(',');`, when `env.CODEMIE_PROFILE_MODELS` is set, re-derive it from `resolution.availableModels.filter(id => allowed.has(id))`, falling back to the unfiltered join when the intersection is empty.
- Modify: `src/agents/plugins/codex/codex.plugin.ts:513-524` (Ollama branch) and `:540` (LiteLLM branch) — apply the same intersection to `ids`/the single configured model when `CODEMIE_PROFILE_MODELS` is set.
- Test: `src/agents/plugins/codex/__tests__/codex-profile-models-filter.test.ts` (new).

**Interfaces:**
- Consumes: `CODEMIE_PROFILE_MODELS` (Task 2).

- [ ] Write a failing test for the SSO branch: `resolveCodexModel` resolves `availableModels: ['a','b','c']`; with `CODEMIE_PROFILE_MODELS=a,b`, `env.CODEMIE_CODEX_AVAILABLE_MODELS` ends up `'a,b'`; unset, it stays `'a,b,c'`.
- [ ] Write a failing test for the Ollama branch with the same shape.
- [ ] Implement both filters.
- [ ] Run the new test file and confirm it passes.

Test-first: yes — the two branch cases above.

---

### Task 10: OpenCode / codemie-code dynamic model config — intersect with `CODEMIE_PROFILE_MODELS`

**Files:**
- Modify: `src/agents/plugins/codemie-code.plugin.ts:272-283` — after `const allModels = await fetchDynamicModelConfigs(...)`, when `env.CODEMIE_PROFILE_MODELS` is set, build `const limitedModels = filterToAllowed(allModels, env.CODEMIE_PROFILE_MODELS, selectedModel)` (new small helper, see below) and pass `limitedModels` instead of `allModels` into `getChatCompletionsModelConfigs`/`getResponsesApiModelConfigs`; `modelConfig` itself keeps resolving from the unfiltered `allModels` so the active model always has a valid config even if excluded by a stale list.
- Modify: `src/agents/plugins/opencode/opencode.plugin.ts:300` area — apply the identical change (same import, same local variable names per the technical analysis).
- Create: a small exported `filterToAllowed(allModels: Record<string, OpenCodeModelConfig>, allowedCsv: string, selectedModel: string): Record<string, OpenCodeModelConfig>` in `src/agents/plugins/opencode/opencode-model-configs.ts`, keeping any key in the CSV list plus `selectedModel`; empty intersection returns `allModels` unchanged (AC22 fallback).
- Test: `src/agents/plugins/opencode/__tests__/opencode-model-configs-filter.test.ts` (new).

**Interfaces:**
- Produces: `filterToAllowed(...)`, consumed by both `codemie-code.plugin.ts` and `opencode.plugin.ts`.

- [ ] Write a failing test: `allModels` has 3 keys; `filterToAllowed(allModels, 'a,b', 'a')` returns only `a`/`b`; `filterToAllowed(allModels, 'z', 'a')` (no overlap) returns `allModels` unchanged; `filterToAllowed(allModels, '', 'a')` is never called when the env var is unset (covered at the call-site tests below instead).
- [ ] Write a failing call-site test for `codemie-code.plugin.ts` (or `opencode.plugin.ts`): with `CODEMIE_PROFILE_MODELS` set, the generated OpenCode config's model list is the filtered set; unset, it is the full set.
- [ ] Implement `filterToAllowed` and wire it into both plugin files.
- [ ] Run both test files and confirm they pass.

Test-first: yes — the helper's three cases plus one call-site case.

---

### Task 11: Pi `models.json` — intersect with `CODEMIE_PROFILE_MODELS`

**Files:**
- Modify: `src/agents/plugins/pi/pi.models.ts:422-427` (inside `fetchAndBuildPiModels`, the live-catalog branch) — after `entries = rawModels.filter(model => model.enabled).map(convertLlmModelToPiEntry);`, when `env.CODEMIE_PROFILE_MODELS` is set, filter `entries` to those whose id is in the allowed set (keep the configured `env.CODEMIE_MODEL` even if absent from the list, matching the Ollama id-reinsertion precedent in `codex.plugin.ts:519-521`); if the intersection is empty, keep `entries` unfiltered and `logger.warn` the AC22 fallback notice.
- Test: `src/agents/plugins/pi/__tests__/pi.models.profile-filter.test.ts` (new, alongside the existing `pi.models.test.ts`).

**Interfaces:**
- Consumes: `CODEMIE_PROFILE_MODELS` (Task 2).

- [ ] Write a failing test: `fetchCodeMieModels` returns 3 enabled models; with `CODEMIE_PROFILE_MODELS=a,b` the written `models.json` contains only `a`/`b` (plus the configured model if it was dropped); unset, all 3 are written.
- [ ] Write a second failing test: `CODEMIE_PROFILE_MODELS` set to ids with no overlap at all → the unfiltered list is written and a warning logged.
- [ ] Implement the filter.
- [ ] Run the new test file and confirm it passes.

Test-first: yes — the two cases above.

---

### Task 12: Visibility — profile display/status and `codemie models list`

**Files:**
- Modify: `src/utils/profile.ts:53-55` (`renderProfileInfo`) — accept an optional `otherModels?: string[]` field on its options object; when non-empty, add a row `formatRow('Other models', otherModels.join(', '))` right after the existing `Model` row.
- Modify: `src/cli/commands/profile/display.ts:33-42` (`ProfileDisplay.format`) and `:117-124` (`formatStatus`) — compute `const ids = resolveProfileModels(profile); const otherModels = ids.filter(id => id !== profile.model);` and pass `otherModels` into `renderProfileInfo`.
- Modify: `src/cli/commands/models.ts:38-46` (`formatTable`) — accept the active profile's `resolveProfileModels(...)` result and `profile.model` as parameters; mark each row whose `model.id` is in that list, and bold/suffix the one matching the active model (e.g. an extra column or a trailing `(active)`/`(profile)` tag), reusing the existing `ID_WIDTH`/padding helpers.
- Modify: `src/cli/commands/models.ts:76-98` (`listCommand`'s action) — load `const profile = await ConfigLoader.getProfile(await ConfigLoader.getActiveProfileName(...) ?? '')` (or reuse `config` already loaded) and pass the computed ids/active model into `formatTable`.
- Test: `src/cli/commands/profile/__tests__/index.test.ts` (extend), `src/cli/commands/__tests__/models-list-marking.test.ts` (new).

**Interfaces:**
- Consumes: `resolveProfileModels` (Task 1).

- [ ] Write a failing test: `ProfileDisplay.format` on a profile with `model: 'a'`, `models: ['a','b','c']` renders an "Other models" row containing `b, c` but not `a`; a legacy single-model profile renders no such row.
- [ ] Write a failing test: `codemie models list`'s table marks catalog rows `a` and `b` as belonging to the profile, and only `a` as active, when the active profile has `model: 'a'`, `models: ['a','b']`.
- [ ] Implement both changes.
- [ ] Run the extended/new test files and confirm they pass.

Test-first: yes — the two cases above.

---

### Task 13: Documentation updates

**Files:**
- Modify: `docs/CONFIGURATION.md` ("Multi-Provider Profiles" section, l.24-110 per the technical analysis) — describe the optional `models` array alongside `model`, with an example profile that has 2+ models.
- Modify: `docs/COMMANDS.md` ("Profile Management Commands", l.585 and l.1310 per the technical analysis) — document `codemie models switch [model-id]` next to `codemie models list`.
- Modify: `.ai-run/guides/usage/project-config.md` — add the `models` field to the v2 schema example and note it is optional/additive.
- Modify: `docs/ARCHITECTURE-CONFIGURATION.md` — add `CODEMIE_PROFILE_MODELS` to the env var flow diagram/table (l.12, 323 area per the technical analysis).
- Modify: `src/cli/commands/models.ts` — update the `command.description(...)` (l.69) and add a `.addHelpText('after', ...)` block describing `switch`, multi-model profiles, and the limited in-session menus.

No test — documentation only; nothing here is independently executable.

- [ ] Update each doc file with the content above.
- [ ] Update `codemie models --help` text in `models.ts`.

Test-first: no — documentation-only change; nothing here has executable behavior to pin with a test.

---

## Self-Review

**Spec coverage:** Setup multi-select + default-pick + custom/search merge + empty-reprompt + Ollama install loop + Anthropic/Moonshot untouched → Tasks 4–5. Update pre-check + re-ask-default-on-removal → Task 5. `models switch` interactive/arg/error/single-model/subscription-wording paths → Task 6. Launch-time "not silently replaced" / "retired still heals" → already-existing behavior per the spec, no task needed (confirmed no `CODEMIE_MODEL_SOURCE` change required). Claude tier refresh on switch → Task 6 step 6. Compatibility-hint addition → Task 7. `CODEMIE_PROFILE_MODELS` export → Task 2. Agent menus (Claude/Codex/OpenCode/Pi) + AC22 fallback → Tasks 8–11. Visibility (`profile`/`status`, `models list`) → Task 12. Legacy profiles keep working → Task 1's normalization plus every later task reading through `resolveProfileModels`. Docs → Task 13. No gaps found.

**Placeholder scan:** No TBD/"add appropriate handling"/elided code found; every step either cites an exact file:line edit or shows the new symbol's full shape.

**Type consistency:** `resolveProfileModels(profile): string[]` (Task 1) is used with the same name and signature in Tasks 2, 4 (via `preselected`), 5, 6, 7, 12. `switchActiveProfileModel(modelId, workingDir?, tierOverrides?)` (Task 3) is called identically in Task 6 step 7. `promptForModelsSelection(...): Promise<{ models, activeModel }>` (Task 4) is destructured identically in Task 5. `filterToAllowed(allModels, allowedCsv, selectedModel)` (Task 10) is the only new per-plugin filter helper; Tasks 8, 9, 11 inline their own filters since each plugin's data shape (`ModelPickerOption[]`, a CSV string, Pi entries) differs enough that a shared helper would need three different adapters — not worth the indirection for 3 call sites.

**Negative constraints:**
- `buildConfig`/`installModel` signatures unchanged — Tasks 1–11 never touch `ProviderSetupSteps`; verified by grep-before-delete step in Task 5.
- No config migration — Task 1's `resolveProfileModels` normalizes at read time instead; no file under `src/migrations/` is touched by any task.
- `models switch` never touches another profile or `--profile` — Task 6's `runModelsSwitch` takes no profile-name argument, only `modelIdArg`.
- `models switch` never writes `models`, credentials, `reasoningEffort`, or workspace — Task 3's `switchActiveProfileModel` only mutates `model` and, optionally, the three tier fields, inside the existing profile object; it does not call `saveProfile`'s wholesale-replace path.
- Anthropic/Moonshot subscription setup is untouched — Task 4/5's multi-select is only reached when `setupSteps.selectModel` returns nothing (l.257-266 is unchanged in that branch), which the two subscription providers' `selectModel` auto-pick already short-circuits.
- In-session agent choices never persist — Tasks 8–11 only shape each agent's own menu/env data for that process; none of them write back into `ConfigLoader`.
- `codemie models switch` never shows the full provider catalog — Task 6's picker is built from `ids = resolveProfileModels(profile)` only, never from `ProviderRegistry.getModelProxy(...).fetchModels(...)`.
- negative-constraints: all covered above; none skipped.
