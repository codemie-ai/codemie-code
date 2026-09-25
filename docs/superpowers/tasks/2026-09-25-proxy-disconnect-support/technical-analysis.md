# Technical Research

**Task**: proxy disconnect connectors config
**Generated**: 2026-09-25T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15246: CLI: proxy disconnect support for Claude Desktop, VS Code Copilot Chat, VS Code Claude Code. `codemie proxy connect` supports 4 client apps, but `codemie proxy disconnect` only supports 1 (--codex-desktop). Need to implement --claude-desktop, --vscode, --vscode-claude-code disconnect, mirroring the codex-desktop reference implementation (removeCodexDesktopConfig, ~/.codemie/proxy/codex-desktop-state.json ownership tracking, disconnect-orchestrator.js). Scope: (1) Claude Desktop - config at ~/Library/Application Support/Claude-3p/configLibrary/, _meta.json points at appliedId file; remove only CodeMie's managed MCP entries (undo mergeManagedMcpServers/reconcileManagedMcpServers) without touching other MCP servers. (2) VS Code Copilot Chat (BYOK) - .../Code/User/chatLanguageModels.json, shared JSON array; CodeMie's entry identified by vendor === 'customendpoint' && name === 'CodeMie'; filter it out. (3) VS Code Claude Code extension - .../Code/User/settings.json; CodeMie's entries live in claudeCode.environmentVariables array as ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN; strip only those two. Each must report success/failure like --codex-desktop (✓ <App> disconnected / actionable error) and handle 'nothing to disconnect' gracefully.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/disconnect-orchestrator.ts` — the entire current `disconnectTargets()` implementation. Only knows `DisconnectTargets.codexDesktop`; prints the target list when no target flag is set; imports only `removeCodexDesktopConfig` from `./connectors/codex-desktop.js`. This is the file the new targets must be added to.
- `src/cli/commands/proxy/connectors/codex-desktop.ts` — the reference removal implementation named in the ticket:
  - `getCodexDesktopStatePath()` → `getCodemiePath('proxy', 'codex-desktop-state.json')` (ownership marker, write-ahead before the config write).
  - `removeCodexDesktopConfig(statePath)` → reads the state file, no-ops with `{removed:false}` when absent/empty/config-file-gone, otherwise surgically strips the managed region, falls back to a `.codemie-backup` file if the strip leaves CodeMie keys behind (`assertNoCodeMieKeys`), then clears the state file (`writeAtomically(statePath, '')`).
  - Returns `{ removed, usedBackup, configPath }` — this is the shape `disconnect-orchestrator.ts` branches on today.
- `src/cli/commands/proxy/connectors/desktop.ts` (Claude Desktop) — already has ownership tracking that section (1) of the ticket needs, not a new mechanism to build:
  - `getManagedMcpStatePath()` → `getCodemiePath('proxy', 'desktop-managed-mcp-state.json')`, storing `{ managedNames: string[] }`.
  - `readManagedMcpState(statePath)` / `writeManagedMcpState(statePath, managedNames)` (module-private, not exported) — record exactly which `managedMcpServers` entries CodeMie owns this run, written as a union before the config write and narrowed to the exact set after (mirrors the codex-desktop write-ahead pattern).
  - `getDesktopConfigPath(baseDir)` (exported, async) — resolves `configLibrary/_meta.json`'s `appliedId` to the active `configLibrary/<uuid>.json` file; falls back to a fresh UUID path if `_meta.json` is absent/corrupt or has no `appliedId` — this is precisely the "`_meta.json` points at appliedId file" lookup the ticket describes.
  - `getDesktopBaseDir()` → `getClaudeDesktopBaseDir()` from `src/telemetry/clients/claude-desktop/claude-desktop.paths.js`.
  - `mergeManagedMcpServers` / `reconcileManagedMcpServers` are the write-side functions the ticket says disconnect must "undo" — reconcile already filters `existingServers` by `ownedLower` (union of `previouslyManagedNames` and current `managedNames`) and by `managedUrls`, so removal is the same filter with an empty managed set: every name in the state file's `managedNames` gets dropped, everything else (genuine user-added servers) survives.
  - No `removeDesktopConfig`/disconnect function exists yet in this file — it is write-only today.
