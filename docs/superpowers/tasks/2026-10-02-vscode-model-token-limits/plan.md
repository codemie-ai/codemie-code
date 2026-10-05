# VS Code Model Token Limits: Subtract Output From Catalog Input

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** In `codemie proxy connect --vscode`, `maxInputTokens` = catalog `max_input_tokens` minus the resolved `maxOutputTokens`, so input plus output fits the context window.

**Requirements:** `docs/VSCODE_TOKEN_LIMITS_ADJUSTMENT.md` (authoritative). Research: `technical-analysis.md` in this dir.

**Already on the branch (do not redo):** catalog parsing of `max_input_tokens`/`max_output_tokens` in `tenant-catalog.ts`; `LlmModel.max_output_tokens`; `resolveVsCodeTokenLimits` + `pickTokenLimit` in `vscode-models.ts:385-403` (currently returns the catalog input unchanged); `vscode.ts:119` already uses the resolver for table and default models. Only the input rule, comments, docs, task records and tests change.

**Commits:** Commit per task using the repository's existing convention (Conventional Commits). Do not commit `.codemie/codemie-cli.config.json`; leave other dirty files alone.

## Acceptance criteria

- Catalog `max_input_tokens` present: written `maxInputTokens` = that value minus the resolved `maxOutputTokens` (catalog, then table, then 8192).
- Subtraction result <= 0, or no usable catalog input: entry value (table value or 128000).
- Output limit order unchanged: catalog, table, 8192; input and output resolve independently.
- Tenant reporting no limits yields today's output.
- `docs/COMMANDS.md` describes the rule; example `gpt-5.6-sol` shows 922000.
- Story and task-dir records match the shipped rule.
- New tests in the three connector test files pass; lint and typecheck pass.

Negative-constraints pass: do not leave catalog input unchanged (Task 1); do not remove table values or change `tenant-catalog.ts`/`vscode.ts` (not touched); do not test every table family or repeat the fallback order across files (Task 3 scope); the doc's "Don't" items honored; ignore `.codemie/codemie-cli.config.json` (header).

---

### Task 1: Subtract output from catalog input, update comments

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode-models.ts` (`resolveVsCodeTokenLimits` ~395-403 and its doc comment; comment above `VS_CODE_CAPABILITY_TABLE` ~48-51)
- Modify: `src/providers/plugins/sso/sso.http-client.ts:196-200` (doc comment on `max_input_tokens`)

Test-first: yes — `resolveVsCodeTokenLimits` with descriptor `maxInputTokens: 200000` and Claude 4.5 table entry (output 64000) expects `maxInputTokens` 136000 (fails today: returns 200000).

- [ ] Resolve `maxOutputTokens` first via `pickTokenLimit`. Then if the descriptor's input passes the same positive-finite check, use `input - maxOutputTokens` when that is > 0, else `entry.maxInputTokens`. Rewrite the function doc: API input is treated as the whole context window, output is subtracted so the pair fits.
- [ ] Table comment: keep the "fallbacks" note; add that the table's `maxInputTokens` is a prompt budget (window minus output) while the catalog value is not, hence the subtraction. In `sso.http-client.ts`, say the value is the whole window for some models and only the prompt budget for others, so callers must not assume it fits alongside the output limit.

### Task 2: Docs and task records

**Files:**
- Modify: `docs/COMMANDS.md` (paragraph ~108; JSON example ~155)
- Modify: `docs/stories/2026-10-02-vscode-model-token-limits/story.md` (line 36 background; line 42 first criterion)
- Modify: `docs/superpowers/tasks/2026-10-02-vscode-model-token-limits/technical-analysis.md` (minimal edits only where it states the old rule: Section 1 "used as-is"/ordering text, Section 6 risk bullet about larger `maxInputTokens`, Section 7 summary, Section 8 key facts "no arithmetic")

Test-first: no — documentation only

- [ ] `COMMANDS.md`: input limit is the catalog value minus the resolved output limit, else table value or 128000; output is catalog, table, 8192; keep the note that the catalog does not return an output limit yet. Change the `gpt-5.6-sol` example `maxInputTokens` from 1050000 to 922000.
- [ ] `story.md`: line 36 explains the catalog input may be the whole window so the output limit is subtracted; line 42 says input = catalog value minus resolved output limit and still wins over the table. Leave line 48 as is.
- [ ] `technical-analysis.md`: change the old "unchanged/as-is, no arithmetic" statements and the 922000 -> 1050000 example to the subtract rule, and reword the risk bullet as mitigated by subtraction. Keep other content untouched; this plan already replaces the old one.

### Task 3: Tests

**Files:**
- Modify: `src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts`
- Modify: `src/cli/commands/proxy/connectors/__tests__/tenant-catalog.test.ts` (next to the "maps label, provider, multimodal and features.tools" test, ~116-176)
- Modify: `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts` (using `writeVsCodeLanguageModelsConfigAtPath`; existing fixtures stay unchanged)

Test-first: yes — each new case asserts the new rule or parsing (e.g. untabled model with catalog input 922000 expects written `maxInputTokens` 913808, `maxOutputTokens` 8192; fails before Task 1).

- [ ] `vscode-models.test.ts`, `describe('resolveVsCodeTokenLimits')` with real table numbers: catalog input + table output (Claude 4.5, 200000 -> 136000); catalog input + default output (untabled, API value - 8192); catalog input + catalog output (subtract catalog output); catalog output overrides table and default; subtraction <= 0 falls back to entry `maxInputTokens`; no catalog values returns entry unchanged; catalog output only (no input) keeps entry input.
- [ ] `tenant-catalog.test.ts`: valid `max_input_tokens`/`max_output_tokens` become `maxInputTokens`/`maxOutputTokens`; `0`, negative, string and `null` are omitted; missing fields omitted.
- [ ] `vscode.test.ts`: one fixture with `max_input_tokens` on one table family and one unknown model; assert both written `maxInputTokens` and `maxOutputTokens` in `chatLanguageModels.json`, proving the descriptor reaches table and default entries.
- [ ] Run `npx vitest run src/cli/commands/proxy/connectors/__tests__/`, `npm run lint`, `npm run typecheck` for the touched files' sake (these are task-level checks; the flow runs the full gates).
