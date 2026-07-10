# Technical Research

**Task**: test vitest claude-code cli version install setup
**Generated**: 2026-07-09T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

Implement Claude Code CLI version enforcement in tests. The feature reads CLAUDE_SUPPORTED_VERSION from src/agents/plugins/claude/claude.plugin.ts (currently '2.1.199'). When tests run: if claude-code is not installed or is at a different version (greater or less) than CLAUDE_SUPPORTED_VERSION, install that exact version globally. If already at the correct version, skip installation. This ensures developers who bump the version locally will have tests install and use the correct version from the variable. Installation must override the user's global claude-code version.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/plugins/claude/claude.plugin.ts` — Defines `CLAUDE_SUPPORTED_VERSION = '2.1.199'` at module level; exposes it as `ClaudePluginMetadata.supportedVersion`; overrides `installVersion()` to call `installNativeAgent()` with `--force` flag
- `src/agents/core/BaseAgentAdapter.ts` — Provides `checkVersionCompatibility()` (compares installed binary version against `metadata.supportedVersion`) and a base `installVersion()` that calls `npm.installGlobal`
- `tests/setup/agent-build-setup.ts` — Vitest `globalSetup` for the `agent` project; currently only checks that `claude` binary exists via `claude --version`; does **not** compare versions or enforce `CLAUDE_SUPPORTED_VERSION`; uses `execSync` (synchronous)
- `src/utils/processes.ts` — Exports `installGlobal(packageName, { version })`, `exec()`, and `commandExists()`; used by base adapter for npm-based installs
- `src/utils/native-installer.ts` — Exports `installNativeAgent()` with `--force` flag support; this is the code path Claude's `installVersion()` uses, bypassing npm for platform-native installs
- `src/utils/version-utils.ts` — Exports `compareVersions()`, `parseSemanticVersion()`, `isValidSemanticVersion()`
- `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` — Direct structural analog for the Claude equivalent unit test; tests `CODEX_SUPPORTED_VERSION`, calls `installVersion('supported')`, verifies `installGlobal` mock; this is the exact template to replicate
- `src/agents/plugins/claude/__tests__/claude.provider-support.test.ts` — Minimal; only checks `supportedProviders`; no version-support test exists for Claude
- `src/agents/plugins/claude/__tests__/plugin-installer.test.ts` — Tests `ClaudePluginInstaller` (file-based plugin install); unrelated to CLI version
- `tests/integration/sso-claude-plugin.test.ts` — Tests plugin auto-install flow; not CLI version enforcement
- `vitest.config.ts` — Defines three named projects: `unit` (`src/`), `cli` (`tests/integration/` excluding `agent-*`), `agent` (`tests/integration/agent-*.test.ts` with `globalSetup: ['tests/setup/agent-build-setup.ts']`)

### Architecture and Layers Affected

- **Plugin layer** (`src/agents/plugins/claude/claude.plugin.ts`): source of truth for `CLAUDE_SUPPORTED_VERSION`; `installVersion()` override uses native installer
- **Adapter base layer** (`src/agents/core/BaseAgentAdapter.ts`): shared `checkVersionCompatibility()` logic that compares running binary version to `metadata.supportedVersion`
- **Utility layer** (`src/utils/processes.ts`, `src/utils/native-installer.ts`, `src/utils/version-utils.ts`): install and version comparison primitives
- **Test setup layer** (`tests/setup/agent-build-setup.ts`): Vitest `globalSetup` that runs once before all `agent` project tests; the primary location to add version enforcement

### Integration Points

