# Technical Research

**Task**: codemie-code plugin supportedVersion install doctor
**Generated**: 2026-11-13
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16980 — `codemie install codemie-code --supported` fails with "No supported version defined in metadata", even though `codemie doctor` recommends this exact command as the fix for an outdated built-in `codemie-code` agent.

Root cause: `CodeMieCodePluginMetadata` (src/agents/plugins/codemie-code.plugin.ts ~190-222) sets npmPackage '@codemieai/codemie-opencode' and isBuiltIn true but no `supportedVersion`. `BaseAgentAdapter.installVersion()` (src/agents/core/BaseAgentAdapter.ts ~208-217) throws "<displayName>: No supported version defined in metadata" when version === 'supported' and metadata.supportedVersion is unset. The generic outdated-version warning (BaseAgentAdapter.ts ~470,514,538) always suggests `codemie install <name> --supported`.

Fix: add `supportedVersion` to CodeMieCodePluginMetadata. package.json pins "@codemieai/codemie-opencode": "0.0.47" (line 124); supportedVersion should equal it. Prevent drift: either read it from package.json dependency, or constant + test failing when it mismatches package.json — pick less code.

Specific research asks:
1. How do Kimi, Pi, Codex, Claude plugins define supportedVersion / minimumSupportedVersion?
2. BaseAgentAdapter.checkVersionCompatibility skips when supportedVersion or minimumSupportedVersion missing. What does adding ONLY supportedVersion do to `codemie doctor` (src/cli/commands/doctor/checks/AgentsCheck.ts:56 and :64) and the startup warning? Is minimumSupportedVersion also needed?
3. How is the codemie-code binary/version resolved (codemie-code-binary.ts) — does the installed version get checked against supportedVersion in a way that could now produce new false warnings for built-in agents?
4. Existing tests for plugin metadata / supportedVersion (where, and patterns), for placing a new test. Note existing tests are Vitest.
5. Open PR #627 touches this plugin; keep the change minimal.

---

## 2. Codebase Findings

### Existing Implementations
- `src/agents/plugins/codemie-code.plugin.ts` — `CodeMieCodePluginMetadata` (~line 190): npmPackage `@codemieai/codemie-opencode`, `cliCommand: resolvedBinary || null` (resolved at module load, line 166), `isBuiltIn: true`; no supportedVersion/minimumSupportedVersion. Plugin overrides `isInstalled()` (binary exists on disk), `install()` (`installGlobal('@codemieai/codemie-opencode')`), `uninstall()`. It does NOT override `getVersion()` or `installVersion()`.
- `src/agents/core/BaseAgentAdapter.ts` — `installVersion()` (208-): throws if version==='supported' and no metadata.supportedVersion; otherwise npm install with that version. `getVersion()` (291): runs `<cliCommand> --version`, returns trimmed stdout. `checkVersionCompatibility()` (312): when `metadata.supportedVersion` unset returns compatible/isSupported true with 'latest'; otherwise `compareVersions` (exact match = supported unless `acceptsSupportedMajor`); `isBelowMinimum` only if minimumSupportedVersion set. `warnOnceIfUntested()` (432): returns early if no supportedVersion; otherwise one-time notice when installed != supported. Hard-gate method (~510) requires BOTH supportedVersion and minimumSupportedVersion.
- `src/agents/core/types.ts:229-245` — `AgentMetadata.supportedVersion?`, `acceptsSupportedMajor?`, `minimumSupportedVersion?` (all optional).
- `src/cli/commands/doctor/checks/AgentsCheck.ts` — builds detail per installed agent: if `compat.isBelowMinimum` -> error; if `!compat.isSupported` -> warn "CodeMie recommends vX" with hint `codemie install <name> --supported`. Iterates `AgentRegistry.getInstalledAgents()` (all non-analyticsOnly adapters where `isInstalled()`), so built-in codemie-code is included.
- `src/cli/commands/install.ts:105-125,229` — `--supported` path calls `checkVersionCompatibility()` to display `compat.supportedVersion`, then `installVersion('supported')`; after install calls `warnOnceIfUntested()`.
- Version pins in sibling plugins (research ask 1):
  - Kimi `kimi/kimi.plugin.ts:26-43`: consts `KIMI_SUPPORTED_VERSION='0.42.0'`, `KIMI_MINIMUM_SUPPORTED_VERSION='0.16.0'`; both in metadata; overrides installVersion (line ~340).
  - Pi `pi/pi.plugin.ts:29,182-183`: `PI_SUPPORTED_VERSION='1.5.2'`, `acceptsSupportedMajor: true`; NO minimumSupportedVersion.
  - Codex `codex/codex.plugin.ts:74,85,127`: `CODEX_SUPPORTED_VERSION='0.154.0'`, `CODEX_MINIMUM_SUPPORTED_VERSION='0.143.0'`; codex-acp sets `supportedVersion: undefined`.
  - Claude `claude/claude.plugin.ts:178-179`: `CLAUDE_SUPPORTED_VERSION` and `CLAUDE_MINIMUM_SUPPORTED_VERSION` constants in metadata; overrides installVersion.
  - Gemini: `GEMINI_SUPPORTED_VERSION='0.59.0'` + minimum '0.29.5'. Copilot-cli: '1.0.92' / '1.0.83'.
  - Convention: module-level `X_SUPPORTED_VERSION` string constant, referenced in metadata. Pi shows supportedVersion-only is an accepted precedent.

