# EPMCDME-16963 - Isolate the embedded OpenCode engine's config location - Spec

**Story**: `story.md` (AC1-AC10, NG1-NG5, D1-D6); Jira comment 2 (id 16110592) wins where they differ. **Size**: S (14/36).

## Problem

`codemie --task` and `codemie-code` (interactive too) launch the embedded OpenCode engine. `beforeRun` in `src/agents/plugins/codemie-code.plugin.ts` redirects only `XDG_DATA_HOME` (:363). The engine therefore reads the user's real `~/.config/opencode`. A broken `tool/*.ts` there (`Cannot find module '@opencode-ai/plugin'`) crashes every run. `getOpenCodeConfigDir()` (`opencode.paths.ts:249-254`) is not on this run path; it serves only the plain `opencode` agent's load-time metadata. Engine behaviour is unverified in-repo (analysis sections 2, 6).

## Behaviour to deliver

1. For `codemie-code` runs, the child engine gets `XDG_CONFIG_HOME` pointing to a CodeMie-owned dir, a sibling of `opencode-storage`: `<getCodemieHome()>/opencode-config`. It comes from a path helper `getOpenCodeConfigBase()` next to `getOpenCodeStorageBase()` in `opencode.paths.ts` and honours `CODEMIE_HOME`. The engine's config dir is `<base>/opencode`, so the config and data bases must differ (D6). `getOpenCodeConfigDir()` keeps its meaning (the user's real location) and gets a one-line comment saying so.
2. The assignment sits above both early returns in `beforeRun` (:258-265), so it applies for any base URL (AC9). The data redirect (`XDG_DATA_HOME`, :363) stays where it is (Q7). The assignment is one place in the code, so a later opt-back-in switch can condition it.
3. The user's own `XDG_CONFIG_HOME` is restored in the wrapper's `process.env` before the engine is spawned, so the wrapper keeps the user's value (Q8, AC7). The seam is the plugin's own lifecycle, with no change to `BaseAgentAdapter` or other agents. Order verified in `BaseAgentAdapter.run()`: `beforeRun` (:680) -> `Object.assign(process.env, env)` (:700) -> `enrichArgs` (:705) -> flag transforms -> `spawn(..., { env })` (:933-935). The child receives the local `env` object, not `process.env`, so restoring `process.env` after :700 does not change what the child sees. No hook runs after spawn and `codemie-code` has no `afterRun`, so "restore after spawn" is realised as "restore before spawn":
   - `beforeRun` captures the user's value from `process.env.XDG_CONFIG_HOME` at entry, before any early return and before :700. It records whether the variable was unset, so unset is distinguishable from empty.
   - `enrichArgs` of `codemie-code` (the first plugin hook after the :700 merge) restores `process.env` as its first statement, before its `--task`/subcommand early returns. It uses `delete` when the user had none, never assigning the string `undefined`. A comment states why. The restore is skipped when `beforeRun` captured nothing.
   - The wrapper therefore sees the redirected value only between :700 and :705 (no awaits in between); the dry-run path returns before :700 and never merges.
   - Rule for later XDG redirects (NG2) in this plugin: capture in `beforeRun`, restore in `enrichArgs`. `XDG_DATA_HOME` keeps its existing load-time capture (`USER_XDG_DATA_HOME`) and is not changed here. A child-only env channel in `BaseAgentAdapter` is recorded as the follow-up that would replace both mechanisms.
4. The plain `opencode` / `opencode-acp` agents are untouched (AC4). `opencode.plugin.ts` metadata does not change.
5. `CHANGELOG.md`, Unreleased -> Changed: the user's global OpenCode config no longer applies to `codemie-code` runs, and project-level `.opencode` is still loaded (AC10). The entry adds a known-gap line for `~/.opencode` and/or a git/gh note only if the local checks below call for them.

## Implementation-time checks (first step, D5), against the local OpenCode v2 install

