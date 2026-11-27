# Technical Research

**Task**: pi install exec windows
**Generated**: 2026-11-19
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-16982 — Windows: codemie install pi fails with spawn pi ENOENT because the Pi package-install exec() omits shell:true/.cmd resolution.

Root cause claimed: `installRequiredPiPackages` (`src/agents/plugins/pi/pi.packages.ts`) calls exec(cliCommand, 'install', pkg, { cwd, timeout }) with no `shell` option. `exec()` (`src/utils/exec.ts:42-50`) only sets `shell: true` when explicitly passed; no path/extension resolution. `cliCommand` is literal `'pi'` (`pi.plugin.ts:171,516`), never resolved to `pi.cmd`. npm/npx spawns (`src/utils/processes.ts`) pass `shell: isWindows`. Installer also re-runs package install when Pi already installed (`install.ts:137-139,166-168` call `additionalInstallation` in "already installed" branches; `PiPlugin.additionalInstallation` has no skip). Related "Unknown provider codemie-anthropic" fixed by PR #485; out of scope.

Suggested fix: pass `shell: true` (or resolve `.cmd`) when exec'ing `pi`; also skip `additionalInstallation` when Pi already installed.

Extra constraint from the user: they run the prod version of codemie on this machine, so any change/verification must not break or modify their installed environment (no global installs/npm link, don't touch ~/.codemie or the global npm prefix). Flag any such risk (including other callers of exec() a change to exec() would affect, and other plugins with the same Windows .cmd problem).

---

## 2. Codebase Findings

### Existing Implementations

Purpose: run `pi` (a `.cmd` shim on Windows) as a child process.
- `src/agents/plugins/pi/pi.packages.ts:35` — `exec(cliCommand, ['install', pkg], {cwd, timeout})`, no `shell`. Wraps any throw in `AgentInstallationError('pi', 'Failed to install Pi package ...: <msg>')` (l.39-45). `REQUIRED_PI_PACKAGES` = `git:github.com/obra/superpowers`, `npm:pi-subagents` (l.5). Superpowers is first, so it is the step that fails. Only caller: `pi.plugin.ts:501`.
- `src/utils/exec.ts:36-141` — `useShell` is `false` unless `options.shell` set (l.47-50). Doc comment (l.29) claims "On Windows, resolves full path" but no such resolution exists. With shell true and args, args are joined into one string, quoting args containing space, `"`, or (Windows) `& | < > ^ % ( ) [ ] { }` (l.60-71). Note `:` and `/` in `git:github.com/obra/superpowers` are not quoted and are safe. Errors are rewrapped as `Failed to execute ${command}: ${error.message}` (l.106), matching the ticket text.
- `src/agents/plugins/pi/pi.plugin.ts:184` — `cliCommand: process.env.CODEMIE_PI_BIN || 'pi'` (a different line than the ticket's 171/516). Override may be a path containing spaces; with shell:true and no args-quoting of the command itself, a path with spaces would break (command is not quoted by exec).

Purpose: do the same for other `.cmd`-shim commands (the "pattern" the ticket cites).
- `src/utils/processes.ts:315,365,411,451,487,535` — `shell: isWindows` for npm/npx. `src/utils/npm-prefix.ts:114` — same. `src/cli/commands/doctor/checks/PythonCheck.ts:83` — same.
- `src/agents/core/BaseAgentAdapter.ts:936` — the agent *run* path spawns with `shell: isWindows` (so running pi works; only install/version paths lack it).

Purpose: decide whether an agent is installed / skip redundant work.
- `BaseAgentAdapter.isInstalled` (l.274-286) uses `commandExists` (`processes.ts:28-40`, `where.exe $PATH:<cmd>`), which works for `.cmd` shims (so the `where` check passes while the spawn fails).
- `BaseAgentAdapter.getVersion` (l.297) does `exec(cliCommand, ['--version'])` with no shell and swallows errors -> returns null on Windows for `pi`. Pi has no override of getVersion (not checked in depth; no grep hit for override in pi.plugin.ts around the metadata).
- `src/cli/commands/install.ts:128-171` — if installed: when a version is requested and equals installed (l.133-141) or no version requested (l.161-170), prints "already installed" and calls `agent.additionalInstallation(options)` then returns. A third call is after a fresh install (l.221-223). Default comment: "Run additional installation steps (e.g., sounds)" — the hook is deliberately run in the already-installed branch (also used by Claude: `claude.plugin.ts:963`, sounds). For Pi, no version is defaulted (only claude/codex, l.120), so plain `codemie install pi` with Pi present takes the l.161-170 branch.
- `additionalInstallation` signature: `types.ts:813`; default no-op `BaseAgentAdapter.ts:266`; options type `AgentInstallationOptions` (passed but unused by Pi, `pi.plugin.ts:498-502`). Options contents were not inspected for a "was freshly installed" signal.

### Decisions Already in the Code
- `exec()` defaults to `shell:false` for security and DEP0190; callers opt in per call (comments `exec.ts:44-46`, `processes.ts:31`). Callers needing `.cmd` pass `shell: isWindows`.
- `additionalInstallation` runs in already-installed branches by design (sounds example). Alternative (skip) none found recorded.
- Docs: `docs/superpowers/specs/2026-08-07-codemie-pi-required-packages-design.md` and plan of the same date describe the installer; neither mentions Windows. Prior task `2026-10-27-epmcdme-16292-...` plan.md:28 says make no speculative changes to `pi.packages.ts` (scoped to that task).

### Task Statements Checked Against the Code
- "pi.packages.ts ~lines 25,36-39 omit shell": holds (actual lines 24, 35-38).
- "exec() only sets shell:true when caller passes it, no resolution": holds (`exec.ts:47-50`); its doc comment claiming resolution is stale.
- "cliCommand is 'pi' never resolved to pi.cmd (pi.plugin.ts:171,516)": holds in substance; metadata is at line 184, `CODEMIE_PI_BIN` can override.
- "npm/npx pass shell: isWindows": holds.
- "install.ts:137-139,166-168 call additionalInstallation in already-installed branches": holds; keeps in place an existing, intentional mechanism (sounds for Claude) whose consumers are Claude (`claude.plugin.ts:963`) and Pi. Changing install.ts would affect Claude; skipping inside `PiPlugin.additionalInstallation` would not.
- "installer redundantly re-runs": holds, no skip in Pi plugin.
- Unverified (outside repo): that `pi.cmd` is on PATH under the CodeMie npm prefix and works from PowerShell; no sample in reach.

### Consumers of Changed Contracts
- If `exec()` itself changes default shell behavior (e.g. resolving `.cmd` or defaulting shell on win32), affected callers (all via `exec` from `@/utils/exec.js`): `src/frameworks/plugins/{speckit,graphify,codegraph,codebase-memory,bmad}.plugin.ts`, `frameworks/core/BaseFrameworkAdapter.ts:33,38,69`, `agents/core/BaseAgentAdapter.ts:297`, codex/gemini/kimi/copilot-cli/claude plugin version checks, `claude-code-otlp/client-version-cache.ts:39`, `anthropic-subscription.auth.ts:19,34`, `utils/processes.ts` (where/which/git/ps/npm), `utils/windows-path.ts` (where/reg/setx, comment l.54 relies on shell:false array args), `utils/system-proxy.ts:312`, `native-installer.ts:212,268,342 (shell:false powershell),366-380`, `hooks/executor.ts:452`, `utils/hardware.ts:39`, doctor checks, `opencode.sqlite-reader.ts:127` (SQL passed as arg; shell:true quoting would matter), `identity-resolver.ts`. Several of these deliberately use absolute paths with shell:false; changing the default is a broad blast radius. A change local to `pi.packages.ts` has the single consumer `pi.plugin.ts:501`.
- Other plugins with the same Windows `.cmd` exposure (exec without shell, npm-installed CLIs): the `--version` probes in `BaseAgentAdapter.getVersion` (inherited by all agents not overriding), `codex.plugin.ts:480`, `gemini.plugin.ts:239`, `kimi.plugin.ts:334`, `copilot-cli.plugin.ts:449`, `claude.plugin.ts:774`, `client-version-cache.ts:39`, `anthropic-subscription.auth.ts:19,34`; framework plugins (`graphify`, `codegraph`, `speckit`, `codebase-memory`) calling `pipx`/`pip3`/`specify`/`codegraph`. Some of these may be `.exe`, not `.cmd`; not verified per tool. Claude/kimi have native-path branches. Out of ticket scope, listed for awareness.

### Architecture and Layers Affected
Agent plugin layer (`src/agents/plugins/pi/`), CLI command layer (`src/cli/commands/install.ts`) if the skip is done there, utility layer (`src/utils/exec.ts`) only if the fix is done centrally.

### Integration Points
`pi install <source>` child process (network: git clone from github.com, npm); `AgentInstallationError` (`src/utils/errors.ts`); `os.platform()` used in exec.ts (tests mock `os`/`exec` in other files).

### Patterns and Conventions
`shell: isWindows` with a `.cmd` comment; `@/` alias imports with `.js`; project error classes; `logger` not console (per AGENTS.md).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` referenced by AGENTS.md (architecture, development-practices, testing-patterns, quality-gates); not read in depth for this narrow bug. AGENTS.md: tests only on explicit request; git ops only on explicit request; Pi has no guide coverage (read `src/agents/plugins/pi/` and `docs/superpowers/specs/`).

### Architectural Decisions
Design spec `docs/superpowers/specs/2026-08-07-codemie-pi-required-packages-design.md` (installer runs after npm install; failure throws).

### Derived Conventions
See Patterns above.

---

## 4. Testing Landscape

### Existing Coverage
No test file for `pi.packages.ts` or `exec.ts` found (globbed `*pi.packages*`, `*utils/exec*`). Pi plugin tests: `src/agents/plugins/pi/__tests__/pi.plugin.version-support.test.ts`. Tests that mock exec exist elsewhere (e.g. `src/utils/__tests__/npm-prefix.test.ts`, `identity-resolver.test.ts`, `client-version-cache.test.ts`).

### Testing Framework and Patterns
Vitest; dynamic-import mocking (`vi.mock('@/utils/exec.js')` pattern as in the files above).

### Coverage Gaps
`installRequiredPiPackages` (success, non-zero exit, throw), the shell option, `PiPlugin.additionalInstallation`, and `install.ts` already-installed branches for Pi. `exec()` itself has no unit test.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_PI_BIN` — overrides the Pi cli command (`pi.plugin.ts:184`), flows into `installRequiredPiPackages`.

### Configuration Files
None governing this path.

### Feature Flags and Deployment Concerns
None. Side effects of the code path itself: `pi install` writes to Pi's own settings dir (user-level, e.g. `~/.pi`) and clones git repos; running `codemie install pi` for real modifies the user's installed environment.

---

## 6. Risk Indicators

- User-environment safety: running `codemie install pi`, `npm link`, `npm i -g`, or `pi install` on this machine alters global npm prefix / `~/.pi` / `~/.codemie`. Verification should be via build in-repo (`npm run build`/`typecheck`) and mocked unit tests only, if tests are requested; never invoke the real installer. `getCodemiePath()` paths and the prod `codemie` on PATH must not be touched. Running `bin/codemie.js` from the repo would still read the user's real `~/.codemie`.
- Speculative: changing `exec()` defaults has the broad consumer set in Section 2 (including `windows-path.ts`, `opencode.sqlite-reader.ts`, `native-installer.ts`, which rely on shell:false array-arg semantics); a Pi-local change avoids that.
- Speculative: with shell:true, `exec()` does not quote the command; a `CODEMIE_PI_BIN` path with spaces would break, and args with metacharacters are only partially quoted.
- Existing mechanism kept in place: `additionalInstallation` in already-installed branches (`install.ts`), shared with Claude (`claude.plugin.ts:963`); see Task Statements.
- `BaseAgentAdapter.getVersion` has the same no-shell flaw (returns null on Windows for `.cmd`), which can affect the version-equality branch of install.ts (l.132-141) and `--supported`; outside the ticket text.
- Same `.cmd` exposure in other plugins (Section 2, Consumers).
- No tests around the touched files; Windows-specific behavior depends on `os.platform()` mocking.
- `exec.ts` doc comment is stale (claims Windows path resolution).

---

## 7. Summary for Complexity Assessment

The bug is confined to one call site: `pi.packages.ts:35` calls `exec('pi', ...)` without `shell`, and `exec()` defaults to `shell:false`, so a `.cmd` shim cannot be spawned on Windows. The repo's established pattern for `.cmd` shims is `shell: isWindows`. The redundant-reinstall part touches `PiPlugin.additionalInstallation` (`pi.plugin.ts:498`) or the three `install.ts` call sites; the latter are shared with Claude. Likely file surface: 1-3 files (`pi.packages.ts`, `pi.plugin.ts`, optionally `install.ts`).

There is no technical novelty. The test posture is poor: no tests exist for `pi.packages.ts`, `exec.ts`, or the install branches for Pi. The main risks are scope creep into `exec()` (large consumer set), the same `.cmd` flaw in `getVersion` and other plugins' probes, and the user's machine constraint: verification must not run the real installer or touch the global prefix, `~/.codemie`, or `~/.pi`.

---

## 8. External References

None named by the task.
