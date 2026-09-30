# Spec: Proxy Disconnect — Claude Desktop, VS Code Copilot Chat, VS Code Claude Code

**Ticket**: EPMCDME-15246
**Status**: Approved (human-reviewed decisions applied 2026-09-25)

## Problem

`codemie proxy connect` supports four client apps (`--claude-desktop`, `--vscode`,
`--vscode-claude-code`, `--codex-desktop`); `codemie proxy disconnect` only
supports one (`--codex-desktop`). Add disconnect support for the other three,
mirroring the codex-desktop reference implementation
(`src/cli/commands/proxy/connectors/codex-desktop.ts`,
`src/cli/commands/proxy/disconnect-orchestrator.ts`).

## Approach

Extend, don't reinvent. Each new connector gets a removal function beside its
existing write function, following `removeCodexDesktopConfig`'s contract:
`{ removed: boolean, ... }`, "nothing to disconnect" is a clean `removed: false`
no-op (no `process.exitCode` change), genuine failures throw and are caught by
the orchestrator (`logger.warn` + `chalk.red('✗ ...')` + `process.exitCode = 1`).

`disconnect-orchestrator.ts` moves from its single `if` branch to the same
`TargetResult { label, ok, error }` / `printSummary()` shape
`connect-orchestrator.ts` already uses for its four targets
(`src/cli/commands/proxy/connect-orchestrator.ts`) — one result per requested
target, printed as `✓ <label> disconnected` / `✗ <label> — <error>` /
`<label>: nothing to disconnect` (dim), independent of the others' outcomes.

### Claude Desktop (`connectors/desktop.ts`)

New `removeDesktopConfig()`:
- Read the existing (module-private today — export it) managed-MCP marker via
  `getManagedMcpStatePath()` / the state read helper. `removed: false` no-op if
  the marker is absent/empty or `getDesktopConfigPath()`'s resolved config file
  doesn't exist.
- Otherwise: reconcile `managedMcpServers` with an empty managed set (same
  filter `reconcileManagedMcpServers` already applies, dropping every name the
  marker recorded and keeping everything else — untouched MCP servers survive).
- Delete the full set of CodeMie-written top-level keys from the config:
  `managedMcpServers`, `inferenceProvider`, `inferenceGatewayBaseUrl`,
  `inferenceGatewayApiKey`, `inferenceGatewayAuthScheme`, `inferenceModels`,
  `coworkEgressAllowedHosts`. (Decision: full undo of everything
  `writeDesktopConfig` writes, not just the MCP entries — see Decisions.)
- Write atomically, then clear the marker state file (mirrors codex-desktop's
  `writeAtomically(statePath, '')`).
- No `.codemie-backup` fallback for this target (see Decisions).

### VS Code Copilot Chat (`connectors/vscode.ts`)

New `removeVsCodeLanguageModelsConfig()`:
- Resolve **both** `getVsCodeLanguageModelsPath(false)` (stable) and
  `getVsCodeLanguageModelsPath(true)` (Insiders), unconditionally — no
  `--insiders` flag (see Decisions).
- For each path that exists and contains an entry matching `isManagedProvider`
  (`vendor === 'customendpoint' && name === 'CodeMie'`): filter that entry out
  and write atomically via the existing `writeAtomically`.
- `removed: false` only if **neither** location had a matching entry (or
  neither file exists); `removed: true` if either or both did.

### VS Code Claude Code (`connectors/vscode-claude-code.ts`)

New `removeVsCodeClaudeCodeConfig()`:
- Resolve **both** `getVsCodeClaudeCodeSettingsPath(false)` (stable) and
  `getVsCodeClaudeCodeSettingsPath(true)` (Insiders), unconditionally — no
  `--insiders` flag (see Decisions).
- For each path that exists and has `claudeCode.environmentVariables`
  containing either `MANAGED_ENV_VAR_NAMES` key: strip only those two entries
  using `jsonc-parser`'s `modify()`/`applyEdits()` (matches the existing
  JSONC-preserving write path — do not `JSON.parse`/re-serialize the whole
  file) and write.
- `removed: false` only if **neither** location had a matching entry (or
  neither file exists); `removed: true` if either or both did.

### CLI wiring (`index.ts`, `disconnect-orchestrator.ts`)

