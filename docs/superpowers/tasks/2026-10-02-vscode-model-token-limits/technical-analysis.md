# Technical Research

**Task**: vscode proxy connector token limits
**Generated**: 2026-10-02
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-15572 (Bug): `codemie proxy connect --vscode` should take VS Code model token limits from the tenant catalog first, then the built-in table VS_CODE_CAPABILITY_TABLE, then defaults (128000 input / 8192 output). Each limit resolves independently. A catalog value counts only if a finite number > 0; otherwise fall through. Catalog GET /v1/llm_models?include_all=true is already read in src/cli/commands/proxy/connectors/tenant-catalog.ts (toDescriptor ignores max_input_tokens today); API doesn't return max_output_tokens yet but code should read it. Tenant with no limits -> identical to today. Docs: docs/COMMANDS.md VS Code section must state order tenant catalog -> table -> defaults; update JSON example (gpt-5.6-sol maxInputTokens -> 1050000). Out of scope: backend changes, moving reasoning effort/API type/headers out of table, removing table values.
Acceptance criteria: (1) catalog input limit overrides table; (2) catalog output limit used; (3) no catalog input -> table value; (4) no catalog input & not in table -> default; (5) missing/zero/negative/NaN ignored; (6) input/output resolved independently; (7) tenant w/o limits = today's results; (8) docs state the order.
Planned code changes (from the author's proposal in /Users/bohdan_maliar/Projects/codemie-dev/codemie-code/VSCODE_MODEL_TOKEN_LIMITS.md, local-only doc, may be read): add `max_output_tokens?: number` to LlmModel in src/providers/plugins/sso/sso.http-client.ts; in tenant-catalog.ts derive token fields of CodeMieLlmModel from LlmModel, add maxInputTokens/maxOutputTokens to TenantModelDescriptor, populate in toDescriptor; in vscode-models.ts add exported pure resolveVsCodeTokenLimits(entry, descriptor) and comment above the table; in vscode.ts resolveManagedModels/buildManagedModel use it for both table-matched and default models; update docs/COMMANDS.md. Verify these against the actual code and report risks (other consumers of TenantModelDescriptor / buildManagedModel, other places the capability table is used).

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/proxy/connectors/tenant-catalog.ts` — local loose `CodeMieLlmModel` interface (id, base_name, deployment_name, label, enabled, provider, multimodal, features.tools; no token fields). Exported `TenantModelDescriptor` (id, label, provider, multimodal, toolCalling). `toDescriptor(model, id)` copies fields only when type-checked. `fetchTenantModelDescriptors` fetches `/v1/llm_models?include_all=true`; `fetchTenantModelCatalog` maps to ids.
- `src/cli/commands/proxy/connectors/vscode-models.ts` — `VsCodeCapabilityEntry` (maxInputTokens/maxOutputTokens required numbers), `VS_CODE_CAPABILITY_TABLE` (line 48), `findVsCodeCapabilityEntry` (~line 329, exact family match then `resolveTenantModelId` match), `DEFAULT_MAX_INPUT_TOKENS=128000` / `DEFAULT_MAX_OUTPUT_TOKENS=8192` (lines 333-334, module-private consts), `buildDefaultVsCodeCapability(descriptor)` (line 367) which already imports type `TenantModelDescriptor`. gpt-5.6-sol table entry: 922000 / 128000.
- `src/cli/commands/proxy/connectors/vscode.ts` — `buildManagedModel(entry, tenantId, name, proxyUrl)` (line 111, not exported; takes no descriptor; reads `entry.maxInputTokens/maxOutputTokens` at lines 126-127). `resolveManagedModels` (line 159): per descriptor, skips `github-copilot-*`, `known = findVsCodeCapabilityEntry(id)`, `entry = known ?? buildDefaultVsCodeCapability(descriptor)`, then `buildManagedModel(entry, descriptor.id, name, proxyUrl)` (line 170). Called once at line 285 in the write path.
- `src/providers/plugins/sso/sso.http-client.ts` — exported `LlmModel` already has `max_input_tokens?: number` (line 200) with doc comment; no `max_output_tokens`. Used by `fetchCodeMieLlmModels` and many agent model modules.
- `src/cli/commands/proxy/connectors/desktop.ts` has its own, different local `CodeMieLlmModel` (id/base_name/deployment_name only); unaffected.

### Architecture and Layers Affected
CLI layer (proxy connectors): tenant-catalog (catalog parsing), vscode-models (capability data and resolution), vscode (config writer). Provider plugin layer type only (`LlmModel` in sso.http-client.ts). Docs: `docs/COMMANDS.md`.

### Integration Points
- vscode.ts -> tenant-catalog.ts (`fetchTenantModelDescriptors`), vscode.ts -> vscode-models.ts; vscode-models.ts -> tenant-catalog.ts (type only).
- Proposed tenant-catalog.ts -> sso.http-client.ts type import: claim in proposal that `codex-desktop.ts` already imports `LlmModel` as a type was not independently re-verified here (grep of `LlmModel` in connectors not run); sso.http-client.ts is a runtime module, so use `import type`. Note AGENTS.md/vscode-models comment says "src/cli must not import from an agent plugin"; sso.http-client is in providers, not agents, so that rule is not violated, but confirm the layering guide.
- `TenantModelDescriptor` consumers: only vscode.ts, vscode-models.ts (`buildDefaultVsCodeCapability`), tenant-catalog.ts, and tests. Optional new fields are non-breaking. `fetchTenantModelCatalog` maps to ids only.
- `buildManagedModel`: private to vscode.ts, single call site.
- `VS_CODE_CAPABILITY_TABLE` usage: vscode-models.ts, and tests only (vscode.test.ts, vscode-models.test.ts, tests/integration/vscode-byok.test.ts, tests/integration/vscode-models.live.test.ts). No other production consumers found.

### Patterns and Conventions
ES modules with `.js` import extensions, explicit return types on exports, `import type` for types, tolerant typeof-guarded parsing in `toDescriptor`, pure helpers in vscode-models.ts. Implementation is verified consistent with the proposal's plan.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `docs/COMMANDS.md` lines 98-160: "VS Code BYOK custom endpoint" section. Line 108 paragraph says "Known families are enriched from the capability table; unknown models get conservative defaults" (no mention of token-limit source). JSON example for `gpt-5.6-sol-2026-07-09` at line 155 has `"maxInputTokens": 922000`, `"maxOutputTokens": 128000`.
- `docs/ARCHITECTURE-PROXY.md:868` describes the VS Code write path but is already stale (refers to a fixed `VS_CODE_SUPPORTED_MODELS` catalog of ~20 entries and says the full table is written); it does not discuss token limits. Not required by the ticket.
- Guides under `.ai-run/guides/` exist per AGENTS.md (architecture, code-quality, development-practices); not read in depth.

### Architectural Decisions
Proposal doc (local-only, untracked) `VSCODE_MODEL_TOKEN_LIMITS.md`: catalog first, output limit subtracted from catalog input, table values kept, output limit hardcoded until API provides it.

### Derived Conventions
Doc comments on fields explaining upstream source (as in `LlmModel.max_input_tokens`).

---

## 4. Testing Landscape

### Existing Coverage
- `connectors/__tests__/tenant-catalog.test.ts` — `fetchTenantModelDescriptors` parsing (lines ~116-176).
- `connectors/__tests__/vscode-models.test.ts` — table sanity, `buildDefaultVsCodeCapability` (default limits 128000/8192 expected).
- `connectors/__tests__/vscode.test.ts` — writer; compares written `maxInputTokens` with `entry.maxInputTokens` (line 135) from table; catalog fixture has no token fields, so unchanged behavior (supports AC 7).
- `tests/integration/vscode-byok.test.ts` (mock catalog built from table families, no limits) and `tests/integration/vscode-models.live.test.ts` (live).
- `claude.models.test.ts` already tests tolerant handling of non-numeric `max_input_tokens` for the Claude picker (separate logic).

### Testing Framework and Patterns
Vitest; temp dirs for config files; fetch mocked for catalog. AGENTS.md: write/run tests only on explicit request.

### Coverage Gaps
No tests for catalog token parsing or limit resolution (new behavior); `LlmModel.max_output_tokens` untested.

---

## 5. Configuration and Environment

### Environment Variables
None specific to this feature found.

### Configuration Files
Output file: VS Code `User/chatLanguageModels.json` (written atomically by vscode.ts).

### Feature Flags and Deployment Concerns
None. No migrations or schema.

---

## 6. Risk Indicators

- Speculative: other agent plugins read `LlmModel`; adding an optional `max_output_tokens` is additive and low risk.
- Speculative: `resolveVsCodeTokenLimits` needs the default constants, which are module-private in vscode-models.ts; if placed in the same file they are accessible, but `entry` for default models already carries them (so the helper can use `entry` as 2nd/3rd source, as the proposal states).
- Catalog `max_input_tokens` overrides table values, so written values change for most table models (e.g. 922000 -> 1050000, claude 136000 -> 200000). The shipped rule subtracts the resolved output limit from the catalog input (e.g. 1050000 - 128000 = 922000); the table deliberately stored reduced values (e.g. 136000 = 200000-64000, 922000 = 1050000-128000) apparently to reserve output room. Using the full context window as VS Code's `maxInputTokens` could let prompt + output exceed the model window; this is mitigated by the subtraction. This is inferred from numbers, not documented in code.
- A catalog `max_input_tokens` could be a numeric string or null from the API; parse must use `typeof === 'number' && Number.isFinite && > 0` (strings fall through per proposal).
- Tests asserting `maxInputTokens === entry.maxInputTokens` stay valid only while fixtures omit token fields.
- docs/ARCHITECTURE-PROXY.md:868 stale text (out of scope).
- Proposal's expected-values tables were taken from a live tenant and may drift.
- Router entries and static-config catalogs lack `max_input_tokens`; fall back as today.

---

## 7. Summary for Complexity Assessment

The change is small and well-contained: three source files in `src/cli/commands/proxy/connectors/` (tenant-catalog.ts, vscode-models.ts, vscode.ts), one type addition in `src/providers/plugins/sso/sso.http-client.ts`, and one docs file (`docs/COMMANDS.md`: paragraph at line 108 and JSON example at line 155). Layers touched are the CLI connector layer plus a type-only provider dependency. No new dependencies, config, env vars, or migrations.

The planned changes in the proposal match the actual code. `TenantModelDescriptor` has only in-folder consumers and `buildManagedModel` is private with one call site, so adding optional fields and a descriptor argument is non-breaking. The capability table is used in production only by vscode-models.ts; elsewhere only tests reference it. Novelty is low: a pure resolution helper following existing tolerant-parsing patterns.

Existing tests cover the touched modules and should remain passing as fixtures lack token fields; no tests exist for the new behavior (to be added only on explicit request). Main risks: semantic shift of larger `maxInputTokens` versus the table's reduced values (mitigated by subtracting the output limit), drift of catalog data, and layering of the `LlmModel` type import.

---

## 8. External References

`/Users/bohdan_maliar/Projects/codemie-dev/codemie-code/VSCODE_MODEL_TOKEN_LIMITS.md` — resolved and read. Key facts: value counts only if finite number > 0; output order API -> table -> default (8192); input = API value minus resolved output, else entry value (table or 128000); add `max_output_tokens?: number` to `LlmModel`; derive token fields of local `CodeMieLlmModel` from `LlmModel` (`Partial<Pick<LlmModel,'max_input_tokens'|'max_output_tokens'>>`); add `maxInputTokens`/`maxOutputTokens` to `TenantModelDescriptor`, populated in `toDescriptor`; exported pure `resolveVsCodeTokenLimits(entry, descriptor)` in vscode-models.ts; comment above table; vscode.ts passes descriptor to `buildManagedModel` for table and default models; docs JSON example gpt-5.6-sol -> 1050000. Includes expected-value tables from a 51-model live tenant (e.g. gpt-6-* 922000, claude-sonnet-5-5 1000000, o3 200000).
