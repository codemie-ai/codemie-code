# Technical Research

**Task**: agent version-check update compatibility
**Generated**: 2026-09-22T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14767 — Smarter Agent Version Recommendations. Replace the hand-edited "supported version" constants (e.g. KIMI_SUPPORTED_VERSION='0.42.0' in src/agents/plugins/kimi/kimi.plugin.ts:26, Claude's ClaudePluginMetadata.supportedVersion) with a live-tracked "latest upstream version" number, fetched via npm registry lookups (reusing getLatestVersion() in src/utils/processes.ts:314), cached for 24h with force-refresh available via `codemie doctor` and `codemie update`. Reconcile the two divergent "is this current?" code paths: checkVersionCompatibility() in src/agents/core/BaseAgentAdapter.ts:284 (today: pure local compare, zero network I/O, called from AgentsCheck.ts/install.ts/setup.ts on effectively every launch) vs checkAgentForUpdate() in src/cli/commands/update.ts:45 (today: correctly queries npm via getLatestVersion() for standard agents, but special-cases Claude at update.ts:58-79 by copying checkVersionCompatibility()'s hardcoded supportedVersion instead of checking). After this change, checkAgentForUpdate() should do its own real current-vs-latest comparison for every agent uniformly, Claude included, sourced from npm for both Claude (@anthropic-ai/claude-code) and Kimi (@moonshot-ai/kimi-code) — verified empirically that npm tracks each project's real upstream releases in lockstep. minimumSupportedVersion (the hard startup-blocking floor, isBelowMinimum in VersionCompatibilityResult) stays hardcoded and untouched — explicitly out of scope. UI copy changes from a "CodeMie verified this version" framing to "a newer version is available" (exact strings/locations to be found in research). New requirement: a single GLOBAL (not per-agent) on/off config setting to enable/disable the live version-check entirely, following the existing ConfigLoader priority layering (CLI args > env vars > project config > global config > defaults; global config lives in ~/.codemie/codemie-cli.config.json), with a fail-safe default — since the global EnvConfig store is string-only key-value, an invalid/unrecognized stored value must resolve to "checks enabled", never silently disabled. This setting must gate all three flows: the agent-run startup warning, `codemie setup`, and `codemie update`. Explicitly out of scope: automated backend-compatibility testing of new agent versions against CodeMie, opencode/pi agent support, per-agent toggle granularity (global only).

---

## 2. Codebase Findings

### Existing Implementations

**Agent core (local, hardcoded comparison — unchanged per ticket except downstream copy/UI):**
- `src/agents/core/BaseAgentAdapter.ts:284` `checkVersionCompatibility()` — reads `this.metadata.supportedVersion` / `minimumSupportedVersion` (hand-edited constants), calls local `getVersion()`, compares with `compareVersions()` from `version-utils.ts`. Zero network I/O. Returns `VersionCompatibilityResult { compatible, installedVersion, supportedVersion, isNewer, hasUpdate, isBelowMinimum, minimumSupportedVersion }`.
- `src/agents/core/BaseAgentAdapter.ts:395` `warnOnceIfUntested()` — calls `checkVersionCompatibility()`, dedupes via `VersionWarningStore` (`src/utils/version-warnings.ts`), emits notice `"CodeMie recommends ${displayName} v${supportedVersion}; you are running v${installedVersion}"`. Called from `run()` (agent-run startup), `install.ts` (post-install), `update.ts` `updateAgent()` (post-update).
- `src/agents/core/BaseAgentAdapter.ts:472` `blockIfBelowMinimum()` — hard gate using `isBelowMinimum` from the same result; explicitly out of scope for this ticket but shares `VersionCompatibilityResult`.
- `src/agents/core/types.ts:195-209` `VersionCompatibilityResult` interface; `src/agents/core/types.ts:211-374` `AgentMetadata` interface — `supportedVersion?: string` (line 228, doc'd as "Latest version tested with the CodeMie backend"), `minimumSupportedVersion?: string` (line 237, doc'd as the hard floor).