### Architecture and Layers Affected
Agent plugin layer (`src/agents/plugins/codemie-code.plugin.ts` metadata) only; core adapter (`BaseAgentAdapter`) and CLI/doctor layers consume it unchanged.

### Integration Points
- `package.json:124` pins `"@codemieai/codemie-opencode": "0.0.47"` (exact, a dependency, so installed under node_modules with the same version: `node_modules/@codemieai/codemie-opencode/package.json` = 0.0.47).
- Binary resolution (`codemie-code-binary.ts`): `getPlatformPackage()` maps platform/arch to `@codemieai/codemie-opencode-<platform>-<arch>`, `findPackageInNodeModules` walks up node_modules; `resolveCodemieOpenCodeBinary()` returns a path. No version logic in this file (grep for "version" found none relevant).
- Verified locally: `node_modules/@codemieai/codemie-opencode-darwin-arm64/bin/codemie --version` prints exactly `0.0.47` (clean semver, so `compareVersions` parses it).

### Patterns and Conventions
- Constant-in-plugin-file pattern (above). `@/` alias and `.js` import extensions required.
- Reading package.json at runtime exists in `src/utils/cli-updater.ts:43-49` (resolves `../../package.json` from src/utils) — the plugin would need a similar read of the dependency map; more code than a constant.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` present (architecture, external-integrations, testing-patterns etc.); not read in depth — task is a one-field metadata change. PR #627 modifies `.ai-run/guides/integration/external-integrations.md` and `docs/AGENTS.md`.

### Architectural Decisions
`types.ts` doc: minimumSupportedVersion is "the only remaining hard gate" for startup; supportedVersion alone yields advisory notices only.

### Derived Conventions
Pin constants beside the metadata; Pi precedent for supportedVersion without minimum.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/pi/__tests__/pi.plugin.version-support.test.ts` — closest template: `@group unit`, vitest, mocks `providers/core/registry.js`, `utils/processes.js` (importActual + overrides for `installGlobal`, `exec`, `commandExists`), `utils/logger.js`; dynamic `await import('../pi.plugin.js')`; asserts metadata value and `installVersion('supported')` calls `installGlobal(pkg, { version })`.
- `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts`, `kimi/__tests__/kimi.plugin.test.ts`, `codex-acp.plugin.test.ts`, `copilot-cli.registry.test.ts`.
- `src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts`, `src/utils/__tests__/version-warnings.test.ts`, `src/cli/commands/__tests__/install.version-selection.test.ts`.
- codemie-code: `src/agents/plugins/__tests__/codemie-code-plugin.test.ts` (no version assertions found).

