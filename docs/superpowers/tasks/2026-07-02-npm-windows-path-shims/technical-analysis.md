# Technical Research

**Task**: npm postinstall windows path bin shims installer
**Generated**: 2026-07-02
**Research path**: filesystem (codegraph MCP tool not available in this environment)

---

## 1. Original Context

EPMCDME-13191 — "Windows npm global install does not configure CodeMie PATH or bin shims"

Summary: `npm install -g @codemieai/code` on Windows does not configure the CodeMie executable path and does not create/populate the expected CodeMie bin folder with command shims such as `codemie.cmd` and `codemie-claude.cmd`. The Windows curl installer does create `C:\Users\<user>\AppData\Local\CodeMie\bin`, copies the command shim files there, and adds this folder to the user PATH.

Description: The Windows installation behavior is inconsistent between the npm global install flow and the curl-based Windows installer.
- `npm install -g @codemieai/code` does not add a PATH entry for CodeMie on Windows.
- The npm flow does not create the CodeMie `bin` folder under the expected local CodeMie installation path.
- The npm flow does not copy command shim files such as `codemie.cmd`, `codemie-claude.cmd`, and related executable wrappers into the expected CodeMie bin folder.
- The curl-based installer correctly creates `C:\Users\<user>\AppData\Local\CodeMie\bin`, copies shim files, and adds it to PATH.

Root causes suspected (from ticket investigation):
- The npm prefix/bin directory logic in the postinstall script is Unix-oriented and incorrect for Windows. On Windows, npm global command shims are placed directly in the npm prefix directory, not in a nested `bin` directory.
- PATH parsing uses the Unix separator `:` instead of the Windows separator `;`.
- Windows does not use shell RC files such as `.bashrc`/`.zshrc`; the postinstall script exits without applying a persistent PATH update on Windows.
- Claude Code executes hooks defined in `~/.codemie/claude-plugin/hooks/hooks.json` via non-interactive, non-login bash (`/usr/bin/bash -c "codemie hook"`). This shell does not source `~/.bash_profile`, so PATH entries added there are not inherited — hooks fail with `codemie: command not found` even after the curl installer, and more fundamentally for npm-installed users since codemie isn't on any PATH at all.

Acceptance criteria (from ticket):
- Windows-specific handling implemented for `npm install -g @codemieai/code`.
- Correctly determine the Windows command directory (no assumption of a Unix-style nested `bin` dir).
- PATH separator checks use `;` on Windows, keep `:` on Linux/macOS.
- Apply a persistent user PATH update on Windows using an appropriate Windows mechanism (e.g. `setx` or PowerShell/registry-based approach), not just an RC file append.
- Required shim files (`codemie.cmd`, `codemie-claude.cmd`, etc.) created/copied to the expected command directory.
- Behavior verified against the existing curl-based Windows installer flow (`install/windows/install.cmd`).
- No regression to Linux/macOS npm installation behavior.
- Claude Code hooks must be able to resolve `codemie` from a non-interactive, non-login bash subprocess after install — this requires the CodeMie bin directory to be in the actual Windows user PATH env var (not only in `~/.bash_profile`), or hooks must reference the binary by absolute path.
- Testing requirement per ticket: unit tests (Vitest) co-located at `scripts/__tests__/postinstall.test.ts`; ticket notes `postinstall.mjs` must export its helper functions before tests can be written (currently a flat script with no exports).

---

## 2. Codebase Findings

### Existing Implementations

