# Spec: Multi-model profiles and `codemie models switch` (EPMCDME-15639)

## Problem

A `ProviderProfile` holds exactly one model (`model?: string`, `src/env/types.ts`). A user who
alternates between two models on the same SSO/LiteLLM/Bedrock/Ollama/JWT endpoint must keep one
profile per model, duplicating credentials, or pass `--model` on every launch. This spec lets a
profile hold several models and adds a command to change which one is active, without touching
how any single-model profile already behaves.

## Approach

Add an **additive, optional** `models?: string[]` field next to the existing `model?: string`
scalar. `model` keeps its current meaning — the active model — and remains the only field every
existing consumer (~20 call sites: `AgentCLI`, `exportProviderEnvVars`, `ConfigLoader.validate`,
`ProfileDisplay`, doctor, proxy, health checks) has to read. `models`, when present, is the full
selected set and always contains `model`. A profile with no `models` field is a legacy or
single-model profile; every read path treats a missing `models` as `[model]` without persisting
it. **No config migration is needed** — this keeps the acceptance criterion "pre-change one-model
profiles keep working after upgrade" true by construction, and avoids the schema-migration and
dual-write risk the complexity assessment flagged as the main driver of its XL technical-risk
score.

```ts
// src/env/types.ts — additive field, no change to existing fields
interface ProviderProfile {
  model?: string;    // unchanged: the active model
  models?: string[]; // new, optional; always includes `model` when present
}
```

`ProviderSetupSteps.buildConfig(credentials, selectedModel)` **keeps its current signature.**
Setup already merges extra fields into the built config after calling it (Claude tiers, l.292-294
of setup.ts); `models` is merged the same way, so none of the 7 provider `*.setup-steps.ts` files
change. `installModel` (Ollama) is called once per selected model, same signature, in a loop —
satisfying AC4 without changing its contract either. This removes two of the four provider-contract
touch points the technical analysis flagged as risk, at no cost to the acceptance criteria.

### Setup wizard (`setup.ts`, `setup-ui.ts`)

`promptForModelSelection` becomes a checkbox (multi-select) step, built on the existing
`getAllModelChoices` ordering (recommended first) plus the existing "Custom model" and "Search
Ollama library" entries — picking either of those adds that model to the checked set rather than
replacing it (AC1, AC3). Empty confirmation re-prompts (AC5). When 2+ models are checked, a second
single-choice prompt (reusing today's list-prompt pattern) asks which is active (AC2); with
exactly one, that step is skipped. Anthropic/Moonshot subscription setup is untouched — their
`selectModel` auto-pick path never reaches the checkbox (AC6).

On "Update an existing profile," the checkbox pre-checks the profile's current `models` (or
`[model]` for a legacy profile) (AC7). If the update removes the active model, the single-choice
"which is active" prompt runs over the remaining set before the profile saves (AC8).

Setup's save path reuses `ConfigLoader.saveProfile` / `initProjectConfig` as today; this spec does
not change their wholesale-replace semantics, since every write already goes through the full
wizard output (model list included) each time.

### `codemie models switch [model-id]`

New subcommand on `createModelsCommand` (`models.ts`), sibling to `list`. Operates only on the
currently active profile, in whichever scope (global/local) it already lives — the same
resolution `ConfigLoader.switchProfile` uses, but it writes `model` (and leaves `models`,
credentials, `reasoningEffort`, workspace untouched) rather than swapping `activeProfile`.

- No argument, 2+ models: interactive picker (reusing the `shared/selection` raw-mode UI already
  used by `profile switch`) lists only `profile.models`, marks the current one, writes the choice,
  prints `Switched <profile> to <model>` (AC9).
- `<model-id>` argument present in `profile.models`: writes it, no prompt (AC10).
- `<model-id>` argument absent from `profile.models`: exits non-zero, lists the profile's models,
  points to `codemie setup`, writes nothing (AC15).
- Single-model profile (`models` absent or length 1): prints that the profile has one model and
  that `codemie setup` → "Update an existing profile" adds more; writes nothing (AC16). For an
  Anthropic/Moonshot subscription profile this same path applies, with wording that the provider
  doesn't support multiple models rather than pointing at the multi-select step.
- If the new active model is a Claude-family id, `autoSelectModelTiers` reruns and the
  `haikuModel`/`sonnetModel`/`opusModel` fields are rewritten exactly as setup would compute them
  (AC12).

