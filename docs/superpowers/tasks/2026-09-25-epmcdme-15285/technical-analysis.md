# Technical Research

**Task**: vscode byok model-list setup
**Generated**: 2026-09-25
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-15285 (Bug): VS Code BYOK: model list is inconsistent after changing the default model in CodeMie Setup

Summary: In CodeMie 15.3 with BYOK configured in VS Code, changing the default model in CodeMie Setup causes the model list in VS Code to be displayed inconsistently.

Description: The available-model list in VS Code becomes filtered or stale after the default model is changed in CodeMie Setup. This prevents users from reliably selecting from the complete set of currently available models.

Preconditions:
- CodeMie version 15.3 is used.
- BYOK is configured in VS Code.
- CodeMie Setup is available and allows selecting a default model.

Steps to Reproduce:
1. Open CodeMie Setup.
2. Select Sonnet 5 as the default model.
3. Open the model selector in VS Code and review the available models.
4. Return to CodeMie Setup and select GPT-6 Sol as the default model.
5. Open the model selector in VS Code again and review the available models.

Expected Result:
- The VS Code model selector consistently displays the complete and current list of models available to the user.
- Changing the default model in CodeMie Setup changes only the default selection and does not filter, replace, or revert the available-model list.

Actual Result:
- After selecting Sonnet 5, it is the only model displayed in the VS Code model selector.
- After selecting GPT-6 Sol, the older model list returns, but newly added models are missing.

Affected Areas: CodeMie Setup default model selection; VS Code BYOK integration; model discovery, synchronization, and model-selector UI.

Acceptance Criteria:
1. Changing the default model in CodeMie Setup does not reduce the VS Code model list to the selected model.
2. The VS Code model selector displays the complete current set of models available to the user after any default-model change.
3. Newly added models remain visible after selecting either Sonnet 5 or GPT-6 Sol as the default model.
4. The selected default model is reflected correctly in VS Code without restoring a stale model list.
5. The behavior is verified in CodeMie 15.3 with BYOK configured in VS Code.

