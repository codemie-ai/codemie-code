# Technical Research

**Task**: self-update cli-updater npm-prefix PATH
**Generated**: 2026-11-07
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16080: after `codemie self-update` (non-silent updateCli in src/utils/cli-updater.ts), verify the first `codemie` on PATH runs the just-installed version; if not, print a clear warning (active binary path, old version, how to fix) instead of the unconditional "takes effect on next command". Cross-platform (POSIX which / Windows where.exe). The spawned child (`<path> --version`) must not trigger the CLI's own auto-update. Silent auto-update (updateCli(..., silent=true)): debug log only. Exit code stays 0. Ticket: after self-update installs the new version in npm's global prefix, an older install earlier in PATH (e.g. ~/.codemie/npm-prefix/bin, %LOCALAPPDATA%\CodeMie\npm-prefix) keeps being run, while the CLI prints "updated successfully / takes effect on the next command". Acceptance (ticket 'Expected result'): the next `codemie` uses the updated version OR self-update updates the active install OR reconciles PATH OR clearly warns that the old version will still be used. We chose the 'clearly warn' option.

(Additional instructions given with the task: do not modify source files; do not touch `.codemie/codemie-cli.config.json`; target repo is `C:/Repositories/codemie-code-dzmitry-halai - Copy`.)

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A: tell the user, after a self-update, which `codemie` will run next (and warn if it is stale).**
- Today only an unconditional message: `src/utils/cli-updater.ts:301-306` prints "updated successfully", `Current version: <latest>`, and "The update will take effect on the next command." Nothing checks PATH. Same text is shown for every non-silent success. Silent branch (`:297-299`) is `logger.debug` only.
- `updateCli(latestVersion, silent=false)` (`cli-updater.ts:283`) callers: `src/cli/commands/self-update.ts:56` (`silent=false`, then prints auto-update status lines `:58-65`); `cli-updater.ts:380` (silent=true, auto mode, under update lock); `cli-updater.ts:411` (silent=false, prompt mode `CODEMIE_AUTO_UPDATE=false`, followed by `process.exit(0)` at `:414`). So the non-silent success path runs from two entry points: the `self-update` command and the start-up prompt flow.
- Failure path (`cli-updater.ts:308-328`) prints `npm install -g @codemieai/code@<v> [--prefix "<p>"]` using `getNpmPrefixArgs()`; rethrows. Exit code is 1 in `self-update.ts:68-69`. Only the success path is in scope.
- Related diagnostics already existing: `NpmPrefixOverrideCheck` (`src/cli/commands/doctor/checks/NpmPrefixOverrideCheck.ts:12-51`) warns when the user `.npmrc` redirects the global prefix to the legacy prefix and prints manual fix steps (`npm config delete prefix --location user`, list/reinstall packages). Wording and legacy-path helper `getLegacyNpmPrefixPath()` (`src/utils/npm-prefix.ts:78`: `%LOCALAPPDATA%\CodeMie\npm-prefix` win32, `~/.codemie/npm-prefix` otherwise) match the paths named in the ticket. `install/README.md:106-110` documents the same legacy prefix and "rerun the installer" remedy; `install/windows/install.ps1:265` and `install/macos/install.sh:9-10` still create/handle the `npm-prefix` dir.

