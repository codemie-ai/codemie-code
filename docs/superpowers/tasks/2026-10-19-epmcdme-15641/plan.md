# Harness-compatible model setup (EPMCDME-15641) Implementation Plan

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Setup asks which agents (harnesses) a profile serves, offers/validates only compatible models, and launch guards the persisted active model.

**Architecture:** Optional `classifyModel` hook on `AgentMetadata`; `src/agents/core/model-compat.ts` reads it via `AgentRegistry`. CLI and `AgentCLI` use only that helper (CLI -> Registry -> Plugin). Profile gains additive `harnesses` and `confirmedModels`.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `@/` alias), Vitest (dynamic-import mocking), inquirer, chalk, `logger.debug`.

**Spec:** `docs/superpowers/tasks/2026-10-19-epmcdme-15641/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- No profile migration or rewrite; profile without `harnesses` is legacy and loads unchanged.
- CLI code never imports `agents/plugins/*`.
- Agent without `classifyModel` is unrestricted (always `compatible`, never gated, never a launch mismatch).
- Do not change `ProviderSetupSteps.buildConfig` / `installModel` signatures. One active model per profile.

## Review Focus

- Router/alias names (`*router`, `ModelInfo.metadata.isRouter`) with no family: `unverified`, not rejected.
- Removing a model or harness on update must re-run the coverage gate.
- Only unrestricted harnesses selected: behavior identical to today.
- `--model` / `CODEMIE_MODEL` launch must skip the new check.
- Provider not in a harness's `supportedProviders`: that harness has zero compatible models.

### Task 1: Schema, hook type, shared helper

**Files:** Modify `src/env/types.ts:51-62`, `src/agents/core/types.ts:269`; Create `src/agents/core/model-compat.ts`; Test `src/agents/core/__tests__/model-compat.test.ts`

**Produces:**
```ts
export type ModelCompat = 'compatible' | 'incompatible' | 'unverified';
export interface ModelClassifyContext { isRouter?: boolean }
// types.ts: AgentMetadata.classifyModel?(modelId: string, ctx?: ModelClassifyContext): ModelCompat
// model-compat.ts:
export function classifyWithPredicate(isCompatible: (id: string) => boolean, id: string, ctx?: ModelClassifyContext): ModelCompat
export function classifyModelForAgent(agent: string, id: string, opts?: { isRouter?: boolean; confirmedModels?: string[]; provider?: string }): ModelCompat
export function getClassifierAgents(): string[]            // base names with classifyModel
export function compatibleHarnesses(harnesses: string[], id: string, opts?): string[]
export function uncoveredHarness(harnesses: string[], models: string[], opts?): string | undefined  // coverage gate
```

- Add `harnesses?: string[]` and `confirmedModels?: string[]` (documented, subset of `models`) to `ProviderProfile`.
- `classifyWithPredicate`: predicate true -> `compatible`; else router (`ctx.isRouter` or `/router/i`) with no definite other-vendor family (claude, gpt, gemini, kimi, qwen, deepseek, llama, mistral, grok) -> `unverified`; else `incompatible`.
- `classifyModelForAgent` resolves `*-acp` to base via `AgentRegistry`, returns `compatible` when no hook, `unverified` for ids in `confirmedModels`, `incompatible` when `provider` is outside the agent's non-empty `supportedProviders`.

- [ ] Test-first: yes — no-hook agent returns `compatible`; confirmed id returns `unverified`; `gpt-smart-router` vs claude is `incompatible`, `sy-router` is `unverified`; `uncoveredHarness(['codex'], ['claude-sonnet-4'])` returns `'codex'`.
- [ ] Implement; run `npx vitest run src/agents/core/__tests__/model-compat.test.ts`.

### Task 2: Per-agent classifiers

**Files:** Modify `src/agents/plugins/claude/claude.models.ts:49` (export `isClaudeCompatibleModelName` from `CLAUDE_FAMILY_PATTERNS`), `claude/claude.plugin.ts:157`, `codex/codex.plugin.ts:147`, `gemini/gemini.plugin.ts:49`, `kimi/kimi.plugin.ts:55`; Test the existing `*.models.test.ts` / new `claude.classify.test.ts`

- Each plugin's metadata gets `classifyModel: (id, ctx) => classifyWithPredicate(isXCompatibleModelName, id, ctx)` using `isCodexCompatibleModelName` (`codex-models.ts:139`), `isGeminiCompatibleModelName` (`gemini.models.ts:43`), `isKimiCompatibleModelName` (`kimi.models.ts:61`). Do not edit existing rules; opencode, pi, codemie-code, copilot-cli, openwiki get no hook.

- [ ] Test-first: yes — via `AgentRegistry`: `classifyModelForAgent('codex','claude-sonnet-4-5')` is `incompatible`; `'claude','gpt-5.5'` is `incompatible`; `'claude','claude-sonnet-4-5'`, `'codex','gpt-5.4'`, `'gemini','gemini-2.5-pro'`, `'kimi','kimi-k2'` are `compatible`; `'opencode','anything'` is `compatible`.
- [ ] Implement; run the touched plugin tests.

### Task 3: Setup harness step, model filtering, coverage gate

**Files:** Modify `src/cli/commands/setup.ts:229-344` (`handlePluginSetup`), `:579` (`promptForModelsSelection`), `src/providers/integration/setup-ui.ts` (row labels); Test `src/cli/commands/__tests__/handle-plugin-setup.test.ts`, `prompt-for-models-selection.test.ts`

**Consumes:** Task 1 helpers.

- After model fetch (`:253`), before model step, add `promptForHarnesses(existing?: string[]): Promise<string[]>`: checkbox, min 1, offered list from `AgentRegistry` = claude, codex, gemini, kimi, opencode, pi, codemie-code (ACP folded, copilot-cli/openwiki excluded); pre-select `existingProfile.harnesses`. Skip when `setupSteps.selectModel` auto-picks (do not save `harnesses`).
- Pass harnesses into `promptForModelsSelection`: hide models `incompatible` for every selected harness; label each row with the harnesses it works with and "unverified"; if a selected harness has no compatible model, explain and let the user change harness or provider (loop back, never save).
- Catalog-less / `custom` / `search` entry (`:589`, `:653`): silent accept if not `incompatible` for at least one harness; else warn and re-prompt or confirm; confirmed ids go to `confirmedModels`.
- Active-model prompt (`promptForActiveModel`): label with working harnesses, do not restrict.
- Before `buildConfig` (`:331`): run `uncoveredHarness`; on failure name the harness and re-prompt models. Set `config.harnesses` (even single-model) and `config.confirmedModels` (subset of final `models`; drop ids removed by the user or by failed installs at `:305`).

- [ ] Test-first: yes — with harnesses `['codex']` the checkbox choices exclude Claude ids; a custom `claude-x` for codex-only warns and requires confirm, then lands in `confirmedModels`; update that removes the only codex-compatible model is refused naming `codex`; only `['opencode']` selected shows all models and skips the gate; saved config contains `harnesses`; auto-select providers save no `harnesses`.
- [ ] Update PTY `tests/integration/agent-setup.test.ts` TC-029 for the new harness prompt.
- [ ] Implement; run the two unit files.

### Task 4: Switch picker, `profile status`, `models list`

**Files:** Modify `src/cli/commands/models.ts:48-64,137`, `models-switch-prompt.ts:62` (+ its render fn), `src/cli/commands/profile/display.ts:37,121`, `src/utils/profile.ts:21,59`; Test `models-list-marking.test.ts`, `models-switch-prompt.render.test.ts`, `profile/__tests__/index.test.ts`

- Annotate rows with `compatibleHarnesses(profile.harnesses, id, {confirmedModels})` in the switch picker, in `(profile)`/`(active)` rows of `models list` (use `model.metadata?.isRouter`), and per model in `profile status` plus a "Harnesses" row. Emit nothing when the profile has no `harnesses`.

- [ ] Test-first: yes — profile with `harnesses:['claude','codex']` and models `[claude-x, gpt-5.4]` renders `claude` next to `claude-x` and `codex` next to `gpt-5.4` in all three views; a legacy profile output is byte-identical to before.
- [ ] Implement; run the three test files.

### Task 5: Launch check

**Files:** Modify `src/agents/core/AgentCLI.ts:679-736` (`validateCompatibility`; env source is set at `:369`); Test `src/agents/core/__tests__/agentcli-compatibility-hint.test.ts`, `AgentCLI-model-source.test.ts`

- After the existing provider and blocked-pattern checks, skip entirely when `options.model` or `CODEMIE_MODEL` is set. Else `classifyModelForAgent(this.adapter.name, config.model, {confirmedModels, provider})`; only `incompatible` acts. Profile with `harnesses`: `logger.error`, list compatible models from `resolveProfileModels(config)` with `codemie models switch`, else "none exists" with `codemie setup`; return false. Legacy profile: print a warning naming the mismatch and the fix, return true. Existing errors unchanged.

- [ ] Test-first: yes — codex launch with `harnesses` + Claude active model returns false and names a compatible sibling; same without `harnesses` returns true after a warning; `--model claude-x` and `CODEMIE_MODEL` set skip the check; unrestricted agent and `unverified` model print nothing.
- [ ] Implement; run both test files.

### Task 6: Docs

**Files:** Modify `docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `.ai-run/guides/usage/project-config.md`, `docs/ARCHITECTURE-CONFIGURATION.md`

- [ ] Test-first: no — document `harnesses`, `confirmedModels`, the harness step and its skip for subscription providers, the offered agent list, `classifyModel`, and the launch block versus legacy warning.

---
negative-constraints: honored by Global Constraints (no migration: Tasks 3/5 never rewrite legacy profiles; no CLI plugin imports: Tasks 3-5 use model-compat only; no buildConfig change: Task 3 sets fields on the returned config; legacy mismatch stays a warning: Task 5; no per-agent active model: Task 3 single active prompt; no retired-model re-check: out of tasks).