- `src/cli/commands/proxy/connectors/vscode.ts` — `isManagedProvider(provider)` (private) already implements the exact identification rule from ticket scope (2): `vendor === 'customendpoint' && name === 'CodeMie'`. `writeVsCodeLanguageModelsConfigAtPath` reads the whole JSON array via `readProviders`, filters/merges the CodeMie entry in, writes atomically via `writeAtomically` (exported). `getVsCodeLanguageModelsPath(insiders)` resolves `.../Code/User/chatLanguageModels.json` (throws `ConfigurationError` if the VS Code product dir is missing). No disconnect/removal function exists yet — read/merge/write only.
- `src/cli/commands/proxy/connectors/vscode-claude-code.ts` — `upsertManagedEnvVars` (private) is scope (3)'s write-side counterpart: identifies managed entries by `name` (`ANTHROPIC_BASE_URL_KEY`/`ANTHROPIC_AUTH_TOKEN_KEY`, both in module-level `MANAGED_ENV_VAR_NAMES`). `getVsCodeClaudeCodeSettingsPath(insiders)` resolves `.../Code/User/settings.json`. Uses `jsonc-parser`'s `parse`/`modify`/`applyEdits` (JSONC-tolerant read, targeted-edit write preserving comments/formatting) rather than `JSON.parse`/full re-serialize — `writeVsCodeClaudeCodeConfigAtPath` is the pattern a disconnect write would need to follow to avoid clobbering user comments. No removal function exists yet.
- `src/cli/commands/proxy/index.ts` (lines ~316-322) — the `disconnect` subcommand definition: only declares `--codex-desktop`; the `connect` command's `TARGET_LIST`-equivalent flags (`--claude-desktop`, `--vscode`, `--vscode-claude-code`, `--codex-desktop`) are already declared on `connect` (lines 290-299) and are the flag set disconnect must mirror.
- `src/cli/commands/proxy/connect-orchestrator.ts` — not part of the disconnect surface, but the four `run*` per-target functions (`runClaudeDesktop`, `runVscodeByok`, `runVscodeClaudeCode`, `runCodexDesktop`) and `TargetResult { label, ok, error }` / `printSummary` establish the per-target success/failure reporting convention the ticket asks disconnect to match ("✓ <App> disconnected / actionable error").

### Architecture and Layers Affected

- **CLI command layer**: `src/cli/commands/proxy/index.ts` — `disconnect` subcommand option declarations and the `opts → DisconnectTargets` mapping in its `.action()`.
- **Orchestrator layer**: `src/cli/commands/proxy/disconnect-orchestrator.ts` — `DisconnectTargets` interface, `DISCONNECT_TARGET_LIST` help text, and the per-target dispatch/summary logic (currently single-target, would need the `connect-orchestrator.ts` per-target-result/summary pattern if extended to 4 targets — see Risk Indicators).
- **Connector layer**: `src/cli/commands/proxy/connectors/{codex-desktop,desktop,vscode,vscode-claude-code}.ts` — where each app's config-file read/write/strip logic lives. A disconnect implementation for the three new targets belongs here, as sibling functions to each file's existing write function (`removeCodexDesktopConfig` sits beside `writeCodexDesktopConfig` in the same file).
- **Utility layer**: `src/utils/paths.ts` (`getCodemiePath`), `src/cli/commands/proxy/connectors/vscode.ts` (`writeAtomically`, reused by `codex-desktop.ts` and available to any connector for atomic writes).

### Integration Points

- `getCodemiePath('proxy', <name>)` from `src/utils/paths.ts` is the convention for every proxy ownership-marker file (`codex-desktop-state.json`, `desktop-managed-mcp-state.json`); a disconnect implementation reads these rather than the live client config to know what CodeMie owns.
- `ConfigurationError` from `src/utils/errors.js` is the error type connectors throw for user-actionable failures (unreadable/malformed config, unsupported platform); `disconnect-orchestrator.ts` catches generically (`error instanceof Error ? error.message : String(error)`), not specifically on `ConfigurationError`.
- `logger` (`src/utils/logger.js`) + `sanitizeLogArgs` (`src/utils/security.js`) — every connector and the orchestrator logs failures via `logger.warn('[proxy] ...', ...sanitizeLogArgs({...}))`; gateway keys/tokens are never logged in cleartext (see the explicit comment in `codex-desktop.ts` about omitting `gatewayKey` from log args).
- No network/external-service calls in the disconnect path for any of the four targets — this is filesystem-only.

### Patterns and Conventions

