# EPMCDME-15285 VS Code BYOK Full Model List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `chatLanguageModels.json` always lists every enabled tenant model from `/v1/llm_models?include_all=true`, whatever the profile's default model is.

**Architecture:** The connector reads full model descriptors from the tenant catalog. It keeps the catalog order and enriches each model from `VS_CODE_CAPABILITY_TABLE` when a family matches. A model with no matching family gets conservative defaults built from its descriptor. The profile model no longer reaches the writer.

**Tech Stack:** TypeScript (ESM), Vitest.

## Acceptance criteria

- [ ] Changing the profile/default model never shrinks the written VS Code list to the selected model.
- [ ] Every enabled model the tenant catalog returns is written, in catalog order, including models that have no capability-table family (e.g. a `gpt-6-*` deployment).
- [ ] A re-run after the catalog grows writes the new models too. The list is rebuilt from the live catalog every time, never from an older or narrowed list.
- [ ] No model is reordered or marked as the default.
- [ ] Known families keep their capability-table metadata (apiType, effort, token limits, headers).

## Global Constraints

- ES modules with `.js` import extensions, `@/` alias, `logger` (never `console`), no `any`, explicit return types on exports.
- `resolveTenantModelId` (`src/cli/commands/proxy/connectors/model-name-resolver.ts`) is called as-is and never edited. It is shared with Claude Desktop.
- Do not import from `src/agents/plugins/opencode/`. The connector layer re-implements the small heuristics it needs, following `opencode-dynamic-models.ts:36-85` as precedent.
- Kept prior product-owner decision (`docs/superpowers/tasks/2026-09-17-tenant-model-catalog/spec.md:175`): `github-copilot-*` deployments stay excluded. This is the only exclusion besides `enabled: false`.
- Commit per task using the repository's existing convention.

---

### Task 1: Tenant catalog returns model descriptors

**Files:** Modify `src/cli/commands/proxy/connectors/tenant-catalog.ts:5-13,32-42,107-155`. Test `src/cli/commands/proxy/connectors/__tests__/tenant-catalog.test.ts`.

**Produces:**
```ts
export interface TenantModelDescriptor {
  id: string;            // id || base_name || deployment_name, verbatim
  label?: string;
  provider?: string;
  multimodal?: boolean;
  toolCalling?: boolean; // from features.tools
}
export async function fetchTenantModelDescriptors(proxyUrl: string, gatewayKey: string): Promise<TenantModelDescriptor[]>;
```

Test-first: yes — `fetchTenantModelDescriptors` returns `label`/`multimodal`/`features.tools` mapped per entry, drops `enabled: false` entries, and keeps the first of two same-id entries, in response order.