`AgentCLI`'s existing compatibility error (l.663-706) gains one more suggested command,
`codemie models switch`, shown only when the active profile has 2+ models; otherwise it keeps
suggesting `codemie setup` as today (AC17).

### Launch-time model resolution — no new mechanism needed

AC11 ("switched model, if still in the catalog, is not silently replaced") and AC13 ("a retired
active model still heals to the newest equivalent") are **already the existing behavior** of
`resolveClaudeModel` (`claude.models.ts` l.456-508) and `resolveCodexModel`
(`codex-models.ts` l.411-476): both keep a `default`-sourced model as long as it is still present
in the live catalog and only replace it once it is retired. Switching the active model is just
writing a new `model` value through the same persisted path every profile model already takes, so
no new `CODEMIE_MODEL_SOURCE` value or protection flag is required. `--model <other>` continues to
set `CODEMIE_MODEL_SOURCE=cli` and never persists (AC14, unchanged).

### Agent model menus (AC18–22)

Export a new env var, `CODEMIE_PROFILE_MODELS` (comma-separated model ids), from
`exportProviderEnvVars`, populated only when the active profile has 2+ models. Its absence is the
signal for "behaves as today" (AC20): codemie-claude, codemie-opencode, codemie-codex and
codemie-pi each already build or inject a model catalog for their own in-session menu (Claude's
`/model`, OpenCode's dynamic config, Codex's `CODEMIE_CODEX_AVAILABLE_MODELS` catalog file, Pi's
`models.json` via `fetchAndBuildPiModels`); each is extended to intersect that catalog with
`CODEMIE_PROFILE_MODELS` when the var is set, dropping incompatible or retired entries (AC21) and
preselecting the active model (AC18). The in-session choice only changes that session's env, never
the persisted `model` (AC19). For any agent whose menu genuinely cannot be filtered this way, the
launch proceeds unchanged and prints a one-line notice that its menu still shows the full catalog
(AC22) — this is the designed fallback, not an error.

### Visibility

`ProfileDisplay.format`/`formatStatus` and `renderProfileInfo` gain an "other models" line next to
the existing "Model" row, listing `models` minus the active one. `codemie models list` marks, next
to each live-catalog row, whether it is in the active profile's `models` and whether it is the
active one.

### Docs

`docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `.ai-run/guides/usage/project-config.md`,
`docs/ARCHITECTURE-CONFIGURATION.md`, and `codemie models --help` are updated to describe
multi-model profiles, `models switch`, and limited menus. `config.example.json` (legacy v1) is
left as-is.

## Acceptance Criteria

All 22 criteria of EPMCDME-15639 as written in the ticket, plus the "Visibility and continuity"
bullets, are in scope and addressed above: multi-select setup with default pick (1–8), `models
switch` interactive/argument/error/single-model/compatibility-hint paths (9–17), limited agent
menus with the no-filter fallback (18–22), and profile/status/`models list` visibility plus
doc updates.

## Non-goals

- A different active model per agent.
- In-session switching other than through each agent's own menu.
- `codemie models add`/`remove` — editing the list only happens through `codemie setup`.
- Showing the full catalog in `models switch`.
- `codemie models switch --profile <other>` — only the active profile's model changes.
- Any change to how a retired *active* model is resolved, or to retired-model list hygiene.
- Multi-model selection for Anthropic/Moonshot subscription profiles.
- Separate selection of the Claude haiku/opus helper tiers.
- A config schema migration (handled by treating a missing `models` as `[model]` at read time).
- Changes to `ProviderSetupSteps.buildConfig`'s or `installModel`'s signatures.

## Open risks

- The exact per-agent mechanism for intersecting `CODEMIE_PROFILE_MODELS` with each of Claude's,
  OpenCode's, Codex's and Pi's own in-session catalog differs per plugin and is left to the
  implementation plan; Claude Code's `/model` menu in particular is upstream-binary behavior and
  its filterability needs confirming during planning — AC22's fallback notice covers the case
  where it cannot be limited.
- If a proxy daemon (`proxy connect`) is already running when `models switch` is used, its
  pinned `profileModel` state is not addressed by this spec; the next fresh launch picks up the
  new model normally, matching today's behavior for any other hand-edited config change.
- `setup.ts`, `models.ts`, `profile/index.ts` and `getAllModelChoices` have no unit-test
  scaffolding today; the SSO-gated PTY test (`agent-setup.test.ts` TC-029) pins the current
  "Choose a model ... (Use arrow keys)" prompt text and will need updating for the new checkbox
  prompt.