### Testing Framework and Patterns
Vitest, dynamic imports after `vi.mock`. Note repo policy: tests only on explicit request.

### Coverage Gaps
No test asserts codemie-code supportedVersion or its equality with package.json.

---

## 5. Configuration and Environment

### Environment Variables
None relevant.

### Configuration Files
`package.json` (dependency pin line 124; no `engines` impact).

### Feature Flags and Deployment Concerns
None. Open PR #627 ("feat(agents): support OpenCode 2.x config, telemetry and session analytics") modifies `src/agents/plugins/codemie-code.plugin.ts`, `BaseAgentAdapter.ts`, `types.ts` and many opencode files, so a conflict is possible in the metadata block.

---

## 6. Risk Indicators

- Effect of adding ONLY supportedVersion (ask 2): `checkVersionCompatibility` switches from the "no supportedVersion -> always supported" branch to a real compare. `isBelowMinimum` stays false (minimum unset), so doctor can never produce an error and startup is never blocked; the hard gate (BaseAgentAdapter ~510) is skipped. Possible output: doctor warn + one-time startup notice when installed != 0.0.47. minimumSupportedVersion is NOT needed to fix the bug (Pi precedent).
- New-warning risk (ask 3): installed version comes from `<binary> --version`, which prints clean `0.0.47` for the current pin, so a fresh install matches -> no warning. Users with a different binary version (older, or newer via `npm i -g` latest, or a dev/global binary resolved from a different node_modules) will now get a doctor warn and a one-time launch notice with a hint that now works. Exact-match semantics mean a NEWER installed version also warns, unless `acceptsSupportedMajor` is set (that would be major 0, so effectively near-useless). This is arguably intended behavior (the issue says doctor already warns/recommends today, but note: with supportedVersion unset, `checkVersionCompatibility` returns isSupported true, so the doctor warning described in the ticket may come from a different path, e.g. deprecation/other checks, worth verifying in AgentsCheck before claiming behavior unchanged).
- Speculative: drift guard options. Constant + one Vitest test comparing to `package.json` dependency is small and follows the Pi/Codex pattern; runtime package.json read is more code and adds fs/path-resolution risk in the bundled/dist layout. Speculative: a constant must be bumped together with package.json (and `update`/release flow) otherwise `install --supported` installs a version different from the bundled one.
- `install.ts` for built-in: `--supported` path calls `installVersion('supported')` (base impl, npm install of `@codemieai/codemie-opencode@<version>`); plugin's own `install()` override is bypassed in that path. Platform package is an optionalDependency of the wrapper, so it is resolved by npm.
- Merge conflict with PR #627 on codemie-code.plugin.ts; keep the diff to a constant plus one metadata line.

---

## 7. Summary for Complexity Assessment

The change is confined to the agent-plugin layer: one constant and one metadata field in `src/agents/plugins/codemie-code.plugin.ts`, with the core `BaseAgentAdapter`, `install.ts` and `AgentsCheck.ts` consuming it unchanged. A single-file, trivial-novelty change; the repo already has the constant-in-plugin convention (Kimi, Pi, Codex, Gemini, Copilot, Claude) and Pi demonstrates supportedVersion without minimumSupportedVersion.

Behavioral side effect: supportedVersion switches the built-in agent from the permissive "latest" branch to an exact-match compare using `<binary> --version` (prints `0.0.47` for the current pin, verified). Matching installs stay silent; mismatched installs now get a doctor warn and a one-time startup notice, never an error or block since no minimum is set. Existing Vitest templates (`pi.plugin.version-support.test.ts`) make an optional drift test (metadata equals package.json dependency) cheap; no current codemie-code version test exists. Open PR #627 edits the same file, so keep the diff minimal.

---

## 8. External References

None named by the task
