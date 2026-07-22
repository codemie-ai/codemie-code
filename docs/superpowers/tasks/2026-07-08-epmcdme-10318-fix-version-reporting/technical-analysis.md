# Technical Research

**Task**: cli install claude version reporting
**Generated**: 2026-07-08T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Bug: Incorrect version installed after installing a new Claude version via 'codemie install claude <version>' when previous version is already present. The CLI prompts for reinstall, begins installation of the target version, but ultimately reports that the previous version was installed successfully. Steps: (1) Install Claude v2.1.33. (2) Run: codemie install claude 2.1.34. (3) Confirm reinstall prompt. (4) Observe: output says 'Installing Claude Code v2.1.34...' but result says 'Claude Code v2.1.33 installed successfully'. Expected: CLI should report the correct actually-installed version after every install/upgrade/downgrade. Acceptance criteria: CLI always reports the correct installed Claude version in the result message; if installation fails or does not change the version, this is clearly communicated; fix confirmed for both upgrading and downgrading scenarios.

---

## 2. Codebase Findings

### Existing Implementations

**Install command (CLI entry point)**
- `src/cli/commands/install.ts` — `createInstallCommand()` orchestrates the entire user-facing install flow. Lines 176-191 contain the exact defect site: after calling `agent.installVersion(versionToInstall)`, the code makes a second independent call to `agent.getVersion()` to obtain the version for the success message. `installVersion()` returns `void` so its internally-captured verified version is discarded before this call.

**Claude agent adapter**
- `src/agents/plugins/claude/claude.plugin.ts` — `ClaudePlugin` extends `BaseAgentAdapter` and overrides three methods central to this bug:
  - `installVersion(version?: string): Promise<void>` (line 474) — calls `installNativeAgent()`, receives `result.installedVersion`, logs it, but returns `void` without exposing it to the caller.
  - `getVersion(): Promise<string | null>` (line 360) — on non-Windows tries `exec(resolveHomeDir('.local/bin/claude'), ['--version'])` WITHOUT `shell: true`, then silently falls back to `exec('claude', ['--version'])` if the full-path exec throws.
  - `install(): Promise<void>` (line 458) — thin wrapper that calls `installVersion(undefined)`.

**Native installer utility**
- `src/utils/native-installer.ts` — `installNativeAgent()` is the workhorse. It runs the platform-specific install script, then calls `verifyInstallation()` which uses `exec(verifyCommand, ['--version'], { shell: true, timeout: 5000 })` with up to 3 retries (on Windows) or 2 retries (on Unix) and exponential back-off. Returns `NativeInstallResult` with `installedVersion: string | null`. The `installVersion()` caller receives this struct but discards `installedVersion`.

**Base adapter**
- `src/agents/core/BaseAgentAdapter.ts` — `BaseAgentAdapter.installVersion()` (line 127) is the npm-based default; also returns `Promise<void>`. `BaseAgentAdapter.getVersion()` (line 204) calls `exec(cliCommand, ['--version'])` with no retries, no shell option, and no path preference.

**Interface contract**
- `src/agents/core/types.ts` (line 774) — `AgentAdapter.installVersion?(version: string): Promise<void>` — the void return type is the primary interface-level constraint that must change to carry the verified version out.

**Plugin installer (separate concern)**
- `src/agents/plugins/claude/claude.plugin-installer.ts` — `ClaudePluginInstaller` (extends `BaseExtensionInstaller`) handles the CodeMie hook/plugin overlay installation to `~/.codemie/claude-plugin`. Not involved in this bug.

**Existing test**
- `src/cli/commands/__tests__/install.version-selection.test.ts` — only tests that `installVersion` is called with `'supported'` and the spinner succeeds. It mocks `getVersion` to return `'0.129.0'` directly, so it cannot catch this bug.

### Architecture and Layers Affected

| Layer | Component | Role in This Bug |
|---|---|---|
| CLI | `install.ts` | Defect site: calls `getVersion()` after `installVersion()` returns void |
| Agent-Plugin | `claude.plugin.ts` | `installVersion()` discards verified version; `getVersion()` has fallback that produces stale result |
| Utility | `native-installer.ts` | Correctly captures verified version in `NativeInstallResult.installedVersion` but caller ignores it |
| Interface | `types.ts` | `installVersion` return type is `void`, blocking propagation of the verified version |

### Integration Points

