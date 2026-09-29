# EPMCDME-14763 Catalog-Driven Claude `[1m]` Context Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch Claude Code with `[1m]` automatically for every model whose CodeMie catalog entry reports a 1M-token input window, without breaking models that do not.

**Architecture:** The backend returns `max_input_tokens` per model on `/v1/llm_models`; the CLI reads it and picks the id form through one helper, `applyContextWindow`. No capability table, no second picker row, no `[1m]` carry-over. Claude Code owns `[1m]` semantics (strips it, adds the `context-1m` beta header); proxy and core code never see the suffix.

**Tech Stack:** TypeScript (ESM), Vitest.

**State of the tree:** Tasks 1-5 are ALREADY IMPLEMENTED (uncommitted) in the working tree. Verify them against the tree and record them done; do NOT re-implement or rewrite them. Only Tasks 6-8 change files.

## Global Constraints

- ES modules with `.js` import extensions, explicit return types on exports, no `any`, `logger.debug`/`logger.notice` only, no placeholder TODOs.
- Tests are in scope only because the user asked for them for this ticket.
- `.codemie/codemie-cli.config.json` has an unrelated local edit: never touch or stage it. Stage only the files a task names.
- Run Claude tests with: `npx vitest run src/agents/plugins/claude`
- Commit per task using the repository's existing convention.

## Acceptance criteria

- [ ] `LlmModel` carries optional `max_input_tokens`; absent on routers and static catalogs.
- [ ] A servable catalog entry with `max_input_tokens >= 1_000_000` yields `<bareId>[1m]`; a smaller number yields the bare id (stripping an existing `[1m]`); an absent or non-numeric value leaves the id untouched.
- [ ] Bare configured ids (profile, `--model`, env, tier vars) gain `[1m]` when the catalog reports 1M; a `[1m]` id whose entry reports less loses it.
- [ ] Explicit `--model` still consults the catalog for window sizing but is never auto-healed or replaced; catalog fetch failure or an unlisted id keeps it as-is.
- [ ] A retired model's replacement gets its own window; nothing carries over from the retired id.
- [ ] `/model` picker lists one row per model (`[1m]` id at 1M, bare otherwise), label unchanged, no "(1M context)" row.
- [ ] Reason enum is `unavailable | one-million-enabled | one-million-unsupported`; the stderr warning is silent for `one-million-enabled`, says "does not support 1M context" for `one-million-unsupported`, and "not available in this CodeMie catalog" for `unavailable`.
- [ ] Statusline still strips a trailing `[1m]` before router-id and label lookups.
- [ ] Local-auth run (`codemie-claude --jwt-token <local JWT> --base-url http://localhost:8080`) launches with the `[1m]` id (already confirmed; the calling flow owns re-verification).
- [ ] The explicit-source debug log and the `beforeRun` propagation comment describe current behavior.

---

### Task 1: `max_input_tokens` data field — already implemented, verify only

**Files:** `src/providers/plugins/sso/sso.http-client.ts` (`LlmModel`)

Test-first: no — already implemented, verify only.

- [ ] Confirm `LlmModel.max_input_tokens?: number` exists with its "absent on routers and static-config catalogs" doc comment, and that `fetchCodeMieLlmModels` is untouched. Record done.

### Task 2: Context-window helper and resolution — already implemented, verify only

**Files:** `src/agents/plugins/claude/claude.models.ts`, `src/agents/plugins/claude/__tests__/claude.models.test.ts`

Test-first: no — already implemented, verify only.

- [ ] Confirm `applyContextWindow` (~line 213: non-number untouched, `>= ONE_MILLION_TOKENS` adds `[1m]`, else bare), `findServableEntry` (~219), `ClaudeModelResolutionReason` (line 15) and `resolveClaudeModel` (~389) with its `keepWithContextWindow()` closure covering the explicit-source, in-family, live-outside-family branches, and the replacement branch using `applyContextWindow(ranked[0].id, findServableEntry(...)?.max_input_tokens)`.
- [ ] Confirm no `supportsOneMillionContext`, `isRouterLikeEntry` or `splitOneMillionSuffix` remains in `src/`.
- [ ] Confirm `describe('resolveClaudeModel — explicit --model override')` and `describe('resolveClaudeModel — catalog context window')` pass.