**Hand-edited per-agent constants (the ones the ticket wants replaced by live npm lookups):**
- `src/agents/plugins/claude/claude.plugin.ts:39` `CLAUDE_SUPPORTED_VERSION = '2.1.269'`, `:51` `CLAUDE_MINIMUM_SUPPORTED_VERSION = '2.1.218'` (comment: "UPDATE THIS WHEN BUMPING CLAUDE VERSION"), wired into `ClaudePluginMetadata` at `:66`.
- `src/agents/plugins/kimi/kimi.plugin.ts:26` `KIMI_SUPPORTED_VERSION`, `KIMI_MINIMUM_SUPPORTED_VERSION`, wired into `KimiPluginMetadata` at `:36`.
- `src/agents/plugins/gemini/gemini.plugin.ts:16` `GEMINI_SUPPORTED_VERSION`, `:27` `GEMINI_MINIMUM_SUPPORTED_VERSION` — same pattern, third agent with the constant (not named in ticket scope but shares the mechanism).

**Update-check path (queries npm today, except for Claude):**
- `src/cli/commands/update.ts:45` `checkAgentForUpdate(agent)` — for standard npm agents and the built-in agent, calls `npm.getLatestVersion(npmPackage)` (real npm query) and compares with `compareVersions()`. For Claude specifically (`:58-79`), it does **not** query npm: it calls `agent.checkVersionCompatibility()` and treats `compat.supportedVersion` (the hardcoded constant) as the "latest" value — this is the exact special-case the ticket names.
- `src/cli/commands/update.ts:146` `checkAllAgentsForUpdates()` — parallel-maps `checkAgentForUpdate` over `AgentRegistry.getManageableAgents()`.
- `src/cli/commands/update.ts:210` `updateAgent(agent, latestVersion)` — Claude branch installs `'supported'` (i.e. the hardcoded constant) rather than the checked `latestVersion`; other agents `installGlobal(npmPackage, { version: latestVersion, force: true })`.
- `src/cli/commands/update.ts:289` — UI copy for Claude when no update is found: `` `${agent.displayName} is already up to date with latest verified version by CodeMie (${result.currentVersion})` `` — one of the two "verified" framing locations the ticket wants reworded.

**npm/version utilities (reusable building blocks):**
- `src/utils/processes.ts:315` `getLatestVersion(packageName, options)` — runs `npm view <pkg> version`, 10s default timeout, returns `string | null`. Already used by `checkAgentForUpdate` for non-Claude agents; ticket names this as the function to reuse for Claude/Kimi live lookups.
- `src/utils/version-utils.ts` — `parseSemanticVersion` (strict `major.minor.patch` regex, no pre-release/build metadata support), `compareVersions` (treats `'latest'`/`'stable'` as always-highest), `isValidSemanticVersion`.
- `src/utils/version-warnings.ts` `VersionWarningStore` — persists a one-time-per-(agent, installedVersion, supportedVersion) acknowledgement to `~/.codemie/version-warnings.json`; **not** a TTL cache — it is a dedup marker for the notice, not a fetched-value cache.

**Doctor / setup / install integration points:**
- `src/cli/commands/doctor/checks/AgentsCheck.ts:37` `buildDetail(agent)` — calls `agent.checkVersionCompatibility()` (local), UI copy: `` `${displayName}${versionStr} - CodeMie recommends v${compat.supportedVersion}` `` (already "recommends" framing, not "verified").
- `src/cli/commands/setup.ts:706` `checkAndInstallClaude()` — Claude-only path, calls `claude.checkVersionCompatibility()` with a 3s race-timeout guard; UI copy at **`setup.ts:783`**: `` `CodeMie has only tested and verified v${compat.supportedVersion}` `` — the other concrete "verified" framing location named by the ticket.
- `src/cli/commands/install.ts:229` — calls `agent.warnOnceIfUntested()` after a fresh install/version-mismatch report.

### Architecture and Layers Affected

- **Agent Core layer** (`src/agents/core/`) — `BaseAgentAdapter` (shared version-check/warn/block logic), `types.ts` (`VersionCompatibilityResult`, `AgentMetadata`).
- **Agent Plugin layer** (`src/agents/plugins/{claude,kimi,gemini}/*.plugin.ts`) — per-agent hardcoded version constants and `AgentMetadata` wiring.
- **CLI Commands layer** (`src/cli/commands/update.ts`, `src/cli/commands/setup.ts`, `src/cli/commands/doctor/checks/AgentsCheck.ts`, `src/cli/commands/install.ts`) — the three flows named in scope (startup warning via `install.ts`/`BaseAgentAdapter.run()`, `codemie setup`, `codemie update`) plus `codemie doctor`.
- **Utils layer** (`src/utils/processes.ts`, `src/utils/version-utils.ts`, `src/utils/version-warnings.ts`, `src/utils/config.ts`) — npm lookup primitive, semver comparison, notice dedup store, and `ConfigLoader` (global config priority chain).
- **Config/Env layer** (`src/env/types.ts`, `src/utils/config.ts`) — `CodeMieConfigOptions = ProviderProfile & WorkspaceConfig`; `ConfigLoader.load()` implements the CLI > env > project > global > defaults priority the ticket asks the new toggle to follow.

