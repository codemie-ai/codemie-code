# Technical Research

**Task**: agent version check supported-version doctor plugin registry launch install update setup ACP wrapped-agent claude codex gemini kimi
**Generated**: 2026-08-04T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-13734 — "User-friendly agent version handling — warn once, never block"

Replace blocking agent version checks with a one-time, non-blocking "untested version" warning that warns once per (agent, agent version, running CodeMie version) combination and never blocks execution.

Background: CodeMie CLI pins an exact "supported version" per wrapped agent (claude, codex, gemini, kimi). When a user runs a newer/older agent version, they get warned or blocked on every launch, and the pinned version is permanently out of date. The check creates friction without adding safety. Trust must shift to the user: inform them once that a combination is untested, then let them proceed.

Requirements summary:
- Remove all pinned per-agent supported-version constants (e.g. CLAUDE_SUPPORTED_VERSION and equivalents for codex, gemini, kimi) and any release-process step that bumps them.
- At agent launch, install, update, setup, and `codemie doctor`: detect the installed agent version; if the (agent, agent version, running CodeMie version) tuple has never been warned before at the user level, show a one-time informational "untested version" warning and proceed. Otherwise stay silent.
- In non-interactive / ACP / silent / scripted / CI / non-TTY contexts: log the warning and proceed automatically. Never throw and never block on version mismatch.
- Provide a reset mechanism (flag or config option) that clears the user-level "already warned" markers so warnings reappear.
- `codemie doctor` / health output must display each wrapped agent's installed version and its "verification status" against the running CodeMie version.
- No flow may offer only "install a different version or exit" — there must always be a path to proceed.
- Because pinned constants disappear, no CodeMie release or manual bump should be needed to keep users unblocked when agent CLIs release new versions.

Affected areas: agent launch flow, install/update/setup commands, non-interactive/ACP/silent execution, `codemie doctor`, agent plugin metadata, release process.

---

## 2. Codebase Findings

### Existing Implementations

**Version constant declarations (all must be removed):**
- `src/agents/plugins/claude/claude.plugin.ts` line 38 — `CLAUDE_SUPPORTED_VERSION = '2.1.218'`; line 48 — `CLAUDE_MINIMUM_SUPPORTED_VERSION = '2.1.208'`; both written into `ClaudePluginMetadata` object
- `src/agents/plugins/codex/codex.plugin.ts` line 73 — `CODEX_SUPPORTED_VERSION = '0.143.0'`; line 83 — `CODEX_MINIMUM_SUPPORTED_VERSION = '0.133.0'`; both written into `CodexPluginMetadata`
- `src/agents/plugins/gemini/gemini.plugin.ts` line 15 — `GEMINI_SUPPORTED_VERSION = '0.29.5'`; line 25 — `GEMINI_MINIMUM_SUPPORTED_VERSION = '0.29.0'`; both written into `GeminiPluginMetadata`
- `src/agents/plugins/kimi/kimi.plugin.ts` line 23 — `KIMI_SUPPORTED_VERSION = '0.16.0'`; line 24 — `KIMI_MINIMUM_SUPPORTED_VERSION = '0.15.0'`; both written into `KimiPluginMetadata`
- `src/agents/core/types.ts` — `AgentMetadata.supportedVersion?: string` and `AgentMetadata.minimumSupportedVersion?: string` optional interface fields that receive these constants

**Version check enforcement (primary target):**
- `src/agents/core/BaseAgentAdapter.ts` lines 272–373 — `checkVersionCompatibility()`: spawns agent binary via `exec` to get installed version, calls `compareVersions()` from `src/utils/version-utils.ts`, returns `VersionCompatibilityResult { compatible, installedVersion, supportedVersion, isNewer, hasUpdate, isBelowMinimum, minimumSupportedVersion? }`
- `src/agents/core/BaseAgentAdapter.ts` lines 383–506 — `run()`: the enforcement gate. Three branches:
  - `isBelowMinimum` → **BLOCKING**: interactive path shows `inquirer.prompt` with "Install supported version / Exit" choices, calls `process.exit(0)`; silentMode path **throws** an Error
  - `isNewer` → **BLOCKING INTERACTIVE PROMPT**: `inquirer.prompt` with "Install supported / Continue / Exit"; calls `process.exit(0)` on "exit"
  - `hasUpdate && compatible` → **INFORMATIONAL PROMPT**: `inquirer.prompt` with "Update / Continue / Exit"

