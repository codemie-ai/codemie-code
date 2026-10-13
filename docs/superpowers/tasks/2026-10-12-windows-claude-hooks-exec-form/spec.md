# Windows: Claude plugin hooks in exec form, refreshed on every launch

## Problem

On Windows without Git Bash, `codemie-claude` opens a console window that never closes at session start, on prompt submit and on response.

Since 0.15.0 the installed `~/.codemie/claude-plugin/hooks/hooks.json` holds shell-form commands pointing at the extensionless npm shim (`C:/nvm4w/nodejs/codemie hook`), produced by `resolveCodemieBinary` (`src/utils/hook-command.ts:59-79`) through `localizeInstalledHooks` (`src/agents/core/extension/BaseExtensionInstaller.ts:522-537`) and migration 006. The shim is a shell script. Without bash, Claude Code runs the hook through PowerShell, which hands the extensionless file to Windows; it opens in a detached console with no stdin, so `codemie hook` never exits.

Existing installs stay broken because hooks are localized only when the plugin is copied or updated (`BaseExtensionInstaller.ts:697-700`), an absolute command is never re-resolved (`hook-command.ts:84-98`), and migration 006 runs once.

## Behaviour

Applies to the Claude plugin installer on `win32` only.

**Exec-form entries.** Every bundled hook entry whose `command` starts with the bare token `codemie` (`src/agents/plugins/claude/plugin/hooks/hooks.json`, 11 entries) is written to the installed file as:

```json
{
  "type": "command",
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/Users/me/AppData/Roaming/npm/node_modules/@codemieai/code/bin/codemie.js", "hook"],
  "timeout": 60
}
```

- `command` is `process.execPath`; `args[0]` is the absolute path of this package's `bin/codemie.js`, resolved from the compiled module's location as in `src/cli/commands/proxy/daemon-manager.ts:102-104`. `process.argv[1]` is not a source: during a launch it is `bin/codemie-claude.js`.
- The remaining `args` are the whitespace-separated tokens that followed `codemie` in the bundled command, in order (`hook`, or `sound`, `SessionStart`).
- Both paths use forward slashes and are never quoted. No `${CLAUDE_PLUGIN_ROOT}`, no PATH lookup.
- Every other field of the entry and of the file (`type`, `timeout` where present, `description`, event structure) is carried over from the bundled copy. Entries that do not start with `codemie` are copied unchanged.

**Refresh on every install call.** Each `ClaudePluginInstaller.install()` generates the expected content from the bundled `hooks.json` and the current paths, and writes the installed file only when its parsed JSON differs from the expected value; a missing or unparseable installed file counts as different. This holds for all three outcomes (`copied`, `updated`, `already_exists`) and therefore for all callers of the installer (`src/providers/core/default-agent-hooks.ts:34`, `anthropic-subscription.template.ts:70-90`, `src/cli/commands/skills/setup/sync-plugin.ts:24-25`). Writes keep the existing two-space `JSON.stringify` format.

**Result and failures.** `install()` returns the same `success` and `action` as today; a hooks-only rewrite still reports `already_exists`. Any refresh failure (bundled file unreadable, `bin/codemie.js` not found, write error) is logged with `logger.warn`, leaves the installed file as it was, and does not reach the outer catch of `install()` (`BaseExtensionInstaller.ts:618-779`), which would turn it into a failed install.

## Acceptance criteria

- **AC-1** On win32, after `install()` returns with action `copied`, `updated` or `already_exists`, every entry whose bundled command starts with `codemie` is exec-form in the installed Claude `hooks.json` as specified above; paths containing spaces appear unquoted.
- **AC-2** On win32, an installed file holding the old shell form or a stale node/script path is rewritten by the next `install()` with no plugin version change, and the result action is `already_exists`.
- **AC-3** On win32, when the installed file already equals the expected content, no write happens.
- **AC-4** On non-Windows platforms the installed Claude `hooks.json` content and the set of file writes are identical to current behaviour, including no hook work on `already_exists`.
- **AC-5** Gemini and Kimi installers perform no new reads, writes or warnings on any platform; `resolveCodemieBinary`, `resolveHookCommand`, `rewriteHooksCommandTree` and `buildDefaultHooks` (`src/agents/plugins/codemie-code.plugin.ts:29-35`) return the same values as today.
- **AC-6** A refresh failure leaves the `install()` result unchanged and emits a warning.
- **AC-7** Unit tests cover: exec-form generation under simulated win32 for both argument shapes and a path with spaces; rewrite of old-form and stale-path files; no write when equal; refresh failure; the unchanged non-Windows path.

## Non-goals

- Gemini, Kimi, OpenCode and codemie-code hook handling, on any platform.
- Changing the output of `resolveCodemieBinary`, `resolveHookCommand` or `rewriteHooksCommandTree`, or editing migration 006.
- Any new write or content change for Claude on macOS/Linux.
- A new migration or a plugin version bump (`plugin.json` stays `1.0.28`).
- Editing the bundled `hooks.json` template; it stays machine-agnostic with bare `codemie`.
- Preserving manual edits to the installed Claude `hooks.json` on Windows.
- `.cmd`-shim or shell-string `node "…"` variants; supporting Claude Code older than the current minimum `2.1.269` (`claude.plugin.ts:52`).
- Making `ClaudePluginInstaller.getTargetPath()` honour `CODEMIE_HOME`.

## Testing constraints

- The `test-windows` CI job runs the `unit` project, so the new branch executes for real there: the order-sensitive `readFile` mocks in `src/agents/plugins/claude/__tests__/plugin-installer.test.ts:79-103` must be adjusted, and `tests/integration/sso-claude-plugin.test.ts:298` must keep passing.
- win32 is simulated with `process.platform` / `process.execPath` spies; expected paths are derived, not hardcoded literals (`.ai-run/guides/testing/testing-patterns.md:144-154`).

## Risks

- Two CodeMie installs used alternately on one machine (global and `npm link`) rewrite the file on each switch; the last launch wins.
- Gemini extension hooks on Windows keep the shell-form shim path and may show the same symptom; excluded by decision.
- The exec-form schema is known only from manual verification on Claude Code 2.1.218–2.1.295; nothing in the repo validates it.