### Integration Points

- `AgentRegistry.getManageableAgents()` / `getInstalledAgents()` (`src/agents/registry.ts`) feed both `checkAgentForUpdate` (update.ts) and `AgentsCheck` (doctor) — any new caching layer sits behind these entry points for every managed agent, not just Claude/Kimi.
- `getCurrentCliVersion()` (`src/utils/cli-updater.ts`) is used alongside `getLatestVersion` for the built-in agent's own update check and inside `warnOnceIfUntested()`'s notice text.
- `VersionWarningStore` is also referenced from `src/cli/commands/doctor/index.ts` (2nd caller besides `BaseAgentAdapter.ts`), i.e. `codemie doctor` already touches the notice-store lifecycle — the likely wiring point for a "force-refresh" reset, though the exact doctor flag/command was not read in full.
- `npm.installGlobal` / `npm.getLatestVersion` (`src/utils/processes.ts`) are the only npm registry touchpoints in the codebase for agent versions.

### Patterns and Conventions

- Per-agent plugin metadata is a flat exported `const` object (`ClaudePluginMetadata`, `KimiPluginMetadata`, …) built from module-level constants — any live-fetched value would need to either replace these at metadata-construction time or be read lazily by `checkVersionCompatibility`/`checkAgentForUpdate` rather than baked into the static metadata object.
- `WorkspaceConfig` (`src/env/types.ts:134-143`) already has a **direct precedent for a global nested on/off toggle**: `metrics: { enabled?: boolean; sync: { enabled?: boolean; ... } }`, stored in the same `~/.codemie/codemie-cli.config.json` the ticket names, and resolved through the same `ConfigLoader` priority chain.
- `ConfigLoader.loadFromEnv()` (`src/utils/config.ts:412-452`) is the existing pattern for reading a `CODEMIE_*` boolean env var: `env.debug = process.env.CODEMIE_DEBUG === 'true'` — note this pattern resolves any value other than the literal string `'true'` (including typos/garbage) to `false`, i.e. it is **fail-closed**, not fail-open.
- `BaseHealthCheck` / `HealthCheck` interfaces (`src/providers/core/base/BaseHealthCheck.ts`, `src/cli/commands/doctor/types.ts`) are the doctor-check pattern; `AgentsCheck implements ItemWiseHealthCheck` with `run()` and `runWithItemDisplay()`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/usage/project-config.md` — directly documents the `ConfigLoader` priority chain (`CLI args > Environment variables > Project config > Global config > Defaults`), the two config file locations (`~/.codemie/codemie-cli.config.json`, `.codemie/codemie-cli.config.json`), and the diagnostic `codemie profile status --show-sources`. This matches the ticket's stated requirement for the new toggle almost verbatim.
- `.ai-run/guides/architecture/architecture.md` — general 5-layer architecture reference (not read in full this pass; referenced by the Guide Map for `agent`/`plugin`/`registry` keywords).
- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions, not read in full; testing is out of scope unless explicitly requested per repo policy.

### Architectural Decisions

- Inline comment at `src/agents/core/BaseAgentAdapter.ts:466-471` records the deliberate decision that `minimumSupportedVersion` is "the only remaining hard gate" and everything above it is a non-blocking recommendation — this is the documented rationale for why `blockIfBelowMinimum` stays untouched while `checkVersionCompatibility`/`warnOnceIfUntested` are the malleable, recommendation-only paths.
- Inline comments on `CLAUDE_SUPPORTED_VERSION` / `CLAUDE_MINIMUM_SUPPORTED_VERSION` document the manual bump ritual ("UPDATE THIS WHEN BUMPING CLAUDE VERSION", "move its old value down to here") — this is the exact hand-maintenance process the ticket wants automated for the *recommended* value (minimum stays manual, per ticket).

### Derived Conventions

- No documentation describes a TTL-cache pattern anywhere in the guides; the closest code precedent, `VersionWarningStore`, is a dedup-marker store (keyed by agent+installed+supported version), not a fetched-value cache with an expiry — this appears to be new territory for the codebase, not an existing pattern to extend.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts` — covers `warnOnceIfUntested()`.
- `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` — covers `checkVersionCompatibility()` via the Codex plugin.
- `src/cli/commands/__tests__/install.version-selection.test.ts` — covers install-time version selection.
- `src/utils/__tests__/version-warnings.test.ts` — covers `VersionWarningStore`.
- `src/agents/plugins/claude/__tests__/claude.plugin.auto-update.test.ts` — Claude-specific update behavior.
- `src/utils/__tests__/processes.test.ts` — covers `getLatestVersion()`.
- `src/utils/__tests__/utils-misc-coverage.test.ts` — covers `compareVersions()` / `isValidSemanticVersion()`.
- `src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts` — covers `AgentsCheck` (and other doctor checks).