- `installNativeAgent()` is also used by `kimi.plugin.ts` (`installVersion` override, line 332) — same void return pattern; Kimi has the same latent bug.
- `BaseAgentAdapter.installVersion()` (npm-based) is used by Codex and other npm-installed agents. They use `getVersion()` after npm install; npm installs are more reliable on PATH so the bug is less visible there, but the interface inconsistency still exists.
- `restoreCliBinLink()` is called between `installVersion()` and `getVersion()` in `install.ts` (line 185). This operates on the `codemie` symlink, not the `claude` binary, so it does not cause the bug — but it does widen the window between install completion and the `getVersion()` call.

### Patterns and Conventions

- Agent methods follow async/await with `Promise<void>` or `Promise<T>` returns.
- Error handling uses `AgentInstallationError` from `src/utils/errors.ts`.
- All path handling goes through `resolveHomeDir()` / `getCodemiePath()` from `src/utils/paths.ts` — never hardcoded `~`.
- Logging: `logger.success()` / `logger.info()` / `logger.debug()` from `src/utils/logger.ts`.
- The `AgentAdapter` interface in `types.ts` is the authoritative contract; changes there cascade to all implementations.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No guides in `.ai-run/guides/` were checked during this research. The AGENTS.md Task Classifier maps `cli`, `command`, `commander` keywords to `architecture` (P0) and `development-practices` (P1) guides. Relevant guides to consult before implementing:
- `.ai-run/guides/architecture/architecture.md` — plugin-based 5-layer architecture
- `.ai-run/guides/development/development-practices.md` — async patterns, error handling

### Architectural Decisions

- The comment in `claude.plugin.ts` line 169 records a deliberate decision: auto-updater is disabled (`DISABLE_AUTOUPDATER=1`) so CodeMie controls Claude versions explicitly via `installVersion()`. This makes correct version reporting even more important — the user must trust that the reported version is accurate.
- The `--force` flag is always passed to the native installer (line 539 of `claude.plugin.ts`). This is intentional to overwrite existing installations.
- `verifyPath` (full absolute path) is preferred over `verifyCommand` (PATH-based) for verification on Unix, specifically to avoid PATH refresh issues (comment at line 536).

### Derived Conventions

- `installVersion()` and `getVersion()` are designed to be independent calls — the interface does not currently create any data flow between them. The fix must add that data flow.
- The `verifyInstallation()` function is the single authoritative source of truth for what version is actually on disk after install. Its result should be the one exposed to the user.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/__tests__/install.version-selection.test.ts` — tests version selection logic (defaults to supported version for claude/codex). Mocks `getVersion` directly; does not exercise the actual version-reporting code path.
- `src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts` — tests that `installVersion` resolves to `undefined` (void). These tests would need updating if the return type changes.
- `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` — tests codex npm install path.
- `src/agents/plugins/claude/__tests__/plugin-installer.test.ts` — tests `ClaudePluginInstaller` (hook overlay), not the native install path.

### Testing Framework and Patterns

- Framework: Vitest
- Pattern: `vi.mock()` for all external dependencies (`ora`, `inquirer`, registry, utilities)
- Dynamic import mocking: modules are mocked before import; see `install.version-selection.test.ts` for the exact pattern used in the install command tests
- The spinner `succeed`/`fail` mocks are used to assert what version string reaches the success message

### Coverage Gaps

The following scenarios have no test coverage and must be added to confirm the fix:
1. `installVersion()` returns the verified installed version (e.g., `'2.1.34'`) and `install.ts` uses it for the success message without calling `getVersion()` again.
2. Upgrade scenario: install 2.1.33 first, then install 2.1.34 — success message says `2.1.34`.
3. Downgrade scenario: install 2.1.34 first, then install 2.1.33 — success message says `2.1.33`.
4. Scenario where `installVersion()` returns `null` (verification failed) — success message omits version or shows fallback.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_DEBUG=true` / `process.env.CODEMIE_DEBUG` — enables verbose logging in the install command (line 31 of `install.ts`). Useful for reproducing and diagnosing the bug.
- `DISABLE_AUTOUPDATER=1` — injected into the subprocess environment by the lifecycle `beforeRun` hook; not relevant to the install command itself.
- `CODEMIE_HOME` — overrides `~/.codemie` path; relevant if tests use isolated directories.

### Configuration Files

- No config files are read or written during the install command flow for the affected code path.
- The Claude binary path is computed at runtime: `resolveHomeDir('.local/bin/claude')` → absolute path via `path.join(homedir(), '.local/bin/claude')`.