- `scripts/postinstall.mjs` (53 lines, plain ESM, wired via `package.json` `"postinstall": "node scripts/postinstall.mjs"`) — **Unix-only, no `process.platform` branch at all**. Contains four module-private, unexported top-level functions plus top-level executable statements:
  - `getNpmBinDir()` — always computes `join(npmPrefix, 'bin')`. This is the primary root cause: on Windows, `npm install -g` places global shims directly in the prefix directory, not in a nested `bin/` subfolder, so this path is simply wrong on Windows.
  - `isInPath(dir)` — splits `process.env.PATH` on `':'` only. Wrong separator on Windows (needs `';'` / `path.delimiter`).
  - `getShellRcFile()` — picks `.zshrc` (if `$SHELL` contains `zsh`), else `.bash_profile` (if it exists), else `.bashrc` (if `$SHELL` contains `bash`); returns `null` if none match. On Windows there is no `$SHELL` env var, so this always returns `null`, and the script falls through to printing a manual "add this to your PATH" console message — no persistence path exists at all for npm-installed Windows users.
  - `alreadyInRcFile(rcFile, dir)` — substring guard to avoid duplicate `export PATH=` appends.
  - None of these functions are exported; the script runs entirely for side effects. This confirms the ticket's claim and blocks any unit testing until refactored to export the helpers.
  - The script imports nothing from `src/` or `dist/` — it does not reuse the existing compiled Windows PATH utility described below, which is itself a gap.

- `package.json` — `"bin"` field maps ~12 command names (`codemie`, `codemie-code`, `codemie-claude`, `codemie-claude-acp`, `codemie-gemini`, `codemie-opencode`, `codemie-mcp-proxy`, etc.) to files under `bin/`. This is what npm's own auto-shim mechanism uses to generate `.cmd`/`.ps1`/no-extension shims at global-install time — postinstall.mjs does not create shim files itself, it only tries (and fails, on Windows) to add a bin **directory** to PATH.

- `bin/codemie.js`, `bin/codemie-claude.js`, etc. — plain Node ESM entry points (`#!/usr/bin/env node`) that import compiled `dist/**` output (e.g. `bin/codemie.js` → `dist/cli/index.js`, `dist/migrations/index.js`, `dist/utils/cli-updater.js`; `bin/codemie-claude.js` → `dist/agents/core/AgentCLI.js`, `dist/agents/registry.js`). No `.cmd`/`.ps1` files are checked into `bin/` as static assets — everything Windows-shim-shaped is generated at install time either by npm itself or by `install.ps1` (see below).

- `install/windows/install.cmd` — thin bootstrapper only: downloads `install.ps1` from GitHub raw via `curl -fsSL` into `%TEMP%\codemie-install.ps1`, then runs `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`. No PATH/bin logic of its own. Known limitation noted in `install/README.md`: forwards args to PowerShell via `%*`, which breaks on quoted paths containing spaces.

