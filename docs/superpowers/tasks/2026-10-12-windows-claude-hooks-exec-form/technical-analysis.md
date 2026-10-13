# Technical Research

**Task**: claude plugin hooks installer windows
**Generated**: 2026-10-12
**Research path**: filesystem

---

## 1. Original Context

Bug fix (Windows): `codemie-claude` opens persistent cmd.exe console windows at session start, on prompt submit and on response when Git Bash (Git for Windows) is not installed.

Root cause (verified): since 0.15.0 (commit 3805b35, EPMCDME-14035), CodeMie rewrites the Claude plugin's hook commands in the installed `~/.codemie/claude-plugin/hooks/hooks.json` from bare `codemie hook` to an absolute path of the extensionless npm shim, e.g. `C:/nvm4w/nodejs/codemie hook` (`resolveCodemieBinary` in `src/utils/hook-command.ts`, applied by `BaseExtensionInstaller.localizeInstalledHooks` and migration 006). That shim is a shell script and only runs in bash. When Git Bash is absent, Claude Code runs shell-form hooks through PowerShell, which cannot execute an extensionless file and has Windows open it in a new detached console window; the hook gets no stdin, `codemie hook` never finishes and its window stays open.

Agreed design:
1. Claude agent on Windows (win32) only: write the installed plugin hooks in Claude Code exec form — `"command": "<absolute path of the running node.exe>", "args": ["<absolute path of CodeMie's bin/codemie.js>", ...original arguments]` (e.g. `hook`, or `sound`, `SessionStart`), keeping other fields such as `type` and `timeout`. Use forward slashes; do not use `${CLAUDE_PLUGIN_ROOT}`; do not rely on PATH. Exec form spawns the process directly with no shell (verified on Claude Code 2.1.218, 2.1.269, 2.1.281, 2.1.295; CodeMie's minimum supported Claude Code is 2.1.269, exec form exists since 2.1.139).
2. Refresh on every `codemie-claude` launch: the plugin installer already runs on every launch (`src/providers/core/default-agent-hooks.ts` → `installer.install()`), but only rewrites hook paths when the plugin version changes. Change it so that on every launch the expected hooks.json content is regenerated from the bundled plugin's hooks.json with the current paths and the installed file is rewritten only when it differs. This must also repair existing installs whose hooks contain the old extensionless absolute path. Regenerating the whole installed hooks.json from the bundled copy is acceptable (manual edits to that file are not preserved).
3. Unchanged: macOS/Linux behaviour for Claude; Gemini extension hooks, kimi, and OpenCode/codemie-code hooks (they share `resolveCodemieBinary` / `rewriteHooksCommandTree`).

Note: on nvm-windows `C:\nvm4w\nodejs` is a link to the active Node version; `import.meta.url` resolves to the real versioned folder while `process.execPath` / `process.argv[1]` keep the link. Because paths are refreshed on every launch, either is acceptable.

Acceptance criteria:
- On win32, after `codemie-claude` launch preparation, every `codemie …` hook entry in `~/.codemie/claude-plugin/hooks/hooks.json` is exec-form with absolute forward-slash node and codemie.js paths and the original arguments in `args`; paths containing spaces need no quoting.
- An installed hooks.json containing the old form (`C:/…/codemie hook`) or a stale path is rewritten on the next launch without a plugin version bump; when content already matches, the file is not written.
- On non-Windows platforms the installed hooks.json content is the same as before this change.
- Gemini and codemie-code/OpenCode hook command resolution is unchanged.
- A failure to refresh hooks never blocks the agent launch (log and continue), consistent with existing `localizeInstalledHooks` behaviour.
- Unit tests cover the Windows exec-form generation, the refresh-when-different / no-write-when-same behaviour, and the unchanged non-Windows path.

---

## 2. Codebase Findings

### Existing Implementations

- `src/utils/hook-command.ts` — shared resolver.
  - `resolveCodemieBinary()` (59-79): `getCommandPath('codemie')` → forward-slashed, quoted only when it matches `NEEDS_QUOTING`; rejects a shim resolving into `/@codemieai/codemie-opencode/`. Fallback is `process.argv[1]`; on win32 with a `.js` argv[1] it returns the shell string `"<execPath>" "<argv1>"`. Last fallback: bare `codemie`. Never throws.
  - `resolveHookCommand(command, binary)` (84-98): rewrites only a leading bare `codemie` token or a first token that is a shadowed shim. An already-absolute command is returned unchanged (asserted at `src/utils/__tests__/hook-command.test.ts:21-27`).
  - `rewriteHooksCommandTree(node, binary)` (102-129): recursive, mutates in place, touches only string-valued `command` keys; `args` are never visited.
- `src/agents/core/extension/BaseExtensionInstaller.ts`
  - `install()` (618-779): picks `copied` / `updated` / `already_exists` by comparing manifest versions; on copy/update it removes the target, copies the source, runs `verifyInstallation`, then `localizeInstalledHooks(targetPath)` (697). The `already_exists` branch (698-700) does nothing to hooks. The body is wrapped in a try/catch returning `{ success: false, action: 'failed' }`.
  - `localizeInstalledHooks()` (522-537, `protected`): reads `<target>/hooks/hooks.json`, rewrites via the two helpers, writes `JSON.stringify(parsed, null, 2)` only when something changed; every error becomes a non-fatal `logger.warn`.
- `src/agents/plugins/claude/claude.plugin-installer.ts` — `ClaudePluginInstaller`, four path overrides only; source `<module dir>/plugin`, target `join(homedir(), '.codemie', 'claude-plugin')`.
- `src/agents/plugins/claude/plugin/hooks/hooks.json` — bundled template, 11 command entries over 7 events: 7 × `codemie hook` (`timeout: 60`) and 4 × `codemie sound <Event>` (no timeout). Plain space-separated tokens, no quoting. Top-level `description` plus `hooks`. Plugin manifest version `1.0.28`.
- `src/migrations/006-resolve-hook-command-paths.migration.ts` — one-shot rewrite of the installed Claude (`getCodemiePath('claude-plugin', 'hooks', 'hooks.json')`) and Gemini files with the same helpers.
- `src/agents/plugins/codemie-code.plugin.ts` — `buildDefaultHooks(binary)` (29-35) and its call site (313-314) build inline OpenCode hooks from `resolveCodemieBinary()` + `resolveHookCommand()`.
- `bin/codemie.js` — CLI entry and the only launcher that runs `MigrationRunner`; `bin/codemie-claude.js` goes straight to `AgentCLI`.

Why existing installs stay broken today: hooks are localized only on copy/update, `resolveHookCommand` leaves absolute commands alone, and migration 006 runs once.

### Architecture and Layers Affected

- Utils: `src/utils/hook-command.ts`.
- Agent core: `BaseExtensionInstaller` (template-method base shared by Claude, Gemini, Kimi).
- Agent plugin: `src/agents/plugins/claude/` (installer, bundled plugin assets).
- Provider (callers only): `default-agent-hooks.ts`, `anthropic-subscription.template.ts`.

### Integration Points

- Callers of the Claude installer's `install()`:
  - `src/providers/core/default-agent-hooks.ts:34` — wildcard `beforeRun` for every agent exposing `getExtensionInstaller()` (Claude, Gemini, Kimi); try/catch, sets `CODEMIE_<AGENT>_EXTENSION_DIR`.
  - `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts:70-90` — calls the Claude installer directly.
  - `src/cli/commands/skills/setup/sync-plugin.ts:24-25` — constructs its own `ClaudePluginInstaller`.
  - `tests/setup/agent-build-setup.ts:152-166` — pre-installs once so parallel agent tests all see `already_exists` and skip the destructive remove/copy.
- Sibling installers on the same base: `gemini.extension-installer.ts` (bundled hooks are shell-form with `name` and millisecond `timeout`); `kimi.extension-installer.ts` (`manifest.json` + `SKILL.md`, no `hooks/hooks.json`).
- Claude Code reads the installed file through `--plugin-dir` (`default-agent-hooks.ts:57-60`).
- Build: `scripts/copy-plugins.js` copies plugin assets to `dist/agents/plugins/claude/plugin`, so the bundled `hooks.json` and `bin/codemie.js` sit at fixed relative positions in the package.

### Patterns and Conventions

- Locating a `bin/*.js` from compiled code: `join(getDirname(import.meta.url), '../../../../bin/proxy-daemon.js')` paired with `process.execPath` (`src/cli/commands/proxy/daemon-manager.ts:102-104, 140`; same in `codebase/daemon-manager.ts`). `findPackageRoot` in `src/utils/npm-prefix.ts:19` is module-private.
- Path normalization: `normalizePathSeparators()` in `src/utils/paths.ts:41`; `hook-command.ts` has a private `toForwardSlash`.
- Hook-file work is non-fatal: catch, `logger.warn`, continue.
- Agent-specific installer behaviour is an override on `BaseExtensionInstaller` (Kimi overrides `getInstalledInfo`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/testing/testing-patterns.md` — dynamic import after mock setup; lines 144-154 forbid hardcoded POSIX literals for values produced by `path.join()`.
- `.ai-run/guides/quality-gates.md:45-49` — a `test-windows` CI job runs the `unit` and `cli` Vitest projects.
- No guide covers `BaseExtensionInstaller`, `hook-command.ts` or Claude Code hook forms.
- `docs/superpowers/tasks/2026-08-12-codemie-claude-hook-path-and-effort-param/` — the EPMCDME-14035 plan and analysis that introduced the current behaviour.

### Architectural Decisions

- EPMCDME-14035 `plan.md:20`: bundled templates stay machine-agnostic (bare `codemie`); only the installed copy and runtime-built hooks are localized.
- `hook-command.ts:12-19`: the shadowed-shim rule exists because `@codemieai/codemie-opencode` also registers a `codemie` bin.
- `claude.plugin.ts:40, 52`: supported Claude Code `2.1.281`, minimum `2.1.269`.

### Derived Conventions

- Installed-file writes use two-space `JSON.stringify` with no trailing newline.
- `hook-command.js` is loaded by dynamic `import()` inside the base class.

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/hook-command.test.ts` — resolver fallbacks, quoting, win32 argv[1] branch (54-69), tree rewrite.
- `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts` — one case: fresh install rewrites commands to `/abs/codemie …`.
- `src/agents/plugins/claude/__tests__/plugin-installer.test.ts:79-103` and `src/agents/plugins/gemini/__tests__/gemini.extension-installer.test.ts:80-104` — `vi.mock('fs/promises')` with exactly two ordered `readFile` results on the `already_exists` path; neither inspects hook content.
- `src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts` — rewrite, no-op, idempotence, write failure.
- `src/agents/plugins/__tests__/codemie-code.hooks.test.ts` — `buildDefaultHooks` output.
- `tests/integration/sso-claude-plugin.test.ts` — real install into a temp target; line 298 asserts a repeat `install()` returns `already_exists`.
- `src/providers/core/__tests__/providers-core.test.ts:340-372` — `beforeRun` with a mocked installer.

### Testing Framework and Patterns

- Vitest, projects `unit` (`src/**/*.test.ts`), `cli`, `agent`; `vitest.config.ts` sets `CODEMIE_HOME` for all of them.
- Harness: real `mkdtemp` dirs, `vi.resetModules()` + `vi.doMock('…/utils/processes.js')`, dynamic import, inline subclass of `BaseExtensionInstaller`.
- Platform simulation: `vi.spyOn(process, 'platform' | 'execPath' | 'argv', 'get')`.
- The 006 test mocks the logger so an open log handle does not block temp-dir removal on Windows.

### Coverage Gaps

- No test exercises hooks on the `already_exists` path, an installed file holding an old absolute path, or a "no write when identical" case.
- No test asserts an `args` field or exec-form entry.
- No unit test runs `ClaudePluginInstaller` against real files.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_CLAUDE_EXTENSION_DIR` — set from `install()`'s `targetPath`, consumed as `--plugin-dir`.
- `CODEMIE_HOME` — honoured by `getCodemiePath()` (`src/utils/paths.ts:368`), so migration 006 follows it; `ClaudePluginInstaller.getTargetPath()` uses `homedir()` and does not.

### Configuration Files

- `src/agents/plugins/claude/plugin/.claude-plugin/plugin.json` — version that gates copy/update.
- `src/agents/plugins/claude/plugin/.claude-plugin/local-install.json` — local copy of `sound/**` only; hooks are not part of it.

### Feature Flags and Deployment Concerns

- No feature flag or secret in this area.

---

## 6. Risk Indicators

- Shared base: `install()` / `localizeInstalledHooks()` serve Claude, Gemini and Kimi. Speculative: per-launch logic without a Claude-only seam would also run for Gemini (must stay unchanged) and Kimi (no hooks file, a warning every launch).
- `process.argv[1]` during a launch is the agent launcher (e.g. `bin/codemie-claude.js`), not `bin/codemie.js`; the existing win32 fallback in `resolveCodemieBinary` would emit `node …/codemie-claude.js hook`. Speculative: the exec-form script path needs a source other than argv[1].
- Open scope. Speculative: whether the every-launch refresh also applies to Claude on macOS/Linux, where content must stay identical.
- Migration 006 shares the helpers; it leaves a `command` holding a node.exe path untouched and never reads `args`.
- Three production call sites reach the Claude installer (Section 2); logic placed in one caller misses the others.
- Order-sensitive `fs/promises` mocks in `plugin-installer.test.ts` and `gemini.extension-installer.test.ts`, plus `sso-claude-plugin.test.ts:298`, pin the current `already_exists` behaviour.
- Unit tests run on Linux and Windows CI; win32 behaviour must be simulated with spies and expected paths derived, not literal.
- Exec-form hooks are undocumented in the repo; the task description is the only source for the format.

---

## 7. Summary for Complexity Assessment

The change spans three layers: the shared hook-command utility (`src/utils/hook-command.ts`), the agent-core installer base (`BaseExtensionInstaller.ts`) and the Claude plugin installer. Provider-layer callers already run `install()` on every launch and swallow failures. The production surface is a handful of files, with more test files than source files around them; the bundled template is small and regular (11 entries, two argument shapes).

Novelty is moderate: every existing rewrite produces a shell-form `command` string, nothing reads or writes `args`, and nothing touches hooks on the `already_exists` path. A precedent exists for resolving `bin/*.js` from the compiled module with `process.execPath`.

Current behaviour is well tested with a reusable temp-dir harness and platform spies, but repeat-launch hook handling has no coverage. Main risks are regressions in the non-Windows, Gemini and Kimi paths through the shared base, and order-sensitive installer tests.

---

## 8. External References

None named by the task.