- **Marker-file ownership tracking** (`codex-desktop-state.json`, `desktop-managed-mcp-state.json`): write-ahead before the config write, narrowed/cleared after — established convention any new disconnect target that needs to distinguish "ours" from "user's" should reuse rather than reinvent. Claude Desktop already has this marker; VS Code Copilot Chat and VS Code Claude Code identify their own entries structurally (`vendor`/`name`, or env-var `name`) and need no marker file.
- **Surgical strip over blind restore**: `removeCodexDesktopConfig`'s doc comment states the design rationale explicitly — stripping preserves user edits made while connected; a blind backup restore would discard them. `desktop.ts`'s `reconcileManagedMcpServers` already embodies the same idea for the MCP array (filter by ownership, keep everything else).
- **Backup-file fallback**: `codex-desktop.ts` keeps a `${configPath}.codemie-backup` snapshot (`backupIfUnmanaged`) and falls back to it only when the surgical strip cannot produce a config `assertNoCodeMieKeys` accepts. No equivalent backup file exists for Claude Desktop, VS Code Copilot Chat, or VS Code Claude Code config connectors today.
- **Atomic write**: `writeAtomically(path, content)` (exported from `vscode.ts`, reused across connectors) — temp file + `rename`, preserves existing file mode. Any new write path should use it (as `codex-desktop.ts` already does).
- **`TargetResult`/summary reporting** (`connect-orchestrator.ts`): `{ label, ok, error }` per target + `printSummary()` printing `✓ label` / `✗ label — error`. The current `disconnect-orchestrator.ts` does not yet use this shape (it is single-target and prints ad hoc `chalk.green`/`chalk.red` lines) — this is a design decision for spec/plan, not something already built.
- **JSONC-tolerant read + targeted `modify()`/`applyEdits()`** (`vscode-claude-code.ts`) vs. **full-array `JSON.parse`/re-serialize** (`vscode.ts`) — two different parsing strategies already coexist for the two VS Code config files; a disconnect writer for each should match its own file's existing read/write style to avoid diverging behavior on comments/formatting.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/integration/external-integrations.md` — general P0 guides; neither contains proxy-connector-specific content (grep for "proxy connect"/"proxy disconnect" in `integration/exposed-api.md` returned nothing).
- No `.ai-run/guides/` file documents the proxy connect/disconnect connector implementation directly — conventions are derived from the codex-desktop connector and its design spec below.

### Architectural Decisions

- `docs/superpowers/tasks/2026-08-18-codex-desktop-proxy-connect/spec.md` — the approved design spec for the reference implementation the ticket names. Recorded fixed decisions relevant here: rollback is "atomic write + write-ahead marker state"; the shared `TargetResult` contract was kept untouched when codex-desktop was added; five units were touched (pure-string layer, connector, connect-orchestrator, disconnect-orchestrator, CLI index). `docs/superpowers/tasks/2026-08-12-unified-proxy-connect/` is the earlier spec for the 4-target `connect` unification this ticket's disconnect side is catching up to.
- `docs/stories/2026-08-18-codex-desktop-proxy-connect.md` — the original story for the codex-desktop precedent.
- Inline decision comments worth carrying into design: `desktop.ts`'s `reconcileManagedMcpServers` doc comment on why `previouslyManagedNames` is needed (Claude Desktop re-stamps entries it persists, so a custom marker field on the entry itself cannot survive); `codex-desktop.ts`'s `removeCodexDesktopConfig` doc comment on surgical-strip-over-restore; `vscode-claude-code.ts`'s `writeVsCodeClaudeCodeConfigAtPath` doc comment on why JSONC targeted edits are used over full re-serialization.

### Derived Conventions

