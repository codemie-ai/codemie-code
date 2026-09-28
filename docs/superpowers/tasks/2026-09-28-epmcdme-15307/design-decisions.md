# EPMCDME-15307 — Decided design (user-approved)

## Decided design

1. **New default mode `auto` in `install.ps1`**
   - Resolves to `npm-global` when the `npm config get prefix` folder is writable, otherwise to `portable`.
   - The resolved mode is printed.
   - Writability is probed by creating and deleting a temp file in the prefix folder, or in its nearest existing parent when the folder does not exist yet (`%APPDATA%\npm` is often absent until the first global install). No ACL-only or `Test-Path`-only check.
   - On affected machines, mode resolution runs only after the legacy override has been removed (see 5), otherwise `auto` resolves into the CodeMie prefix.
2. **Portable mode never touches the user's npm config**
   - Installs CodeMie with `npm install -g --prefix %LOCALAPPDATA%\CodeMie\npm-prefix`.
   - Keeps the `CodeMie\bin` shims on PATH as today.
   - No `prefix` is written to any `.npmrc`.
3. **Transparency**
   - Any user-wide npm setting the installer still changes (only `@codemieai:registry` when `-ScopeRegistryUrl` is given) is printed with its revert command.
4. **Self-update targets the running copy**
   - `codemie update` and the auto-updater install into the prefix CodeMie derives from its own package path:
     - Windows: `<prefix>\node_modules\@codemieai\code`
     - POSIX: `<prefix>/lib/node_modules/@codemieai/code`
   - `--prefix` is passed only when that differs from `npm prefix -g`.
   - Dev checkouts and `npm link` fall back to the default behavior.
   - `uninstallGlobal` and version listing for CodeMie's own package follow the same rule.
   - Agent installs keep using the user's normal `npm install -g`.
   - Must keep working for old portable installs after the user deleted the override by hand (running copy in `CodeMie\npm-prefix`, `npm prefix -g` now `%APPDATA%\npm`).
5. **Migration of affected machines**
   - Detect a **user-level** npm `prefix` (`npm config get prefix --location user`) that exactly matches `...\CodeMie\npm-prefix` (Windows) or `~/.codemie/npm-prefix` (macOS/Linux). Never act on a custom prefix, `NPM_CONFIG_PREFIX`, or global/project `.npmrc` values.
   - **Installer rerun:**
     1. List the packages stranded in the old prefix (`npm ls -g --prefix <old> --depth=0`).
     2. Remove the override (`npm config delete prefix --location user`) and print that it did.
     3. Resolve the mode (after step 2) and install per the resolved mode.
     4. If the resolved mode isn't portable, remove the stale `CodeMie\bin` shims and their PATH entry. Otherwise they keep launching the old copy.
     5. Print how to reinstall stranded packages (e.g. `npm i -g @anthropic-ai/claude-code@latest`) and how to delete the old folder. The folder itself is left in place.
   - **`codemie doctor`:** a new check warns about the override and prints the fix commands. Read-only.
6. **macOS/Linux `install.sh`**
   - The `user-prefix` fallback uses `npm install -g --prefix "$USER_PREFIX"` instead of writing `~/.npmrc`, and keeps the PATH guidance for `$USER_PREFIX/bin`.
   - Same migration detection.
   - Account for `restoreCliBinLink()` in `src/utils/cli-bin.ts`, which uses `npm prefix -g`.
7. **`install/README.md`**
   - Document the modes, the new `auto` default, what each mode changes, revert commands, and migration steps for affected users.
   - Correct the "Default Paths" section if it conflicts.

## Out of scope (follow-ups)

- **npm-based agent installs.** Agent install behavior stays exactly as it is today in every mode. Support for agent installs on locked-down machines (portable/user-prefix mode), including a clear failure message instead of false success, is deferred to its own ticket. Ticket AC3 is narrowed accordingly: npm-global mode, CodeMie update and agent installs work; portable/user-prefix mode, CodeMie self-update works and agent installs are unchanged.
- **CodeMie Connect GUI wizard.** Only prebuilt binaries are in this repo. Its README implies it puts `CodeMie\npm-prefix` on PATH; whether it writes `.npmrc` is unverified and should be flagged for the wizard owners.