Record the engine version and read issue #251. Reproduce the defect first, before and after the fix. Use a broken `tool/x.ts` importing `@opencode-ai/plugin` in `~/.config/opencode/tool`, `~/.opencode/tool` and project `.opencode/tool`. Run `codemie --task`, `codemie-code --task` and interactive. The checks settle:
- **Gate G1 (redirect honoured)**: the engine reads its config from `<XDG_CONFIG_HOME>/opencode` on the OS under test. Pass: with the redirect and a broken `~/.config/opencode/tool/x.ts` (the ticket's case, which is Windows), `codemie-code --task` exits 0; an interactive `codemie-code` start with the broken tool does not hit module-not-found (AC2); and a profile with a non-empty, non-http(s) base URL plus the broken tool does not hit it either (AC9). Run it on Windows and macOS where available, and on Linux. A pass on one OS does not stand in for another; record which OSes were checked.
- **Gate G2 (Q2, empty dir is benign)**: on a fresh `CODEMIE_HOME`, run 3-5 simultaneous first `--task` runs and compare `node_modules` integrity afterwards; run once with the network blocked and record exit code and time to failure; record first-run duration. Pass: every run exits 0, or fails with a message naming the cause (AC8), and no run corrupts the shared dir.
- **Q6**: whether `~/.opencode/tool` is loaded. If not, no gap wording. If yes, AC1 and the release note state `~/.opencode` as a known gap and an engine-side global-config disable flag is filed as a follow-up. Also record whether `OPENCODE_CONFIG_DIR` is additive.
- **Q5**: whether git and gh lose their global settings on Linux/macOS under the redirect. If so: when the engine offers an env hook in the injected hooks plugin, restore the user's value for shell-tool children there. Otherwise accept and document it in the release note, with an engine-side switch as follow-up. If git and gh are not affected, nothing is needed.
- AC4 check: the plain `opencode` agent still reads its own config and history.

**If G1 or G2 fails**, the `XDG_CONFIG_HOME` redirect is not shipped as specified and the work goes back to the user. The named fallback to put in front of them is pointing the engine at a CodeMie dir through `OPENCODE_CONFIG_DIR` (present in the engine binary), which is usable only if it replaces the global dir rather than adding to it (the additive check above). If it is additive, or if G1 fails because the engine ignores XDG on an OS, the open question goes to the engine owners (an engine-side switch in `codemie-opencode`, which CodeMie owns). Switching mechanism is a change to a user decision, so it is proposed, not applied.

## Acceptance criteria

AC1-AC10 from `story.md` stand. AC1 gains the `~/.opencode` known-gap wording only if the Q6 check requires it. AC7 means: the engine and its children see the isolated location, and the wrapper keeps the user's value (Q8, restored before spawn, see item 3). AC5 holds by construction. Verification is manual (the matrix above) plus the existing quality gates (lint, typecheck, build). Per AGENTS.md no tests are added or run unless the user asks.

AC4 verification: a pin that `XDG_CONFIG_HOME` stays undefined for the plain `opencode` agent (covering `opencode-acp`, which spreads the same lifecycle) is offered to the user as an optional test on request only, and is not added unprompted.

## Non-goals

- NG1: bare positional task text as a `cd` target (already fixed, PR #322).
- NG2: isolating other OpenCode locations (`XDG_STATE_HOME`, `XDG_CACHE_HOME`).
- NG3: changing how the plain `opencode` agent resolves config or data.
- NG4: failing fast when a run has no CodeMie provider.
- NG5: isolating the project-level `.opencode` (deliberate project config).
- Not in scope: moving the data redirect above the early returns; a child-only env channel in `BaseAgentAdapter` (follow-up); overriding HOME/USERPROFILE; writing tests.

## Decisions

- Cover both `--task` and interactive runs over `--task` only (D1).
- Fix only the config-location gap over the positional-argument bug (D2).
- Remove the user's global OpenCode config from `codemie-code` runs over keeping the merge, with a changelog entry and a note that project `.opencode` still loads (D3).
- Apply the config redirect on non-http(s) base URL runs by placing it above the early returns, over leaving that branch exposed (D4).
- Reproduce the defect against the installed engine before accepting the fix, using the D5 matrix (D5).
- Use `<CODEMIE_HOME>/opencode-config` over reusing `opencode-storage`, because both engine dirs are named `opencode` under their base (D6).
- Hoist only the config redirect above the early returns over hoisting the data redirect too, so those runs keep recording sessions where they do today (Q7) — user
- Restore the user's `XDG_CONFIG_HOME` in `process.env` over capture-at-load or a child-only env channel in the shared adapter, so other agents stay unchanged; restore before spawn (no post-spawn hook exists) (Q8) — user. The user chose option B, "restore"; the before-spawn timing is an implementation consequence, not a user choice.
- Settle the `~/.opencode` question after the local v2 check: no gap wording if not loaded, otherwise a known gap in AC1 and the release note with an engine-side flag as follow-up, over deciding it now (Q6) — user
- If git/gh are affected: restore the user's value via the hooks plugin when the engine offers an env hook, otherwise accept and document it, with an engine-side switch as follow-up (Q5) — user
- Treat Q2 as a local check, and a blocker if the install failure is fatal or concurrent runs race, over accepting it unchecked (Q2).
- Realise the Q8 restore as capture in `beforeRun` and restore in the plugin's `enrichArgs` (before spawn), over a hook after spawn (none exists) or a change to `BaseAgentAdapter` (AR-1).
- Make "engine honours the redirect on each OS" and "empty config dir is benign under parallel and offline first runs" gating checks with `OPENCODE_CONFIG_DIR` or an engine-side switch as the proposed fallback, over shipping on the unverified premise (AR-2).

## Risks

- Q2 engine self-install behaviour in an empty config dir is unverified (gate G2).
- The engine's honouring of `XDG_CONFIG_HOME` on Windows and macOS is unverified (gate G1).
- The user's global OpenCode settings, agents, commands and MCP no longer apply to `codemie-code` runs (accepted, D3).
- `~/.opencode` may stay a gap.
- The wrapper sees the redirected `XDG_CONFIG_HOME` between `BaseAgentAdapter.ts:700` and `enrichArgs` (:705), with no awaits in between. The restore depends on the plugin's `enrichArgs` running; every normal run reaches it. The pair is copied per later XDG redirect until the adapter follow-up lands.