- `tests/setup/agent-build-setup.ts` → `src/agents/plugins/claude/claude.plugin.ts` (must import `CLAUDE_SUPPORTED_VERSION` to read the version constraint)
- `tests/setup/agent-build-setup.ts` → `src/utils/native-installer.ts` or `src/agents/plugins/claude/claude.plugin.ts` `installVersion()` (to trigger version-correct install)
- `tests/setup/agent-build-setup.ts` → `src/utils/version-utils.ts` (to compare installed vs required version)
- `agent-build-setup.ts` uses synchronous `execSync` — all new integration points must remain synchronous or be adapted with `execSync`
- `ClaudePluginMetadata.supportedVersion` — exposes `CLAUDE_SUPPORTED_VERSION` on the metadata object; accessible without instantiating the full plugin

### Patterns and Conventions

- **Version constant pattern**: module-level `const CLAUDE_SUPPORTED_VERSION = '...'` in the plugin file; consumed by `metadata.supportedVersion`; the unit test accesses it directly (not via the metadata object)
- **`codex.plugin.version-support.test.ts` is the exact template**: mock `processes.js`, dynamically import plugin, assert `supportedVersion` value, call `installVersion('supported')`, verify mocked install function was called with correct args
- **Claude diverges from Codex on install path**: Codex uses `installGlobal`; Claude uses `installNativeAgent()` with `--force`; any new unit test mock must target `native-installer.js`, not `processes.js`
- **globalSetup runs synchronously before all agent tests**: modifications to `agent-build-setup.ts` must be synchronous (`execSync`) or use top-level `async` if the setup function signature is async

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions; dynamic import pattern required for mocking (`vi.mock` must precede dynamic import); unit test structure using `describe`/`it`/`beforeEach`
- `.ai-run/guides/quality-gates.md` — `npm run test:unit` runs `vitest run --project unit`; `test:integration:agent` runs the `agent` project with `globalSetup`; test commands and CI gates

### Architectural Decisions

- Claude's `installVersion()` intentionally uses the native installer (not npm `installGlobal`) to support platform-native installs; this is captured in the plugin's `installVersion()` override which passes `--force` to `installNativeAgent()`
- The `globalSetup` in `agent-build-setup.ts` is the established hook for pre-test environment provisioning; no competing mechanism exists

### Derived Conventions

