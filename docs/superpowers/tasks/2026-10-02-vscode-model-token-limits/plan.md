# VS Code Model Token Limits Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `codemie proxy connect --vscode` resolves each token limit as tenant catalog, then built-in table, then defaults (128000 input / 8192 output).

**Architecture:** Parse `max_input_tokens` / `max_output_tokens` into `TenantModelDescriptor`, add a pure resolver in `vscode-models.ts`, and use it in `vscode.ts` `buildManagedModel`.

**Spec:** `/Users/bohdan_maliar/Projects/codemie-dev/codemie-code/VSCODE_MODEL_TOKEN_LIMITS.md` (section "Code changes"); research in `technical-analysis.md` (same dir as this plan).

**Commits:** Commit per task using the repository's existing convention (Conventional Commits). Do not commit `VSCODE_MODEL_TOKEN_LIMITS.md`, `docs/stories/`, or `.codemie/codemie-cli.config.json`; do not touch other dirty files.

## Global Constraints

- Imports use `.js` extensions and the `@/` alias; no `any`; explicit return types on exports; `import type` for type-only imports.
- A catalog value counts only if `typeof === 'number'`, finite and > 0; missing, null, 0, negative, string and NaN fall through.
- Input and output resolve independently. No table values removed; reasoning effort, API type and headers stay in the table. No backend changes.
- Tests are not requested (AGENTS.md): write no new tests; existing tests must keep passing.

## Review Focus

- Numeric string `"200000"` or `null` in catalog: ignored, falls back to table/default.
- Catalog has input but not output (today's API): output comes from table or 8192.
- Router / `sy-signal-*` models with no catalog limits: unchanged from today.
- Model not in table with catalog input: gets catalog value, output 8192.

## Acceptance criteria

- Catalog input limit overrides the table value.
- Catalog output limit is used when present.
- No catalog input: table value; not in table either: 128000.
- Missing, zero, negative or NaN catalog values are ignored.
- Input and output resolve independently.
- Tenant with no limits yields the same output as today.
- `docs/COMMANDS.md` states the order tenant catalog, built-in table, defaults.

Negative-constraints pass: tests not requested (no test tasks, honored); no table values removed (Task 1 adds only a comment); no backend changes (none planned); local docs/config files not committed (header); strings/NaN/0 fall through (Task 1 parsing, Task 2 helper).

---

### Task 1: Catalog parsing of token limits

**Files:**
- Modify: `src/providers/plugins/sso/sso.http-client.ts:~200` (next to `max_input_tokens`)
- Modify: `src/cli/commands/proxy/connectors/tenant-catalog.ts` (`CodeMieLlmModel`, `TenantModelDescriptor`, `toDescriptor`)

**Interfaces:**
- Produces: `TenantModelDescriptor.maxInputTokens?: number` and `.maxOutputTokens?: number`, set only when the catalog value is a finite number > 0.

Test-first: no — tests not requested per AGENTS.md

- [ ] Add `max_output_tokens?: number` to `LlmModel` with a doc comment (LiteLLM `model_info.max_output_tokens`; not returned by the backend yet). In `tenant-catalog.ts`, extend the local `CodeMieLlmModel` with `Partial<Pick<LlmModel, 'max_input_tokens' | 'max_output_tokens'>>` via `import type { LlmModel } from '@/providers/plugins/sso/sso.http-client.js'` (keep the rest of the loose local shape). Add the two optional fields to `TenantModelDescriptor` and populate them in `toDescriptor` with a small private positive-finite-number guard.

### Task 2: Resolver and writer wiring

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode-models.ts` (comment above `VS_CODE_CAPABILITY_TABLE` at ~line 48; new export near `buildDefaultVsCodeCapability` ~line 367)
- Modify: `src/cli/commands/proxy/connectors/vscode.ts` (`buildManagedModel` ~line 111-127, `resolveManagedModels` ~line 159-170)

**Interfaces:**
- Consumes: `TenantModelDescriptor` from Task 1.
- Produces: `export function resolveVsCodeTokenLimits(entry: VsCodeCapabilityEntry, descriptor: TenantModelDescriptor): { maxInputTokens: number; maxOutputTokens: number }` returning, per field, the descriptor value if valid, else the `entry` value (table entry or default capability).

Test-first: no — tests not requested per AGENTS.md

- [ ] Add the comment above the table: its token limits are fallbacks, used only when the tenant catalog does not report them. Implement the helper (re-validating with the same positive-finite check, so it is safe on hand-built descriptors).
- [ ] Change `buildManagedModel` to take the descriptor and read limits from the helper instead of `entry.maxInputTokens/maxOutputTokens`; pass `descriptor` at its single call site for both table-matched and default models.

### Task 3: Docs

**Files:**
- Modify: `docs/COMMANDS.md` (paragraph ~line 108; JSON example ~line 155)

Test-first: no — tests not requested per AGENTS.md

- [ ] Extend the paragraph to state token limits resolve per field in the order tenant catalog, built-in capability table, defaults (128000 input / 8192 output), and that the catalog does not return an output limit yet. Change the `gpt-5.6-sol-2026-07-09` example `maxInputTokens` from 922000 to 1050000.