### Task 3: Single-row model picker — already implemented, verify only

**Files:** `src/agents/plugins/claude/claude.models.ts` (`buildModelPickerOptions`, ~line 338), same test file

Test-first: no — already implemented, verify only.

- [ ] Confirm one row per model with `model = applyContextWindow(id, model.max_input_tokens)` and unchanged `label`; confirm the `describe('buildModelPickerOptions')` cases (one row per model, no "(1M context)" row, no window stays bare, no double suffix) pass.

### Task 4: Plugin warning matrix — already implemented, verify only

**Files:** `src/agents/plugins/claude/claude.plugin.ts` (~line 405), `src/agents/plugins/claude/__tests__/claude.plugin.model-swap-warning.test.ts`

Test-first: no — already implemented, verify only.

- [ ] Confirm the warning is skipped for `one-million-enabled` and the added case asserts empty stderr with `env.CODEMIE_MODEL === 'claude-opus-5[1m]'`; existing "not available" + hint and "does not support 1M context" cases pass.

### Task 5: Statusline suffix stripping kept — already implemented, verify only

**Files:** `src/agents/plugins/claude/plugin/statusline.ts` (`isRoutingConfigured`, `lookupNominalLabel`), its `statusline.test.ts`

Test-first: no — already implemented, verify only.

- [ ] Confirm both helpers strip a trailing `[1m]` before lookup and the existing statusline tests (~lines 105-125) pass. No edit.

### Task 6: Correct the stale explicit-source debug log

**Files:** Modify `src/agents/plugins/claude/claude.models.ts:449-451`

Test-first: no — log text only, no behavior change.

- [ ] Replace the tail of the `logger.debug` message `...; skipping catalog resolution` with `...; skipping auto-heal, sizing context window only`. Keep the rest of the string and the `return keepWithContextWindow();` untouched.

### Task 7: Correct the stale `beforeRun` comment

**Files:** Modify `src/agents/plugins/claude/claude.plugin.ts:431`

Test-first: no — comment only.

- [ ] Change the first comment line to: `// resolution is non-null when the model was stale/absent or only its [1m] window changed — always` (keep the following two lines as they are).

### Task 8: Boundary and non-numeric window tests

**Files:** Modify `src/agents/plugins/claude/__tests__/claude.models.test.ts` (extend `describe('resolveClaudeModel — catalog context window')` after the `it.each` at ~line 223, and `describe('buildModelPickerOptions')`)

Test-first: no — characterization tests over already-implemented `applyContextWindow` behavior; they pass on first run. Prove they bite by temporarily changing `>=` to `>` in `applyContextWindow` and confirming the 1_000_000 case fails, then revert.

- [ ] Add cases reusing the existing `model()` factory, `freshEnv()` and `ONE_MILLION` (no new helpers):
  - `max_input_tokens: 1_000_000` on a bare `claude-sonnet-4-6` resolves to `claude-sonnet-4-6[1m]`, reason `one-million-enabled`.
  - `max_input_tokens: 999_999` on `claude-sonnet-4-6[1m]` resolves to `claude-sonnet-4-6`, reason `one-million-unsupported`; on bare `claude-sonnet-4-6` returns `null`.
  - `it.each` of a numeric string (`'1000000'`) and `null`, injected via `max_input_tokens: value as unknown as number`, leaves both `claude-sonnet-4-6` and `claude-sonnet-4-6[1m]` untouched (`null` result, env unchanged).
  - Picker: entry with `max_input_tokens: 1_000_000` yields `[1m]` id and `999_999` yields the bare id.
- [ ] NaN is deliberately not covered: JSON cannot carry it, and `typeof NaN === 'number'` currently falls in the "smaller" branch, so it is not "absent". Do not change `applyContextWindow` for it.
- [ ] Run `npx vitest run src/agents/plugins/claude` and expect all pass.
