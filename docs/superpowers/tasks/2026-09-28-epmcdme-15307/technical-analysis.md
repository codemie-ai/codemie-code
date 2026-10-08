# Technical Research

**Task**: installer npm-prefix doctor
**Generated**: 2026-09-28
**Research path**: filesystem

---

## 1. Original Context

Fix Jira bug EPMCDME-15307 — the full ticket body (description, repro, root cause, proposed fix, acceptance criteria) is verbatim at docs/superpowers/tasks/2026-09-28-epmcdme-15307/ticket.md. Read it first; it is the task requirements. Summary: install/windows/install.ps1 defaults to portable mode and runs `npm config set prefix <LOCALAPPDATA>\CodeMie\npm-prefix --location user`, silently redirecting ALL global npm installs for the user (breaks npm-installed Claude Code auto-update). Fix: never write prefix to user .npmrc; add auto mode default (npm-global when prefix writable, portable fallback); portable mode should scope prefix to CodeMie via `npm install -g --prefix` and persist that prefix so src/utils/processes.ts installGlobal/uninstallGlobal/list use it for self-update and npm-based agent installs; detect existing override in installer rerun and `codemie doctor` with a warning + fix command; same rule for install/macos/install.sh user-prefix mode; update install/README.md. Also check whether the CodeMie Connect Windows wizard sets the same prefix.

---

## 2. Codebase Findings

### Existing Implementations

