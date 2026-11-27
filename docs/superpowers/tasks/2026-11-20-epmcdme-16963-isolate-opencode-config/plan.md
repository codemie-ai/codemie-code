# EPMCDME-16963 Isolate the embedded OpenCode engine's config location - Plan

Spec: `spec.md` (decisions Q5-Q8, D1-D6, AR-1, AR-2 are fixed). Commit per task using the repository's existing convention, and only when the user asks. Per AGENTS.md no tests are written or run; every task carries `Test-first: no`. Imports use the `.js` extension and `@/` alias; log with `logger.debug`.

## Task 1 - Reproduce the defect and run gates G1/G2 and checks Q6/Q5 (manual, before any code change)

Test-first: no - repo policy, tests only on explicit request (manual verification task, no code).

Against the local OpenCode v2 install, per spec "Implementation-time checks":
1. Record the engine version and read issue #251.
2. Reproduce the crash on unmodified code: broken `tool/x.ts` importing `@opencode-ai/plugin` in `~/.config/opencode/tool`, `~/.opencode/tool` and project `.opencode/tool`. Run `codemie --task`, `codemie-code --task` and interactive `codemie-code`.
3. Q6: record whether `~/.opencode/tool` is loaded, and whether `OPENCODE_CONFIG_DIR` is additive.
4. G1 and G2 need the redirect in place, so run them after Tasks 2-4 and before Task 5. Pass criteria are in the spec: G1 is exit 0 with the broken global tool, the interactive start and non-http(s) base URL variants (AC2, AC9), on each OS available, with the OSes recorded. G2 is 3-5 parallel first runs on a fresh `CODEMIE_HOME`, one network-blocked run, and first-run duration (AC8).
5. Q5: on Linux/macOS, check whether git and gh lose their global settings under the redirect. If they do and the injected hooks plugin offers an env hook, add a restore there as an extra task. Otherwise record it for the release note.
6. AC4: confirm the plain `opencode` agent still reads its own config and history.

**Stop path:** if G1 or G2 fails, stop and return to the user. Do not ship the redirect. Propose `OPENCODE_CONFIG_DIR` pointed at a CodeMie dir (usable only if it replaces the global dir and is not additive), or an engine-side switch in `codemie-opencode`. Changing the mechanism is a user decision.

## Task 2 - Add `getOpenCodeConfigBase()` helper

Test-first: no - repo policy, tests only on explicit request.

In `src/agents/plugins/opencode/opencode.paths.ts`, next to `getOpenCodeStorageBase()` (lines 17-19), add:

```ts
/** CodeMie-owned XDG_CONFIG_HOME base for codemie-code runs. Must differ from the data base (engine dir is `<base>/opencode`). */
export function getOpenCodeConfigBase(): string {
  return join(getCodemieHome(), 'opencode-config');
}
```

Also add a one-line comment above `getOpenCodeConfigDir()` (:249-254) saying it is the user's real OpenCode config location, used by the plain `opencode` agent, and not the codemie-code isolated one. Do not change its behaviour.

## Task 3 - Capture and redirect `XDG_CONFIG_HOME` in `beforeRun`

Test-first: no - repo policy, tests only on explicit request.

In `src/agents/plugins/codemie-code.plugin.ts`, `lifecycle.beforeRun` (:248):
- Add a module-level record of the user's value, for example `let capturedUserXdgConfigHome: { value: string | undefined } | undefined`, with a comment pointing at the capture-in-`beforeRun` / restore-in-`enrichArgs` rule for later XDG redirects (NG2).
- As the first statements of `beforeRun`, above the early returns at :258-265: capture `process.env.XDG_CONFIG_HOME` (an unset variable stays distinguishable from an empty one), then set `env.XDG_CONFIG_HOME = getOpenCodeConfigBase()` and `logger.debug` the redirect. Keep this assignment in one place so an opt-back-in switch can condition it later.
- Leave `env.XDG_DATA_HOME = getOpenCodeStorageBase()` at :363 where it is (Q7).
- Import `getOpenCodeConfigBase` from the existing `opencode.paths.js` import.

## Task 4 - Restore the user's `XDG_CONFIG_HOME` in `enrichArgs`

Test-first: no - repo policy, tests only on explicit request.

In `codemie-code.plugin.ts`, `enrichArgs` (:386), as the first statement and before the subcommand and `--task` early returns: when the captured record exists, restore `process.env.XDG_CONFIG_HOME` to the user's value, using `delete` when the user had none (never assign the string `undefined`), then clear the record. Skip when nothing was captured. Add a comment explaining why: `BaseAgentAdapter.ts:700` merges the returned env into `process.env`, the child is spawned with the local env object (:933-935), and `enrichArgs` (:705) is the first plugin hook after the merge, so the wrapper keeps the user's value while the child keeps the redirect. `BaseAgentAdapter` and other agents stay unchanged, and `opencode.plugin.ts` is not touched (AC4).

## Task 5 - CHANGELOG entry

Test-first: no - repo policy, tests only on explicit request (docs only).

In `CHANGELOG.md` `## [Unreleased]` (:5), add a `### Changed` section before the existing `### Fixed`. One bullet, in the style of existing entries: `codemie-code` runs, `--task` and interactive, now use a CodeMie-owned OpenCode config location under the CodeMie home, so the user's global OpenCode config (`~/.config/opencode`: settings, agents, commands, tools, MCP) no longer applies; a broken global tool file no longer crashes runs; project-level `.opencode` is still loaded. Add a `~/.opencode` known-gap line only if Task 1 Q6 found it loaded, and a git/gh note only if Task 1 Q5 found them affected and not restored.

## Negative-constraint pass

- NG1 (bare positional `cd` target): no task touches the positional-arg handling in `enrichArgs`; Task 4 adds only a leading restore statement.
- NG2 (`XDG_STATE_HOME`, `XDG_CACHE_HOME`): not touched; Task 3 states the rule for later redirects.
- NG3 and AC4 (plain `opencode` agent unchanged): Task 2 adds a comment only; `opencode.plugin.ts` is untouched.
- NG4 (no fail-fast without a provider): the redirect is hoisted above the early returns, which still return as before.
- NG5 (project `.opencode` not isolated): no task alters project config loading; Task 5 says it still loads.
- No `BaseAgentAdapter` change, no HOME/USERPROFILE override, no tests, no whole-suite gates, and no hoisting of the data redirect (Task 3).
