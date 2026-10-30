# Technical Research

**Task**: native-installer windows kimi powershell
**Generated**: 2026-10-23
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-15957, Bug: Windows `codemie install kimi` fails with exit code 255 "The syntax of the command is incorrect."
User story: As a developer on Windows 11 I want `codemie install kimi` to install Kimi Code successfully from both PowerShell and Command Prompt.
Root cause per ticket:
- src/utils/native-installer.ts: Windows branch of `buildInstallerCommand` is hard-coded for a batch installer: `curl -fsSL <url> -o install.cmd && install.cmd [version] [flags] && del install.cmd` (designed for Claude's https://claude.ai/install.cmd).
- src/agents/plugins/kimi/kimi.plugin.ts (installer URLs): Kimi's Windows installer is a PowerShell script (https://code.kimi.com/kimi-code/install.ps1), saved as install.cmd and run by cmd.exe -> fails. On Windows the step runs via `cmd.exe /d /s /c` (Node shell:true) from any terminal.
- kimi-acp shares installer config with kimi.
- Kimi install.ps1 (PS 5.1) has no param() block / positional args; version via env KIMI_VERSION (also KIMI_INSTALL_DIR, KIMI_NO_MODIFY_PATH, KIMI_CODE_HOME). Installs to <dir>\bin\kimi.exe, backs up existing exe to .bak, adds bin to user PATH. Documented invocation: `irm <url> | iex`.
- Error reporting gap: installNativeAgent reports only "Installer exited with code N. Output: ..."; failed step/command not included; debug log omits command.
- Cleanup gap: if && chain fails after download, `del install.cmd` skipped -> stray install.cmd. Failed Kimi install after copy step leaves kimi.exe/PATH changes; KimiPlugin.uninstall exists but isn't called on failure.
- Precedent for non-shell PowerShell invocation: src/frameworks/plugins/codebase-memory.plugin.ts (`powershell -NoProfile -ExecutionPolicy Bypass -Command ...` via exec without shell).
Affected: native-installer.ts, kimi.plugin.ts, kimi-acp.plugin.ts, possibly `installerUrls` type in src/agents/core/types.ts; Claude native install shares the Windows path (regression risk).
Acceptance criteria: (1) PowerShell Win11 `codemie install kimi` succeeds; (2) same from cmd; (3) --verbose shows Windows-compatible syntax, no 255 syntax error; (4) kimi-acp same; (5) failure message identifies failed install step / actionable reason; (6) on partial failure no temp installer files left and no partial/incorrectly registered Kimi install; (7) Claude on Windows behaves exactly as before; (8) macOS/Linux unchanged.
Out of scope: changing Kimi distribution, Unix installer behavior/version pinning, Windows CI.
Open questions: honor pinned version (0.42.0) via KIMI_VERSION on Windows or latest only? failure cleanup: uninstall partial or just report? Risks: install.ps1 calls Read-Host on failure which may block until 300s timeout with piped stdin (unverified); fresh install may not be on current process PATH. native-installer.ts has no automated tests today (Kimi plugin test mocks installNativeAgent).

---

## 2. Codebase Findings

### Existing Implementations
- `src/utils/native-installer.ts` (466 lines, TypeScript ESM, tab-indented) — exports `PlatformInstallerUrls {macOS, windows, linux}` (string URLs only), `NativeInstallOptions {timeout, env, verifyCommand, verifyPath, installFlags}`, `NativeInstallResult`, and `installNativeAgent`.
  - `buildInstallerCommand` (l.69-130): validates HTTPS URL, version (semver or latest/stable), flags against whitelist (`--force --silent --yes -y -f --no-progress`). Windows branch (l.115-120) returns `curl -fsSL ${url} -o install.cmd && install.cmd${version}${flags} && del install.cmd`. Unix branch: `curl -fsSL url | bash -s -- args`. Platform selected by URL key only; no per-URL script-type distinction. Indentation of the else branch is inconsistent (cosmetic).
  - `installNativeAgent` (l.275+): runs `exec(command, [], {timeout, env, shell: true})`. Debug log at l.295 deliberately omits the command ("may contain sensitive URLs"). Windows-only retry on execution-policy error via `fixWindowsExecutionPolicy` (runs `powershell -Command Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`), HTML-response detection (message is Claude-specific, region text), then generic error `Installer exited with code ${code}. Output: ${sanitized stderr||stdout}` (l.348-351). After success: Windows `ensureCommandInPath(verifyCommand)` (from `windows-path.js`), then `verifyInstallation` (3 retries on Windows with 1s/2s backoff, `--version`, 5s timeout).
  - Note: `env` option is passed straight to `exec`; whether `exec` merges with `process.env` was not checked (relevant to passing KIMI_VERSION).
- `src/agents/plugins/kimi/kimi.plugin.ts` — `KIMI_INSTALLER_URLS` (l.30-34): windows = `https://code.kimi.com/kimi-code/install.ps1`, others `install.sh`. `KIMI_SUPPORTED_VERSION='0.42.0'`, min `0.16.0`. `installNative` (l.179-224) calls `installNativeAgent(name, installerUrls, version, {timeout:300000, verifyCommand:'kimi', verifyPath: win32 ? undefined : ~/.kimi-code/bin/kimi})`; does not pass `env` or `installFlags`. Throws `AgentInstallationError` on `!result.success` with "Installation failed. Output: ...". `installVersion` (l.336-373): `supported` -> 0.42.0; `npm|latest|stable` -> undefined; semver passed through. `uninstall` (l.238-287) removes `~/.kimi-code/bin/kimi(.exe)`, `~/.local/bin/kimi(.exe)`, PATH binary, empty `~/.kimi-code`, then `super.uninstall()` (npm). It does not touch the user PATH entry added by install.ps1. `isInstalled`/`getVersion` check native path only on non-Windows; Windows relies on PATH (`commandExists`).
- `src/agents/plugins/kimi/kimi-acp.plugin.ts` — spreads `...KimiPluginMetadata` and `KimiAcpPlugin extends KimiPlugin`; so installerUrls/install logic is inherited. No own install code.
- `src/agents/plugins/claude/claude.plugin.ts` — `CLAUDE_INSTALLER_URLS.windows = 'https://claude.ai/install.cmd'` (l.93); calls `installNativeAgent` at l.830 with timeout, verifyCommand, verifyPath (non-Windows). `claude-acp.plugin.ts` and `codex-acp.plugin.ts` set `installerUrls: undefined`. Only Claude and Kimi use `installNativeAgent`.
- `src/agents/core/types.ts` l.243-247 — `installerUrls?: {macOS: string; windows: string; linux: string}` in `AgentMetadata`.
- `src/frameworks/plugins/codebase-memory.plugin.ts` l.42-55 — precedent: `exec('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', "$installer = Join-Path $env:TEMP '...ps1'; Invoke-WebRequest -Uri '<url>' -OutFile $installer; & $installer --ui"], {timeout:300000})`, no shell. Its test asserts these exact args (codebase-memory.plugin.test.ts l.35). Does not clean up the temp file.
- `src/utils/processes.ts` — `exec(command, args, options)` wrapper; Windows npm calls use `shell: isWindows`; comments mention DEP0190 (shell:true with args deprecation) so `exec(cmd, [], {shell:true})` with a full string is the existing pattern for the installer.

### Architecture and Layers Affected
Utility layer (`utils/native-installer.ts`), agent plugin layer (`agents/plugins/kimi`, inherited by `kimi-acp`, `claude`), core metadata types (`agents/core/types.ts`), and CLI `install` command path (via `plugin.installVersion`).

### Integration Points
- `native-installer.ts` imports `processes`, `errors`, `logger`, `security` (sanitizeValue/sanitizeLogArgs), `version-utils`, `windows-path`.
- Kimi/Claude plugins -> `installNativeAgent`; Kimi plugin -> `uninstall`, `commandExists`, `getCommandPath`.
- External: `code.kimi.com` / `claude.ai` installer scripts, PowerShell 5.1, curl.exe on Windows.

### Patterns and Conventions
- Security: HTTPS-only URLs, whitelist validation of version and flags before interpolation into a shell string; output sanitised before inclusion in errors.
- Errors: `AgentInstallationError(agentName, message)`.
- Windows PATH handled by `ensureCommandInPath` then retry-verify.
- The plugin metadata is spread for ACP variants.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` absent at repo root (no such dir listed); `docs/` has `architecture`, `development`, `testing`, `security`, `standards`, plus `docs/specs/claude-version-management/installation-and-versioning.md` (describes native install). Kimi design: `docs/superpowers/specs/2026-06-13-kimi-agent-integration-design.md` and plan `docs/superpowers/plans/2026-06-13-kimi-agent-integration-plan.md`. Prior task analyses touching native-installer: `docs/superpowers/tasks/2026-07-10-epmcdme-12737-windows-special-char-path`, `2026-07-09-force-update-claude-code-cli-tests`, `2026-07-08-epmcdme-10318-fix-version-reporting`. (Those docs were located but not read in depth.)

### Architectural Decisions
Inline comment at native-installer l.116: "Windows CMD command (simpler and more universal than PowerShell)". Type comment l.18 says `windows: // PowerShell script URL`, which contradicts Claude's actual `.cmd` URL.

### Derived Conventions
Plugins pass metadata URLs only; no installer-type or env metadata exists. Tests colocated in `__tests__/` (kimi) or beside source (`*.test.ts`).

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts` — mocks `utils/native-installer.js`; asserts `installNativeAgent` called with `(name, installerUrls, version, expect.any(Object))` for supported/npm/etc. Does not exercise command construction.
- `tests/integration/agent-kimi.test.ts` — integration (not inspected).
- `src/frameworks/plugins/codebase-memory.plugin.test.ts` — asserts PowerShell exec args (model for a Windows test).
- No test file for `native-installer.ts` found (glob for `*native-installer*.test.ts` returned none).

### Testing Framework and Patterns
Vitest (`vitest.config.ts`), `vi.mock` of module boundaries, `vi.fn().mockResolvedValue`. Platform branching is testable by stubbing `process.platform` (not yet done for this module). `buildInstallerCommand` and `detectPlatform` are non-exported.

### Coverage Gaps
`buildInstallerCommand` (all platforms), `installNativeAgent` error paths (policy retry, HTML, generic), cleanup behaviour, Windows PowerShell invocation, Kimi-specific `env`/uninstall-on-failure.

---

## 5. Configuration and Environment

### Environment Variables
Kimi installer (per ticket): `KIMI_VERSION`, `KIMI_INSTALL_DIR`, `KIMI_NO_MODIFY_PATH`, `KIMI_CODE_HOME`. Plugin currently sets none; `NativeInstallOptions.env` exists and is forwarded to `exec`. Runtime envs for Kimi (KIMI_MODEL_*) are unrelated to install.

### Configuration Files
`package.json`, `vitest.config.ts`, `eslint.config.mjs`, `tsconfig.json`. No install-specific config.

### Feature Flags and Deployment Concerns
None found. Timeout is 300000 ms (plugin and default). No Windows CI (out of scope).

---

## 6. Risk Indicators

- Regression: `buildInstallerCommand` Windows branch is shared with Claude (`install.cmd`); any change must keep Claude's command string byte-identical (acceptance 7). `installerUrls` carries no script-type, so the choice between batch and PowerShell must be derived (URL extension) or via new metadata. Speculative: a type change to `installerUrls` would touch `types.ts` and both plugins.
- Command injection surface: current design interpolates validated strings into a `cmd.exe` string; a PowerShell `-Command` string requires its own quoting of URL/version. Version validation (semver/channel) and the flag whitelist already constrain input.
- Speculative: `install.ps1` `Read-Host` on failure could hang until the 300s timeout with piped stdin (unverified per ticket).
- Execution-policy retry logic and the HTML-detection message are Claude-specific/generic; interplay with a PowerShell path (`-ExecutionPolicy Bypass` would make the retry moot) not yet defined.
- Error reporting: the debug log intentionally omits the command; changing that conflicts with the "may contain sensitive URLs" comment (URLs are static HTTPS constants).
- Cleanup: the Kimi `uninstall` does not revert user PATH changes or restore `.bak`; calling it on failure may remove a prior working install (installer backs up existing exe to `.bak`). `isInstalled`/`getVersion` skip the native path on Windows, so a fresh install not yet on PATH may read as "not installed" and verification may fail (`verifyPath` is undefined on Windows for Kimi).
- Windows verify relies on `ensureCommandInPath('kimi')`, whose behavior with `%USERPROFILE%\.kimi-code\bin` was not inspected.
- Zero tests for `native-installer.ts`; non-exported helpers complicate unit testing.
- Pinned version (0.42.0) via `KIMI_VERSION` is an open decision; Unix path passes version as an arg to `install.sh` (out of scope to change).

---

## 7. Summary for Complexity Assessment

The change is concentrated in one utility file (`src/utils/native-installer.ts`: Windows branch of `buildInstallerCommand` and error/cleanup handling in `installNativeAgent`), with probable small touches to `kimi.plugin.ts` (env/version handling, failure cleanup) and possibly the `installerUrls` type in `types.ts`. `kimi-acp` inherits Kimi's metadata and class, so it needs no separate change. Layers: utils, agent plugins, core types.

Technical novelty is moderate: there is an in-repo precedent for non-shell `powershell -NoProfile -ExecutionPolicy Bypass -Command` (codebase-memory plugin), but no existing mechanism distinguishes batch from PowerShell installers, and the Kimi installer takes its version through environment variables rather than arguments. Windows cannot be exercised in CI and the Read-Host and PATH-propagation behaviors are unverified.

Test posture is weak: `native-installer.ts` has no tests, and the Kimi plugin test mocks the installer wholesale, so new unit tests must be created from scratch with platform stubbing. The key risks are the Claude Windows regression, quoting/injection in a PowerShell command string, partial-install cleanup semantics (uninstall may delete a previous working install), and Windows verification without `verifyPath`.

---

## 8. External References

None named by the task (Kimi `install.ps1` behavior is cited from the ticket only; the script itself was not fetched or verified).