- `disconnect` subcommand gains `--claude-desktop`, `--vscode`,
  `--vscode-claude-code` (mirroring `connect`'s four flags). No `--insiders`
  flag on `disconnect` (see Decisions) — the two VS Code removal functions
  take no `insiders` parameter and always check both locations internally.
- `DisconnectTargets` interface grows from one boolean to four
  (`claudeDesktop`, `vscode`, `vscodeClaudeCode`, `codexDesktop`); no
  `insiders` field.
- No-target invocation keeps printing the target list (`DISCONNECT_TARGET_LIST`),
  updated to list all four.

## Decisions

- **No `--insiders` flag on disconnect.** Instead, `--vscode` and
  `--vscode-claude-code` disconnect always resolve and check both
  `getVsCodeProductDir(false)` and `getVsCodeProductDir(true)` paths and clean
  up CodeMie's entry in whichever one(s) have it. Safe because removal is
  already structural and no-op-safe (only ever touches CodeMie's own entries,
  cleanly no-ops when absent), and it avoids requiring the user to remember
  which variant they connected with.
- **Claude Desktop disconnect clears all CodeMie-written top-level keys**, not
  just `managedMcpServers` — full undo of `writeDesktopConfig`'s writes, scoped
  strictly to the key list above. Never touches other top-level keys or other
  apps' MCP entries.
- **No `.codemie-backup` fallback for the three new targets.** Codex-desktop
  needs one because it does TOML region-stripping with a residual-key check;
  the three new targets do deterministic array-filter / key-delete, so there is
  no partial-strip case to fall back from.
- **Reporting shape**: adopt `connect-orchestrator.ts`'s `TargetResult`/
  `printSummary` convention rather than keep disconnect's ad hoc single-target
  prints, per the ticket's explicit ask for per-target success/failure
  reporting. `disconnect-orchestrator.test.ts` will be restructured, not just
  extended, to match.
- **Export `readManagedMcpState`** (or equivalent) from `desktop.ts` — currently
  module-private, needed for the removal path to know what CodeMie owns.

## Acceptance Criteria

- `codemie proxy disconnect --claude-desktop` removes only CodeMie's
  `managedMcpServers` entries and the listed top-level keys, leaving all other
  MCP servers and unrelated config untouched; no-ops cleanly when nothing was
  connected.
- `codemie proxy disconnect --vscode` checks both the stable and Insiders
  `chatLanguageModels.json` locations and removes only the entry with
  `vendor === 'customendpoint' && name === 'CodeMie'` from whichever
  location(s) have it, leaving other providers untouched; no `--insiders` flag
  exists or is needed.
- `codemie proxy disconnect --vscode-claude-code` checks both the stable and
  Insiders `settings.json` locations and removes only the
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` entries from
  `claudeCode.environmentVariables` in whichever location(s) have them,
  preserving all other settings/comments/formatting; no `--insiders` flag
  exists or is needed.
- Any combination of the four target flags runs independently and reports a
  per-target `✓`/`✗`/no-op line; one target's failure does not block or corrupt
  another's run; `process.exitCode = 1` iff at least one target's removal threw.
- No-target invocation prints the four-target help list, updated from today's
  single-target text.
- `--codex-desktop` behavior is unchanged.

## Non-Goals

- No `--insiders` flag on `disconnect` (see Decisions — auto-detected instead).
- No new backup/rollback file for the three new targets (see Decisions).
- No changes to the `connect` side of any of the four connectors.
- No handling of MDM-managed settings shadowing the local Claude Desktop
  config (`describeManagedSettingsOverride()`) — pre-existing gap, not
  introduced or fixed here.
- No `--force` flag for disconnect (exists on `connect`, not requested here).
- No migration of existing marker-file formats.

## Open Risks

- If a user connected before this change shipped, the Claude Desktop marker
  file predates top-level inference-key tracking; disconnect still deletes the
  full key list unconditionally, which is safe (deleting an absent key is a
  no-op) but is worth noting as a one-way behavior change from today's
  MCP-only removal scope described in the original ticket text.
- Checking both stable and Insiders VS Code locations doubles the filesystem
  reads/writes for the two VS Code targets versus a flag-selected single
  location; negligible in practice (local JSON files, no network) but worth
  noting as a minor behavior difference from `connect`, which still requires
  an explicit `--insiders` selector.