### Feature Flags and Deployment Concerns

- `--supported` flag on the CLI defaults install to `CLAUDE_SUPPORTED_VERSION = '2.1.199'` (hardcoded in `claude.plugin.ts`).
- `--force` is always passed to the native installer; no toggle for this.
- No feature flags gate this code path.

---

## 6. Risk Indicators

- **Primary defect — void return discards verified version**: `installVersion()` in `claude.plugin.ts` (line 474) and `BaseAgentAdapter` (line 127) return `Promise<void>`. The `NativeInstallResult.installedVersion` captured by `verifyInstallation()` is logged but never returned to `install.ts`. Changing the return type is an interface-breaking change that affects `types.ts`, `BaseAgentAdapter`, `claude.plugin.ts`, `kimi.plugin.ts`, and any future implementors.

- **`getVersion()` exec without shell falls back to stale PATH result**: `ClaudePlugin.getVersion()` (line 368) calls `exec(fullPath, ['--version'])` without `shell: true`. In contrast, `verifyInstallation()` in `native-installer.ts` uses `shell: true` for path-based commands. If the full-path exec fails for any reason (permissions change during install, OS file-lock during binary replacement, shebang interpretation differences without shell), `getVersion()` silently falls through to `exec('claude', ['--version'])` which may find the OLD version in PATH.

- **No retry in `getVersion()` vs 2-3 retries in `verifyInstallation()`**: `verifyInstallation()` retries up to 3 times with exponential backoff to handle PATH propagation delays and filesystem sync. `getVersion()` makes a single call with no retry. If the newly-written binary is momentarily unavailable (OS filesystem sync, NFS), `getVersion()` will return stale data.

- **`kimi.plugin.ts` has the same latent bug**: `installVersion()` in Kimi (line 332) also returns `void` and `installNativeAgent()` result is discarded. Not in scope for this ticket but should be noted.

- **Test gap — success message version not asserted against actual install**: The existing test in `install.version-selection.test.ts` mocks `getVersion` to return the expected version directly. The test passes even when the real code path returns a wrong version. No test currently exercises the full chain from `installVersion()` through to `spinner.succeed()`.

- **Interface change cascades to Kimi plugin**: Changing `installVersion` in `types.ts` from `Promise<void>` to `Promise<string | null>` requires updating `BaseAgentAdapter.installVersion`, `ClaudePlugin.installVersion`, and `KimiPlugin.installVersion` — three implementation files plus the interface.

- **`install()` method delegates to `installVersion(undefined)`**: `ClaudePlugin.install()` (line 458) calls `this.installVersion(undefined)`. If `installVersion` changes return type, `install()` also needs updating (or the CLI path through `agent.install()` also needs to capture the return value).

---

## 7. Summary for Complexity Assessment

The bug is a precise design flaw at the boundary between `installVersion()` (which captures the correct verified version inside `NativeInstallResult.installedVersion`) and `install.ts` (which ignores that result and makes a second, uncoordinated `getVersion()` call). The second call can return a stale result for two compounding reasons: `getVersion()` uses `exec()` without `shell: true` while `verifyInstallation()` uses `shell: true`, creating a behavioral difference when the binary at `~/.local/bin/claude` requires shell execution; and `getVersion()` has no retry mechanism while `verifyInstallation()` retries up to three times, meaning timing-sensitive binary replacement can produce stale reads.

The fix touches four layers: the `AgentAdapter` interface (`types.ts`) to change the return type of `installVersion`; the base implementation (`BaseAgentAdapter`) for consistency; the Claude-specific override (`claude.plugin.ts`) to return `result.installedVersion`; and the CLI command (`install.ts`) to use the returned value instead of calling `getVersion()` again. A secondary hardening fix in `ClaudePlugin.getVersion()` — adding `shell: true` to the full-path exec — is advisable to close the fallback scenario independently, but is not sufficient alone. The Kimi plugin has the same void-return pattern and should be fixed in the same pass (low additional cost). Total estimated file change surface: 4-5 files, all in the `src/agents/` and `src/cli/commands/` trees.

Test coverage for the specific scenario (upgrade, downgrade, version propagation through to spinner success message) is absent. The existing test mocks `getVersion()` directly and would not catch a regression. New tests asserting that `spinner.succeed` receives the version returned by `installVersion()` — not by a separate `getVersion()` call — are required to satisfy the acceptance criteria.