**Purpose B: know where the update was installed (to compare with the first `codemie` on PATH).**
- `installGlobal` (`src/utils/processes.ts:287-324`) runs `npm install -g [--prefix <p>] --force @codemieai/code@<v>` with `shell: isWindows`, timeout 60000 from `updateCli`. The prefix arg comes from `getNpmPrefixArgs()` (`src/utils/npm-prefix.ts:151-163`): `[]` when the running copy lives in npm's global prefix, is a dev checkout / `npm link`, or either prefix is unresolvable; otherwise `['--prefix', <running copy's prefix>]`. So the install target is "running copy's prefix, else npm global prefix" - not always "npm global".
- `getCodemieNpmPrefix()` (`npm-prefix.ts:44-71`) derives the prefix from the running package location (`<prefix>\node_modules\@codemieai\code` win32, requires `<prefix>\codemie.cmd` to exist; `<prefix>/lib/node_modules/@codemieai/code` POSIX); `null` for dev/link. `getCodemieOrGlobalNpmPrefix()` (`:141`) exported and used by `cli-bin.ts:36`. `getGlobalNpmPrefix()` (`:99`) is **not exported** (module-private, memoized `npm prefix -g`).
- The "just-installed version" is the `latestVersion` argument of `updateCli`; the running (old) version is `getCurrentCliVersion()` (`cli-updater.ts:44`, reads `../../package.json` relative to the running file).

**Purpose C: find the first `codemie` on PATH, cross-platform.**
- `getCommandPath(command)` (`src/utils/processes.ts:48-72`): POSIX `which <cmd>`; Windows `C:\Windows\System32\where.exe $PATH:<cmd>` (the `$PATH:` prefix stops where.exe searching cwd first). Returns the **first** line only; `null` on non-zero exit or exception. `commandExists` (`:28`) is the boolean sibling. No variant returns all matches; no `which -a` usage anywhere in `src`.
- Windows quirk already handled elsewhere: `where codemie` returns npm's extensionless sh shim first; `resolveBinary()` in `src/utils/hook-command.ts:64-74` swaps to `<path>.cmd` when `existsSync(<path>.cmd)` so PowerShell/spawn can run it. Same file rejects shimmed bundled-agent paths via `isShadowedCodemieShim` (`:27`). Other callers of `getCommandPath('codemie'-like)`: `src/cli/commands/mcp/index.ts:8` (`codemie-mcp-proxy`), `BaseAgentAdapter.ts:860`, `installation-detector.ts:28`, `kimi.plugin.ts:248`.
- Separate Windows helpers in `src/utils/windows-path.ts`: `findCommandDirectory` (`:124`, `where.exe` via `getWindowsSystem32()` which honors `SystemRoot`, `:27`), registry PATH reading (`isInUserPath`, `:165`) and PATH writing (`addToUserPath`, `:219`, setx, 1024-char limit). These are for the "reconcile PATH" option; the task chose warn-only.

**Purpose D: run `<path> --version` safely and read the version.**
- `exec(command, args, {cwd, env, timeout, shell, interactive})` (`src/utils/exec.ts:36-141`): `env` merged over `process.env` (`:74`); `shell: true` merges args into one command string, quotes only args (not the command) (`:60-71`); `windowsHide` on win32; resolves `{code, stdout, stderr}` (trimmed); **rejects** on spawn error, signal exit, or timeout (`:134-139`, `child.kill()`; with `shell:true` on Windows this kills the cmd.exe, not necessarily the node grandchild). Non-zero exit resolves, caller checks `code`.
- Precedents for version probing: `native-installer.ts:140-190` (private `verifyInstallation`: `exec(cmd, ['--version'], {timeout: 5000, shell: path contains / or \\})`, regex `v?(\d+\.\d+\.\d+)`, swallowed errors logged via `sanitizeLogArgs`); `BaseFrameworkAdapter.ts:33`, `kimi.plugin.ts:155,166`, `claude-code-otlp/client-version-cache.ts:39`.
- `codemie --version` output is commander's bare version: `src/cli/index.ts:61-64` (`.version(version)` from package.json). `codemie version` subcommand also exists (`COMMANDS.md:1587`, prints more fields).
- Version comparison: `compareVersions`, `isValidSemanticVersion` in `src/utils/version-utils.ts:58,79` (already used by `cli-updater.ts:23`).

### Decisions Already in the Code

- **`codemie --version` does run the start-up update flow.** `bin/codemie.js:26-73`: the update check is skipped only when `isHookProcess` (argv[2] is `hook`/`sound`), `isMachineOutput` (`--json`/`--json=` in argv before `--`, `src/utils/machine-output.ts:13-24`), or `NODE_ENV==='test'` / `VITEST==='true'` (`:66`). `--version` is not in any skip list (it is only in `OUTPUT_CONTRACT_ARGS` of `whatsnew.ts:237`, which suppresses only the what's-new notice). `docs/COMMANDS.md:1263-1273` documents `codemie --version` as an update-check trigger. Commander parses `--version` later (`cli/index.ts`), after the update step.
- **Ways to keep a child from updating, as they exist today:**
  - `NODE_ENV=test` or `VITEST=true` in the child env: skips update check *and* what's-new. `NODE_ENV` is otherwise read in one non-test place only (`src/utils/profile.ts:135`, `production`). Migrations still run (non-silent unless hook/json).
  - `CODEMIE_AUTO_UPDATE=false` does **not** disable: it switches to the interactive inquirer **prompt** (`cli-updater.ts:388-389`); `parseBooleanEnv` (`src/utils/env.ts:12`) treats any non-true value as false.
  - `CODEMIE_UPDATE_CHECK_INTERVAL` is parsed at module load (`cli-updater.ts:30-33`, `parseInt(... || '86400000')`) and compared only when `.last-update-check` exists and parses (`:79-93`; missing/invalid file => check proceeds). A huge value therefore only suppresses the check if the timestamp file is present.
  - `--json` in the child argv would skip it via `isMachineOutputInvocation`, but `--json` is not a documented flag of `--version`; unverified how commander treats `--version --json` (not exercised).
  - No dedicated "skip update" env var exists (`CODEMIE_AUTO_UPDATE`, `CODEMIE_UPDATE_CHECK_INTERVAL` are the only update env vars in `src`, plus `NODE_ENV/VITEST` in `bin`).
- **What an unguarded child would do** (facts): the `self-update` command's `checkForCliUpdate()` does not call `recordUpdateCheck()` (only `checkAndPromptForUpdate` does, `:360`), so `.last-update-check` may be old or absent; an *older* binary found on PATH would then run `npm view` (5 s) and, in default auto mode, `installGlobal` into **its own** prefix (silent, 60 s) before answering `--version`. In prompt mode, the parent flow (`:401-411`) holds the update lock while `updateCli` runs; a child in auto mode would fail `acquireUpdateLock()` and skip, but in prompt mode with no TTY it would hit inquirer. Also existing: `process.exit(0)` at `:414` sits inside `try/finally`, so `releaseUpdateLock()` (`:416`) does not run on that path (lock goes stale after `UPDATE_LOCK_STALE_MS` = 10 min, `:39`).
- **Error/log conventions (guides + code):** `.ai-run/guides/development/development-practices.md` - use `exec()` from `exec.ts`, never `child_process.exec`; `logger.debug()` for internal details (file only; debug on stderr with `CODEMIE_DEBUG=true`), `logger.warn()` prints to console; `sanitizeLogArgs()` before logging objects (`src/utils/security.ts:388`); no raw `console.log` for debug; specific error classes; path/`Defensive null return` pattern for post-install version calls (guide lines 54-77: wrap version probe in try/catch, return `null`, degrade). Security guide: validate paths from outside, never log secrets. In `cli-updater.ts` user-facing text is `console.log(chalk.*)` and diagnostics are `logger.debug/error` - the module's established split.
- **Imports:** ESM with `.js` extension; `cli-updater.ts` uses relative imports (`./processes.js`, `./npm-prefix.js`, `./paths.js`) while `npm-prefix.ts`/`cli-bin.ts` use the `@/utils/...` alias. Windows hard-codes `C:\Windows\System32\where.exe` in `processes.ts:32,52` (vs `getWindowsSystem32()` in `windows-path.ts`).
- **Docs say** (`docs/COMMANDS.md:1304`, `docs/CONFIGURATION.md:215-230`) "The update takes effect on the next command execution" - matches the message the task replaces.

### Task Statements Checked Against the Code

- "non-silent updateCli in src/utils/cli-updater.ts ... unconditional 'takes effect on next command'" - **holds** (`cli-updater.ts:305`).
- "Silent auto-update: debug log only" - **holds as current behavior** for success (`:297-299`); the new check would be an addition there.
- "Exit code stays 0" - **holds** for the success path: `self-update.ts` returns normally; the prompt-mode path calls `process.exit(0)` (`cli-updater.ts:414`).
- "The spawned child must not trigger the CLI's own auto-update" - **the risk is real**: `bin/codemie.js:67-73` runs `checkAndPromptForUpdate` for `--version` (see Decisions). The suppression mechanism is not yet present; options that exist are listed above.
- "self-update installs the new version in npm's global prefix" - **partially contradicted**: install goes to the running copy's prefix when it differs from npm global (`getNpmPrefixArgs`, `npm-prefix.ts:151-163`), otherwise global. The stale-PATH scenario therefore arises when the running copy is outside a recognizable layout (`getCodemieNpmPrefix()` null, e.g. no `codemie.cmd` at the win32 prefix) or the process was started via a path other than the first PATH entry.
- "older install earlier in PATH (e.g. ~/.codemie/npm-prefix/bin, %LOCALAPPDATA%\CodeMie\npm-prefix)" - **holds** as the legacy prefix locations (`npm-prefix.ts:78-83`, `install/README.md:106-110`). The win32 legacy prefix is the prefix itself (`codemie.cmd` at its root), not `\bin`; POSIX is `<prefix>/bin`.
- "Cross-platform (POSIX which / Windows where.exe)" - **holds**: `getCommandPath` already does this (`processes.ts:48-72`), first match only.
- "how to fix" hint - the repo already has fix text for the same situation: doctor npm-prefix check steps, `install/README.md` rerun-installer guidance; no existing text names a PATH-reordering step.

### Consumers of Changed Contracts

Contracts the task touches or may touch: the console output of `updateCli` (non-silent), `updateCli` signature/behavior, and any helper added to / changed in `processes.ts`/`npm-prefix.ts`.
- `updateCli` callers: `self-update.ts:56`, `cli-updater.ts:380`, `:411`. Output consumers: none programmatic found (no script or test parses "takes effect"; searched `src`, `tests`). `tests/integration/cli-commands/self-update.test.ts` only runs `self-update --check`; `tests/e2e/subscription-analytics/*` mention self-update (not read in detail).
- `getCommandPath`/`commandExists` (if reused unchanged): 10+ production callers (listed in Purpose C and `sound.ts:61`, `opencode.plugin.ts:532`, `codex.plugin.ts:455`, `copilot-cli.plugin.ts:406`, `BaseAgentAdapter.ts:282`). Any change in return shape (e.g. all matches) would reach all of them.
- `getCodemieNpmPrefix` / `getNpmPrefixArgs` / `getCodemieOrGlobalNpmPrefix`: consumers `cli-updater.ts:22,320`, `processes.ts:14` (install/uninstall/list), `cli-bin.ts:14,36`, `NpmPrefixOverrideCheck.ts:5`. Exporting the private `getGlobalNpmPrefix` would add, not change, a contract.
- `exec`'s timeout rejection and Windows `shell:true` command-quoting behavior (`exec.ts:60-71`): shared by all callers; command (as opposed to args) is not quoted, so a PATH result with spaces needs caller-side quoting (precedent `BaseAgentAdapter.ts:863`, `hook-command.ts:40-42`).
- Update env contract (`CODEMIE_AUTO_UPDATE`, `CODEMIE_UPDATE_CHECK_INTERVAL`): documented in `docs/CONFIGURATION.md:215-216`, `docs/COMMANDS.md:1287-1290`; a new suppression env var would be a new documented contract (none exists).

### Architecture and Layers Affected
- Utils layer: `src/utils/cli-updater.ts` (message/branch), `src/utils/processes.ts` (PATH lookup, exec), `src/utils/npm-prefix.ts` (prefix resolution), `src/utils/exec.ts`.
- CLI layer: `src/cli/commands/self-update.ts` (caller; prints auto-update status after `updateCli`).
- Entry wrapper: `bin/codemie.js` (decides whether a child `--version` updates).
- Docs: `docs/COMMANDS.md` self-update section, possibly `docs/CONFIGURATION.md`.

### Integration Points
- `cli-updater.ts` -> `processes.ts` (`installGlobal`, `getLatestVersion`) -> `exec.ts`; `cli-updater.ts` -> `npm-prefix.ts` (`getNpmPrefixArgs`) -> `exec.ts`, `paths.ts` (`isSamePath`, `getDirname`), `platform.ts` (`isWindows`, `getPathModule`).
- External: `npm` (`install -g`, `view`, `prefix -g`, `config get userconfig`), `which` / `where.exe`, the stale `codemie` binary on PATH.

### Patterns and Conventions
- Module split of console vs logger output in `cli-updater.ts` (chalk `console.log` for users, `logger.debug` for diagnostics; error branch logs `logger.error` then prints).
- Defensive "never throw, degrade" for version probes (guide pattern; `hook-command.ts` "Never throws").
- Platform parameter injection for testability: `getCodemieNpmPrefix(packageDir, platform)`, `getLegacyNpmPrefixPath(platform)`, `isSamePath(a, b, platform)`, `isWindows(platform)`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/development/development-practices.md` (P0 for `cli`/`error`): exec/logging/error rules above.
- `.ai-run/guides/security/security-practices.md`: sanitization (`sanitizeLogArgs`), path validation.
- `.ai-run/guides/testing/testing-patterns.md`, `quality-gates.md`: Vitest, dynamic-import mocking (not re-read; referenced by AGENTS.md). `.ai-run/guides/usage/project-config.md` covers env vars/paths.
- `docs/COMMANDS.md:1235-1304` (self-update behavior, env vars), `docs/CONFIGURATION.md:215-230`, `install/README.md:80-110` (legacy prefix).

### Architectural Decisions
- Prior task analyses in `docs/superpowers/tasks/2026-09-30-no-self-update-in-connect/` (Connect installs never self-update; guard sits at top of `checkAndPromptForUpdate`) and `2026-09-28-epmcdme-15307/` (npm prefix work) - same module, same conventions.
- Inline: `cli-updater.ts` header documents env vars (`:7-12`); `// CONCURRENCY FIX`, `// PERFORMANCE FIX` markers on lock/rate limit.

### Derived Conventions
- Warnings for the user go to `console.log`/`console.error` with chalk (`chalk.yellow` for warnings, `chalk.dim` for hints, `chalk.white` for commands, `cli-updater.ts:316-326, 392-395, 404`).

---

## 4. Testing Landscape

### Existing Coverage
- `src/utils/__tests__/cli-updater.test.ts`: `updateCli` failure-path output (prefix in manual command), Connect detection, `checkAndPromptForUpdate` Connect guard. **No test of the non-silent success output.**
- `src/utils/__tests__/utils-misc-coverage.test.ts:326-489`: `isAutoUpdateEnabled`, `getCurrentCliVersion`, `checkForCliUpdate`, rate limit, silent auto-update (`installGlobal` mocked), prompt-decline; env snapshots; temp `CODEMIE_HOME`.
- `src/utils/__tests__/npm-prefix.test.ts` (prefix derivation per platform with `fs` mocked), `processes.test.ts:390+` (`getCommandPath` with `where.exe` \r\n and multi-path output, POSIX `which`, null), `hook-command.test.ts` (mocks `../processes.js` with `getCommandPath`), `cli-bin.test.ts`, `doctor-checks.test.ts` (NpmPrefixOverrideCheck).
- `src/cli/commands/__tests__/self-update.test.ts`: Connect case only, mocks `cli-updater.js` with `{isCodemieConnectInstall, checkForCliUpdate, updateCli, isAutoUpdateEnabled}`.
- `tests/integration/cli-commands/self-update.test.ts`: spawns `bin/codemie.js self-update --check` (network).
- No test of `bin/codemie.js` update gating found.

### Testing Framework and Patterns
- Vitest; dynamic import after mocks; `vi.mock` factories with explicit export lists. **`cli-updater.test.ts` mocks `../processes.js` (only `installGlobal`, `getLatestVersion`), `../npm-prefix.js` (only `getNpmPrefixArgs`), `../paths.js` (only `getCodemiePath`) with full-replacement factories**; any new import from these modules inside `cli-updater.ts` is missing from those mocks. `utils-misc-coverage.test.ts` instead spreads `importOriginal()` over `processes.js`, and mocks `os.platform` via a hoisted fn.

### Coverage Gaps
- Non-silent `updateCli` success output; PATH/version comparison logic; child `--version` spawn behavior; `bin/codemie.js` skip conditions for `--version`; Windows `.cmd`/extensionless shim and paths with spaces.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_AUTO_UPDATE` (default true; false = prompt) `cli-updater.ts:169-171`.
- `CODEMIE_UPDATE_CHECK_INTERVAL` (ms, default 86400000, read at module load) `:30-33`.
- `NODE_ENV=test` / `VITEST=true`: skip update check and what's-new in `bin/codemie.js:66`.
- `CODEMIE_HOME` (via `getCodemiePath`, `.last-update-check`, `.update-lock`). `CODEMIE_DEBUG=true` shows debug logs on stderr. `LOCALAPPDATA`, `HOME` for legacy prefix. `SystemRoot` used by `windows-path.ts:27` only. `CODEMIE_NPM_PREFIX` is read by `install/macos/install.sh`.

### Configuration Files
- `~/.codemie/.last-update-check`, `~/.codemie/.update-lock` (state, not config); user `.npmrc` `prefix` (legacy override, `getUserNpmrcPrefix` `npm-prefix.ts:125`).

### Feature Flags and Deployment Concerns
- CodeMie Connect installs bypass self-update entirely (`isCodemieConnectInstall`, `cli-updater.ts:64`; `self-update.ts:20`). No other flags. Installers: `install/windows/install.ps1`, `install/macos/install.sh`.

---

## 6. Risk Indicators

- Child `codemie --version` re-enters `bin/codemie.js` and the full start-up flow (migrations, update check, what's-new); no dedicated skip switch exists, `CODEMIE_AUTO_UPDATE=false` makes it prompt, and an older stale binary can self-install into its own prefix (see Decisions Already in the Code).
- Speculative: `NODE_ENV=test`/`VITEST=true` are the only existing env-based skip, a reuse of test-only gates in production; side effects of `NODE_ENV=test` on the stale (possibly much older) binary are unverified.
- Windows: `getCommandPath('codemie')` returns the extensionless sh shim first; spawning it needs the `.cmd` swap (`hook-command.ts:67-69`) and, via `exec`, `shell:true` plus caller-side quoting of paths with spaces; `exec` timeout does not reliably kill the grandchild under cmd.exe.
- `getCommandPath` returns the first match only and swallows all errors to `null`; "which binary is first" is answerable, "all earlier installs" is not with current helpers.
- `getGlobalNpmPrefix` is module-private in `npm-prefix.ts`; the install target is "running copy's prefix, else global" (not always global), which the ticket text does not state.
- Existing test mocks for `cli-updater.ts` are full-replacement factories (processes, npm-prefix, paths); new imports in `cli-updater.ts` need those mocks extended or the suites fail.
- Prompt-mode path `process.exit(0)` skips the `finally` lock release (`cli-updater.ts:414-416`); a child process launched from there starts while that lock is held.
- Two non-silent call sites (`self-update.ts:56`, `cli-updater.ts:411`) mean a message change in `updateCli` affects both; the prompt-mode caller exits right after.
- Docs (`COMMANDS.md:1304`, `CONFIGURATION.md`) repeat the "takes effect on next command" claim.
- No guide covers PATH resolution/version-probe patterns; conventions derived from `hook-command.ts`, `native-installer.ts`, and `processes.ts`.

---

## 7. Summary for Complexity Assessment

The change sits in the utils layer: a conditional added to the non-silent success branch of `updateCli` (`src/utils/cli-updater.ts:297-307`) that resolves the first `codemie` on PATH (existing `getCommandPath`, POSIX `which` / Windows `where.exe $PATH:`), probes `<path> --version` through `exec`, and compares with the version just installed (`version-utils.ts`). Prefix helpers for "where did the install go" exist in `npm-prefix.ts` (one is private). Callers are `self-update.ts` and the prompt-mode start-up flow; no programmatic consumer of the current message was found. Expected file surface is small (cli-updater.ts plus possibly processes.ts/npm-prefix.ts, one doc paragraph), with new unit tests in an area that currently has no coverage for the success path.

Technical novelty is low-moderate: all building blocks exist, but the no-auto-update requirement for the child is a real constraint, since `bin/codemie.js` runs the update check for `--version` and the only existing skip mechanisms are the test-env flags, the `--json` argv, and hook argv; `CODEMIE_AUTO_UPDATE=false` prompts instead of skipping. Windows adds the extensionless shim, `.cmd`/shell, and quoting concerns already solved piecemeal in `hook-command.ts` and `BaseAgentAdapter.ts`.

Test posture: the touched module has partial unit coverage with full-replacement mocks that new imports would break; the success output and PATH logic have none. Key risk factors: child process side effects (self-update by a stale binary, prompt, lock), Windows spawning, first-match-only PATH lookup, and the install-target nuance (running prefix vs global) behind the ticket's scenario.

---

## 8. External References

None named by the task. (Ticket EPMCDME-16080 text is quoted in Section 1; no file, directory, or URL was given as a source of truth. The Jira ticket itself was not fetched.)