- Disconnect functions live in the same connector file as the matching write function, are exported, and return a small result object the orchestrator branches on (`{ removed: boolean, ... }` for codex-desktop).
- "Nothing to disconnect" is modeled as a `removed: false` result, not an error/exception — the orchestrator prints `chalk.dim(...)` and returns cleanly, no `process.exitCode` change.
- Genuine failures throw (or reject); the orchestrator catches, logs via `logger.warn`, prints `chalk.red('✗ ...')`, and sets `process.exitCode = 1`.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts` — full coverage of today's single-target orchestrator: no-target help text, successful removal, backup-fallback messaging, "nothing to disconnect" no-op, and thrown-error → `process.exitCode === 1`. Uses `vi.doMock('../connectors/codex-desktop.js', () => ({ removeCodexDesktopConfig: vi.fn()... }))` + dynamic `import('../disconnect-orchestrator.js')` after `vi.resetModules()` in `beforeEach` — this is the mocking pattern any new orchestrator test for the three new targets would follow.
- `src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts` and `codex-desktop-roundtrip.test.ts` — cover `removeCodexDesktopConfig` itself (state-file absent/empty, config-file-gone, surgical strip success, backup-fallback, damaged-marker-with-no-backup throw).
- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` — covers `getManagedMcpStatePath`, `getDesktopConfigPath` (`_meta.json`/`appliedId` resolution, corrupt-meta fallback, fresh-UUID fallback), `mergeManagedMcpServers`, `reconcileManagedMcpServers`, `writeDesktopConfig` — but has no test for a *removal* function because none exists.
- No test files reference a Claude Desktop, VS Code Copilot Chat, or VS Code Claude Code disconnect/removal path — grep for `removeDesktopConfig`/`removeVsCode*`/similar names returned nothing anywhere in `src/`.

### Testing Framework and Patterns

- Vitest (`describe`/`it`/`vi`), per repo standard (`.ai-run/guides/testing/testing-patterns.md`).
- Dynamic-import-after-mock pattern (`vi.resetModules()` in `beforeEach`, `vi.doMock(...)` then `await import(...)`) is used consistently for orchestrator tests where the connector module is swapped per test case.
- Connector-level tests (`desktop.test.ts`, `codex-desktop.test.ts`) use real temp directories (not full mocks) to exercise atomic-write and JSON/TOML round-tripping — `codex-desktop-roundtrip.test.ts` specifically round-trips write→remove→verify-clean.

### Coverage Gaps

- No disconnect/removal logic exists yet for Claude Desktop, VS Code Copilot Chat, or VS Code Claude Code, so there is no test coverage to gap-fill — this is greenfield for three of the four targets, following an established one-target pattern.
- `disconnect-orchestrator.test.ts` only exercises the single existing target; extending `DisconnectTargets` to four booleans has no existing multi-target dispatch test to model against (unlike `connect-orchestrator.test.ts`, which already tests multi-target dispatch/summary for `connectTargets`).

---

## 5. Configuration and Environment

### Environment Variables

- None specific to disconnect. `codex-desktop.ts` reads `CODEX_HOME` (Codex config location) and `getVsCodeProductDir` reads `APPDATA`/`XDG_CONFIG_HOME` for VS Code paths — both already used by the existing write paths and would be reused unchanged by a matching disconnect path (same path-resolution functions, no new env var surface).

### Configuration Files

- Claude Desktop: `<getDesktopBaseDir()>/configLibrary/_meta.json` (→ `appliedId`) and `<configLibrary>/<appliedId>.json` (the actual managed config, holds `managedMcpServers` as a JSON-encoded string) — resolved via `getDesktopConfigPath()`.
- VS Code Copilot Chat: `<getVsCodeProductDir(insiders)>/User/chatLanguageModels.json` — resolved via `getVsCodeLanguageModelsPath(insiders)`.
- VS Code Claude Code: `<getVsCodeProductDir(insiders)>/User/settings.json` — resolved via `getVsCodeClaudeCodeSettingsPath(insiders)`.
- Ownership markers (existing): `~/.codemie/proxy/codex-desktop-state.json` (codex), `~/.codemie/proxy/desktop-managed-mcp-state.json` (Claude Desktop, already present — no new marker file needed for scope (1)).

### Feature Flags and Deployment Concerns

- `--insiders` on `connect` selects the VS Code Insiders product dir instead of stable; disconnect for `--vscode`/`--vscode-claude-code` would need the same selector to find the right file (the ticket text does not mention `--insiders` on disconnect — see Risk Indicators).
- `--force` on `connect` bypasses app-detection; no analogous flag exists on `disconnect` today.

---

## 6. Risk Indicators