- `install/windows/install.ps1` (221 lines) — PowerShell bootstrap.
  - `:3-4` `[ValidateSet('portable','npm-global')] $Mode = 'portable'`.
  - `:120-125` `$InstallRoot` defaults to `$env:LOCALAPPDATA\CodeMie`; `$BinDir = <root>\bin`, `$PrefixDir = <root>\npm-prefix`.
  - `:169-176` portable: creates dirs, then `Invoke-Checked $NpmPath @('config','set','prefix',$PrefixDir,'--location','user')` — the bug.
  - `:178-180` `-ScopeRegistryUrl` also writes `@codemieai:registry` to user config (persistent, user-requested).
  - `:189` `npm install -g $PackageSpec --registry $RegistryUrl` (no `--prefix`; relies on the user config).
  - `:191-218` portable: writes 7 `.cmd` shims in `bin\` that `call` `<PrefixDir>\<cmd>.cmd` (fallback `<PrefixDir>\node_modules\.bin\<cmd>.cmd`), then `Add-UserPath $BinDir` (`:96-118`). `$Commands` list at `:15-23` is hard-coded (no `codemie-codex`, `codemie-kimi`, etc.).
  - Helpers: `Write-Status`, `Invoke-Checked` (honours `-DryRun`), `Get-PackageVersion`, `Add-UserPath`. No prefix read, no detection of prior override, no rollback.
- `install/windows/install.cmd` — downloads `install.ps1` and forwards `%*`; no logic of its own.
- `install/macos/install.sh` (103 lines) — `INSTALL_MODE=${CODEMIE_INSTALL_MODE:-auto}`, `USER_PREFIX=${CODEMIE_NPM_PREFIX:-$HOME/.codemie/npm-prefix}`. `:58-65` auto → `npm-global` if `[ -w "$(npm config get prefix)" ]`, else `user-prefix`. `:69-80` user-prefix runs `npm config set prefix "$USER_PREFIX" --location user` (`:71`) and only prints a PATH hint. `:97` plain `npm install -g`.
- `src/utils/processes.ts`
  - `installGlobal(packageName, options: NpmInstallOptions)` `:142-179` — `exec('npm', ['install','-g',(--force),spec], {cwd, env, timeout, shell: isWindows})`.
  - `uninstallGlobal` `:193-223` — `npm uninstall -g <pkg>`.
  - `listGlobal` `:240-262` — `npm list -g <pkg>`, returns `code === 0`.
  - `NpmOptions` / `NpmInstallOptions` interfaces at `:78-98` (cwd, env, timeout, version, force). No prefix option; nothing reads a persisted install location.
  - `commandExists` / `getCommandPath` `:27-60` (PATH-based `where`/`which`).
- Callers of the npm helpers:
  - CLI self-update: `src/utils/cli-updater.ts:245` (`updateCli`, also prints manual fallback `npm install -g @codemieai/code@<v>` at `:275`); `src/cli/commands/update.ts:216` (built-in agent → `@codemieai/code`) and `:228` (npm agents); `src/cli/commands/self-update.ts` delegates to `updateCli`.
  - Agents: `src/agents/core/BaseAgentAdapter.ts:163,199` (install / installVersion), `:223` (uninstall); `src/agents/plugins/codemie-code.plugin.ts:495,507,512` (`@codemieai/codemie-opencode` + platform pkg).
  - Frameworks: `src/frameworks/plugins/codegraph.plugin.ts:40` (installGlobal), `src/frameworks/plugins/bmad.plugin.ts:172` (listGlobal).
- `BaseAgentAdapter.isInstalled()` `:246-258` uses `commandExists(cliCommand)` — PATH resolution only. Agents installed into a prefix not on PATH are reported "not installed" (consistent with GitHub #493 hypothesis).
- Doctor: `src/cli/commands/doctor/index.ts` builds a fixed `checks: HealthCheck[]` array (`NodeVersionCheck, NpmCheck, PythonCheck, UvCheck, AwsCliCheck, AIConfigCheck, JWTAuthCheck, AgentsCheck, WorkflowsCheck, FrameworksCheck`); barrel `checks/index.ts`. `checks/NpmCheck.ts` (33 lines) only reports `npm.getVersion()`. Result shape `{ name, success, details: [{ status: 'ok'|'warn'|'error'|'info', message, hint? }] }` (`doctor/types.ts`).
- `.npmrc` reading precedent: `src/providers/plugins/sso/proxy/proxy-http-client.ts:139-160` `readNpmNoProxyEntries()` parses `join(homedir(), '.npmrc')` line-by-line (`key=value`, skips `#`/`;`).
- `scripts/postinstall.mjs` — runs `npm config get prefix`, appends `<prefix>/bin` to `~/.zshrc`/`~/.bash_profile` if missing (POSIX `:`-split PATH; effectively no-op-ish on Windows). Would pick up whatever prefix is active.
- `scripts/prepare-install-artifacts.mjs` — copies the three scripts into `artifacts/install/` with version header + sha256; wired to `.github/workflows/publish.yml` (added in #266).
- `src/utils/paths.ts` — `getCodemieHome()` (`CODEMIE_HOME` or `~/.codemie`) and `getCodemiePath(...)`, the standard place for persisted CodeMie state.

### Architecture and Layers Affected

- Distribution layer (outside `src/`): `install/windows/install.ps1`, `install/macos/install.sh`, `install/README.md`.
- Utils layer: `src/utils/processes.ts` npm helpers (+ possibly `src/utils/paths.ts` / config for a persisted prefix).
- CLI layer: `src/cli/commands/doctor/` checks; `update.ts` / `cli-updater.ts` as consumers.
- Agent/framework plugins consume helpers indirectly (no direct change needed unless signatures change).

### Integration Points

- npm CLI (`npm config get/set/delete prefix`, `npm install -g --prefix`), user `%USERPROFILE%\.npmrc` / `~/.npmrc`, Windows user PATH via `[Environment]::SetEnvironmentVariable`.
- Direction: `cli/commands/{update,self-update,install,doctor}` → `utils/processes.ts` → `utils/exec.ts`; `agents/core/BaseAgentAdapter` → `utils/processes.ts`.

### Patterns and Conventions

- Health checks implement `HealthCheck { name; run() }`, exported from `checks/index.ts`, instantiated in `doctor/index.ts`.
- `exec()` from `src/utils/exec.ts` with `shell: isWindows` for npm.
- Errors wrapped via `parseNpmError` (`src/utils/errors.ts`) into `NpmError`.
- Installer output uses `Write-Status '<Name>' '<Value>'` / `status "<Name>" "<Value>"`; every mutation goes through `Invoke-Checked` so `-DryRun` prints it.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/` exist (architecture, development-practices, testing-patterns, project-config); none cover the bootstrap installers or npm prefix handling.
- `install/README.md` is the only installer doc: `:67-74` PowerShell param table (`-Mode` default `portable`), `:76-84` shell env table, `:92-106` "Windows Defaults" / "macOS/Linux Defaults", `:108-158` Connect wizard section; `:143-148` lists `%USERPROFILE%\AppData\Local\CodeMie\npm-prefix` and `%APPDATA%\npm` as PATH entries the wizard adds.

### Architectural Decisions

- Installers introduced in PR #266 (`4b7b35c`, 2026-04-30); later only `a9af611` (#401, Node.js path probing for GUI/wizard callers — comment at `install.ps1:130-131`). No ADR on prefix choice.

### Derived Conventions

- macOS script already embodies the "auto" pattern the ticket asks for on Windows.
- Persisted CodeMie state lives under `getCodemiePath()`; user config via `ConfigLoader` (`.ai-run/guides/usage/project-config.md`).

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/processes.test.ts` — asserts exact argv for `installGlobal` (`['install','-g','test-package']`, `@1.0.0` variant), uninstall, list via `vi.spyOn(exec,'exec')`.
- `src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts` (22 KB) — contract tests for each check; hoisted `vi.mock('@/utils/processes.js')` overriding `exec`.
- Helper consumers mocked in `BaseAgentAdapter.test.ts`, `BaseAgentAdapter.version-notice.test.ts`, `codemie-code-plugin.test.ts`, `codex.plugin.version-support.test.ts`, `cli-misc-coverage.test.ts` (asserts `installGlobal('@google/gemini-cli', {version, force:true})`), `bmad.plugin.test.ts`.

### Testing Framework and Patterns

- Vitest; dynamic `await import()` after mocks; `vi.hoisted` + `vi.mock` factories; exact-argv assertions on `exec`.

### Coverage Gaps

- No tests of any kind for `install/windows/install.ps1`, `install.cmd`, or `install/macos/install.sh` (no Pester/bats; `tests/` has none).
- `NpmCheck` has no prefix-related behavior to test today.

---

## 5. Configuration and Environment

### Environment Variables

- Windows script params: `-Mode`, `-Version`, `-RegistryUrl`, `-ScopeRegistryUrl`, `-InstallRoot`, `-DryRun`. `install.cmd`: `CODEMIE_INSTALL_URL`.
- Shell script: `CODEMIE_INSTALL_MODE` (auto|npm-global|user-prefix), `CODEMIE_NPM_PREFIX`, `CODEMIE_PACKAGE_VERSION`, `CODEMIE_REGISTRY_URL`, `CODEMIE_SCOPE_REGISTRY_URL`.
- Runtime: `CODEMIE_HOME` (paths.ts), `CODEMIE_AUTO_UPDATE` (cli-updater). npm itself honours `npm_config_prefix` env var (npm behavior, not used in repo).

### Configuration Files

- User `.npmrc` (`%USERPROFILE%\.npmrc`, `~/.npmrc`) — mutated by both installers; read by `proxy-http-client.ts` for `noproxy`.

### Feature Flags and Deployment Concerns

- Scripts are served from `main` raw URLs and republished as release artifacts via `prepare-install-artifacts.mjs` / `publish.yml`, so a fix reaches users on merge.
- CodeMie Connect wizard (`install/windows/CodeMie Connect_2.0.1_x64-setup.exe`) is a compressed binary built from a separate repo; grep of the binary found no `npm-prefix`, `config set prefix`, or `install.ps1` strings (packed payload — inconclusive). README says it runs `npm install -g` and adds `...\CodeMie\npm-prefix` to PATH.

---

## 6. Risk Indicators

- Existing portable installs have `codemie` living in `%LOCALAPPDATA%\CodeMie\npm-prefix` with shims in `bin\`; removing the user prefix without migrating means `codemie update`/`self-update` (plain `npm install -g`) installs into `%APPDATA%\npm` while shims keep running the old copy.
- Speculative: persisting a CodeMie-scoped prefix requires `installGlobal`/`uninstallGlobal`/`listGlobal` to pass `--prefix`, but `BaseAgentAdapter.isInstalled()` is PATH-based, so npm agents installed there also need PATH exposure (the shim `bin\` only covers 7 hard-coded commands); this couples to GitHub #493.
- Speculative: every `installGlobal` argv assertion in `processes.test.ts` and consumer tests may shift if the prefix is appended.
- Detecting the legacy override must distinguish CodeMie's `...\CodeMie\npm-prefix` / `~/.codemie/npm-prefix` from a user's own deliberate prefix; `--location user` vs global/project `.npmrc` precedence matters.
- `install/macos/install.sh:71` has the same user-wide write; `scripts/postinstall.mjs` also edits shell rc files based on the active prefix.
- Writability test on Windows: `[ -w ]` has no direct PowerShell equivalent; the auto check needs a real probe (e.g. temp-file write) and must handle a non-existent prefix dir.
- Connect wizard behavior cannot be verified from this repo (binary only, separate source repo) — open question.
- No installer test harness; validation is manual/`-DryRun` only.

---

## 7. Summary for Complexity Assessment

The change spans the distribution layer (two installer scripts plus `install/README.md`), the utils layer (`src/utils/processes.ts` npm helpers, likely plus a persisted-prefix lookup under `getCodemiePath()`), and the CLI layer (a doctor check alongside `NpmCheck`). Consumers of the helpers — `cli-updater.ts`, `update.ts`, `BaseAgentAdapter.ts`, `codemie-code.plugin.ts`, `codegraph.plugin.ts`, `bmad.plugin.ts` — go through three functions, so a helper-level change covers them without touching each. Roughly 5-8 files, depending on how portable mode is kept.

Technically the pieces are familiar. `install.sh` already has an auto mode to copy, the doctor check pattern is established, and there is precedent for parsing `.npmrc` (`proxy-http-client.ts`). The novel parts are PowerShell prefix-writability probing, detecting and migrating legacy overrides, and keeping self-update and agent installs consistent with a CodeMie-scoped prefix. Agent detection resolves through PATH, and that interaction is where hidden scope lives.

For tests, the TS side is well covered and uses exact-argv assertions on npm calls. The installer scripts have no automated tests at all. The main risks are breaking self-update for existing portable installs, misclassifying a user's own custom prefix as CodeMie's, and the unverifiable Connect wizard.

---

## 8. External References

- `docs/superpowers/tasks/2026-09-28-epmcdme-15307/ticket.md` — resolved; it holds the full requirements. Key facts: root cause at `install.ps1:4,175,189,217`. The proposed fix is an auto default, portable mode using `npm install -g --prefix <dir>` with the prefix persisted for `installGlobal`/`uninstallGlobal`/`npm list -g`, installer rerun plus `codemie doctor` detecting `prefix=...\CodeMie\npm-prefix` and printing the fix, the same rule for `install.sh:71`, and a README update. Workaround revert command: `npm config delete prefix --location user`. Acceptance: with defaults, `npm config get prefix` is unchanged by the install; `codemie update` and `codemie install <npm agent>` work in every mode and resolve in a new terminal; any npm setting still changed is printed and has a documented revert.
- GitHub PR #266 / issue #493 and https://code.claude.com/docs/en/setup were not fetched (no network lookup performed); PR #266 was confirmed locally as commit `4b7b35c`.