- Tests that verify version enforcement for a plugin use the codex test as a template: mock the install utility, dynamically import the plugin module, assert the `supportedVersion` constant, call `installVersion('supported')`, and assert the mock was called with version and force arguments
- The `globalSetup` pattern keeps integration test environment setup decoupled from individual test files

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` — Covers version constant value, `installVersion('supported')` invocation, and that `installGlobal` is called with the correct version; the structural template for the missing Claude test
- `src/agents/plugins/claude/__tests__/claude.provider-support.test.ts` — Covers `supportedProviders` only; no version enforcement coverage
- `src/agents/plugins/claude/__tests__/plugin-installer.test.ts` — Covers file-based plugin installation; does not touch CLI version
- `tests/setup/agent-build-setup.ts` — Integration: installs `claude` if not present but does not validate or enforce `CLAUDE_SUPPORTED_VERSION`

### Testing Framework and Patterns

- **Framework**: Vitest (three named projects: `unit`, `cli`, `agent`)
- **Dynamic import mocking**: `vi.mock('../../utils/native-installer.js', ...)` before `await import('./claude.plugin.js')` — required because Vitest hoists `vi.mock` calls; this is the pattern used by the codex analog
- **globalSetup**: runs once before all tests in the `agent` project; synchronous `execSync` calls used throughout

### Coverage Gaps

- `src/agents/plugins/claude/__tests__/` — no `claude.plugin.version-support.test.ts` exists; the exact gap this task fills
- `tests/setup/agent-build-setup.ts` — no version comparison or enforcement logic exists; only presence check; this is the second gap

---

## 5. Configuration and Environment

### Environment Variables

- No dedicated env var for `CLAUDE_SUPPORTED_VERSION`; the value lives as a module-level constant in `src/agents/plugins/claude/claude.plugin.ts`
- `.env.test.local` — optional local overrides loaded by the test setup via `dotenv`

### Configuration Files

- `vitest.config.ts` — `agent` project config; `globalSetup: ['tests/setup/agent-build-setup.ts']`; this is the entry point for version enforcement at the integration test level
- `tests/setup/agent-build-setup.ts` — current global setup; checks `claude` presence; must be extended with version comparison and conditional install

### Feature Flags and Deployment Concerns

- No feature flags govern this behavior
- `installNativeAgent()` with `--force` overrides any existing global install; this is the mechanism for ensuring the correct version even when the user has a different version installed
- The `--force` flag on the native installer is already wired in `claude.plugin.ts`'s `installVersion()`; the global setup needs to call the same code path or replicate the logic using `execSync`

---

## 6. Risk Indicators

- **No existing version enforcement in globalSetup**: `tests/setup/agent-build-setup.ts` only checks binary presence; adds no version guarantee; this is the primary gap
- **No `claude.plugin.version-support.test.ts`**: The codex analog exists; Claude does not have an equivalent; unit test coverage for the version constant and `installVersion()` is missing
- **Claude uses native installer, not `installGlobal`**: The codex test template mocks `processes.js`; the Claude equivalent must mock `native-installer.js`; applying the codex template verbatim will produce a broken test
- **Synchronous constraint in globalSetup**: `agent-build-setup.ts` uses `execSync` throughout; the version check (`claude --version`) and conditional install must remain synchronous or the setup function must be declared `async`
- **Import path for `CLAUDE_SUPPORTED_VERSION` in globalSetup**: `globalSetup` files run in Node.js directly (not inside Vitest's module system); importing a TypeScript source file from `src/agents/plugins/claude/claude.plugin.ts` may require a compiled build or `tsx`/`ts-node` registration; the existing setup file already imports TypeScript modules, so this pattern is established, but it must be verified
- **Version string format**: `CLAUDE_SUPPORTED_VERSION = '2.1.199'`; `version-utils.ts` exports `parseSemanticVersion()` and `compareVersions()` for safe comparison; using string equality alone (`===`) is fragile if the `claude --version` output includes a prefix (e.g. `Claude Code 2.1.199`)
- **Force-install side effect**: Installing a specific version globally will downgrade or upgrade the user's system-wide `claude-code`; this is intentional per requirements but should be clearly documented in the setup file comment

---

## 7. Summary for Complexity Assessment

The task requires changes in two distinct locations. First, `tests/setup/agent-build-setup.ts` must be extended to import `CLAUDE_SUPPORTED_VERSION` from the plugin, check the installed `claude --version` output using the existing `version-utils.ts` comparison utilities, and conditionally invoke the native installer with `--force` when the version is absent or does not match. Second, a new unit test file `src/agents/plugins/claude/__tests__/claude.plugin.version-support.test.ts` must be created following the exact structure of the Codex analog, with the critical difference that the mock target is `native-installer.js` rather than `processes.js`. Total file change surface is small: one modification to `tests/setup/agent-build-setup.ts`, one new test file, and no changes to production source code (the version constant and `installVersion()` override already exist and are correct).

The task follows an established pattern — the Codex plugin has the equivalent version-support test, and `BaseAgentAdapter` already has `checkVersionCompatibility()` logic — so there is no architectural novelty. The only non-trivial decision is how the `globalSetup` file imports a TypeScript source module (the plugin file) at test setup time; the existing setup already does this, establishing the precedent. The synchronous constraint of `execSync` in the current setup must be respected or the function signature explicitly upgraded to `async`.

Test coverage posture for the affected area is weak: no version-support test exists for Claude, and the global setup has no version enforcement. The new test file and setup changes together will close both gaps. The primary risks are the native-installer mock target (must not copy the Codex mock blindly), the version string parsing from `claude --version` output (must strip any prefix before comparison), and the side effect of force-installing a version globally (intentional, but warrants a comment in the setup file). Overall complexity is low-to-medium: well-understood pattern, small surface area, established utilities, but requires careful attention to the Claude-vs-Codex install path difference.