**ACP variant:**
- `src/agents/plugins/claude/claude-acp.plugin.ts` — inherits `ClaudePlugin`; sets `silentMode: true` in metadata; version checks inherited from `BaseAgentAdapter`; the `silentMode` flag causes the `isBelowMinimum` path to throw instead of prompt

**Version check callers outside `run()`:**
- `src/cli/commands/install.ts` — calls `agent.checkVersionCompatibility()` only to resolve the `'supported'` version keyword for install and to display notes; no blocking check. **Critical ripple**: removing `supportedVersion` from metadata breaks the `'supported'` keyword resolution in the install command.
- `src/cli/commands/update.ts` — calls `agent.checkVersionCompatibility()` for Claude/built-in only to determine if an update is available; non-blocking
- `src/cli/commands/setup.ts` line ~883 — calls `claude.checkVersionCompatibility()` with 3-second timeout; shows `chalk.yellow` warning for `isNewer`, `chalk.green` for `compatible`; non-blocking

**Doctor/health check:**
- `src/cli/commands/doctor/checks/AgentsCheck.ts` — currently shows each agent's installed version and checks for deprecated npm installations; does NOT call `checkVersionCompatibility()` and does NOT show a compatibility/verification status field today
- `src/cli/commands/doctor/index.ts` — doctor command orchestrator; runs `AgentsCheck` as one of multiple checks

**Registry:**
- `src/agents/registry.ts` — `AgentRegistry` singleton; `getManageableAgents()`, `getInstalledAgents()`, `getAgent()`; all four plugins are registered here

**Agent registry test setup (critical coupling):**
- `tests/setup/agent-build-setup.ts` — Vitest `globalSetup` for the agent project; directly imports `CLAUDE_SUPPORTED_VERSION` from the built dist to decide whether to install or reinstall the Claude CLI before running integration tests. **Removing this constant breaks the global test setup.**

### Architecture and Layers Affected

- **Plugin metadata layer**: Four plugin files (`claude.plugin.ts`, `codex.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts`) each declare version constants and embed them in metadata objects. The `AgentMetadata` interface in `types.ts` declares the two optional version fields.
- **Agent adapter / core layer**: `BaseAgentAdapter.ts` owns `checkVersionCompatibility()` (comparison logic) and the enforcement block inside `run()` (UX and blocking behavior). This is the primary file to refactor.
- **CLI commands layer**: `install.ts`, `update.ts`, `setup.ts` each call `checkVersionCompatibility()` independently for their own purposes. The `'supported'` version keyword in `install.ts` is coupled to `metadata.supportedVersion`.
- **Doctor / health layer**: `AgentsCheck.ts` needs a new "verification status" field in its output.
- **State persistence layer**: No "already warned" store exists today. A new persistent marker store must be introduced under `~/.codemie/` (details in Section 5).
- **Types layer**: `VersionCompatibilityResult`, `AgentMetadata` — both require field removal/addition as part of this change.

### Integration Points

- `BaseAgentAdapter` → `src/utils/version-utils.ts` (`compareVersions`, `isValidSemanticVersion`)
- `BaseAgentAdapter` → `inquirer` (interactive prompts — to be removed from version-check paths)
- `BaseAgentAdapter` → `src/utils/logger.ts` (`logger.warn()`, `logger.info()`)
- `AgentRegistry` → all four plugin files
- `install.ts` → `AgentRegistry` → plugin `installVersion('supported')` — the `'supported'` keyword resolution depends on `metadata.supportedVersion` being present
- `AgentsCheck.ts` → `AgentRegistry` → `getInstalledAgents()` for the doctor output
- New warned-state store → `src/migrations/tracker.ts` (reuse pattern) or a new `src/utils/warned-versions.ts` module → `src/utils/paths.ts` (`getCodemiePath()`)

