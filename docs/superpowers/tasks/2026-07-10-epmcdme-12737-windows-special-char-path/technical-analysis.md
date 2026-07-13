# Technical Research

**Task**: CLI windows path escaping special-characters agent-executor
**Generated**: 2026-07-10T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

codemie-code command fails on Windows if user's profile name contains the '(' character (or similar special characters). When executing the codemie-code command on Windows, users whose profile directory contains the '(' character (e.g., C:\Users\AkshathaR(Contractor\Desktop\ai-bootcamp) encounter a critical error. The CLI attempts to interpret the directory path incorrectly, resulting in the error: 'C:\Users\AkshathaR' is not recognized as an internal or external command, operable program, or batch file. This suggests improper escaping or handling of special characters (such as parentheses, spaces, or other characters) in the user's home directory path. The problem may affect any users with profile names containing parentheses or potentially other special characters allowed by Windows for user folders. Acceptance criteria: Users with parentheses or other special characters in their Windows username/profile path can execute codemie-code without errors. The CLI properly escapes and processes all valid Windows directory names. Regression tests ensure that directory name edge cases (spaces, parentheses, etc.) do not break CLI operation.

---

## 2. Codebase Findings

### Existing Implementations

**Primary bug site — `BaseAgentAdapter.ts` (spawn of the inner binary):**

- `C:/Projects/codemie-code/src/agents/core/BaseAgentAdapter.ts` lines 706–771
  - `run()` method, specifically the path-resolution and spawn block.
  - Line 707: `let commandPath = this.metadata.cliCommand;` — assigns the raw, unquoted absolute path from plugin metadata as the initial `commandPath`.
  - Lines 710–713: calls `getCommandPath(this.metadata.cliCommand)`. If `getCommandPath` returns a non-null `resolvedPath`, the path is conditionally quoted: `commandPath = isWindows && /[ ()&|<>^%[\]{}]/.test(resolvedPath) ? \`"${resolvedPath}"\` : resolvedPath;`
  - Lines 715–750: `else if (!isWindows)` branch — dead code on Windows; handles Unix `~/.local/bin/` fallback only.
  - **Critical gap**: when `getCommandPath()` returns `null` (which it does when `where.exe` cannot confirm the path), execution falls through to line 754 with `commandPath` still holding the raw unquoted value from line 707.
  - Lines 754–764: `finalCommand` is assembled — `commandPath` (potentially unquoted) is concatenated with quoted args.
  - Line 766: `spawn(finalCommand, finalArgs, { shell: isWindows, ... })` — on Windows, `shell: true` is always used. This invokes `cmd.exe /d /s /c "..."`. CMD.EXE interprets bare `(` as a compound-command-group delimiter, parsing `C:\Users\AkshathaR` as the command name and failing.

**Binary resolver — how `cliCommand` gets the parenthesis-containing path:**

- `C:/Projects/codemie-code/src/agents/plugins/codemie-code-binary.ts` — `resolveCodemieOpenCodeBinary()` (lines 63–104)
  - Uses `dirname(fileURLToPath(import.meta.url))` as the start directory and calls `findPackageInNodeModules()` to walk up the directory tree.
  - For a user with profile `C:\Users\AkshathaR(Contractor`, npm installs the package under `C:\Users\AkshathaR(Contractor\AppData\Roaming\npm\node_modules\@codemieai\codemie-opencode-windows-x64\`.
  - The resolved binary path becomes `C:\Users\AkshathaR(Contractor\AppData\Roaming\npm\node_modules\@codemieai\codemie-opencode-windows-x64\bin\codemie.exe`.
  - `existsSync(platformBin)` returns `true` (file exists), so the full path is returned.

- `C:/Projects/codemie-code/src/agents/plugins/codemie-code.plugin.ts` line 187:
  - `cliCommand: resolvedBinary || null` — the full absolute path (including `(`) becomes `this.metadata.cliCommand`.

**Path resolution utility — why `getCommandPath` returns null for absolute paths:**

- `C:/Projects/codemie-code/src/utils/processes.ts` lines 45–68 — `getCommandPath(command: string)`
  - Calls `exec('C:\\Windows\\System32\\where.exe', [command])` with `shell: false`.
  - `where.exe` treats the argument as a PATH search pattern. When passed a full absolute path like `C:\Users\AkshathaR(Contractor\...\codemie.exe`, `where.exe` may exit non-zero because the npm global `node_modules\...\bin\` directory is not registered in the user's `PATH` (npm only adds the top-level `npm` bin dir to PATH, not individual package bin subdirs). In fresh terminal sessions or when the npm global bin dir is not in PATH, `where.exe` returns exit code 1.
  - Result: `getCommandPath` returns `null`, and the quoting branch at `BaseAgentAdapter.ts:712–713` is never entered.

**Secondary bug site — `exec.ts` (base spawn utility):**

- `C:/Projects/codemie-code/src/utils/exec.ts` lines 57–71
  - When `useShell && args.length > 0`, args are individually quoted (via `needsQuoting()` at lines 63–65), but the `command` parameter itself is **never quoted**: `finalCommand = \`${command} ${quotedArgs.join(' ')}\`` (line 69).
  - Callers that pass a full path as `command` with `shell: true` (e.g., `native-installer.ts` line ~159 sets `useShell = command.includes('/')  || command.includes('\\')`) would hit the same unquoted-path-through-CMD.EXE failure.
  - For the `codemie-code` case, this path is not triggered because `exec.ts` is not called directly from the primary spawn chain — `BaseAgentAdapter.ts` calls `spawn()` directly.

**Native installer secondary site:**

- `C:/Projects/codemie-code/src/utils/native-installer.ts` lines ~158–162
  - `verifyInstallation()` sets `useShell = verifyCommand.includes('/') || verifyCommand.includes('\\')`.
  - If `verifyCommand` is an absolute path containing `(`, calling `exec(verifyCommand, ['--version'], { shell: true })` would fail for the same reason.
  - Currently mitigated for the Claude plugin: `claude.plugin.ts` sets `verifyPath = undefined` on Windows, so `verifyCommand = 'claude'` (a bare name, no path separators, `useShell = false`).

### Architecture and Layers Affected

The task touches three layers of the plugin-based 5-layer architecture:

| Layer | Component | Change needed |
|---|---|---|
| Core | `src/agents/core/BaseAgentAdapter.ts` | Primary fix: unconditional Windows quoting of `commandPath` before spawn |
| Utils | `src/utils/exec.ts` | Secondary fix: quote `command` itself (not just args) when `useShell && isWindows` |
| Utils | `src/utils/processes.ts` | No change needed — `getCommandPath` correctly returns null; the bug is the unhandled null case |
| Tests | `src/agents/core/__tests__/BaseAgentAdapter.test.ts` | New test: spawn path with `(` in binary path |
| Tests | `src/utils/__tests__/processes.test.ts` | New test: `getCommandPath` with `(` in path |
| Tests | `src/utils/__tests__/exec.test.ts` (new file) | New tests for `exec()` command-quoting on Windows |

### Integration Points

- **`bin/agent-executor.js`** → compiled from `src/agents/core/AgentCLI.ts` + `src/agents/registry.ts` — the CLI entry point that invokes the affected `run()` path.
- **`spawn()` from Node.js `child_process`** — the actual process-spawning call in `BaseAgentAdapter.ts:766`. Direct Node.js import, not wrapped.
- **`C:\\Windows\\System32\\where.exe`** — called by `getCommandPath()` to resolve command paths; the return value (or its absence) determines whether the quoting branch at line 713 fires.
- **`CODEMIE_OPENCODE_WL_BIN`** env var — override for the binary path (documented escape hatch in `codemie-code-binary.ts:65`). If set by a user to a quoted path, it bypasses the bug.
- **`getCodemieHome()`** from `src/utils/paths.ts` — used by `codemie-code.plugin.ts:beforeRun` to set `XDG_DATA_HOME`. This uses `os.homedir()` internally, so a `(` in the home dir propagates into env vars like `XDG_DATA_HOME`; these are passed as environment variables (not in the command string), so they do NOT go through CMD.EXE metachar parsing.

### Patterns and Conventions

- **Windows quoting regex already established**: `/[ ()&|<>^%[\]{}]/` is used at `BaseAgentAdapter.ts:713` and `/[ "()&|<>^%[\]{}]/` at `BaseAgentAdapter.ts:760`. The `exec.ts` variant is `needsQuoting()` at lines 63–65. The fix must replicate this same regex pattern.
- **Quote-wrap pattern**: `\`"${path}"\`` — standard throughout the codebase for wrapping paths with special chars.
- **Guard against double-quoting**: check `!commandPath.startsWith('"')` before adding quotes (the `resolvedPath` branch at line 713 may have already quoted it).
- **`shell: true` only on Windows**: `BaseAgentAdapter.ts:769` — `shell: isWindows`. On Windows, `.cmd` and `.bat` wrappers require a shell. This is the architectural reason `(` in paths causes failures: CMD.EXE metacharacter parsing.
- **No third-party shell-escape library**: all quoting is hand-rolled. `shellescape`, `shell-quote`, `execa`, `cross-spawn` are absent from `package.json`. The fix must stay within this convention.
- **Process execution convention**: all spawns go through `src/utils/exec.ts`; the direct `spawn()` call in `BaseAgentAdapter.ts` is a documented exception for `stdio: 'inherit'` / interactive mode.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `C:/Projects/codemie-code/.ai-run/guides/architecture/architecture.md` — describes the 5-layer plugin architecture (`CLI → Registry → Plugin → Core → Utils`) and the strict unidirectional layer flow. The bug crosses Core and Utils layers; the fix must respect the layer boundary (no Utils layer importing from Core).
- `C:/Projects/codemie-code/.ai-run/guides/development/development-practices.md` — confirms: all process execution must go through `src/utils/exec.ts`; the `BaseAgentAdapter.ts` direct `spawn()` is an architectural exception documented in the guide for interactive stdio.
- `C:/Projects/codemie-code/.ai-run/guides/testing/testing-patterns.md` — Vitest framework; `vi.spyOn(exec, 'exec')` mock pattern for process tests; dynamic imports inside `beforeEach` required; `vi.mock('child_process', ...)` for spawn-level tests.
- `C:/Projects/codemie-code/.ai-run/guides/standards/code-quality.md` — single quotes in TypeScript, `.js` extensions on imports, explicit return types, functions under 50 lines, JSDoc on public APIs, `logger.debug()` for internal detail, no `console.log()`.
- `C:/Projects/codemie-code/docs/superpowers/runs/epmcdme-10318/technical-analysis.md` — prior analysis for a related Windows PATH-staleness bug (Claude plugin). Confirms the Windows-specific `verifyPath: undefined` mitigation and the `setx` session-scope limitation. Relevant context for understanding the Windows environment.

### Architectural Decisions

- **`shell: isWindows` on spawn**: an explicit architectural decision documented in `BaseAgentAdapter.ts:769` comments — required because Windows `.cmd`/`.bat` wrappers need a shell interpreter. This decision is the root enabler of the metacharacter bug.
- **`where.exe` full path** (`C:\\Windows\\System32\\where.exe`) instead of bare `where`: documented decision in `windows-path.ts` to prevent PATH hijacking. Applied consistently across the codebase.
- **No shell for utility `exec()` calls**: `exec.ts` defaults to `shell: false` for security. The `shell: true` path in `exec.ts` is a narrow opt-in used for installer commands and verified contexts only.
- **`validateDirectoryPath` explicitly allows `( )`**: `src/utils/windows-path.ts:57` — `( )` are excluded from the dangerous-chars regex with an inline comment: "valid in Windows dir names (e.g., Program Files (x86))". This is correct for `shell: false` callers but incompatible with the `shell: true` spawn path in `BaseAgentAdapter.ts`.

### Derived Conventions

- Quoting applied to args already follows a consistent regex set (`/[ "()&|<>^%[\]{}]/`); the missing piece is identical quoting applied to the command path itself.
- Double-quote-escape pattern for embedded quotes: `arg.replace(/"/g, '\\"')` — used in both `BaseAgentAdapter.ts:760` and implied by `exec.ts:67`.
- Windows-specific code blocks always guarded by `const isWindows = process.platform === 'win32'` or `os.platform() === 'win32'` — not by env vars.

---

## 4. Testing Landscape

### Existing Coverage

- `C:/Projects/codemie-code/src/utils/__tests__/windows-path.test.ts` — tests `addToUserPath`, `validateDirectoryPath`, `findCommandDirectory`, `isInUserPath`. Line 309: explicit test for `( )` in dir name via `addToUserPath('C:\\Users\\Test(User)\\.local\\bin')`. This tests the PATH-write utility, not the spawn/exec path.
- `C:/Projects/codemie-code/src/utils/__tests__/processes.test.ts` lines 382–495 — tests `getCommandPath()` for: CRLF trimming, multiple-path output, Unix line endings, empty-line filtering, error cases. All test paths use clean usernames (e.g., `C:\\Users\\test\\AppData\\...`). No test with `(` in a path.
- `C:/Projects/codemie-code/src/utils/__tests__/paths.test.ts` — tests `normalizePathSeparators`, `splitPath`, `resolveHomeDir`, `getFilename`. "Special characters" test at line 250 covers only hyphens and underscores.
- `C:/Projects/codemie-code/src/agents/core/__tests__/BaseAgentAdapter.test.ts` — tests metadata cloning, proxy selection, `setSilentMode`, reasoning effort. All tests mock `getCommandPath` to return `null`. The spawn path at lines 706–771 is entirely untested.
- `C:/Projects/codemie-code/tests/integration/agent-shortcuts.test.ts` — integration test that calls `agent-executor.js --help`, `--version`, etc. via real `execSync`. Uses the system's actual PATH; no simulation of `(` in profile path.

### Testing Framework and Patterns

- **Framework**: Vitest v4.1.5 with three named projects: `unit` (src/**), `cli` (tests/integration/, excludes agent-*), `agent` (tests/integration/agent-*).
- **Coverage provider**: v8; targets 80%+ overall, 90%+ for `src/utils/` and core logic.
- **Spy pattern** for exec calls:
  ```typescript
  execSpy = vi.spyOn(exec, 'exec');
  execSpy.mockResolvedValue({ code: 0, stdout: 'C:\\path\\with(parens\\cmd.exe\r\n', stderr: '' });
  ```
- **spawn mock pattern** (needed for `BaseAgentAdapter.ts` tests):
  ```typescript
  vi.mock('child_process', () => ({
    spawn: vi.fn().mockReturnValue({ on: vi.fn(), stdout: null, stderr: null, kill: vi.fn() })
  }));
  ```
- **Dynamic import after mock setup**: tests must use `await import('../BaseAgentAdapter.js')` inside `beforeEach`, after spies are configured.
- **Arrange-Act-Assert** within nested `describe` blocks; one concept per `it()`.

### Coverage Gaps

1. **`BaseAgentAdapter.run()` — Windows quoting branch never exercised** (`src/agents/core/__tests__/BaseAgentAdapter.test.ts`): the conditional at lines 712–713 (`isWindows && /.../.test(resolvedPath)`) is never reached. No test exercises the `spawn()` call with a path containing `(`.
2. **`getCommandPath()` with `(` in path** (`src/utils/__tests__/processes.test.ts`): no test mocks `where.exe` returning a path with parentheses to verify trimming and return value behavior.
3. **`getCommandPath()` returning null for full absolute paths** (`src/utils/__tests__/processes.test.ts`): no test verifies what `BaseAgentAdapter.run()` does when `getCommandPath` returns null for the full binary path (the primary failure mode).
4. **`exec.ts` has no dedicated test file**: `src/utils/exec.ts` is the foundational spawn utility; no `exec.test.ts` exists. The `shell: true` + special-char-in-command path is entirely uncovered.
5. **No integration test with `(` in profile path** (`tests/integration/`): `tests/helpers/temp-workspace.ts` supports Windows paths but never creates temp dirs with `(` in the path to simulate the affected user environment.
6. **`resolveCodemieOpenCodeBinary()` with `(` in home dir** (`src/agents/plugins/`): no unit test verifies that `findPackageInNodeModules` correctly walks paths containing `(` and that the returned binary path is correctly handled downstream.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_OPENCODE_WL_BIN` — override for the inner binary path (`codemie-code-binary.ts:65`). If set to a path containing `(`, the override path bypasses normal resolution but would hit the same spawn quoting bug.
- `USERPROFILE` — read by `src/utils/windows-path.ts:80–83` to build candidate install locations. Contains `(` for affected users (e.g., `C:\Users\AkshathaR(Contractor`).
- `LOCALAPPDATA` — read by `windows-path.ts` and `claude-desktop.paths.ts`. Derived from `USERPROFILE` when not set; inherits `(` if present.
- `APPDATA` — read by `windows-path.ts` for npm global bin directory candidates (`${APPDATA}\npm`). Affected users have `(` here too.
- `CODEMIE_HOME` — override for the codemie home dir (`src/utils/paths.ts:320`). If not set, defaults to `path.join(homedir(), '.codemie')` — which for affected users contains `(`. This path is used as `XDG_DATA_HOME` value set in the child process env; it is passed as an env var, not in the command string, so CMD.EXE metachar parsing does not apply.
- `XDG_DATA_HOME` — set by `codemie-code.plugin.ts:356` to `getOpenCodeStorageBase()` before spawning the child binary. Contains `(` for affected users but is safe as an env var.
- `OPENCODE_CONFIG` — temp file path for oversized config; written by `writeConfigToTempFile()`. If the path contains `(`, it is passed as an env var (safe) not as a shell argument.

### Configuration Files

- `C:/Projects/codemie-code/config.example.json` — user-facing config; no Windows path handling settings.
- `C:/Projects/codemie-code/tsconfig.json` — `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`. Source compiles to `dist/`; `bin/` scripts import from `dist/`.
- `C:/Projects/codemie-code/vitest.config.ts` — three test projects: `unit`, `cli`, `agent`. Coverage via v8, excluding `bin/`, `tests/`, `dist/`.

### Feature Flags and Deployment Concerns

- **No feature flag** for the Windows path quoting behavior — it is unconditional platform logic.
- **CI pipeline** (`C:/Projects/codemie-code/.github/workflows/ci.yml`): includes a `test-windows` job running `npm run test:unit` and `npm run test:integration` on `windows-latest`. The `dist/` artifact is built on Ubuntu and reused. **No CI test simulates a `(` in the runner profile path** — the GitHub-hosted Windows runner uses a clean username. Regression tests added for this bug must mock the affected path rather than relying on CI environment paths.
- **`publish.yml`**: Ubuntu only; no Windows-specific publish steps.

---

## 6. Risk Indicators

- **Primary spawn path is 100% untested on the affected code path**: `BaseAgentAdapter.ts` lines 706–771 are not exercised by any existing test. The `spawn()` call is mocked out at the `getCommandPath` level; the actual `spawn(finalCommand, finalArgs, { shell: true })` call is never reached in test execution. Any change here must be accompanied by new unit tests.
- **`exec.ts` has zero direct tests**: the foundational `exec()` function (used by virtually every process-spawning code path) has no `exec.test.ts`. The `command`-quoting fix in `exec.ts` is entirely unvalidated by any existing test.
- **`getCommandPath()` with full absolute paths is an unverified assumption**: the function was designed for bare command names (e.g., `'claude'`); passing a full absolute path like `C:\Users\AkshathaR(Contractor\...\codemie.exe` is a use case that falls outside tested behavior. The null-return scenario for absolute paths is the root cause of the unquoted-spawn failure.
- **Hand-rolled shell quoting with slight regex inconsistencies**: `BaseAgentAdapter.ts:713` uses `/[ ()&|<>^%[\]{}]/`, `:760` uses `/[ "()&|<>^%[\]{}]/` (adds `"`), and `exec.ts:65` uses `/[&|<>^%()[\]{}]/` (omits space and `"`). The inconsistency is low-risk for this bug but indicates no single canonical quoting utility exists — a shared helper should be introduced to prevent drift.
- **`validateDirectoryPath()` explicitly allows `( )`**: `src/utils/windows-path.ts:57` — while correct for `shell: false` callers, this creates a misleading signal: callers may assume `(` is safe everywhere in Windows paths. The doc comment should clarify it is only safe when shell is not involved.
- **No integration test with `(` in profile path**: CI runs on standard GitHub-hosted runners with no parentheses in their user paths. A regression in Windows path handling would not be caught by CI without mocked path tests.
- **`CODEMIE_OPENCODE_WL_BIN` workaround not documented for users**: users could work around the bug by setting this env var to a quoted or short-path value, but this is undocumented in user-facing docs.
- **`where.exe` behavior with absolute paths containing `(` is empirically unverified**: the `getCommandPath` null-return for `C:\Users\AkshathaR(Contractor\...\codemie.exe` is inferred from the observable failure, but no test directly verifies that `where.exe` fails (vs. the quoting being incorrectly applied). The fix should be robust regardless of `where.exe` behavior.
- **`exec.ts:69` concatenates unquoted `command` before quoted args**: `finalCommand = \`${command} ${quotedArgs.join(' ')}\`` — the command itself is not run through `needsQuoting()`. For `codemie-code`, this specific line is not in the affected call path (the primary spawn is direct `spawn()` in `BaseAgentAdapter.ts`), but it is a latent bug for any future caller that passes a full path as `command` with `shell: true`.

---

## 7. Summary for Complexity Assessment

**Layers and file change surface**: The bug is confined to two files that need code changes — `src/agents/core/BaseAgentAdapter.ts` (primary fix, ~3–5 lines) and `src/utils/exec.ts` (secondary fix, ~5 lines) — plus test files. The architectural layers involved are Core (agent adapter) and Utils (exec utility). No schema changes, no new dependencies, no API surface changes. The production code change is minimal: add a Windows quoting guard for `commandPath` in `BaseAgentAdapter.ts` before the `finalCommand` assembly, and add an equivalent guard for `command` in `exec.ts`. The fix follows the established quoting pattern already present in both files for args; it simply extends the same pattern to the command/path itself.

**Technical novelty**: The fix applies no new patterns — identical quoting logic (`/[ ()&|<>^%[\]{}]/` + `"${value}"` wrapping) is already used for args in the exact same functions. The gap is purely an oversight: args are quoted, but the command path is not. An optional refactor to extract a shared `quoteWindowsPath(s: string): string` utility would consolidate the three slightly-inconsistent regex variants across `BaseAgentAdapter.ts:713`, `BaseAgentAdapter.ts:760`, and `exec.ts:65`, but is not strictly required. The fix is straightforward and well-precedented in the existing code.

**Test coverage posture and key risk**: The affected spawn path in `BaseAgentAdapter.ts` has zero test coverage — no existing test reaches `spawn()` in the `run()` method. This is the highest-risk aspect: the fix will need new unit tests that mock `child_process.spawn` and verify the exact `finalCommand` string passed to it, for both the `getCommandPath-succeeds` and `getCommandPath-returns-null` branches. The secondary `exec.ts` fix also needs a new test file (`exec.test.ts`) since none exists. The primary complexity driver is therefore test authoring (verifying the exact CMD.EXE-safe command string produced), not the code change itself. Overall complexity is low-to-medium: the root cause is well-understood, the fix location is precise, and no architectural changes are required.
