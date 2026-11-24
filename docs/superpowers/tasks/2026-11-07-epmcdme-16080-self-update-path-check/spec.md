# EPMCDME-16080: warn when self-update leaves a stale `codemie` first on PATH

## Problem

`updateCli` (`src/utils/cli-updater.ts:283-307`) installs the new version and then always prints
"The update will take effect on the next command." That is false when an older install sits earlier
on PATH (typically the legacy prefix: `~/.codemie/npm-prefix/bin`, `%LOCALAPPDATA%\CodeMie\npm-prefix`;
`npm-prefix.ts:78`). The next `codemie` then runs the old version, with no hint why.

## Scope

After a successful install in `updateCli`, find the first `codemie` on PATH, learn its version without
running it, and compare with the version just installed. Of the ticket's four acceptable outcomes we
implement "clearly warn" only. We do not reorder PATH, uninstall anything, or install into the stale
prefix.

Both non-silent entry points (`self-update.ts:56` and the prompt-mode flow at `cli-updater.ts:411`) go
through `updateCli`, so the check and message live in `updateCli`'s success branch only.

## Behavior

1. **Locate** the first `codemie` with the existing `getCommandPath('codemie')` (`processes.ts:48`:
   POSIX `which`, Windows `where.exe $PATH:codemie`). Its signature and other callers stay untouched.
2. **Read the active version without spawning anything.** Resolve the real path of the hit, then find
   the `package.json` named `@codemieai/code` that owns it:
   - POSIX: the hit is a symlink into `<prefix>/lib/node_modules/@codemieai/code/bin/`; walk up from the
     realpath to the nearest such `package.json`.
   - Windows: the hit is npm's extensionless shim (not a symlink) next to `codemie.cmd`; the package is
     at `<dir of hit>\node_modules\@codemieai\code\package.json`. No `.cmd` swap, shell, or quoting is
     needed because nothing is executed, so paths with spaces are not a concern.
   The helper (new small util module, e.g. `src/utils/active-cli.ts`) returns `{ path, version, prefix }`
   or `null`; it never throws. The prefix, when derivable, comes from the existing
   `getCodemieNpmPrefix(packageDir, platform)`.
3. **Compare** with `compareVersions` (`version-utils.ts`). Outcomes:
   - active version >= installed version: print the current success text, including the "takes effect on
     the next command" line (it is now verified true).
   - active version < installed version: print the success lines (`updated successfully`, installed
     version) but replace the "takes effect" line with a yellow warning containing:
     the active binary path, the version it will still run, the installed version, and how to fix:
     (a) remove the stale install, `npm uninstall -g @codemieai/code --prefix "<active prefix>"`
     (omitted when the prefix cannot be derived), or (b) put the directory holding the new install ahead
     of it on PATH; then open a new terminal.
   - not determinable (no PATH hit, no owning package, unreadable or invalid version): keep today's text
     unchanged and log the reason with `logger.debug`. The check must never turn a successful update
     into an error.
4. **Silent mode** (`silent=true`): run the same check; on a mismatch log one `logger.debug` line, print
   nothing.
5. **Exit code** stays 0 in every case; `self-update.ts` and the `process.exit(0)` at
   `cli-updater.ts:414` are unchanged.

## Why not `codemie --version` in a child

A child re-enters `bin/codemie.js`, which runs migrations, the update check and the what's-new notice
for `--version` (`bin/codemie.js:26-73`; `COMMANDS.md:1263`). The only existing skips are `NODE_ENV=test`
/ `VITEST=true`, `--json`, and hook argv, and they are evaluated by the *stale* binary's own code, which
is by definition the version we cannot trust to honour them. An old binary without the gate would run
`npm view` and self-install into its own prefix. `CODEMIE_AUTO_UPDATE=false` prompts rather than skips.
A new "skip update" env var would not exist in that old binary either. Reading `package.json` beside the
resolved path has none of these side effects, needs no timeout, and avoids the Windows `cmd.exe` timeout
and quoting problems.

## Documentation

- `docs/COMMANDS.md:1304`: the sentence "The update takes effect on the next command execution" becomes
  "...once the `codemie` first on your PATH is the updated install; `codemie self-update` warns when an
  older install shadows it."
- `docs/CONFIGURATION.md:215-230` contains no "next command" claim; no change needed.

## Decisions

- Read the version from the `package.json` owning the first PATH hit, over spawning `codemie --version` with a suppression env (the stale binary's own start-up flow cannot be trusted to honour it).
- Put the check and message in `updateCli`'s success branch, over each caller, since both non-silent paths share it.
- New helper in its own util module, over extending `getCommandPath` (10+ callers) or growing `cli-updater.ts`.
- Compare against the installed target version (`latestVersion`), over comparing with the running binary's version.
- Warn only when the active version is lower than the installed one, over warning on any inequality (a newer dev checkout or link is not a problem).
- Report the active binary's version as the "old version", over the running process's version (the active one is what will actually run).
- Undeterminable result keeps today's text plus a debug line, over a new "could not verify" message.
- Run the check in silent mode too, logging at debug only, over skipping it.
- Fix hint offers uninstalling the stale install or moving PATH, over any automatic remedy.
- Leave `docs/CONFIGURATION.md` unchanged, over adding a bullet.

## Non-goals

- Auto-fixing: no PATH edits, no uninstall, no install into the stale prefix.
- No change to `getCommandPath`/`commandExists` or the update-check / `bin/codemie.js` gating.
- Listing every `codemie` on PATH (first hit only).
- Detecting a stale install by any means other than the first PATH hit (no check at start-up or in `doctor`).
- Changes to the failure path, exit codes, or the `NpmPrefixOverrideCheck` doctor check.
- Handling non-npm layouts (Volta shims and similar); they fall into "not determinable".

## Acceptance criteria

1. A non-silent successful update where the first `codemie` on PATH reports an older version prints a warning with the active path, its version, the installed version and fix steps, and does not print "takes effect on the next command".
2. When the first `codemie` on PATH is at or above the installed version, output is as today.
3. When the active install cannot be determined, output is as today and a debug line explains why.
4. Silent auto-update prints nothing new; a mismatch is logged at debug level only.
5. The check never spawns `codemie`, never triggers an update check or prompt, and never throws.
6. Works with POSIX `which` and Windows `where.exe`, including a path with spaces and the extensionless npm shim.
7. Exit code is 0 for every successful-update outcome, in both `self-update` and prompt mode.
8. `docs/COMMANDS.md` no longer states the update unconditionally takes effect on the next command.