### Patterns and Conventions

- Each plugin file declares its version constants as module-level `const` exports with JSDoc `@description UPDATE THIS WHEN BUMPING` markers. These markers and constants are fully removed by this task.
- `supportedVersion` and `minimumSupportedVersion` are optional fields on `AgentMetadata`. Callers already handle their absence via optional chaining; removing the fields from the interface is safe once all write sites are removed.
- The `silentMode: true` flag on ACP plugins (set in their plugin metadata) is the existing gate for "no interactive output." Any new warning path must check `metadata.silentMode` before writing chalk output to stdout. In silentMode, use `logger.warn()` only (writes to log file + stderr).
- Non-interactive detection in `AgentCLI.ts` line 692: `!process.stdin.isTTY || process.env.CODEMIE_NO_PROMPTS === '1'` — this is the canonical signal to skip `inquirer.prompt` calls.
- `DISABLE_AUTOUPDATER=1` must remain in `lifecycle.beforeRun` (per the existing ADR) regardless of version-check changes.
- Logger: singleton `logger` from `src/utils/logger.ts`; `logger.warn()` writes to console + log file. For chalk-formatted terminal output, the existing pattern is `console.error(chalk.yellow(...))` or `console.log(chalk.yellow(...))` guarded by `!this.metadata.silentMode`. The `AGENTS.md` rule permits `console.log(chalk....)` for interactive UI output but prohibits plain `console.log()` for debug.
- Warn output must sanitize args with `sanitizeLogArgs()` before passing to `logger` (mandated by `AGENTS.md`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — defines the five-layer architecture (`CLI → Registry → Plugin → Core → Utils`); confirms version-check logic belongs in the `Core` layer (`BaseAgentAdapter`), not in CLI commands directly
- `.ai-run/guides/development/development-practices.md` — mandates `logger.warn()` for recoverable issues; specifies that channel aliases (`latest`, `stable`, `supported`) must never trigger a version mismatch; documents the `getVersion()` null-return defensive pattern post-install
- `.ai-run/guides/testing/testing-patterns.md` — dynamic `await import()` required for Vitest module isolation; lazy-getter override for class-level static fields; relevant for mocking the new warned-state store
- `.ai-run/guides/integration/external-integrations.md` — references ADR-002 (OpenCode config injection); no ADR for version-check behavior

### Architectural Decisions

- **ADR (version config location)**: `supportedVersion` stored in plugin metadata objects (co-located, type-safe, no I/O) — this ADR is superseded by the ticket; the field disappears entirely
- **ADR (install flag)**: `--supported` flag for install command; removing `supportedVersion` will require reconsidering what `--supported` resolves to (it currently maps to `metadata.supportedVersion`)
- **ADR (minimumSupportedVersion rule)**: 10 patch versions below `supportedVersion`; this rule is removed with the constants
- **ADR (auto-updater)**: `DISABLE_AUTOUPDATER=1` in `lifecycle.beforeRun` — unchanged by this task
- **ADR (post-install null return)**: `getVersion()` returns `null` on failure; callers degrade gracefully — the new warned-state logic must handle `null` installedVersion (no warning if version cannot be detected)
- **ADR (silentMode throw)**: In ACP/silentMode, version errors currently throw rather than writing prose to stdout. This task changes the behavior: instead of throwing, silentMode should call `logger.warn()` and proceed. This supersedes the existing silentMode throw ADR for version mismatches.

### Derived Conventions

- Warning UI uses `chalk.yellow` for non-blocking warnings, `chalk.red` for blocking errors. The new one-time notice should use `chalk.yellow`.
- All state files live under `~/.codemie/` via `getCodemiePath()` from `src/utils/paths.ts`. `CODEMIE_HOME` env var overrides the home directory (used in tests via `setupTestIsolation()`).
- A "has this already happened" check follows the `MigrationTracker` pattern: write a JSON record with an ID and `appliedAt` timestamp; query with `hasBeenApplied(id)`. The ID encodes all discriminating fields.
- The `checkVersionCompatibility()` call is expensive (spawns a subprocess). With the new one-time-per-session model, the check should short-circuit immediately if the tuple has already been warned (read the state store first, skip the subprocess if already recorded).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` — asserts the `CODEX_SUPPORTED_VERSION` constant value, exercises `checkVersionCompatibility()` for `isNewer` and `isBelowMinimum` scenarios, and tests `installVersion('supported')` calls. This test file must be substantially rewritten (the constant disappears, the scenarios change).
- `src/cli/commands/__tests__/install.version-selection.test.ts` — exercises install command flow: calls `checkVersionCompatibility`, defaults to `'supported'` version, stale-PATH warning path; mocks the full `AgentRegistry`. Affected by removal of `'supported'` version keyword.
- `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — tests `run()` pipeline for reasoning effort, Windows path quoting, dry-run, proxy. Does NOT cover version-check branches (no `supportedVersion` in any test metadata).
- `src/agents/__tests__/registry.test.ts` — asserts all plugins are registered and have required interface methods; does not check version constants.
- `src/cli/commands/__tests__/setup.enforcement.test.ts` — tests setup wizard with `checkVersionCompatibility` mock on Claude adapter; does not exercise the version-check path inside `setup.ts` line ~883.
- `tests/setup/agent-build-setup.ts` — globalSetup for agent integration project; directly imports `CLAUDE_SUPPORTED_VERSION` from the built dist. Removing this constant breaks the integration test global setup.
- `tests/integration/cli-commands/doctor.test.ts` — runs `codemie doctor` CLI, checks Node/npm/Python/uv output; no agent version or compatibility checks.

### Testing Framework and Patterns

- Vitest, multi-project config: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**` excluding `agent-*`), `agent` (`tests/integration/agent-*.test.ts`)
- `vi.mock(path, factory)` at file top; `vi.fn()` / `vi.mocked(x).mockResolvedValue(...)` for async stubs
- `beforeEach(() => vi.clearAllMocks())` in every unit suite
- Dynamic `await import(...)` inside test bodies for fresh module instances after mocks (required for all agent plugins due to top-level side-effects)
- `vi.hoisted()` for variables that must be hoisted above `vi.mock` calls
- `setupTestIsolation()` from `tests/helpers/test-isolation.ts` — sets a per-suite `CODEMIE_HOME` env var pointing to a temp directory; this is the mechanism to isolate the new warned-state JSON file during tests
- Shared helpers: `tests/helpers/CLIRunner`, `TempWorkspace`, `pty-session`, `session-poll`
- Agent integration tests: `globalSetup: ['tests/setup/agent-build-setup.ts']`, `testTimeout: 180000`

### Coverage Gaps

1. `BaseAgentAdapter.run()` version check branches — `isBelowMinimum` blocking prompt and `isNewer` interactive prompt are entirely untested at the unit level; zero test metadata sets `supportedVersion`
2. New one-time warning behavior — does not exist yet; no tests for warned-state store read/write, tuple deduplication, or reset mechanism
3. Claude, Gemini, Kimi plugin version constant tests — only Codex has `codex.plugin.version-support.test.ts`; no equivalents for the other three agents
4. `setup.ts` claude version check path (~line 883) — calls `checkVersionCompatibility()` with timeout but is not covered by `setup.enforcement.test.ts`
5. `update.ts` version check path — calls `checkVersionCompatibility()` for Claude during update; no dedicated update command test file exists
6. `AgentsCheck.ts` version status output — doctor check is only tested via full CLI integration test, which does not assert agent version compatibility fields
7. `agent-build-setup.ts` coupling — the integration test global setup imports `CLAUDE_SUPPORTED_VERSION` from dist; removing the constant requires updating this file and deciding on the replacement install strategy

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides `~/.codemie/` for all user-level state; used by `setupTestIsolation()` for test isolation of config, sessions, logs, and the new warned-state file
- `CODEMIE_NO_PROMPTS` — when set to `'1'`, suppresses interactive prompts (checked in `AgentCLI.ts` line 692); equivalent to non-TTY signal for the version-check prompt gate
- `CODEMIE_DEBUG` — enables debug logging

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — global multi-provider config; managed by `ConfigLoader` (`src/utils/config.ts`); holds profiles, skills, assistants, active profile, user email. Not the right place for warned-version markers (config is user-editable; markers should be opaque state).
- `~/.codemie/migrations.json` — migration history managed by `MigrationTracker` (`src/migrations/tracker.ts`); format: `{ version: 1, migrations: [{ id, appliedAt, success }] }`. The `MigrationTracker` pattern is directly reusable for warned-version markers (see State Persistence below).
- `~/.codemie/installation-id` — plain-text UUID; created once by `getInstallationId()`
- `config.example.json` (repo root) — template; governs provider, baseUrl, apiKey, model, timeout, debug, allowedDirs, ignorePatterns

### Feature Flags and Deployment Concerns

- No feature flags (`featureFlag`, `FEATURE_`, toggle) exist in `src/` today.
- **State persistence for warned markers**: Two viable approaches both follow existing patterns:
  - **Option A — Dedicated file**: `~/.codemie/version-warnings.json` (new file, similar to `migrations.json`); format: `{ version: 1, warnings: [{ agentName, agentVersion, codemieVersion, warnedAt }] }`. A new `VersionWarningStore` class in `src/utils/warned-versions.ts` reads/writes this file via `getCodemiePath('version-warnings.json')`. Lookup is `warnings.some(w => w.agentName === agent && w.agentVersion === agentVer && w.codemieVersion === codemieVer)`.
  - **Option B — Reuse `MigrationTracker`**: Mint synthetic IDs like `warn-untested-claude-2.1.219-codemie-1.5.0`; call `MigrationTracker.hasBeenApplied(id)` to check and `MigrationTracker.recordMigration(id, true)` to record. Simpler but pollutes the migrations file with non-migration records and makes the reset mechanism harder to scope.
  - Option A is preferred: the reset mechanism (flag or config option to clear warned markers) maps cleanly to deleting or truncating `version-warnings.json` without touching migrations.
- **Reset mechanism**: A `codemie config reset-version-warnings` subcommand or a `--reset-version-warnings` flag on `codemie doctor` would delete/truncate `version-warnings.json`. Alternatively, `CODEMIE_RESET_VERSION_WARNINGS=1` env var for CI use.
- **`'supported'` install keyword**: `install.ts` resolves `--version supported` to `metadata.supportedVersion`. When this field is removed from metadata, the `'supported'` keyword has no resolution target. The implementation plan must decide: (a) remove the `--supported` flag from the install command entirely, (b) replace it with `--latest` (resolves via npm registry), or (c) keep the keyword but resolve it differently.

---

## 6. Risk Indicators

- **`BaseAgentAdapter.run()` version-check block has zero unit test coverage**: the `isBelowMinimum` and `isNewer` branches (lines 383–472) are not exercised by any unit test. Any refactor of this block is high-risk without first adding tests.
- **`tests/setup/agent-build-setup.ts` imports `CLAUDE_SUPPORTED_VERSION` from built dist**: removing the constant without updating this file will break all agent integration tests at the `globalSetup` stage. This file must be updated as part of the same PR; the replacement logic (e.g., always install latest, or skip version-pinned install) must be decided.
- **`install.ts` `'supported'` keyword resolution**: `installVersion('supported')` currently resolves to `metadata.supportedVersion`. Removing the field from `AgentMetadata` breaks this resolution. The install command needs a replacement strategy (install latest, or query npm registry). This is a user-visible behavioral change not explicitly addressed in the ticket requirements.
- **`codex.plugin.version-support.test.ts` asserts constant values**: this test will fail as written once constants are removed; it must be rewritten to cover the new one-time-warning behavior instead.
- **ACP silentMode currently throws on `isBelowMinimum`**: the ticket requires "never throw and never block on version mismatch" in non-interactive contexts. The existing silentMode ADR (throw structured error) is superseded for this specific case. Care must be taken not to break other silentMode throw paths unrelated to version checks.
- **`checkVersionCompatibility()` spawns a subprocess**: the call is expensive. If the new design calls it on every launch (to obtain `installedVersion` for the tuple check), it still pays the subprocess cost even when the tuple is already recorded. The store should be checked first; if the tuple is already warned, skip the subprocess entirely. This requires storing the result from prior launches.
- **No equivalent version test for Claude, Gemini, or Kimi plugins**: only Codex has a dedicated version test. The new behavior needs test coverage for all four agents.
- **`AgentsCheck.ts` doctor output gap**: the doctor command currently shows installed version but not verification/compatibility status. The new "verification status" field specified in the ticket requirements does not exist and must be added.
- **`DISABLE_AUTOUPDATER=1` in `lifecycle.beforeRun`**: this must remain in place regardless of version-check changes (per existing ADR); do not inadvertently remove it during the BaseAgentAdapter refactor.
- **No CHANGELOG in the repo**: breaking changes (removal of `--supported` flag or change in `isBelowMinimum` behavior) must be called out in PR descriptions and GitHub Release notes.
- **codegraph not indexed**: research was conducted via filesystem fallback; symbol cross-references were built manually from grep results.

---

## 7. Summary for Complexity Assessment

This task touches five architectural layers and approximately 12–18 source files. The primary refactor target is `src/agents/core/BaseAgentAdapter.ts`, specifically the `checkVersionCompatibility()` method (lines 272–373) and the version-enforcement block inside `run()` (lines 383–506). Four plugin files (`claude.plugin.ts`, `codex.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts`) need constant removal and metadata cleanup. The `AgentMetadata` interface and `VersionCompatibilityResult` type in `types.ts` need field removal. Two CLI command files (`setup.ts`, `update.ts`) need their `checkVersionCompatibility()` call sites updated. The `AgentsCheck.ts` doctor check needs a new "verification status" output field. One new module must be created (`src/utils/warned-versions.ts` or equivalent) along with a new state file at `~/.codemie/version-warnings.json`. A reset mechanism must be plumbed through to at least one command or env var.

Technical novelty is low-to-moderate: the one-time-warned-marker pattern maps closely to the existing `MigrationTracker` in `src/migrations/tracker.ts` (`hasBeenApplied` / `recordMigration`). The architectural inversion — from "block unless proven safe" to "trust but note once" — is conceptually straightforward, but the silentMode behavior change (from throw to log-and-proceed) is a breaking behavioral change for ACP consumers and must be deliberate. The `'supported'` install keyword resolution gap (not covered by the ticket requirements) is a latent breakage that needs a decision before implementation.

Test coverage posture is poor for the specific code being changed: `BaseAgentAdapter.run()` version-check branches have zero unit coverage, and `agent-build-setup.ts` directly imports `CLAUDE_SUPPORTED_VERSION` from dist, so removing the constant will break integration test global setup immediately. The implementation plan should include (a) adding unit tests for the current `run()` version-check block before modifying it, (b) rewriting `codex.plugin.version-support.test.ts` and adding equivalents for the other three agents, (c) adding unit tests for the new warned-state store, and (d) fixing `agent-build-setup.ts` in the same PR. The `setupTestIsolation()` helper already isolates `CODEMIE_HOME`, so the new `version-warnings.json` state file will be automatically isolated in existing unit tests that use it.
