# CodeMie Code runs isolated from the user's global OpenCode config — Story

**Date**: 2026-11-19
**Status**: Draft
**Ticket**: EPMCDME-16963

---

## Context

- `codemie-code` (and `codemie --task`) launches an embedded OpenCode engine. Its lifecycle `beforeRun` already redirects the engine's data location (sessions, database, credentials) to a CodeMie-owned directory under the CodeMie home (`codemie-code/src/agents/plugins/codemie-code.plugin.ts:363`). Nothing in `src` redirects the engine's config location.
- With no redirect the engine reads the user's real global OpenCode config directory (`~/.config/opencode`). A tool file there that cannot resolve its dependencies fails every `codemie-code` run. The crash is not reproduced locally and the engine source is not in the repository; the claim is consistent with the installed engine binary but unverified.
- The helper the ticket names (`getOpenCodeConfigDir`, `opencode.paths.ts:249-254`) is used only by the plain `opencode` agent's load-time metadata. It is not on the `codemie-code` run path.
- `beforeRun` is shared by `--task` and interactive runs, so both are exposed. It returns early when the CodeMie base URL is not an http(s) URL, before the data redirect, so that branch is exposed too. Through the CLI an empty base URL stops earlier with a configuration error, so the early return is reachable only for non-proxy providers with a non-http(s) base URL.
- The plain `opencode` agent deliberately does not redirect data, and a test pins it (`opencode-session-lifecycle.test.ts:310-317`). No test covers `codemie-code` environment isolation or `opencode.paths`.
- Today the user's global OpenCode settings, agents, commands and MCP servers merge into `codemie-code` runs. This is undocumented and untested; isolating config removes it.

---

## Complexity

**Size**: S (14/36) · **Recommended flow**: sdlc-light

The mechanism has a close precedent in the same startup hook; the risk is the engine's unverified config-loading and first-run behaviour and the early-return branch.

---

## Story

**As a** CodeMie CLI user who also has a personal OpenCode setup, **I want** `codemie-code` and `codemie --task` to ignore my global OpenCode configuration and tools **so that** a broken or custom file there cannot crash my CodeMie runs.

---

## Background

Users who experiment with OpenCode keep custom tools in their global OpenCode config. When one cannot resolve its module, every `codemie --task` and `codemie-code --task` run crashes with `Cannot find module '@opencode-ai/plugin'`, even though the CodeMie-owned engine has nothing to do with that setup. CodeMie already isolates the engine's data from the user's OpenCode install; config is the remaining gap.

---

## Acceptance Criteria

