# Spec: Harness-compatible model setup (EPMCDME-15641)

## Problem

Setup stores a provider and models but knows nothing about the agent (harness) that will run them.
A Codex harness with a Claude model, or a Claude harness with a GPT model, saves fine and fails at
runtime. Compatibility is enforced only at launch and unevenly: Codex and Gemini have name rules,
Claude has none, and `blockedModelPatterns` is empty for Claude and Codex (`AgentCLI.ts:679-736`).

This spec builds on the EPMCDME-15639 branch, which already provides `models?: string[]` plus the
active `model` (`src/env/types.ts:62`, `resolveProfileModels`), the multi-select setup step
(`setup.ts:579`), `codemie models switch`, and the `(profile)`/`(active)` tags in `models list`.

## Approach

### Profile schema (additive, no migration)

- `harnesses?: string[]` on `ProviderProfile`: base agent names the profile serves. Persisted
  whenever setup collects it, including for single-model profiles.
- `confirmedModels?: string[]`: model ids the user explicitly confirmed despite a name-rule mismatch
  (catalog-less providers). Always a subset of `models`.
- A profile without `harnesses` is legacy. It loads unchanged and nothing is rewritten.

### Compatibility abstraction

- New optional hook on `AgentMetadata` (`src/agents/core/types.ts`):
  `classifyModel?(modelId, ctx?) => 'compatible' | 'incompatible' | 'unverified'`. `ctx` may carry
  catalog hints such as `isRouter`.
- Shared helper module (`src/agents/core/model-compat.ts`) reads the hook through `AgentRegistry`.
  CLI code (setup, switch picker, `profile status`, `models list`) and `AgentCLI` only use this
  helper. They never import `agents/plugins/*`, which keeps CLI -> Registry -> Plugin.
- An agent without `classifyModel` is unrestricted: every model is `compatible`, it never fails the
  coverage gate, and it never causes a launch mismatch.
- Meaning of the three states:
  - `compatible`: a positive name or catalog match.
  - `incompatible`: the name matches another vendor's family, or it is an unknown non-router name.
  - `unverified`: a router or alias (catalog `is_router` / `metadata.isRouter`, or a `*router` name)
    with no definite family. It is treated as compatible and labeled "unverified".
  - A model id listed in the profile's `confirmedModels` is reported as `unverified`.
- Classifiers wrap existing rules: Codex (`isCodexCompatibleModelName`), Gemini
  (`isGeminiCompatibleModelName`), Kimi (`isKimiCompatibleModelName`). Claude gets a new
  name-based predicate built from the existing family patterns (`claude.models.ts:49`). No new
  rules for other harnesses.

### Harness step (`setup.ts`)

- Runs after provider/credentials and the model fetch, before the model step. It is a multi-select
  of the agents the user actually uses. At least one is required. There is no "no restriction"
  entry.
- Offered list, derived from `AgentRegistry` metadata: `claude`, `codex`, `gemini`, `kimi`,
  `opencode`, `pi`, `codemie-code`. ACP variants (`*-acp`) are folded into their base agent.
  `copilot-cli` (analytics-only) and `openwiki` (docs tool) are excluded.
- Classifier-backed: claude, codex, gemini, kimi. Unrestricted: opencode, pi, codemie-code. If only
  unrestricted agents are selected, behavior equals today (no filtering, no gate).
- Skipped for providers whose setup auto-picks the model (`selectModel`: anthropic-subscription,
  moonshot-subscription). `harnesses` is then not saved, so the profile is treated as legacy.
- On update the step pre-selects `profile.harnesses`. A legacy profile starts with nothing
  pre-selected. The user may add or remove harnesses.

### Model step

- Catalog provider: offer only models that are not `incompatible` for at least one selected
  harness. Each row shows the selected harnesses it works with and an "unverified" label where it
  applies. Codex never sees Claude models, and Claude never sees GPT models.
- A selected harness for which the provider offers no compatible model at all: explain, and let the
  user change the provider or the harness. Do not save.
- Catalog-less provider (no catalog, or manual/custom entry): a typed name that is `compatible` or
  `unverified` for at least one selected harness is accepted silently. A name that is `incompatible`
  for every selected harness shows a mismatch warning, then the user picks another or explicitly
  confirms. A confirmed id goes into `confirmedModels`.
- Active-model prompt: chosen from the selected models. A model not compatible with every harness
  is allowed and is labeled with the harnesses it works with.
- Coverage gate, run on every save (create and update, including removing a model or a harness):
  every selected harness must have at least one non-`incompatible` model among the chosen models.
  Otherwise setup does not proceed and names the harness that still needs a model.

### Switching, status, listing

- `codemie models switch` picker annotates each model with the profile's harnesses it works with.
- `codemie profile status` shows the profile's harnesses and, per model, the harnesses it works
  with. `codemie models list` adds the same annotation to the rows tagged `(profile)`/`(active)`.
- Labels appear only for profiles that have `harnesses`.

### Launch (`AgentCLI.validateCompatibility`)

- Only the persisted active model is checked. The check is skipped when `--model` is given or
  `CODEMIE_MODEL` is set (`CODEMIE_MODEL_SOURCE` cli/env). Existing behavior applies there and the
  profile is untouched.
- Profile with `harnesses` and an active model `incompatible` for the launching agent: block with
  exit 1. If the profile has compatible models, name them and suggest `codemie models switch`.
  Otherwise say none exists and point to `codemie setup`. Existing launch-time errors are unchanged.
- Legacy profile (no `harnesses`) with the same mismatch: print a warning that names the mismatch
  and how to fix it, then continue.
- `compatible` and `unverified` models print nothing. Unrestricted agents are never checked.

### Docs

Update `docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `.ai-run/guides/usage/project-config.md` and
`docs/ARCHITECTURE-CONFIGURATION.md` for `harnesses`, `confirmedModels` and the harness step.

## Acceptance criteria

All 19 acceptance criteria of EPMCDME-15641 as written in the ticket are in scope: Setup (8),
Updating a profile (2), Switching and launching (5), Existing profiles and visibility (4, including
the legacy warning and `profile status`). The refinements above (offered agent list, unrestricted
agents, `confirmedModels`, skipped step for subscription providers) interpret them and add no scope.

## Non-goals

- A different active model per agent.
- Migrating or rewriting existing profiles.
- Changing which models a provider makes available.
- Compatibility rules for harnesses beyond Claude, Codex, Gemini and Kimi (existing predicates).
- Limiting an agent's own in-session model menu.
- Turning the legacy-mismatch warning into a hard block.
- Changing `ProviderSetupSteps.buildConfig` or `installModel` signatures.
- Re-checking the retired-model "newest equivalent" replacement after plugin resolution.

## Open risks

- Retired-model replacement happens in the plugins after `AgentCLI` runs its check. The backstop
  relies on the persisted active model, so an incompatible replacement is not re-checked unless a
  later change moves the check.
- Setup's `fetchModels` returns plain ids. Router detection needs `ModelInfo.metadata.isRouter` or a
  `*router` name. Misclassified routers are mitigated by the "unverified" label.
- A harness that does not support the chosen provider (`supportedProviders`) is treated as having no
  compatible models, with the "change provider or harness" message.
- The PTY test `agent-setup.test.ts` TC-029 pins the old prompts and needs updating.
