# Multi-Model Profiles and Model Switching — Story

**Date**: 2026-10-06
**Status**: Approved
**Ticket**: [EPMCDME-15639](https://jiraeu.epam.com/browse/EPMCDME-15639)
**Related**: [Harness-Compatible Model Setup](../2026-10-06-harness-model-compatibility/story.md) ([EPMCDME-15641](https://jiraeu.epam.com/browse/EPMCDME-15641)) — builds on this story; delivery order decided as this story first (see Context)

---

## Context

- **Delivery order decision**: this story ships first; Harness-Compatible Model Setup (EPMCDME-15641) builds on its multi-select step, active-model concept and `models switch` command, and ships second. Jira link: EPMCDME-15639 **blocks** EPMCDME-15641.
- A profile holds exactly one model today. During `codemie setup`, the model step is a single-choice list, with options to type a custom model ID or search the Ollama library. Each of these returns one model.
- `codemie profile switch` swaps whole profiles; nothing changes the model of an existing profile. Today a user changes it by re-running `codemie setup` → "Update an existing profile", or by passing `--model` on every agent launch.
- `codemie models` only has `list`, which prints the provider's live catalog. It does not read or change the profile's model.
- The profile's model is used in many places: agent launch and compatibility checks, `codemie profile status`, `codemie doctor`, the local proxy, and the Claude helper tiers (haiku/sonnet/opus), which are derived from the chosen model at setup. The Claude and Codex launchers can also replace a model saved in a profile with a newer catalog equivalent. They leave it alone only when it was passed explicitly with `--model` or an env var.
- Inside a running agent, the user picks a model from the agent's own menu (Claude Code `/model`, the OpenCode model list, the Codex model catalog, the Pi model list). These menus are currently filled from the provider's **full** catalog, not the profile's models, so a user who limited their profile to a few models still sees every model in the agent and can pick one outside the list. Each agent builds its menu in its own way, so the limit has to be applied per agent.
- The Anthropic and Moonshot subscription providers have no model catalog and auto-pick their model. SSO, Bearer/JWT, LiteLLM, Bedrock and Ollama all fetch a model list during setup.

---

## Complexity

**Size**: L (25/36, re-estimated 2026-10-13 after adding agent model menus) · **Recommended flow**: sdlc-standard

Touches four core areas (setup wizard, profile storage, a new `models switch` command, launch-time model resolution) across about 12–16 files. The requirements are now clear. The remaining risk is technical: launch must keep a switched model while it is in the catalog but still replace a retired one. Saving also has to keep the profile's other settings and its storage location, which the current save path does not guarantee. Limiting the agents' own model menus adds per-agent work (Claude, OpenCode, Codex, Pi each build their menu differently, from the full catalog). The design choice for how the profile stores its model list is still open, which is why brainstorming first is recommended.

---

## Story

**As a** CodeMie CLI user who works with several models through the same provider, **I want** to pick all the models I use when I set up a profile and switch the active one with a single command, **so that** I don't have to create and maintain a separate profile, with duplicated credentials, for every model.

---

## Background

A user who alternates between, say, a Claude Sonnet model and a GPT model on the same CodeMie SSO or LiteLLM endpoint has two options today. They can create one profile per model, re-entering the same provider details and logging in again for each. Or they can remember to pass `--model` on every launch. The first clutters the profile list and turns every credential or endpoint change into a multi-profile chore. The second is easy to forget and not discoverable. As teams get access to more models through the gateway, the one-profile-per-model pattern does not scale.

---

## Acceptance Criteria

**Setup**

- [ ] Given a provider that offers a model list (SSO, Bearer/JWT, LiteLLM, Bedrock, Ollama), when the user creates a profile with `codemie setup`, then they can select one or more models in a single multi-select step, with recommended models listed first.
- [ ] Given the user selected two or more models, when they confirm the selection, then setup asks which of them is the default (active) model. Given exactly one model is selected, that question is skipped.
- [ ] Given the model the user needs is not in the catalog, when they use custom model entry (or Ollama library search), then the entered or found model is added to the profile's selection alongside the models picked from the list.
- [ ] Given an Ollama profile, when setup finishes, then every selected model is installed locally, as happens today for the single chosen model.
- [ ] Given the user selects no models, when they try to continue, then setup does not proceed and asks them to select at least one model.
- [ ] Given an Anthropic or Moonshot subscription profile, when the user runs setup, then setup behaves as it does today (one auto-picked model, no multi-select).

**Updating a profile**

- [ ] Given an existing multi-model profile, when the user runs `codemie setup` → "Update an existing profile", then the model step starts with the profile's current models pre-selected and lets the user add or remove models.
- [ ] Given the user removes the current active model during an update, when they confirm, then setup asks them to choose a new default from the remaining models.

**Switching**

- [ ] Given the active profile has two or more models, when the user runs `codemie models switch` without arguments, then an interactive picker lists only that profile's models with the current one marked. The chosen model becomes the active model, and a confirmation names the profile and the new model. The command only ever changes the active profile.
- [ ] Given the active profile has two or more models, when the user runs `codemie models switch <model-id>` with one of the profile's models, then that model becomes active without any prompt.
- [ ] Given the user switched the active model, when they launch any agent (e.g. `codemie-claude`, `codemie-codex`, `codemie-code`) without `--model`, then the agent runs on the newly active model. A model that is still available in the provider's catalog is not silently replaced by a different one.
- [ ] Given the user switches to a different Claude model, when the switch is saved, then the Claude helper models (haiku/sonnet/opus) are refreshed the same way setup chooses them for that model.
- [ ] Given the active model has since been retired from the provider's catalog, when the user launches an agent, then the launch behaves as it does today: the agent moves to the newest equivalent model from the catalog.
- [ ] Given the user switched the active model, when they launch an agent with `--model <other>`, then that run uses `<other>` and the profile's active model is unchanged afterwards.
- [ ] Given the user runs `codemie models switch <model-id>` with a model that is not in the profile's list, then the command fails with a message listing the profile's models and pointing to `codemie setup` to add more, and the active model is unchanged.
- [ ] Given the active profile has only one model, when the user runs `codemie models switch`, then they are told the profile has a single model and how to add more, and nothing changes.
- [ ] Given the active model is not compatible with the agent being launched (e.g. a GPT model with `codemie-claude`), when the user launches it, then the existing compatibility error also suggests `codemie models switch` to pick a compatible model from the profile.

**Agent model menus**

- [ ] Given a profile with a limited list of models, when the user opens the model menu inside a supported agent (the `/model` picker in `codemie-claude`, the model list in `codemie-opencode`, and the equivalent menus of `codemie-codex` and `codemie-pi`), then the menu lists only the profile's models, with the active one preselected.
- [ ] Given a profile with a limited list of models, when the user switches the model from the agent's own menu, then only a model from the profile's list can be selected, and the choice applies to that session only; the profile's active model is unchanged afterwards.
- [ ] Given a profile with a single model or a profile created before this change (no explicit list), when the user opens the agent's model menu, then it behaves as it does today.
- [ ] Given a profile's list contains a model that is not compatible with the agent being launched (e.g. a GPT model with `codemie-claude`), when the user opens that agent's menu, then incompatible models are not shown, as the menu already does today.
- [ ] Given a model in the profile's list has been retired from the provider's catalog, when the user opens the agent's menu, then the retired model is not shown, and the launch itself keeps working as described above.
- [ ] Given an agent whose model menu cannot be limited, when the user launches it with a limited profile, then the launch works unchanged and the user sees a notice that the agent's menu still shows the full catalog.

**Visibility and continuity**

- [ ] Given a multi-model profile, when the user runs `codemie profile` or `codemie profile status`, then they see the active model and the profile's other available models.
- [ ] Given a multi-model profile is active, when the user runs `codemie models list`, then the catalog marks which models belong to the active profile and which one is active.
- [ ] Given a profile created before this change (one model), when the user upgrades the CLI and launches an agent, then it works without re-running setup and is shown as a profile with one model.
- [ ] Given the user switches models or updates a profile's model list, when the change is saved, then the profile's other settings (credentials, reasoning effort, workspace) are kept; only the Claude helper models are refreshed, as described above. Other profiles are untouched, and the profile stays where it was stored (global or project config).
- [ ] Given a user reads `codemie models --help` or the configuration docs, then multi-model profiles, the switch command and the limited agent model menus are described.

---

## Out of Scope

- A different active model per agent (e.g. Claude → Sonnet, Codex → GPT at the same time). One active model per profile in this story; per-agent defaults are a candidate follow-up.
- Switching the model from inside a running agent session by any other means than the agent's own model menu (e.g. a CodeMie-owned in-session command). The agent's native menu is covered by the "Agent model menus" criteria.
- Dedicated commands to add or remove models without the setup wizard (e.g. `codemie models add/remove`). Editing the list goes through `codemie setup` → "Update an existing profile".
- Offering the provider's full catalog in `codemie models switch`; it only offers the profile's models.
- Switching the model of a profile that isn't active. `codemie models switch` has no `--profile` option; the user switches profiles first.
- Changing how a retired active model is handled at launch, or removing retired models from the profile's list.
- Multi-model selection for the Anthropic and Moonshot subscription providers.
- Letting the user choose the Claude helper models (haiku/opus) separately from the active model.

---

## Open Questions

None open. Decisions taken on 2026-10-06:

- The switch command is `codemie models switch`.
- It acts on the active profile only (no `--profile` option).
- `codemie models list` marks the active profile's models and the active one.
- A retired active model is handled as it is today at launch.
- Switching to a different Claude model refreshes the Claude helper models.
- 2026-10-13: the profile's model list also limits the agents' own model menus (added to scope; previously out of scope).