### Testing Framework and Patterns

- Vitest (per `.ai-run/guides/testing/testing-patterns.md` and file naming `*.test.ts` under `__tests__/`). Not inspected in depth this pass — testing is out of scope unless explicitly requested.

### Coverage Gaps

- `src/cli/commands/update.ts:45` `checkAgentForUpdate()` — codegraph reports **no tests found within 3 caller hops**. This is the single function the ticket asks to change most (removing the Claude special-case, adding a uniform npm-based check for every agent) and it currently has no direct test coverage.
- No test file was found for a config-level global toggle of any kind (the closest precedent, `workspace.metrics.enabled`, was not confirmed to have dedicated coverage in this pass).
- No existing test covers a TTL/cache-expiry code path anywhere in the codebase (none exists to test).

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_DEBUG` — existing precedent read via `ConfigLoader.loadFromEnv()` (`src/utils/config.ts:430-432`), pattern: `value === 'true'` (fail-closed on anything else).
- No `CODEMIE_*` env var currently exists for version-check on/off; none was found in `loadFromEnv()` (`src/utils/config.ts:412-452`).

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (global) and `.codemie/codemie-cli.config.json` (project/local) — both use the same `MultiProviderConfig` schema (`version: 2`, `profiles`, `workspace`), read/written exclusively through `ConfigLoader` (`src/utils/config.ts`).
- `WorkspaceConfig` (`src/env/types.ts:105-144`) is the whole-object-override scope (local wins over global, no field-level merge) that already carries `metrics.enabled` — the closest existing schema location for a new global toggle field, though the ticket asks for global-config, not per-profile.
- `~/.codemie/version-warnings.json` (`src/utils/version-warnings.ts`) — separate file, not part of `ConfigLoader`'s schema; stores the one-time-notice dedup markers.

### Feature Flags and Deployment Concerns

- No existing feature-flag mechanism beyond ad hoc boolean fields inside `WorkspaceConfig`/`ProviderProfile` (e.g. `metrics.enabled`, `metrics.sync.enabled`, `metrics.sync.dryRun`) — there is no central flag registry.

---

## 6. Risk Indicators

- **Coverage gap on the primary target function**: `checkAgentForUpdate()` (`src/cli/commands/update.ts:45`), including the Claude special-case at lines 58-79 that must be removed, has no direct test coverage today (codegraph: "no tests found within 3 caller hops").
- **No existing TTL-cache infrastructure**: the closest code (`VersionWarningStore`) is a notice-dedup marker keyed by version triples, not a time-based cache of a fetched value — a 24h npm-lookup cache is new infrastructure, not an extension of an existing pattern.
- Speculative: the existing `ConfigLoader.loadFromEnv()` boolean-env-var pattern (`CODEMIE_DEBUG === 'true'`) is fail-closed (anything but the literal string `'true'` maps to `false`/disabled); naively copying this pattern for the new toggle's env-var layer would violate the ticket's explicit fail-safe-enabled requirement, since an invalid stored value must resolve to "enabled." This is a pattern mismatch to watch during design, not a discovered constraint.
- **Notice-store interaction risk**: `VersionWarningStore.hasWarned()`/`recordWarning()` key off the exact `supportedVersion` string. If `supportedVersion` becomes a value that changes on every 24h cache refresh (rather than a hand-edited constant that changes rarely), the dedup marker could churn more often than intended, re-surfacing the "recommends" notice on every cache refresh where npm published a new patch — a behavior interaction between the new caching layer and existing notice-suppression logic that the design should account for.
- **Scope ambiguity between the local and live paths**: the ticket states `checkVersionCompatibility()` continues to exist as "pure local compare" language describing today's behavior, but also says `metadata.supportedVersion` moves from hand-edited to live-tracked — since `checkVersionCompatibility()` reads `this.metadata.supportedVersion` directly, and `warnOnceIfUntested()` (the agent-run startup warning explicitly named as a gated flow) is built entirely on `checkVersionCompatibility()`, the exact mechanism by which a live-fetched value reaches `metadata.supportedVersion` (write-through at cache-refresh time vs. a separate live-fetch path only in `checkAgentForUpdate`) is not resolved by the ticket text and was not found pre-built anywhere in the code. This is a design decision for the spec, flagged here only because it affects which of the two divergent code paths actually changes shape.
- **Three additional hardcoded-constant agents beyond the two named in the ticket**: `gemini.plugin.ts` has the same `GEMINI_SUPPORTED_VERSION`/`GEMINI_MINIMUM_SUPPORTED_VERSION` pattern; the ticket only names Claude and Kimi for live npm tracking (Gemini's npm package `@google/gemini-cli` was not evaluated for the "npm tracks upstream releases in lockstep" assumption the ticket verified only for Claude/Kimi).
- **Strict semver parsing**: `parseSemanticVersion()` (`src/utils/version-utils.ts:26-45`) only accepts a bare `major.minor.patch` pattern (after stripping a leading `v`) — no pre-release/build-metadata tolerance. Both `checkAgentForUpdate` callers already route npm output through `extractVersion()` (regex `v?(\d+\.\d+\.\d+)`) before comparing, so this is a known, already-handled constraint rather than a new risk, but any new live-fetch path for Claude/Kimi must apply the same extraction.
- **Doctor force-refresh wiring not fully traced**: `src/cli/commands/doctor/index.ts` is a second caller of `VersionWarningStore` besides `BaseAgentAdapter.ts`, suggesting `codemie doctor` already has some marker-reset behavior, but its exact command/flag surface was not read in this pass.

---

## 7. Summary for Complexity Assessment

This task touches four layers: Agent Core (`BaseAgentAdapter.checkVersionCompatibility`/`warnOnceIfUntested`), three Agent Plugins (`claude.plugin.ts`, `kimi.plugin.ts`, and by pattern-similarity `gemini.plugin.ts`), CLI Commands (`update.ts`'s `checkAgentForUpdate`/`checkAllAgentsForUpdates`/`updateAgent`, `setup.ts`'s `checkAndInstallClaude`, `doctor/checks/AgentsCheck.ts`), and Utils/Config (`processes.ts.getLatestVersion`, `version-utils.ts`, a new TTL-cache module, and `ConfigLoader`/`env/types.ts` for the new global toggle). The minimum file-change surface for the named scope (unify `checkAgentForUpdate` for Claude/Kimi, reword the two "verified" UI strings at `update.ts:289` and `setup.ts:783`, add a global config toggle, gate three flows) spans at least seven to nine files before any new cache module is counted.

Technical novelty is concentrated in two places: the 24h TTL npm-lookup cache has no precedent anywhere in this codebase (the closest thing, `VersionWarningStore`, is a different kind of store — a notice-dedup marker, not a value cache), and the fail-safe-default requirement for the global toggle actively contradicts the codebase's one existing boolean-env-var convention (`CODEMIE_DEBUG === 'true'`, which is fail-closed). The global toggle's config-file placement does have a strong precedent, however: `WorkspaceConfig.metrics.enabled`/`metrics.sync.enabled` is an existing nested-boolean field in the exact same global config file, resolved through the exact same `ConfigLoader` priority chain the ticket describes.

Test coverage is solid around the *existing* local-compare path (`checkVersionCompatibility`, `warnOnceIfUntested`, `AgentsCheck`, `VersionWarningStore`, `getLatestVersion`, `compareVersions` all have direct unit tests) but there is a real gap exactly where the ticket's core change lands: `checkAgentForUpdate()` — including the Claude special-case being removed — has no direct test today. Key risk factors going into planning: the unresolved question of whether a live-fetched "latest" value flows back into `metadata.supportedVersion` (and therefore into `checkVersionCompatibility`/`warnOnceIfUntested`) or stays confined to a new code path inside `checkAgentForUpdate`; the interaction between a refreshing cache and the existing per-version notice-dedup marker; and the fail-safe/fail-closed mismatch in the only existing boolean-config-read precedent.

---

## 8. External References

None named by the task. All locations `task_context` refers to (`kimi.plugin.ts:26`, `BaseAgentAdapter.ts:284`, `update.ts:45`, `update.ts:58-79`, `processes.ts:314`) are inside this repository and were investigated directly via codegraph in Section 2 rather than treated as external sources of truth.
