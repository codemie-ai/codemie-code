# EPMCDME-15307 — Windows installer rewrites user npm prefix, breaking npm-installed Claude Code

## Description
The Windows bootstrap installer (install/windows/install.ps1) runs in portable mode by default. In that mode it runs:

npm config set prefix %LOCALAPPDATA%\CodeMie\npm-prefix --location user

This writes prefix=C:\Users\<user>\AppData\Local\CodeMie\npm-prefix into %USERPROFILE%\.npmrc. After that, every npm install -g that user runs, for any package, goes to the CodeMie folder instead of the default %APPDATA%\npm. The user is not told, and nothing ever reverts it.

Claude Code installed through npm breaks as a result. Its background updater renames the running claude.exe to claude.exe.old and reinstalls through npm. npm now writes the new version into the CodeMie prefix, so the original folder keeps only claude.exe.old and the claude command stops working. Restoring the exe by hand lasts only until the next update check, which breaks it again.

User report (translated): "For the second time: if you install CodeMie CLI via the script, it breaks regular Claude. It goes into a self-update loop, renames claude.exe to claude.exe.old and never finishes the install. Reproduced on a second machine. The root cause really is the npm config rewrite."

## Environment
- Windows 10/11, native (not WSL)
- Node.js 20 or newer, with the npm global prefix at its default %APPDATA%\npm
- Claude Code installed with npm install -g @anthropic-ai/claude-code. In version 2.1.282 the package ships a native bin/claude.exe, placed by postinstall: node install.cjs.
- CodeMie installed with the documented one-liner and default parameters: irm https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.ps1 | iex (install.cmd behaves the same)

## Steps to reproduce
1. Install Claude Code with npm: npm install -g @anthropic-ai/claude-code. claude --version works, and the binary is %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe.
2. Install CodeMie with the script installer, using default parameters.
3. Run npm config get prefix. It now returns C:\Users\<user>\AppData\Local\CodeMie\npm-prefix (before: ...\AppData\Roaming\npm), and %USERPROFILE%\.npmrc contains the prefix= line.
4. To see the redirect directly, run npm install -g @anthropic-ai/claude-code@latest. It installs into %LOCALAPPDATA%\CodeMie\npm-prefix\node_modules, not into %APPDATA%\npm.
5. Start claude while a newer Claude Code version is available, and let the background auto-update run.

## Actual result
- %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe is renamed to claude.exe.old, and no new claude.exe appears in that folder.
- The new version goes to %LOCALAPPDATA%\CodeMie\npm-prefix, which is not on PATH. The installer adds only %LOCALAPPDATA%\CodeMie\bin, which holds shims for the 7 CodeMie commands.
- claude resolves to %APPDATA%\npm\claude.cmd, which points at the missing exe, so Claude Code no longer starts.
- A manual repair (node install.cjs in the package folder) holds only until the next update cycle, which creates another .old.
- Every global npm package is affected. npm ls -g, npm update -g and npm uninstall -g now use the CodeMie prefix: packages installed earlier seem to be missing, and CLIs installed later are not on PATH.

## Expected result
- Installing CodeMie leaves the user's npm configuration unchanged.
- Tools installed with npm before CodeMie keep installing and auto-updating in their original location.

## Root cause
- install/windows/install.ps1:4: -Mode defaults to portable.
- install/windows/install.ps1:175: portable mode runs npm config set prefix <InstallRoot>\npm-prefix --location user. The setting is persistent and applies to every npm command the user runs, not just the @codemieai/code install at :189.
- install/windows/install.ps1:217: only <InstallRoot>\bin is added to PATH, so anything else npm installs into the new prefix can't be found.
- The previous prefix value is not saved, and there is no uninstall or rollback.
- Introduced in PR #266 (commit 4b7b35cc, 2026-04-30). The documented URL points at main, so every default Windows script install since then applied the override.
- The macOS/Linux script behaves differently. install/macos/install.sh:58-65 defaults to auto and switches to a user prefix only when the global prefix isn't writable. On Windows the default %APPDATA%\npm is always writable by the user, so the override isn't needed in the default case.

How this breaks Claude Code (based on the npm package and the Claude Code docs; the updater itself is closed source):
- npm installs of Claude Code update themselves through global npm. The documented upgrade command is npm install -g @anthropic-ai/claude-code@latest, so the update follows the prefix in the user .npmrc.
- Windows lets a running .exe be renamed but not overwritten. The .old rename isn't done by the package's install.cjs (checked in 2.1.282), so it comes from Claude Code's updater.
- The rename therefore happens in the original folder, while the replacement is written to the CodeMie prefix.

