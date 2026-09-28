# EPMCDME-14763 Claude `[1m]` Context Preservation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop CodeMie CLI from stripping Claude Code's `[1m]` suffix during catalog re-matching, and offer `[1m]` rows in the `/model` picker, for every 1M-capable Claude generation.

**Architecture:** One exported `supportsOneMillionContext(modelId)` backed by a first-match-wins regex table (shape of `MODEL_CAPABILITY_TABLE` in the proxy's request normalizer, but its own table, owned by `claude.models.ts`). `resolveClaudeModel` strips a trailing `[1m]` before catalog matching and re-applies it by table/router policy; `buildModelPickerOptions` emits a synthesized `[1m]` row after each capable base row.

**Tech Stack:** TypeScript (ESM), Vitest.

## Global Constraints

- Only `src/agents/plugins/claude/claude.models.ts` and `src/agents/plugins/claude/__tests__/claude.models.test.ts` change.
- Suffix is the exact literal `[1m]`, trailing, matched case-insensitively.
- ES modules with `.js` import extensions, explicit return types on exports, no `any`, `logger.debug`/`logger.notice` only.
- Run one test file with: `npx vitest run src/agents/plugins/claude/__tests__/claude.models.test.ts`
- Commit per task using the repository's existing convention.

## Acceptance criteria

- [ ] Profile-saved `X[1m]` with 1M-capable `X` in the catalog stays `X[1m]` at launch.
- [ ] `CODEMIE_SONNET_MODEL` / `CODEMIE_OPUS_MODEL` / `CODEMIE_HAIKU_MODEL` values keep `[1m]` under the same rule, with no source gating.
- [ ] A retired `X[1m]` is replaced by an available model, keeping `[1m]` only if the replacement is 1M-capable (and not a router); never throws for that reason.
- [ ] A router/alias id carrying `[1m]` that is live in the catalog is never stripped.
- [ ] `/model` picker shows a `<id>[1m]` row labeled `(1M context)` right after each 1M-capable, non-router base row; base rows are neither hidden nor duplicated.
- [ ] A model not 1M-capable per the table never gets `[1m]` added (picker or auto-heal).
- [ ] Explicit `CODEMIE_MODEL_SOURCE=cli|env` short-circuit for the main tier is unchanged.
- [ ] `supportsOneMillionContext` is the single place the version boundary lives.

---

### Task 1: `supportsOneMillionContext()` capability table

**Files:**
- Modify: `src/agents/plugins/claude/claude.models.ts` (add after `TIER_PATTERN`, ~line 55)
- Test: `src/agents/plugins/claude/__tests__/claude.models.test.ts` (new `describe` block)

**Interfaces:**
- Produces: `export function supportsOneMillionContext(modelId: string): boolean`

Test-first: yes — `supportsOneMillionContext` returns the expected boolean for one id per generation; fails because the export does not exist.

- [ ] **Step 1: Write the failing test.** New `describe('supportsOneMillionContext')` with `it.each` over `[id, expected]`, importing via `await import('../claude.models.js')`:
  `claude-sonnet-4-6` true, `claude-sonnet-4-5-20250929` false, `claude-sonnet-4-20250514` false, `claude-opus-4-6` true, `claude-opus-4-7` true, `claude-opus-4-5-20251101` false, `claude-sonnet-5` true, `claude-opus-5` true, `claude-fable-5` true, `claude-haiku-4-5-20251001` false, `claude-haiku-5` false, `claude-3-5-sonnet` false, `claude-4-5-sonnet` false, `claude-4-6-sonnet` true, `us.anthropic.claude-sonnet-4-6-v1:0` true, `claude-router-premium` false.
- [ ] **Step 2: Run it — expect FAIL** (`supportsOneMillionContext is not a function`).
- [ ] **Step 3: Implement.** Add the table and function. Minor-version alternation `[1-9]\d` plus `(?!\d)` keeps date stamps like `-20250514` from reading as a minor version.

```ts
// Claude Code's 1M-context opt-in (`[1m]`) by model version. CodeMie's /v1/llm_models carries
// no context-window field, so this table is the ONLY place the boundary lives — swap this
// function's body for a catalog field once the backend exposes one. First match wins.
const ONE_MILLION_CONTEXT_TABLE: Array<{ pattern: RegExp; supported: boolean }> = [
  { pattern: /haiku/i, supported: false },                                           // no Haiku generation
  { pattern: /(?:sonnet|opus|fable)[-_.]?(?:[5-9]|[1-9]\d)(?!\d)/i, supported: true }, // gen 5+
  { pattern: /(?:sonnet|opus)[-_.]?4[-_.](?:[6-9]|[1-9]\d)(?!\d)/i, supported: true }, // 4.6+
  { pattern: /claude[-_.]?(?:[5-9]|4[-_.][6-9])[-_.](?:sonnet|opus|fable)/i, supported: true }, // version-first ids
];
// Fallback: unknown ids (incl. routers/aliases) are not 1M-capable — never add [1m] speculatively.
const ONE_MILLION_CONTEXT_DEFAULT = false;

export function supportsOneMillionContext(modelId: string): boolean {
  const row = ONE_MILLION_CONTEXT_TABLE.find(({ pattern }) => pattern.test(modelId));
  return row ? row.supported : ONE_MILLION_CONTEXT_DEFAULT;
}
```

- [ ] **Step 4: Run it — expect PASS.**

### Task 2: Preserve `[1m]` in `resolveClaudeModel` (main and tier vars)

**Files:**
- Modify: `src/agents/plugins/claude/claude.models.ts:184-186` (router helper next to `isRouterCatalogEntry`), `:376-435`
- Test: `src/agents/plugins/claude/__tests__/claude.models.test.ts:93-123` plus a new `describe`

**Interfaces:**
- Consumes: `supportsOneMillionContext(modelId: string): boolean` (Task 1)
- Produces (module-private, used by Task 3): `const ONE_MILLION_SUFFIX = '[1m]'`; `function splitOneMillionSuffix(id: string): { bareId: string; wantsOneMillion: boolean }` (strips `/\[1m\]$/i`); `function isRouterLikeEntry(model: LlmModel): boolean`, which is `isRouterCatalogEntry(model)` or any `modelIdentifiers(model)` matching `/router/i`.

Test-first: yes — a profile/tier `[1m]` value whose bare id is live and 1M-capable resolves to `null` (kept); today it heals to the bare id.

- [ ] **Step 1: Write the failing tests** in a new `describe('resolveClaudeModel — [1m] preservation')`, reusing `model()`/`freshEnv()`:
  - main tier `CODEMIE_MODEL: 'claude-sonnet-4-6[1m]'`, no source, catalog has `claude-sonnet-4-6`: expect `null` and env unchanged.
  - main tier `'claude-opus-4-5[1m]'`, catalog has `claude-opus-4-5`: expect `selectedModel` `'claude-opus-4-5'` (suffix dropped, same model).
  - `it.each` over tiers: `CODEMIE_SONNET_MODEL='claude-sonnet-4-6[1m]'` → `null`; `CODEMIE_OPUS_MODEL='claude-opus-5[1m]'` → `null`; `CODEMIE_HAIKU_MODEL='claude-haiku-4-5[1m]'` → `'claude-haiku-4-5'`. Each has its bare id in the catalog and `CODEMIE_MODEL_SOURCE: 'cli'` set, to show no source gating.
  - router: `CODEMIE_MODEL: 'sy-signal-claude-sonnet-haiku[1m]'`, catalog entry `{ ...model({ deployment_name: 'sy-signal-claude-sonnet-haiku' }), is_router: true }`: expect `null`. The name contains "haiku", so this proves the table is bypassed.
  - retired without a capable replacement: `'claude-opus-4-1[1m]'`, catalog `[claude-haiku-4-5]`: expect `'claude-haiku-4-5'` and no throw.
  - regression: retired `'claude-opus-4-1'` (no suffix), catalog `[claude-opus-5]`: expect `'claude-opus-5'` (no suffix added).
  - Update `:93-105`: expect `selectedModel` `'claude-opus-5[1m]'`.
  - Update `:107-123`: set `CODEMIE_SONNET_MODEL` to the retired `'claude-sonnet-4-5[1m]'` and expect `'claude-sonnet-5[1m]'`. The fixture still has a real heal decision, so the test's intent (tiers ignore `CODEMIE_MODEL_SOURCE=cli`) survives.
- [ ] **Step 2: Run — expect FAIL** on the new and updated cases.
- [ ] **Step 3: Implement.**
  - Add the three helpers.
  - In `resolveClaudeModel`, leave `:346-357` (explicit short-circuit) and both verbatim-match checks (`:391-397`, `:413-421`) as they are. The `:125` test depends on them.
  - After `:421`, when `currentModel` has the suffix, find `catalog.find(m => isServableModel(m) && modelIdentifiers(m).includes(bareId))`. If an entry is found and it is router-like or `supportsOneMillionContext(bareId)`, return `null`. If it is found but neither holds, `logger.notice` and return `{ selectedModel: bareId, availableModels }`.
  - At `:431-435`, append `ONE_MILLION_SUFFIX` to `ranked[0].id` only when the original value wanted 1M, the replacement's catalog entry is not router-like, and `supportsOneMillionContext(ranked[0].id)`.
  - `availableModels` stays bare catalog ids.
- [ ] **Step 4: Run — expect PASS** (the whole file, including `:68-91` and `:125-137`).

### Task 3: Synthesize `[1m]` rows in `buildModelPickerOptions`

**Files:**
- Modify: `src/agents/plugins/claude/claude.models.ts:320-327`
- Test: `src/agents/plugins/claude/__tests__/claude.models.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `supportsOneMillionContext` (Task 1), `ONE_MILLION_SUFFIX` and `isRouterLikeEntry` (Task 2)

Test-first: yes — the picker for a catalog `[claude-sonnet-4-6, claude-haiku-4-5, router]` includes a `claude-sonnet-4-6[1m]` row; today it has only base rows.

- [ ] **Step 1: Write the failing test.** Use catalog `[model({deployment_name:'claude-sonnet-4-6'}), model({deployment_name:'claude-haiku-4-5'}), { ...model({deployment_name:'claude-router-premium'}), is_router: true }]`. Expect the `claude-sonnet-4-6[1m]` option (label `'claude-sonnet-4-6 (1M context)'`) to sit at index `indexOf('claude-sonnet-4-6') + 1`. Expect no `claude-haiku-4-5[1m]` or `claude-router-premium[1m]`, and each base id to appear exactly once.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** In the loop at `:322-327`, after pushing the base option, check that the entry is not `isRouterLikeEntry(model)`, that `supportsOneMillionContext(rankedModel.id)` holds, and that `${id}[1m]` is not already in `seen`. When all three hold, add the 1M id to `seen` and push `{ model: \`${id}${ONE_MILLION_SUFFIX}\`, label: \`${baseLabel} (1M context)\`, description }`. Update the function's doc comment to mention the synthesized rows.
- [ ] **Step 4: Run — expect PASS.**

## Negative-constraint pass

- No backend, `/v1/llm_models` or LiteLLM change: no task touches them.
- `claude-request-normalizer.plugin.ts` stays untouched: Task 1's table is new, in `claude.models.ts`, and imports nothing from the proxy.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`: not addressed by any task.
- `default-agent-hooks.ts` and `--model` injection: not modified.
- Never add `[1m]` speculatively to a router: Task 2 (replacement guard) and Task 3 (no router row).
- Don't swap models only to keep `[1m]`: Task 2 returns the same bare id when it is not capable.
- Don't throw when 1M can't be kept: Task 2 falls back to the plain replacement.
- Not Sonnet-only, and version logic not scattered: Task 1 is the single table covering Sonnet, Opus and Fable.
- No hidden or duplicated base picker row: Task 3.
- Explicit-source short-circuit unchanged: Task 2 leaves `:346-357` as is.