- [ ] Add the failing tests (reuse the file's existing fetch-mock helper).
- [ ] Widen the local `CodeMieLlmModel` with `label`, `enabled`, `provider`, `multimodal`, `features?: { tools?: boolean }`. Move the fetch/error body into `fetchTenantModelDescriptors`. Keep entries where `enabled !== false`, since a missing `enabled` means enabled (existing fixtures send only `base_name`). Dedupe by id and keep catalog order. Do not read `default`.
- [ ] Make `fetchTenantModelCatalog` a one-line `.map(d => d.id)` wrapper so its existing tests pass unchanged. Run the file's tests.

### Task 2: Capability table becomes enrichment plus defaults

**Files:** Modify `src/cli/commands/proxy/connectors/vscode-models.ts:12-28`. Test `src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts`.

**Consumes:** `TenantModelDescriptor` (Task 1). **Produces:**
```ts
// on VsCodeCapabilityEntry: toolCalling?: boolean  (absent ⇒ true)
export function findVsCodeCapabilityEntry(tenantId: string): VsCodeCapabilityEntry | undefined;
export function buildDefaultVsCodeCapability(descriptor: TenantModelDescriptor): VsCodeCapabilityEntry;
```

Test-first: yes — `findVsCodeCapabilityEntry('openai.gpt-5.6-luna')` returns the `gpt-5.6-luna` entry and returns `undefined` for `gpt-6-sol`. `buildDefaultVsCodeCapability` maps `multimodal` to vision and `toolCalling: false` to `toolCalling: false`. It returns `responses` + `zeroDataRetentionEnabled: true` for `gpt-6-sol` / `openai.gpt-6-sol` and `chat-completions` for `claude-future-9`.

- [ ] Add the failing tests.
- [ ] `findVsCodeCapabilityEntry`: first try an exact `family === tenantId`. Otherwise return the first entry where `resolveTenantModelId(entry.family, [tenantId]) === tenantId`. This is a read-only use of the resolver.
- [ ] `buildDefaultVsCodeCapability`: `family` = id and `thinking: false`, with no effort fields and no headers. `vision` = `multimodal === true` and `toolCalling` = `toolCalling !== false`. Limits are `maxInputTokens: 128000` and `maxOutputTokens: 8192`. `apiType` is `'responses'` with `zeroDataRetentionEnabled: true` when the id (lowercased, `openai.` stripped) matches `/^gpt-(\d+)/` with major ≥ 6. Every other id gets `'chat-completions'`. Never `'messages'`. This keeps the existing Responses stateless/effort invariants true. Run the tests.

### Task 3: Writer lists the full catalog and drops profile pinning

**Files:** Modify `src/cli/commands/proxy/connectors/vscode.ts:27-47,111-188,277-298`. Test `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts:326-463` and `tests/integration/vscode-byok.test.ts:203-242`.

**Consumes:** Tasks 1–2. **Produces:** `writeVsCodeLanguageModelsConfig(proxyUrl, gatewayKey, insiders = false)` and `writeVsCodeLanguageModelsConfigAtPath(configPath, proxyUrl, gatewayKey)`. The `profileModel` parameter is removed from both.

Test-first: yes — with a catalog of `EXPECTED_MODEL_IDS` plus `{ base_name: 'gpt-6-sol', label: 'GPT-6 Sol' }`, the written list is all 28 in catalog order and `gpt-6-sol` has `name: 'GPT-6 Sol'`. A second write after the catalog adds `claude-sonnet-6` includes it. A `{ enabled: false }` entry is omitted.

- [ ] In `vscode.test.ts`, replace `describe('profileModel pinning')` (391-462) with `describe('full tenant catalog')`, covering the cases above. Change `mockCatalog` (63-69) to accept either id strings or descriptor objects. Rewrite AC5 (378-388): only `github-copilot-*` or disabled entries → rejects with `ConfigurationError`, no file written. Keep AC4, and check that `totally-unknown-model` is now listed.
- [ ] In `vscode-byok.test.ts`, add one unknown id (`gpt-6-sol`) to the served catalog (213). Expect length `VS_CODE_CAPABILITY_TABLE.length + 1`, and expect the unknown model to be written with `apiType: 'responses'`. Keep the `PROFILE_MODEL` absence assertion.
- [ ] `resolveManagedModels(proxyUrl, gatewayKey)`: iterate `fetchTenantModelDescriptors` in order. Skip ids matching `/^github-copilot-/i`. Use `findVsCodeCapabilityEntry(id) ?? buildDefaultVsCodeCapability(d)`. `name` = id for known entries and `label?.trim() || id` for defaults. Delete the pin branch (178-185) and its docstring paragraph (152-158). Throw the existing `ConfigurationError` only when the result is empty, with the message reworded to "no enabled models". `VsCodeManagedModel.toolCalling` becomes `boolean`, set from `entry.toolCalling ?? true` in `buildManagedModel`.
- [ ] Run both test files.

### Task 4: Orchestrator stops passing the profile model; docs updated

**Files:** Modify `src/cli/commands/proxy/connect-orchestrator.ts:459`, `docs/ARCHITECTURE-PROXY.md` §6.6 (709+), `docs/COMMANDS.md:98-210`. Test `src/cli/commands/proxy/__tests__/index.test.ts:452-457,496-501` and `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts:463`.

**Consumes:** the 3-arg `writeVsCodeLanguageModelsConfig` (Task 3).

Test-first: yes — `index.test.ts` "reuses a matching daemon when the profile model is unchanged" expects `writeVsCodeLanguageModelsConfig` to be called with exactly `('http://127.0.0.1:4001', 'local-key', false)`. It fails while `'shared-profile-model'` is still passed.

- [ ] Change the three `toHaveBeenCalledWith` expectations to the 3-arg form, then drop `config.model` at `connect-orchestrator.ts:459`. Daemon-reuse matching on `model` stays unchanged. Run both test files.
- [ ] Docs: in §6.6, replace "selected profile's `model` is written directly…" and "merges one managed model" with this: the connector writes every enabled tenant model in catalog order; the capability table only enriches known families; unknown models get conservative defaults; the profile model does not affect the list. In `COMMANDS.md`, reword the connector description to match. Change the troubleshooting row to "New tenant models missing → re-run `codemie proxy connect --vscode`".

---

negative-constraints:
- "must not reduce the list to the selected model" / "never filters, replaces or reverts" — honored by Task 3 (pin branch deleted, list rebuilt from the live catalog) and Task 4 (profile model no longer passed). No task narrows the list.
- "static table must not be an allowlist" — Tasks 2–3: unmatched ids get defaults and are not dropped.
- "NO default reflection: do not reorder or mark default" — Tasks 1 and 3 keep catalog order. No task reads `default` or writes a default marker.
- "Do not change `resolveTenantModelId` semantics" — Task 2 only calls it. `model-name-resolver.ts` is in no task's Files list.
- "CodeMie Setup out of scope" — no task touches it.
- Architecture layers / no `any` / no `console` — Task 2 reimplements heuristics locally and does not import from the opencode plugin.
- Tension to note: "every enabled model must be listed" versus the kept `github-copilot-*` exclusion (Global Constraints, Task 3). The exclusion was kept because it is an unrevoked product-owner decision that an existing test (AC4) enforces.
