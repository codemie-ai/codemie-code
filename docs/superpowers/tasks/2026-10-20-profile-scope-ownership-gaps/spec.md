# Spec: Close the remaining profile-scope gaps on top of PR #575

**Branch:** `fix/profile-scope-ownership` (created from PR #575 by Filip-Stastny-Philips, merged with current `main`)
**Size:** M (19/36, see `complexity-assessment.json`)
**Inputs:** `technical-analysis.md`, client bug report `D:/Projects/codemie-bugs/codemie-cli-local-config-breaks-profiles.md`

## Intent

A Philips client reported that a project-local config (`.codemie/codemie-cli.config.json`) breaks profile management and can make the CLI unusable in that directory. PR #575 fixes the four core scenarios: delete from the owning scope, fallback for a dangling local `activeProfile`, an empty local `activeProfile`, and key preservation on `switch` for v2 files. Validation found more bugs of the same kind: local writes still destroy data, failures are invisible, rename ignores scopes, and the fallback is silent.

The goal: **profile operations never break a directory, never destroy local config data, and never fail silently.** The fix is a coherent rule, not more point patches, so this class of bug doesn't come back.

## Goals

1. Every write to the local config preserves every key it doesn't explicitly change.
2. Every profile command failure prints a readable reason to the user without `CODEMIE_DEBUG`.
3. Profile operations act on the scope that owns the profile (completing #575 for rename and setup).
4. Falling back from a dangling local `activeProfile` is visible, but not noisy.
5. Regression tests cover bug-report scenarios 1–4 and every gap below.

## Non-goals

- Enforcing unique profile names across scopes (PR #585, a maintainer decision).
- `--profile <typo>` resolving to built-in defaults (`AgentCLI` → `loadGlobalConfigProfile`). This predates the PR and is unrelated to local config.
- Hardening against malformed **global** config files.
- Changing `logger.error` globally (234 call sites, including the proxy daemon and hooks; console output would leak into agent TUIs).
- Fixing the stale logging table in `.ai-run/guides/development/development-practices.md` or the generated OpenWiki pages.
- Changing the by-design rule that `profile switch` stores `activeProfile` locally when `.codemie/` exists.

## Anti-goals (a failure even if it "works")

- Any code path that replaces an existing local config file wholesale.
- Warnings printed to **stdout**, or repeated several times per command, or printed by every agent hook invocation.
- Changing which profile is active in a directory where today's behaviour is correct (a valid local `activeProfile`, or no local file).

## Behaviour

### B1. Safe local writes (closes E4, E5; enforces Goal 1)

- All writes to `<cwd>/.codemie/codemie-cli.config.json` go through one read-modify-write path. It reads the raw JSON, applies only the intended change, and writes back every other top-level key untouched (`codemieAssistants`, `codemieSkills`, `workspace`, unknown keys, other profiles).
- Callers: `switchProfile`, the `deleteProfile` local delete and local-reference repair, `renameProfile` (B5), the setup Local save (B2), `saveAssistantsToProjectConfig` / `saveSkillsToProjectConfig` with Local scope, and migrations that save local config if they currently go through the same save method.
- **Write-path classifier** (*decided during review*; nothing else may overwrite a local file):

  | Existing local file | Write behaviour |
  |---|---|
  | Missing | Create `{version:2, activeProfile:"", profiles:{}}` + the change (B3) |
  | Valid v2 (`isMultiProviderConfig`) | Apply the change, keep every other key |
  | Plain JSON object, not legacy (`isLegacyConfig` false), `version` absent or `2`; `profiles` absent or a plain object whose entries are all plain objects; `activeProfile` absent or a string (e.g. hand-written `{codemieAssistants, workspace}`) | Fill `version: 2`, `profiles: {}` and `activeProfile: ""` where absent, apply the change, keep every other key |
  | Unparseable JSON, not an object, legacy v1, `version` present and ≠ 2, `profiles` an array or with non-object entries, non-string `activeProfile` | Refuse with a `ConfigurationError` naming the file and saying it was left unchanged. Never overwrite. |

- **Reading stays narrow** (*decided during review*): the lenient classification above is used only by the write helper and by the Local-scope skills/assistants load/save paths (`loadSkillsByScope`, `loadAssistantsByScope`, `save*ToProjectConfig`), so registration works in such directories and keeps their keys. `ConfigLoader.load`, `listProfiles` and workspace/identity resolution keep treating a non-v2 local file as absent, as today. No change to the effective config in those directories (anti-goal).

### B2. `codemie setup` → Local save merges (closes E5)

- Adding or updating a profile with Local scope writes only `profiles[<name>]` (provider half) and merges workspace fields into the existing local `workspace` (new values win, other workspace keys kept). Every other local profile and top-level key is preserved.
- **Active-profile handling** (*decided during review*; the old "always active" behaviour was only a side effect of the wipe):
  - **Update** of an existing local profile keeps the current local `activeProfile`. Exception: if the local `activeProfile` is `""` or dangling, it is set to the updated profile. This mirrors the global path, which never switches on update.
  - **Add** of a local profile: if it is the only local profile, or the local `activeProfile` is `""`/dangling, it becomes active. Otherwise the existing `Switch to profile "<name>" as active in local config?` prompt in `setup.ts` asks (that block is unreachable today and becomes live).
- `initProjectConfig`'s existing public behaviour for a directory **without** a local file stays the same (existing tests in `config-project-override.test.ts` 53-145 keep passing). Whether setup calls a new method or `initProjectConfig` is changed to merge is the builder's call.

### B3. A new local file doesn't select a profile (closes E6)

- When a local file is created by something other than an explicit profile choice (Local-scope skill/assistant registration, or `loadLocalMultiProviderConfig`'s default for a missing file), it is written with `activeProfile: ""`, not `"default"`.
- `""` means "no local choice": the effective profile is the global active one, and **no warning** is printed (B4 applies only to a non-empty name).
- Existing files that already contain `activeProfile: "default"` are not rewritten. If no profile named `default` exists in either scope, B4's warning covers them.
- **Delete repair uses `""` too** (*decided during review*): when #575's `deleteProfile` repair has no remaining local profile to choose, it writes `activeProfile: ""` (follow global) instead of copying the current global active name. This applies to deleting the last local profile, and to deleting the global profile the local one pointed at. Copying the name pinned the directory and set up a later B4 warning. AC3's outcome is unchanged; #575's test assertions on the repaired value are updated to `""`. The "first remaining local profile" choice stays as is.

### B4. Visible, one-time fallback warning (closes E3)

- When the local `activeProfile` is a **non-empty** name that exists in neither scope, the CLI uses the global active profile (already done by #575) and prints exactly one warning per process to **stderr**:
  `⚠ Local profile "<name>" not found in <local config path>; using global profile "<global>". Run: codemie profile switch`
- If there is also no valid global active profile, the warning says no profile is available and suggests `codemie setup`. The behaviour after the warning stays as on the branch today.
- It is printed where users act: profile commands (list, status, switch, delete, rename) and agent launches (`ConfigLoader.load` via `AgentCLI`). It must **not** be printed from `codemie hook` invocations, the proxy daemon, or other background paths.
- **Interactive gate** (*decided during review*): print to the console only when `process.stderr.isTTY` is true. ACP adapters, `-p`/print mode and `--task` launched through a pipe stay silent on the console and get the log-file entry only. The once-per-process mechanism is the builder's call.
- The detailed message is also written to the log file.

### B5. Scope-aware rename (closes E2)

- `renameProfile(oldName, newName, workingDir)` finds the owning scope (local first, then global, the same as `getProfileScope`) and renames the profile inside that scope's file through B1 / the global save, preserving every other key.
- `newName` must not exist in **either** scope; otherwise it fails with a clear error. `oldName` not found in either scope fails with the available profiles listed (same as delete).
- The owning scope's `activeProfile` is updated if it pointed to `oldName`.
- If the rename is global and the cwd's local `activeProfile` equals `oldName`, it is updated to `newName` (mirroring #575's delete repair). Local files in other directories are not touched; B4 covers them.
- The CLI prints `✓ Profile "<old>" renamed to "<new>" in local config|global config`.

### B6. Visible errors and clean cancellation (closes E1)

- Every catch block in `src/cli/commands/profile/index.ts` (list, status, switch, delete, rename) and `src/cli/commands/profile/auth.ts` (login, logout, refresh) still calls `logger.error(...)` for the log file **and** prints `✗ <action> failed: <reason>` in red to stderr, then exits 1. Use the existing `getErrorMessage` from `src/utils/errors.ts` and the `console.error(chalk.red(...))` idiom already used across `src/cli/commands`. A tiny local helper is fine; reuse an existing one if it fits (for example the `printProxyError` style).
- Cancelling an interactive picker (`Profile selection cancelled.`) prints a yellow `Cancelled.` and exits 0, matching the delete-confirmation cancel.
- `codemie setup`'s top-level failure (`setup.ts` catch, `logger.error('Setup failed:')`) also prints the reason visibly.

## Acceptance criteria

1. Inside a repo with a local config, `profile delete <global>` removes it from the global config and prints the correct scope. (#575, keep)
2. A local `activeProfile` that is missing in both scopes falls back to the global active profile. B4's warning is printed exactly once to stderr on a TTY and not at all when stderr is not a TTY; the log file gets the entry in both cases. (#575 + B4)
3. Deleting the last local profile, then deleting a global profile, both succeed. (#575, keep)
4. `profile switch` preserves every other key, for a v2 local file and for each "fill" row of the B1 classifier. Every "refuse" row leaves the file byte-identical and prints the reason. (B1)
5. `codemie setup` → Local add/update keeps the other local profiles, `codemieAssistants`, `codemieSkills` and other `workspace` keys. An update doesn't change the local active profile; an add follows B2's activation rule. (B2)
6. Local-scope skill/assistant registration in a fresh directory writes `activeProfile: ""`, and the effective profile there is the global active one, with no warning. (B3)
7. `profile rename` works for local-only and global profiles, rejects a `newName` that exists in either scope, and repairs the cwd local `activeProfile` reference. (B5)
8. Every profile/auth/setup command failure prints a red reason without `CODEMIE_DEBUG`, and picker cancellation exits 0 with `Cancelled.` (B6)
9. `profile list` always marks the effective active profile.
10. Regression tests exist for 1–9. The existing unit tests and `npm run lint`, `npm run typecheck` and `npm run build` pass.
11. `.ai-run/guides/usage/project-config.md` describes rename, the safe-write rule, `activeProfile: ""`, and the fallback warning.

## Constraints

- Follow AGENTS.md: ES modules, `.js` import suffixes, `@/` aliases, no `any` in new code, explicit return types on exports, project error classes (`ConfigurationError`) rather than generic `Error` for config-shape problems.
- Keep PR #575's public return conventions (`StorageScope` returned from mutating methods).
- Tests use the existing real-filesystem harness (`config-project-override.test.ts` path spies) and the command mock pattern (`profile/__tests__/index.test.ts`; add `red` to its chalk mock).
- Never run the built CLI against the real `~/.codemie`; manual checks use an isolated `CODEMIE_HOME`/`HOME`/`USERPROFILE`.
- Filip's commits stay in history (no rebase or squash of his work on this branch). The PR description credits PR #575 as the base.

## Left to the builder

- Name and location of the safe-write helper, and whether `initProjectConfig` is changed or setup gets a new method.
- The exact mechanism for "warn once, interactive paths only" (B4), within the stated constraints.
- Whether the error-printing helper is local to `profile/` or shared.
- Test file split (extend existing files vs a new `profile-scope.test.ts`).