- `install/windows/install.ps1` — the actual Windows "portable" installer logic:
  - Bin/prefix dir creation: `$InstallRoot = Join-Path $env:LOCALAPPDATA 'CodeMie'`; `$BinDir = Join-Path $InstallRoot 'bin'`; `$PrefixDir = Join-Path $InstallRoot 'npm-prefix'`; `New-Item -ItemType Directory -Force -Path $BinDir, $PrefixDir`.
  - Isolates the npm global prefix: `npm config set prefix $PrefixDir --location user` (portable mode), then `npm install -g $PackageSpec --registry $RegistryUrl`. `install/README.md` notes the installer calls `npm.cmd` directly to avoid PowerShell resolving `npm` to `npm.ps1`.
  - Shim generation (hand-authored, not npm's auto-shims): for each command in the commands list, writes a `.cmd` file to `$BinDir\<name>.cmd` that `call`s through to the real npm-generated shim at `$PrefixDir\<name>.cmd` (falling back to `$PrefixDir\node_modules\.bin\<name>.cmd`) via `$shim | Set-Content -Path $shimPath -Encoding ASCII`. This confirms shims in `$BinDir` are wrapper-of-a-wrapper, layered on top of npm's own shim mechanism, not a replacement for it.
  - PATH persistence (`Add-UserPath $BinDir` function, lines ~96-118): reads `[Environment]::GetEnvironmentVariable('Path','User')`, splits on `;`, checks membership case-insensitively (`-icontains`) to avoid duplicate entries, appends, writes back via `[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')`. Note: this uses the .NET environment API (which itself ultimately writes `HKCU\Environment`), **not** `setx.exe` directly and **not** `reg add` directly.

- `src/utils/windows-path.ts` (compiled to `dist/utils/windows-path.js`, so importable from `scripts/postinstall.mjs` since `dist` ships in the package `files`) — an **existing, already-exported** Windows PATH utility with:
  - `findCommandDirectory`, `isInUserPath`, `addToUserPath`, `ensureCommandInPath`.
  - Uses `reg.exe query HKCU\Environment /v PATH` and `setx.exe PATH <value>` (a second, independent implementation of the same PATH-persistence idea as `install.ps1`'s `.NET` approach — the two Windows PATH mechanisms in this repo are not unified).
  - Includes a `validateDirectoryPath` guard that rejects shell metacharacters and requires an absolute path before touching the registry/PATH — a security pattern with no equivalent in `postinstall.mjs` today.
  - Consumed today by `src/utils/native-installer.ts` (`ensureCommandInPath`, called post-install with retry/verify backoff on Windows) — this is the intended integration pattern a Windows-aware `postinstall.mjs` should likely reuse rather than reinventing PATH logic a third time.

- `src/utils/cli-bin.ts` — Unix-only symlink-repair utility that explicitly early-returns on `win32` with the comment that "npm global layout differs (no bin/ subdirectory)" — independent corroboration, from inside this repo's own code, of the root cause described in the ticket.

- `src/utils/paths.ts` — `getCodemieHome()`/`getCodemiePath()` resolve `CODEMIE_HOME` env var or default to `~/.codemie` on all platforms; no win32 special-case for `%LOCALAPPDATA%`. This is a distinct, unrelated path convention from the installer's own `%LOCALAPPDATA%\CodeMie` layout — the two should not be confused when implementing the fix.

- `install/macos/install.sh` — for contrast: `auto` mode picks `npm-global` (if writable) or falls back to a user-prefix install (`$HOME/.codemie/npm-prefix`); it does **not** append to any RC file itself, only prints a manual "add to PATH" instruction and does dedup detection via `case ":$PATH:" in *":$USER_PREFIX/bin:"*)`. This is a "detect writability, fall back to user-local" precedent, but not itself a PATH-persistence precedent (unlike `postinstall.mjs`, which does append to RC files on Unix).

- `install/README.md` — states the GUI installer wizard (a separate distribution, `CodeMie Connect_2.0.1_x64-setup.exe`) explicitly adds `%USERPROFILE%\AppData\Local\CodeMie\npm-prefix` and `%USERPROFILE%\AppData\Roaming\npm` to the current user's PATH — a third precedent for "what Windows PATH entries CodeMie needs," slightly different in scope from `install.ps1`'s `$BinDir`.

### Architecture and Layers Affected

- **npm lifecycle layer** — `package.json` `scripts.postinstall` → `scripts/postinstall.mjs`. This is plain, untranspiled ESM (`.mjs`) that runs outside the TypeScript build/`src/` tree and outside Vitest's current `test.include` glob.
- **npm auto-shim layer** — `package.json` `"bin"` field → npm-generated `.cmd`/no-extension/`.ps1` shims pointing at `bin/*.js`. This layer is npm's own responsibility and is not modified directly; the fix must correctly *locate* what npm already created, not recreate it.
- **Compiled TS utility layer** — `src/utils/windows-path.ts` / `src/utils/native-installer.ts` / `src/utils/paths.ts` → compiled to `dist/utils/*.js`. Importable by `postinstall.mjs` today (dist ships in package `files`) but currently unused by it.
- **Standalone curl-installer layer** — `install/windows/install.cmd` + `install/windows/install.ps1`, and `install/macos/install.sh` — a completely separate, hand-rolled "portable" install path independent of npm's bin-shim mechanism, with its own PATH-persistence implementation (.NET `SetEnvironmentVariable`) distinct from `src/utils/windows-path.ts`'s (`setx.exe`/`reg.exe`).
- **Hook execution layer** — Claude Code plugin hooks (`src/agents/plugins/claude/plugin/hooks/hooks.json`, `src/agents/plugins/gemini/extension/hooks/hooks.json`) invoke bare command strings like `"codemie hook"`. Inside this repo's own hook executor (`src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts`), sync execution uses `execSync(command, {...})` (default shell, OS-dependent) and async execution explicitly uses `spawn("sh", ["-c", command], {...})` — hardcoded to POSIX `sh`, non-login/non-interactive. This is a latent Windows gap independent of the PATH bug (no `sh` binary on Windows) and should be flagged, though the ticket's primary hook-resolution failure mode (Unix non-login bash not sourcing RC files) is corroborated by `postinstall.mjs` writing only to RC files on Unix and nothing persistent at all on Windows.

### Integration Points

- `scripts/postinstall.mjs` currently has **no internal dependencies** — it does not import `src/utils/paths.ts`, `src/utils/windows-path.ts`, or `src/utils/exec.ts`. This is itself a design gap: `dist/utils/windows-path.js` already implements Windows PATH detection/mutation with security validation and could be reused instead of writing new logic from scratch.
- `src/utils/native-installer.ts` → `src/utils/windows-path.ts` (`ensureCommandInPath`) — existing integration pattern to mirror.
- `src/utils/windows-path.ts` → `src/utils/exec.ts`, `src/utils/logger.ts`, `src/utils/security.ts` (`sanitizeLogArgs`) — dependencies a reused/imported version of this logic would pull into `postinstall.mjs`, which currently has zero dependencies of its own.
- `install/windows/install.cmd` → `install/windows/install.ps1` (download + invoke); no shared code with `src/` or `scripts/` — the curl installer and the npm postinstall flow are today entirely independent implementations of overlapping intent, which is the structural source of the inconsistency described in the ticket.
- `bin/*.js` → `dist/**` (compiled output) — the shim source files npm uses for its own auto-generation.
- External processes invoked: `npm.cmd`/`node.exe` (by `install.ps1`), `reg.exe`/`setx.exe` (by `windows-path.ts`), shell RC files (by `postinstall.mjs` on Unix only).

### Patterns and Conventions

- Repo-wide convention for Windows branching: `process.platform === 'win32'` / `os.platform() === 'win32'` (used in `src/utils/exec.ts`, `src/utils/processes.ts`, `src/utils/cli-bin.ts`, `src/utils/windows-path.ts`). `postinstall.mjs` follows none of this — it has no platform branch at all, unconditionally executing Unix-only logic.
- PATH separator convention: literal `';'` in Windows-specific code (`install.ps1`, `windows-path.ts`); literal `':'` hardcoded in `postinstall.mjs` — no code path anywhere uses Node's own `path.delimiter`, which would auto-resolve to the correct separator per platform and is the idiomatic fix.
- Windows PATH persistence has **two independent existing implementations** in this repo already: `.NET Environment.SetEnvironmentVariable` (in `install.ps1`) and `reg.exe`/`setx.exe` (in `src/utils/windows-path.ts`). Any new logic in `postinstall.mjs` should reuse the latter (it's already TS, tested, and exported) rather than introducing a third variant.
- Security pattern: `validateDirectoryPath` in `windows-path.ts` rejects shell metacharacters and enforces absolute paths before any registry/PATH mutation — should be preserved if this logic is reused or ported.
- Testing convention (from `.ai-run/guides/testing/testing-patterns.md` and existing tests): dynamic `import()` of the module under test *after* `vi.mock`/`vi.spyOn` setup (static imports bypass spies due to hoisting); `vi.restoreAllMocks()` in `afterEach`; `Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })` to simulate Windows without mocking `os` (see `src/utils/__tests__/windows-path.test.ts`, the closest existing precedent).
- No existing repo test mocks raw `node:child_process` `execSync` directly — all existing precedents mock through an internal wrapper (`src/utils/exec.ts`). `postinstall.mjs` as currently written does not use `child_process` at all (only `fs`, `os`, `path`); if the fix introduces `setx`/`reg` calls directly in `postinstall.mjs` rather than importing `windows-path.ts`, this would be genuinely new test-mocking territory for the repo.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/development/development-practices.md` — relevant process-execution guidance: prefer `exec()` from `src/utils/exec.ts` for process spawning over raw `child_process`; avoid `execSync` in async contexts; and the mandatory "dynamic import after spy setup" testing pattern.
- `.ai-run/guides/testing/testing-patterns.md` — directly relevant Vitest conventions: dynamic `import()` after `vi.mock`/`vi.spyOn`, `vi.restoreAllMocks()` in `afterEach`, asserting both error class and error code for async failures, co-located `__tests__/*.test.ts` naming, coverage targets (80%+ overall, 90%+ for `src/utils/` and core logic).
- `.ai-run/guides/usage/project-config.md` and `.ai-run/guides/integration/external-integrations.md` — read but not directly relevant to this domain; the latter notes a Windows XDG-style path precedent (`%LOCALAPPDATA%\opencode\storage\`) unrelated to bin shims/PATH.
- `install/README.md` — documents the curl-based bootstrap installers and a separate GUI wizard; states the Windows installer "calls `npm.cmd` directly to avoid PowerShell resolving `npm` to `npm.ps1`" and that the GUI wizard adds `%USERPROFILE%\AppData\Local\CodeMie\npm-prefix` and `%USERPROFILE%\AppData\Roaming\npm` to user PATH.
- `scripts/README.md` — documents `release.sh` and `test-proxy-endpoint.js` only; no mention of `postinstall.mjs` and no documented relationship between the npm postinstall script and the curl-based installers — the two flows have evolved independently with no cross-reference in docs.

### Architectural Decisions

- No ADRs or explicit "DECISION:" records found anywhere in guides, `install/`, `scripts/`, or `docs/`.
- No repo-root `CHANGELOG.md` exists.
- No `NOTE:`/`HACK:`/`TODO:`/`FIXME:` markers found in `scripts/postinstall.mjs`, `install/windows/*`, or `install/macos/*` — the Unix-only limitation of `postinstall.mjs` is undocumented, not a known/flagged gap in the code itself.
- An SDLC workflow tracking artifact already exists at `docs/superpowers/tasks/2026-07-02-npm-windows-path-shims/.state.json` (branch `fix/npm-windows-path-shims`, flow `sdlc-standard`) but contains no plan/spec/decisions yet.

### Derived Conventions

- No guide specifically covers postinstall scripts or Windows PATH manipulation; conventions are derived from `development-practices.md`/`testing-patterns.md` general rules plus the behavior documented in `install/README.md`.
- Windows-specific conventions observed in code: call `npm.cmd` not `npm` from PowerShell; target per-user `%LOCALAPPDATA%` installs (no admin elevation); use `;`-delimited PATH parsing; persist via `.NET SetEnvironmentVariable` or `reg.exe`/`setx.exe`, never RC files (none exist on Windows).
- A refactored `postinstall.mjs` will need a decision on whether to import compiled `dist/` utilities (`getCodemiePath`, `windows-path.js` helpers, error classes) or remain dependency-free as a plain `.mjs` script — currently it has zero internal imports.

---

## 4. Testing Landscape

### Existing Coverage

- `scripts/postinstall.mjs` has **zero test coverage today** and **zero exports** — confirmed by direct read of the file (53 lines, no `export` statement) and by `Glob scripts/__tests__/**` returning no results.
- `scripts/__tests__/postinstall.test.ts` (the file the ticket requires) does **not** exist yet.
- Only one existing test touches anything under `scripts/`: `tests/scripts/test-proxy-endpoint.test.ts`, which tests `scripts/test-proxy-endpoint.js` via subprocess execution (`execFile(process.execPath, [scriptPath, ...])`) against a real local HTTP server — no fs/os/child_process mocking, since that script doesn't touch them. This is a precedent for "testing a file under scripts/" but not for the mocking style postinstall will need.
- `scripts/license-check.js` and `scripts/validate-secrets.js` also have zero test coverage.
- `src/utils/__tests__/windows-path.test.ts` already exists and is the closest precedent for testing Windows-specific PATH/registry branching logic (see below).

### Testing Framework and Patterns

- Vitest `^4.1.5` (`@vitest/ui ^4.1.5`), TypeScript `^5.3.3`. Run via `npm test` / `npm run test:unit` (scoped to `vitest run src`) / `npm run test:integration` (`vitest run tests/integration`) / `npm run test:coverage`.
- **Important gap**: `vitest.config.ts` `test.include` is `['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts']` — it does **not** include `scripts/**/*.test.ts`. A new `scripts/__tests__/postinstall.test.ts` file would not be picked up by `npm test`/`npm run test:unit` unless the include glob is updated (or the test file is placed/run differently). This must be addressed as part of the implementation, not just the test file itself.
- `vitest.config.ts` coverage excludes `bin/`, `tests/`, `dist/`, `node_modules/` but does not currently exclude `scripts/` — no explicit policy either way for scripts/ coverage.
- Closest relevant mocking precedents:
  - `src/utils/__tests__/windows-path.test.ts` — does not mock `os`/`child_process` directly; spies on an internal `exec` wrapper (`vi.spyOn(execModule, 'exec')`) and toggles `process.platform` via `Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })` in `beforeEach`, restoring in `afterEach`. This is the most relevant existing pattern for postinstall's platform-conditional PATH logic.
  - `src/utils/__tests__/cli-bin.test.ts` — mocks `fs/promises` (default export shape) and `os` via `vi.importActual` + override of `default.platform`, including a test explicitly titled "should skip on Windows platform."
  - `src/cli/commands/assistants/setup/generators/__tests__/claude-agent-generator.test.ts` — factory-style `vi.mock('node:fs', () => ({...}))` and `vi.mock('node:os', () => ({ default: {...} }))` declared before imports, then dynamic import of both mocks and SUT.
  - `src/agents/plugins/claude/__tests__/plugin-installer.test.ts` and `src/agents/plugins/kimi/__tests__/kimi.extension-installer.test.ts` — bare `vi.mock('fs/promises')` auto-mocks combined with dynamic `await import()`, and `vi.importActual` to preserve real module behavior while overriding a single function.
- **No existing repo test mocks raw `node:child_process` `execSync` directly** — every existing precedent mocks through the internal `src/utils/exec.ts` wrapper instead. `postinstall.mjs` today does not use `child_process` at all. If the Windows fix calls `setx`/`reg` directly (rather than importing `windows-path.ts`, which already goes through the `exec.ts` wrapper), this will be genuinely new test-mocking territory for the repo.

### Coverage Gaps

- `scripts/postinstall.mjs` — no tests, no exports (blocking issue called out explicitly by the ticket).
- Windows PATH/bin-dir detection logic inside `postinstall.mjs` specifically — completely untested today because it doesn't exist (the script has no platform branch).
- `vitest.config.ts` include glob does not cover `scripts/` — a structural gap that must be fixed alongside adding the new test file, or the new tests will silently not run under `npm test`.
- No precedent for mocking raw `child_process.execSync`/`setx`/`reg` invocations in this repo.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides `~/.codemie` home dir (`src/utils/paths.ts`); no Windows-specific override (same path convention on all platforms, distinct from the installer's `%LOCALAPPDATA%\CodeMie`).
- `CODEMIE_INSTALL_URL` — base URL the `.cmd` bootstrapper downloads `install.ps1` from.
- `CODEMIE_REGISTRY_URL` / `CODEMIE_SCOPE_REGISTRY_URL` / `CODEMIE_INSTALL_MODE` / `CODEMIE_NPM_PREFIX` / `CODEMIE_PACKAGE_VERSION` — consumed by `install/macos/install.sh` for registry/prefix overrides (no Windows equivalent found for these in `install.ps1`, worth checking during implementation for parity).
- `SHELL` — read by `postinstall.mjs`'s `getShellRcFile()` to choose `.zshrc` vs `.bash_profile`/`.bashrc`; not present/applicable on Windows, which is precisely why `getShellRcFile()` returns `null` there today and the script falls back to a manual console instruction with no persistence.

### Configuration Files

- `install/windows/install.ps1` — governs bin-dir creation (`%LOCALAPPDATA%\CodeMie\bin`), npm prefix isolation (`%LOCALAPPDATA%\CodeMie\npm-prefix`), shim generation, and PATH update for the curl-based Windows flow.
- `install/windows/install.cmd` — thin bootstrapper/downloader for `install.ps1`; no config logic of its own.
- `install/macos/install.sh` — governs npm-global vs user-prefix fallback and PATH instruction messaging for macOS/Linux curl flow.
- `scripts/postinstall.mjs` — governs npm-lifecycle PATH/bin handling; the file under repair for this ticket.
- `package.json` — `"bin"` field is the source of truth npm uses for auto-shim generation on all platforms; `"postinstall"` script wires in `postinstall.mjs`.

### Feature Flags and Deployment Concerns

- No application feature flags found in this domain — only CLI parameters on `install.ps1` (`-DryRun`, `-Mode portable|npm-global`).
- Windows curl installer's PATH-update mechanism (`Add-UserPath` in `install.ps1`) uses `[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')` after reading and deduping against the current user PATH — not `setx.exe` directly, contrary to a literal reading of the ticket's "e.g. setx" suggestion; `src/utils/windows-path.ts` is the component in this repo that actually uses `setx.exe`/`reg.exe`. Any implementation choice should note this distinction and ideally standardize on reusing `windows-path.ts` rather than introducing a third mechanism.
- Hook invocation shell context: `hooks.json` manifests contain bare command strings (`"codemie hook"`) with no shell wrapper specified in the manifest itself; this repo's own hook executor (`src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts`) hardcodes `spawn("sh", ["-c", command], {...})` for async execution — non-login, non-interactive, and POSIX-only (no `sh` on Windows). This is a related but distinct latent gap from the PATH bug and should be flagged separately; fixing the PATH issue (getting `codemie` onto the actual persisted Windows user PATH) is necessary but the hook executor's `sh`-only invocation is a second failure mode worth a follow-up ticket if hooks are expected to work cross-platform.
- No CI/CD or Docker files reference this specific postinstall/PATH concern; the fix is scoped to `scripts/postinstall.mjs` plus (optionally) reuse of `src/utils/windows-path.ts`.

---

## 6. Risk Indicators

- **Zero test coverage today** for `scripts/postinstall.mjs`, and it has zero exports — any fix must include a refactor to export helper functions before tests can be written at all, exactly as the ticket states.
- **`vitest.config.ts` test.include does not cover `scripts/**`** — a new `scripts/__tests__/postinstall.test.ts` will not run under `npm test`/`npm run test:unit` unless the config is updated; this is easy to miss and would produce a false "tests pass" signal if overlooked.
- **Two independent, unreconciled Windows PATH-persistence implementations already exist** in this repo (`install.ps1`'s `.NET SetEnvironmentVariable` vs `src/utils/windows-path.ts`'s `setx.exe`/`reg.exe`). A third, ad-hoc implementation inside `postinstall.mjs` would compound inconsistency; reusing `windows-path.ts` is strongly preferable but requires `postinstall.mjs` (a plain `.mjs` script with zero imports today) to depend on compiled `dist/` output, which is a design decision, not a pure bug fix.
- **No existing precedent for mocking raw `node:child_process.execSync`** for `setx`/`reg` calls — if the fix does not reuse `windows-path.ts` (which already goes through the tested `exec.ts` wrapper), new test-mocking patterns will need to be established from scratch, increasing implementation and review effort.
- **Two conflicting descriptions of "the" Windows bin directory** exist across sources: `install.ps1`'s `$BinDir` (`%LOCALAPPDATA%\CodeMie\bin`, hand-authored wrapper shims), the GUI installer's PATH additions (`%LOCALAPPDATA%\CodeMie\npm-prefix` and `%APPDATA%\Roaming\npm`), and npm's own default global prefix (unmanaged, platform-default location when `npm install -g` is run directly without any portable-prefix override). The ticket's acceptance criteria imply parity with `install.ps1`'s `$BinDir` behavior specifically, but the plain `npm install -g` flow (no portable prefix override) will by default install into npm's OS-default global prefix, not `%LOCALAPPDATA%\CodeMie`. This ambiguity needs explicit resolution before implementation: should plain `npm install -g` mimic the portable/isolated-prefix pattern, or just fix PATH/bin-dir detection for whatever prefix npm is already using?
- **Hook shell-invocation gap is real but partially distinct from the PATH bug**: `shell-hooks-source.ts` hardcodes `spawn("sh", ...)`, which has no Windows equivalent regardless of PATH state. Fixing PATH alone will not make hooks work on Windows if this codepath is reached; scope of this ticket vs. a follow-up should be clarified.
- **Undocumented, unflagged limitation**: the Unix-only nature of `postinstall.mjs` carries no `TODO`/`NOTE` in-code and no mention in `scripts/README.md` — there is no existing internal signal of this gap being previously known, meaning the fix is greenfield within this file (low risk of conflicting in-flight work, but also no prior design discussion to draw from).
- **`install/windows/install.cmd` known bug** (documented in `install/README.md`): breaks on quoted paths with spaces when forwarding `%*` to PowerShell — not in scope for this ticket but adjacent, and could confuse "verify against install.cmd" acceptance-criteria testing if hit incidentally.
- **No `.ai-run/guides/` entry specific to postinstall/PATH/installer scripts** — conventions must be derived from general development-practices/testing-patterns guides plus direct code reading, increasing reliance on this analysis rather than a curated guide.

---

## 7. Summary for Complexity Assessment

This task touches a small, well-bounded surface area at the code level — primarily `scripts/postinstall.mjs` (a single ~53-line file) plus, if the recommended reuse path is taken, an integration point into the already-exported `src/utils/windows-path.ts` (and transitively `src/utils/exec.ts`, `src/utils/logger.ts`, `src/utils/security.ts`). A minimal test-configuration change to `vitest.config.ts` (`test.include`) is also required, and a new test file `scripts/__tests__/postinstall.test.ts` must be created from scratch since no precedent exists for testing a `scripts/` file with fs/os/child_process mocking. Realistic file-change count is therefore small (2-4 files: `postinstall.mjs`, `vitest.config.ts`, the new test file, and possibly a small addition to `windows-path.ts` if new helpers are needed there), but the ticket's acceptance criteria also raise an open design question — whether the npm postinstall flow should mimic the curl installer's isolated-prefix/wrapper-shim pattern (`%LOCALAPPDATA%\CodeMie\bin` with hand-authored `.cmd` wrappers) or simply fix PATH/bin-dir detection for npm's actual, unmanaged global prefix on Windows — that should be resolved before implementation sizing is finalized, since the two approaches differ meaningfully in scope.

Technical novelty is moderate: the repo already has two independent precedents for Windows PATH persistence (`install.ps1`'s .NET API approach and `windows-path.ts`'s `setx`/`reg.exe` approach) and an established `process.platform === 'win32'` branching convention used consistently elsewhere — so the fix is not introducing a wholly new pattern, but it is introducing platform-branching into a file that currently has none, and the ticket explicitly requires an export-based refactor of a previously side-effect-only script, which is a meaningful (if small) architectural change to that one file's shape and its relationship to the compiled `dist/` tree.

Test coverage posture is the single biggest risk factor: `scripts/postinstall.mjs` has zero tests today, `vitest.config.ts` does not even include `scripts/**` in its test glob, and no existing test in the repo mocks raw `node:child_process.execSync` (the closest precedents mock through the `exec.ts` wrapper instead). Combined with the ambiguity noted above about which installer behavior npm-install should mirror, and the adjacent-but-distinct hook-invocation gap (`spawn("sh", ...)` with no Windows equivalent) that acceptance criteria reference but may be out of this ticket's direct scope, this should be scored as low-to-moderate code complexity but moderate process/testing complexity, with the config-glob gap and design-scope ambiguity flagged as pre-implementation blockers to resolve rather than in-flight surprises.