Research hint: locate how CodeMie Setup (codemie setup / profile model selection) writes a model list or model config consumed by VS Code BYOK (e.g. VS Code settings / Copilot BYOK / chat language model config, proxy /v1/models endpoint filtering, or cached model lists). Identify where the model list is derived from the default model or a cached/stale list.

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/proxy/connectors/vscode.ts` (326 lines) — sole writer of VS Code Copilot BYOK `User/chatLanguageModels.json`. Key functions:
  - `resolveManagedModels(proxyUrl, gatewayKey, profileModel)` — fetches tenant catalog, intersects it with `VS_CODE_CAPABILITY_TABLE` via `resolveTenantModelId`, then **if `profileModel` resolves to one of the intersected entries, returns `[pinnedManagedModel]` only**; otherwise returns the full intersection. Docstring states this is intentional: "narrow the result to just that one entry instead of offering every family the tenant serves".
  - `mergeManagedProviders()` — replaces the `models` array of the managed provider (`name: 'CodeMie'`, `vendor: 'customendpoint'`) wholesale; preserves `settings` and the `${input:chat.lm.secret.*}` `apiKey` reference.
  - `writeVsCodeLanguageModelsConfigAtPath()` — reconciles duplicate managed providers, writes atomically; returns `{ configPath, requiresSecretConfiguration, modelCount }`.
- `src/cli/commands/proxy/connectors/vscode-models.ts` — static `VS_CODE_CAPABILITY_TABLE` (~27 families: `claude-sonnet-5`, `gpt-5.6-sol/luna/terra`, `claude-opus-5`, gemini, qwen, kimi…). No `gpt-6*` family exists. Any tenant model absent from this table is never written.
- `src/cli/commands/proxy/connectors/tenant-catalog.ts` — `fetchTenantModelCatalog()` GETs `/v1/llm_models?include_all=true` through the local proxy, 10 s timeout, no caching.
- `src/cli/commands/proxy/connectors/model-name-resolver.ts` — `resolveTenantModelId(family, available)`: exact match, else GPT/Claude identity parse (vendor prefix `openai.` stripped, dates stripped, vendor/segment/major/minor equality), `pickMostRecent`.
- `src/cli/commands/proxy/connect-orchestrator.ts:452-459` — `runVscodeByok()` calls `writeVsCodeLanguageModelsConfig(state.url, state.gatewayKey, insiders, config.model)`; `config.model` is the effective profile's model from `ConfigLoader.load`.

Behaviour mapped to the repro:
- Profile model `claude-sonnet-5` (Sonnet 5) → resolves in table + catalog → list narrowed to 1 model (AC1 failure).
- Profile model "GPT-6 Sol" → no capability-table family (parse yields major 6) → falls back to full static-table ∩ catalog → "older list"; tenant models not in the static table (newly added) are dropped (AC3 failure).

History: narrowing introduced by `3c966c1 fix(proxy): route VS Code through selected profile model (#555)` (static table), reworked onto tenant catalog in `c95e6b4 (#567)`.

No code in this repo auto-rewrites `chatLanguageModels.json` when the profile model changes (grep of `chatLanguageModels` / writer callers: only `connect-orchestrator.ts`). "CodeMie Setup" is not a named component in the repo; `src/cli/commands/setup.ts` has no proxy/VS Code references. The re-write happens when `codemie proxy connect --vscode` (or deprecated `connect vscode`) is re-run.

### Architecture and Layers Affected
- CLI layer: `src/cli/commands/proxy/connect-orchestrator.ts`, `src/cli/commands/proxy/index.ts` (flags `--vscode`, `--insiders`, `--profile`).
- Connector (config-writer) layer: `connectors/vscode.ts`, `vscode-models.ts`, `tenant-catalog.ts`, `model-name-resolver.ts`.
- Proxy daemon (SSO provider plugin): unaffected by model selection — docs state the daemon "never receives a configured model"; `vscode-request-normalizer.plugin.ts` normalizes `vscode-byok` requests only.

### Integration Points
- Gateway `/v1/llm_models?include_all=true` via local proxy (Bearer gateway key).
- VS Code user data dir via `getVsCodeProductDir(insiders)` (darwin/win32/linux).
- `resolveTenantModelId` is shared with `connectors/desktop.ts` (Claude Desktop) and `vscode-claude-code.ts`.
- Comparable pattern: `connectors/codex-desktop.ts` `selectCodexModel(discovered, requested, profileModel)` uses profile model to pick the **default** model without narrowing the discovered list.

### Patterns and Conventions
- `ConfigurationError` from `@/utils/errors.js`; `logger` + `sanitizeLogArgs` for logs; atomic write via `writeAtomically`.
- Managed-provider identity = `vendor === 'customendpoint' && name === 'CodeMie'`; user-owned `settings` preserved ("VS Code owns effort selections").

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md:49-52` — proxy connectors use the effective active profile; model/provider/credentials follow the selected profile.
- `docs/ARCHITECTURE-PROXY.md` §6.6 (line 709+) — "The selected profile's `model` is written directly to VS Code's `models[].id`"; "The connector merges one managed model into VS Code's `chatLanguageModels.json`"; "Model changes only rewrite VS Code configuration; they do not restart the daemon."
- `docs/COMMANDS.md:98-210` — says the connector "writes the managed CodeMie model catalog"; troubleshooting row: "Active profile changed but model did not → Re-run `codemie proxy connect vscode`".
- No guide covers the VS Code BYOK model list specifically.

### Architectural Decisions
- #555 / #567 deliberately narrow the picker to the profile-pinned model (docstring in `vscode.ts`). `docs/superpowers/tasks/2026-09-17-tenant-model-catalog/` (spec/plan) records the tenant-catalog intersection and "a capability family with no tenant match is silently dropped".

### Derived Conventions
- Capability metadata (apiType, effort list, token limits) comes only from the static table; the tenant catalog only gates presence and supplies the verbatim id.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts` — `describe('profileModel pinning')` (lines 391-462) **asserts the narrowing** (`toHaveLength(1)` for `gpt-5.6-luna`, `gpt-4.1-mini`) plus fallback for unmatched/unset/blank pins; tenant-catalog AC1-AC5 cases; secret/settings preservation.
- `__tests__/vscode-models.test.ts`, `model-name-resolver.test.ts`, `tenant-catalog.test.ts` — table invariants, resolver, catalog fetch.
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — writer mocked (`vi.fn()`); checks invocation, not the `config.model` argument semantics.
- `tests/integration/vscode-byok.test.ts` — full model matrix with a bogus `PROFILE_MODEL` (fallback path) asserting `models.length === VS_CODE_CAPABILITY_TABLE.length`; `tests/integration/vscode-models.live.test.ts` — live cert.

### Testing Framework and Patterns
- Vitest; temp dir via `mkdtemp`; `globalThis.fetch = vi.fn()` with `mockCatalog(...)` fixtures (`NON_EPAM_TENANT_FIXTURE`, `EXPECTED_MODEL_IDS`); dynamic imports after `vi.mock` in orchestrator tests.

### Coverage Gaps
- No test for tenant models absent from the capability table (they are silently dropped by design).
- No test of repeated writes with differing profile models (list stability across default changes).

---

## 5. Configuration and Environment

### Environment Variables
- `APPDATA` (win32), `XDG_CONFIG_HOME` (linux) — VS Code user-dir resolution. No env var toggles the model list.

### Configuration Files
- VS Code `User/chatLanguageModels.json` (array of providers; CodeMie provider's `models[]` = the picker list). Per-model fields: `id`, `name`, `url`, `apiType`, `toolCalling`, `vision`, `streaming`, `thinking`, token limits, optional effort fields. No default-model field exists in the written schema.
- CodeMie profile `model` (via `ConfigLoader.load`) — the only input tying "default model" to the list.

### Feature Flags and Deployment Concerns
- None. Daemon reuse matches on `model: normalizeDaemonModel(config.model)` among other fields (`connect-orchestrator.ts` `RequestedDaemonConfig`).

---

## 6. Risk Indicators

- Root cause is explicit, tested behaviour (`resolveManagedModels` pin branch + `profileModel pinning` tests); fixing it inverts existing assertions and contradicts #555 intent and `ARCHITECTURE-PROXY.md` §6.6 wording ("merges one managed model").
- "Newly added models missing" stems from the static `VS_CODE_CAPABILITY_TABLE` allowlist; no `gpt-6*` entry. Speculative: satisfying AC3 for arbitrary new tenant models may require default capability metadata for unknown families — a design decision with correctness risk (wrong `apiType`/effort/token limits).
- AC4 ("default reflected in VS Code"): the written schema has no default-model field; Copilot's picker selection is VS Code-owned state. Speculative: may be unachievable from the config file beyond ordering/naming.
- "CodeMie Setup" is not a component in this repo; the trigger that re-runs the connector after a default change is external/manual. Scope boundary unclear.
- `resolveTenantModelId` is shared with Claude Desktop connectors — changes there widen blast radius.
- Docs (`COMMANDS.md`, `ARCHITECTURE-PROXY.md`) describe profile-model behaviour and would drift.

---

## 7. Summary for Complexity Assessment

The bug is located in the connector layer: `resolveManagedModels()` in `src/cli/commands/proxy/connectors/vscode.ts` returns only the profile-pinned model when the profile's model (from `connect-orchestrator.ts:459`, `config.model`) resolves against the tenant catalog and capability table. That produces the "Sonnet 5 is the only model" symptom. When the pinned model (e.g. a GPT-6 variant) matches no family in the static `VS_CODE_CAPABILITY_TABLE`, the code falls back to the full static-table ∩ tenant-catalog list, which omits any tenant model the table doesn't know, producing "older list, newly added models missing". The core change surface is 1-2 source files (`vscode.ts`, maybe `vscode-models.ts`) plus the orchestrator call site. Docs in `docs/ARCHITECTURE-PROXY.md` and `docs/COMMANDS.md` describe the current behaviour.

Nothing here is technically new. The narrowing is deliberate behaviour from #555/#567, and existing unit tests (`vscode.test.ts` "profileModel pinning") assert it, so the fix reverses a recorded decision and rewrites those tests. The resolver, catalog and writer are well covered by Vitest with fetch mocks and temp-dir fixtures. The integration test `tests/integration/vscode-byok.test.ts` already expects the full-table list on the fallback path.

The main risks are about scope, not code. First, "CodeMie Setup" and the step that re-runs the connector are outside this repo. Second, keeping newly added models visible (AC3) runs into the static capability allowlist. Third, AC4 (show the default in VS Code) has no field in the current `chatLanguageModels.json` schema to carry it.

---

## 8. External References

None named by the task.