- [ ] AC1: Given the standard global OpenCode config location holds a tool file that cannot load its dependencies, when the user runs `codemie --task "<prompt>"` or `codemie-code --task "<prompt>"`, then the run starts and completes without a module-not-found error.
- [ ] AC2: Given the same broken tool file, when the user starts `codemie-code` interactively, then the session starts without that error.
- [ ] AC3: Given a user with no global OpenCode config, when they run `codemie-code --task`, then the run behaves as before: the CodeMie profile's provider and model apply and the session is recorded in CodeMie storage and analytics.
- [ ] AC4: Given a user runs the plain `opencode` agent (its own launch command, not the `codemie-code` engine), when it starts, then it still reads the user's own OpenCode config and keeps its existing session history location.
- [ ] AC5: Given the user's global OpenCode config location is missing or unreadable, when they run `codemie-code --task`, then the run still succeeds.
- [ ] AC6: Given a `codemie-code` run has started, when the user's own OpenCode installation reads its config afterwards, then the user's real OpenCode config is unmodified.
- [ ] AC7: Given the user has their own config-location setting, when a `codemie-code` run starts, then only the engine and the tools it starts see the isolated location, and the CodeMie wrapper process keeps the user's own value for its own use. (The mechanism is open: Q8.)
- [ ] AC8: Given a fresh CodeMie home and no network access, when the user runs `codemie-code --task` for the first time, then the run starts, or fails with a message that names the cause (not a module-not-found error from the user's own files).
- [ ] AC9: Given a profile whose base URL is non-empty but not an http(s) URL, when the user runs `codemie-code --task` with the same broken tool file, then the run does not fail with a module-not-found error.
- [ ] AC10: Given the change ships, when users read the release notes, then they state that the user's global OpenCode config no longer applies to `codemie-code` runs and that project-level `.opencode` is still loaded.

---

## Out of Scope

- NG1: Bare positional task text treated as a directory-change target — already fixed (commit 42cde9c5, PR #322).
- NG2: Isolating other OpenCode locations (state, cache) beyond config. No failure from them is known; revisit if one is reported.
- NG3: Changing how the plain `opencode` agent resolves its config or data.
- NG4: Failing fast when a run has no CodeMie provider; a separate change.
- NG5: Isolating the project-level `.opencode`; it is deliberate project configuration — user (Q6 answer).

---

## Decisions

- D1: Should interactive runs be covered, or only `--task`? → Both; the CLI routes any `--task` and the `codemie-code` launcher through the same adapter and the same startup hook — user (high confidence: routing and lifecycle code read).
- D2: Which problem is addressed? → Only the config-location isolation gap; the positional-argument bug is closed — user (ticket).
- D3: Is removing the user's global OpenCode settings, agents, commands and MCP servers from `codemie-code` runs acceptable? → Yes, on two conditions: a changelog entry under Unreleased → Changed (AC10), and users are told that project-level `.opencode` is still loaded. Data is already isolated the same way, no code, doc or test declares the user's global config as supported for `codemie-code`, and CodeMie's own features do not depend on that directory — user (medium-high; whether real users rely on the merge is a product call without usage data).
- D4: Do runs without a valid http(s) base URL get the config isolation? → Yes; they are effectively unsupported through the CLI and the engine's dependence on global provider config there is accidental. The config redirect goes above both early returns (AC9) — user (high on reachability; what the engine does with no provider is unverified).
- D5: Reproduce the defect against the installed engine before accepting the fix? → Yes, as the first implementation step. Matrix: a broken tool file in the standard global config location, in `~/.opencode`, and in project `.opencode`; `codemie --task`, `codemie-code --task` and interactive, before and after the fix; a fresh CodeMie home with the network blocked (AC8); the plain `opencode` agent still reading its own config and history (AC4); record the engine version and read issue #251 — user.
- D6: The CodeMie-owned config location must not share a folder with the engine's data location; a sibling of the existing storage location under the CodeMie home is the proposed shape — proposed by PO: from the analysis, the engine's config and data folders are both named `opencode` under their base, so the same base would collide.

---

## Open Questions

- Q2: A fresh isolated config location has none of the engine's own dependencies, and the engine may install them on first use. Is a first-run install (network needed, may fail offline or behind a corporate proxy) acceptable? Not decidable from the repository (confidence low-medium). CodeMie's injected plugins only use erased type imports and load from the temp directory, so CodeMie itself needs no module in the isolated location, and a missing user tool file removes the reported crash. Unknown: whether the engine self-installs into an empty location, needs the network, or treats failure as fatal. New risk: the isolated location is shared across runs, so parallel first `--task` runs (for example in CI) could race on the install. Recommendation: accept only if an install failure is non-fatal and a concurrent first run is safe; otherwise it is a blocker. Settled by the D5 matrix.
- Q5: The standard config-location setting is inherited by every tool the engine starts. On Linux and macOS, `gh` and git read their config from the standard config location, so they would lose the user's global settings during a run; on Windows `gh` uses `%AppData%` and git uses `~/.gitconfig`, so a Windows-only check would pass and still hide the breakage (tool behaviour is general knowledge, not verified; confidence medium). Options: (1) accept and document it; (2) restore the user's value for shell-tool children through the already-injected hooks plugin, if the engine offers an environment hook in the supported version (unverified); (3) add an engine-side switch in the `codemie-opencode` package, which CodeMie owns. The engine's own config-directory override is likely additive rather than isolating (verify in the D5 matrix). Recommendation: test on Linux and macOS before accepting.
- Q6: Which global locations are in scope? The standard config-location setting does not cover `~/.opencode` (it comes from the home directory), and CodeMie already treats it as a second global location for the plain agent. Isolating it would need a home-directory override, which would break git, ssh and npm, so that is rejected; the engine exposes switches for project config and default plugins but none for global config. Answered (confidence medium): cover the standard location, leave project `.opencode` (NG5). Still open: either state `~/.opencode` as a known gap in AC1, or ask for an engine-side flag. Whether the engine loads tools from `~/.opencode` is unverified (D5 matrix).
- Q7: The data redirect is also skipped in the early-return branches today. Hoist both the config and the data redirect above the early returns, or only config? Recommendation: decide with the Q3 implementation; hoisting data changes where those runs record sessions.
- Q8: The adapter copies every startup variable into the CodeMie wrapper's own environment, so a plain redirect also changes the wrapper's value (AC7). Mechanism to keep the user's value for the wrapper: capture the user's value at load (as done for the data location), restore it after the engine is spawned, or add a child-only environment channel (touches shared adapter code for all agents). Lazy readers on Linux (Claude Desktop and VS Code path helpers) might see the changed value; whether any runs in the wrapper after startup is not established. Recommendation: choose in a short design note before implementation.

---

## Sources

- Jira EPMCDME-16963 (description; no comments, no acceptance criteria, no attachments)
- Answers to Q1-Q6 provided by the requester (2026-11-19), grounded in `src/cli/index.ts`, `AgentCLI.ts`, `BaseAgentAdapter.ts`, `codemie-code.plugin.ts`, `opencode.plugin.ts`, `opencode.paths.ts`, `CHANGELOG.md`
- `codemie-code` · repository