- Speculative: The ticket's phrase "undo mergeManagedMcpServers/reconcileManagedMcpServers" implies calling `reconcileManagedMcpServers(existing, [], managedNames)` (empty managed set) to compute the surviving array, then writing it back — but `reconcileManagedMcpServers` is exported while `readManagedMcpState`/`writeManagedMcpState` are currently module-private in `desktop.ts`; a disconnect implementation will need at least read access to the marker file, which may require exporting a currently-private helper.
- Speculative: `disconnect-orchestrator.ts`'s current structure (single `if (!opts.targets.codexDesktop)` branch, one try/catch) does not generalize to four independent targets with a per-target ✓/✗ summary; matching `connect-orchestrator.ts`'s `TargetResult`/`printSummary` pattern is a design choice, not a given, since disconnect's existing tests assert on specific standalone console messages that a shared-summary refactor could change.
- `--insiders` is not mentioned in the ticket for the two VS Code targets' disconnect; if the VS Code Insiders location was used to connect, disconnect without an equivalent flag cannot find the right file — worth resolving in spec/plan since it is a functional gap the ticket text does not address.
- None of the three new targets has a backup-file fallback the way `codex-desktop.ts` does (`.codemie-backup`) — if a structural (`isManagedProvider`, `ANTHROPIC_BASE_URL_KEY`/`ANTHROPIC_AUTH_TOKEN_KEY`, or `managedNames`-marker) removal cannot cleanly identify CodeMie's entries (e.g. Claude Desktop's `managedMcpServers` field holds unparseable JSON), there is no established fallback path to point to, unlike codex-desktop's TOML case.
- Claude Desktop's managed config also carries `inferenceProvider`/`inferenceGatewayBaseUrl`/`inferenceGatewayApiKey`/`inferenceGatewayAuthScheme`/`inferenceModels`/`coworkEgressAllowedHosts` top-level keys written by `writeDesktopConfig` (`INFERENCE_KEYS` + `inferenceModels`/`coworkEgressAllowedHosts`) in addition to `managedMcpServers` — the ticket's scope (1) only describes removing "managed MCP entries," so whether disconnect should also clear these other CodeMie-written top-level keys is unresolved by the ticket text and worth confirming.
- `describeManagedSettingsOverride()` in `desktop.ts` warns when an MDM-managed settings source shadows the local Claude Desktop config; a disconnect write to the local config would be silently ineffective under the same condition connect already warns about, and the ticket doesn't mention surfacing that warning on disconnect.

---

## 7. Summary for Complexity Assessment

This task touches the CLI layer (`src/cli/commands/proxy/index.ts`, adding three flags to an existing `disconnect` subcommand) and the orchestrator layer (`src/cli/commands/proxy/disconnect-orchestrator.ts`, extending a single-target `DisconnectTargets` to four and restructuring its dispatch/reporting), plus three connector files (`connectors/desktop.ts`, `connectors/vscode.ts`, `connectors/vscode-claude-code.ts`) that each need a new exported removal function alongside their existing write function. The fourth target (`--codex-desktop`) is already implemented and serves as the direct pattern to mirror, which meaningfully lowers novelty: the marker-file-ownership idiom, the atomic-write helper, the `ConfigurationError`/`logger`/`sanitizeLogArgs` error conventions, and the "removed: false → clean no-op" contract are all established and reusable as-is.

Technical novelty is concentrated in three places: (1) Claude Desktop's removal needs to read the *existing* (currently module-private) `managedNames` marker and re-run the reconcile-with-empty-managed-set logic against a config file resolved through `_meta.json`/`appliedId` indirection — more moving parts than the other two targets; (2) VS Code Copilot Chat and VS Code Claude Code both have simpler, purely structural identification (`isManagedProvider`, or the two named env-var keys) with no marker file, closer in shape to a straightforward filter/strip; (3) the disconnect-orchestrator's reporting shape is currently single-target and ad hoc, so scaling it to four targets with the ✓/✗-per-target contract the ticket asks for is itself a small design decision, not just wiring.

Test coverage for the three new targets is a clean gap (no existing removal tests to extend, unlike `codex-desktop.test.ts`/`codex-desktop-roundtrip.test.ts`, which already prove the pattern works end to end), and the existing `disconnect-orchestrator.test.ts` will need restructuring, not just additions, once the target set and reporting shape change. Key risks are the two module-privacy issue in `desktop.ts` (exporting marker read/write), the unresolved `--insiders` question for VS Code disconnect targets, and the absence of a backup-fallback mechanism for the three new targets should structural removal fail to cleanly identify CodeMie's own entries.

---

## 8. External References

None named by the task. The ticket points at the `codex-desktop` connector, `disconnect-orchestrator.js`, and `~/.codemie/proxy/codex-desktop-state.json` as the reference implementation to mirror — these are in-repo source files, already covered in Section 2 above (`src/cli/commands/proxy/connectors/codex-desktop.ts`, `src/cli/commands/proxy/disconnect-orchestrator.ts`), not external sources of truth outside this repository.
