# EPMCDME-15307 — Installers must not rewrite the user's npm prefix

Requirements: `ticket.md`. Decided design: `design-decisions.md`. Codebase context: `technical-analysis.md`.

## Problem

In its default portable mode, `install/windows/install.ps1` runs `npm config set prefix <InstallRoot>\npm-prefix --location user` (`install.ps1:169-176`). That redirects every global npm install for the user, which breaks npm-installed Claude Code's auto-update. The `user-prefix` mode in `install/macos/install.sh:69-80` makes the same user-wide write. Once the override is removed, CodeMie's own self-update (`src/utils/processes.ts:142-262`, via `cli-updater.ts:245` and `update.ts:216`) runs a plain `npm install -g` and would install into a different prefix than the copy that is actually running.

## Behavior

### Windows installer (`install/windows/install.ps1`)
- `-Mode` accepts `auto | npm-global | portable` and defaults to `auto`.
- `auto` resolves to `npm-global` when the folder from `npm config get prefix` is writable, and to `portable` otherwise. The installer prints the resolved mode.
- Writability is probed by creating and deleting a temp file in the prefix folder. If that folder does not exist, the probe uses its nearest existing parent. ACL-only and `Test-Path`-only checks are not used.
- `portable` installs with `npm install -g --prefix <InstallRoot>\npm-prefix`. It keeps the existing `CodeMie\bin` shims and their PATH entry (`install.ps1:191-218`) and writes no `prefix` to any `.npmrc`.
- The only user-wide npm setting the installer may still change is `@codemieai:registry`, and only with `-ScopeRegistryUrl`. When it does, it prints the setting and its revert command (`npm config delete @codemieai:registry --location user`).
- Every new mutation goes through `Invoke-Checked` so that `-DryRun` shows it.

### Migrating affected machines (both installers)
The installers detect a legacy override only when `npm config get prefix --location user` exactly equals `<InstallRoot>\npm-prefix` on Windows or `$HOME/.codemie/npm-prefix` (the default `USER_PREFIX`) on POSIX. They never act on any other prefix value, on `NPM_CONFIG_PREFIX`, or on global or project `.npmrc` values. When the override is detected, a rerun does the following in order:
1. List the packages stranded in the old prefix (`npm ls -g --prefix <old> --depth=0`).
2. Run `npm config delete prefix --location user` and print that it ran.
3. Resolve the mode after the deletion, then install for that mode.
4. If the resolved mode is not portable (Windows), remove the stale `CodeMie\bin` shims and their user PATH entry.
5. Print how to reinstall the stranded packages (for example `npm i -g @anthropic-ai/claude-code@latest`) and how to delete the old folder. The folder itself stays in place.

### macOS/Linux installer (`install/macos/install.sh`)
- `user-prefix` installs with `npm install -g --prefix "$USER_PREFIX"` and no longer writes `~/.npmrc`. It keeps the PATH guidance for `$USER_PREFIX/bin`.
- `auto` resolution (`install.sh:58-65`) is unchanged, except that it runs after the migration above.

### Self-update targets the running copy (`src/utils/`)
- CodeMie works out its own install prefix from its package path: `<prefix>\node_modules\@codemieai\code` on Windows, `<prefix>/lib/node_modules/@codemieai/code` on POSIX.
- If the running package does not match that layout (dev checkout, `npm link`), there is no derived prefix and the current behavior is kept.
- For the `@codemieai/code` package only, install, uninstall and version listing pass `--prefix <derived>` when the derived prefix differs from `npm prefix -g`. The argv of every other package is unchanged, and agent install behavior stays exactly as it is today.
- `restoreCliBinLink()` (`src/utils/cli-bin.ts:27-39`) uses the same derived prefix, so it relinks the running copy's bin.
- This has to work for an old portable install whose user deleted the override by hand: the running copy is in `CodeMie\npm-prefix` while `npm prefix -g` is `%APPDATA%\npm`.

### `codemie doctor`
A new health check, registered next to `NpmCheck` in `src/cli/commands/doctor/index.ts`, uses the same exact-match detection as the installers. When it finds the override, it reports `warn` with the fix commands (`npm config delete prefix --location user`, then the reinstall guidance). Otherwise it reports `ok`. The check is read-only.

### `install/README.md`
The README documents the three Windows modes and the `auto` default, what each mode changes, the revert commands, and the migration steps for affected users. It also corrects the "Windows Defaults" and "Default Paths" content (`README.md:67-106`) wherever it conflicts with the new behavior.

## Acceptance criteria
1. With default parameters, `install.ps1` leaves `%USERPROFILE%\.npmrc` untouched: `npm config get prefix` returns the same value before and after the install.
2. After CodeMie is installed by script on a machine that already has npm-installed Claude Code, `npm install -g @anthropic-ai/claude-code@latest` updates the copy in `%APPDATA%\npm`.
3. (Narrowed from ticket AC3.) In `npm-global` mode, `codemie update` and `codemie install <npm agent>` work, and the installed commands resolve in a new terminal. In `portable`/`user-prefix` mode, `codemie update` updates the running copy and the CodeMie commands resolve in a new terminal. Agent installs in these modes are unchanged and out of scope.
4. `codemie update` on an old portable install whose override was deleted by hand updates the copy in `CodeMie\npm-prefix`.
5. Every user-wide setting that either installer changes or deletes is printed together with its revert command.
6. On a machine with the legacy override, rerunning the installer removes the override, lists the stranded packages with reinstall guidance, and leaves no stale shims on PATH when the resolved mode is not portable.
7. `codemie doctor` warns about the legacy override and prints the fix commands, without changing anything.
8. A user-level prefix that does not exactly match CodeMie's path is never reported or modified.
9. `install.sh` `user-prefix` mode does not write `~/.npmrc`.
10. `install/README.md` documents the modes, the defaults, the revert commands and the migration steps.

## Non-goals
- Any change to npm-based agent installs, including support for them in portable/user-prefix mode and a clear failure message in place of false success. Both go to a follow-up ticket.
- Adding `CodeMie\npm-prefix` to PATH, or generating shims for agents.
- Changes to the CodeMie Connect wizard. It is a prebuilt binary from another repo, so it gets flagged to its owners.
- Deleting the old `CodeMie\npm-prefix` folder or reinstalling stranded packages automatically.
- Changing the `--prefix` behavior for any package other than `@codemieai/code`.
- Changing `scripts/postinstall.mjs` or `install.cmd`.
- A Pester or bats test harness for the installer scripts.