## Also consider
- CodeMie's own npm operations depend on this user-wide override. installGlobal() (src/utils/processes.ts:142-176) runs a plain npm install -g. It is used by CLI self-update (src/cli/commands/update.ts:216, src/utils/cli-updater.ts:245) and by npm-based agent installs (src/agents/core/BaseAgentAdapter.ts:165,201). If we only delete the npm config set prefix line, codemie update will install into a different prefix than the one the portable shims run from.
- Possibly the same root cause: GitHub issue #493. There, codemie install opencode reports success on Windows but OpenCode stays "not installed". With the override active, opencode-ai would be installed into the CodeMie prefix, which is not on PATH. Not confirmed yet.
- Needs checking: the CodeMie Connect Windows wizard may set the same prefix. install/README.md:143-148 lists %LOCALAPPDATA%\CodeMie\npm-prefix among the PATH entries the wizard adds, and install.ps1:131 mentions the wizard.
- Not affected: codemie install claude. It uses Anthropic's native installer (src/agents/plugins/claude/claude.plugin.ts:75-77), which installs to %USERPROFILE%\.local\bin.

## Workaround for affected machines (PowerShell)
1. Remove the override: npm config delete prefix --location user. npm config get prefix should show ...\AppData\Roaming\npm again.
2. Reinstall Claude Code in its original location with npm install -g @anthropic-ai/claude-code@latest. Alternatively, switch to Claude's native installer, irm https://claude.ai/install.ps1 | iex, which doesn't use npm.
3. Delete the leftovers: claude.exe.old in %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin, and %LOCALAPPDATA%\CodeMie\npm-prefix\node_modules\@anthropic-ai\claude-code together with the claude* shims next to it.
4. Recommended: move CodeMie to the default prefix so its own updates stay consistent. Run npm install -g @codemieai/code, or rerun install.ps1 -Mode npm-global. Then remove %LOCALAPPDATA%\CodeMie\bin from the user PATH and delete %LOCALAPPDATA%\CodeMie\npm-prefix.

## Proposed fix
- install.ps1: never write prefix to the user .npmrc. Add an auto mode and make it the default, as the macOS script does. It uses npm-global when npm config get prefix is writable, which is the normal case on Windows, and falls back to portable only when it isn't.
- Portable mode, if we keep it: limit the prefix to CodeMie's own commands with npm install -g --prefix <dir>. Save that prefix so installGlobal, uninstallGlobal and npm list -g in src/utils/processes.ts use it for CLI self-update. Also make sure agents that CodeMie installs end up on PATH.
- Fix existing installs: a rerun of the installer and codemie doctor should detect a user .npmrc whose prefix points at ...\CodeMie\npm-prefix, warn, and print or apply the fix.
- Apply the same rule to install/macos/install.sh:71. Its user-prefix mode also writes prefix to ~/.npmrc, but only when the global prefix isn't writable.
- Update install/README.md with the modes, the defaults, and migration steps for affected users.

## Acceptance criteria
- [ ] With default parameters, install.ps1 leaves %USERPROFILE%\.npmrc untouched: npm config get prefix returns the same value before and after the install.
- [ ] On a Windows machine where Claude Code was installed with npm and CodeMie then with the script, npm install -g @anthropic-ai/claude-code@latest updates the existing install in %APPDATA%\npm. Claude's auto-update completes without leaving claude.exe.old or breaking claude.
- [ ] After a script install, in every supported mode, codemie update and codemie install <npm-based agent> work, and the installed commands resolve in a new terminal.
- [ ] Any npm setting the installer still changes is printed in the installer output and has a documented revert command. Nothing user-wide is changed silently.
- [ ] Machines that already have the prefix=...\CodeMie\npm-prefix override get a warning and a fix command from codemie doctor or from rerunning the installer.
- [ ] install/README.md documents the new defaults and the migration steps.

## References
- Code: install/windows/install.ps1:4,175,189,217, install/macos/install.sh:58-71, src/utils/processes.ts:142-176
- Introduced by: https://github.com/codemie-ai/codemie-code/pull/266
- Possibly related: https://github.com/codemie-ai/codemie-code/issues/493
- Claude Code install and auto-update docs: https://code.claude.com/docs/en/setup
