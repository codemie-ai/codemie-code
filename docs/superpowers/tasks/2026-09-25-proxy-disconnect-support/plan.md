# Proxy Disconnect Support (Claude Desktop, VS Code Copilot Chat, VS Code Claude Code) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `codemie proxy disconnect` from `--codex-desktop`-only to all four `connect` targets (`--claude-desktop`, `--vscode`, `--vscode-claude-code`, `--codex-desktop`), each with a per-target `✓`/`✗`/no-op result.

**Architecture:** Each new connector file gets an exported removal function beside its write function, following `removeCodexDesktopConfig`'s `{ removed: boolean, ... }` contract. `disconnect-orchestrator.ts` is rewritten from its single `if` branch to the `TargetResult { label, ok, error }` / `printSummary()` shape already used by `connect-orchestrator.ts`.

**Tech Stack:** TypeScript, Vitest, `jsonc-parser` (VS Code Claude Code settings), Node `fs/promises` atomic-write pattern already in the codebase.

**Spec:** `docs/superpowers/tasks/2026-09-25-proxy-disconnect-support/spec.md`

Commit per task using the repository's existing convention (Conventional Commits, per `.ai-run/guides/standards/git-workflow.md`).

## Global Constraints

- No `--insiders` flag on `disconnect`; the two VS Code removal functions take no `insiders` parameter and always check both `getVsCodeProductDir(false)` and `getVsCodeProductDir(true)`.
- No `.codemie-backup` fallback for the three new targets — deterministic array-filter/key-delete only.
- `--codex-desktop` behavior is unchanged; do not touch `codex-desktop.ts` or its tests except as a read-only reference.
- "Nothing to disconnect" is `removed: false`, no exception, no `process.exitCode` change.
- Genuine failures throw; orchestrator catches, `logger.warn` + `chalk.red('✗ ...')` + `process.exitCode = 1`.
- No new backup/rollback files, no `--force` on disconnect, no marker-file format migration.

## Review Focus

- Claude Desktop disconnect must delete the full `INFERENCE_KEYS` set + `inferenceModels` + `coworkEgressAllowedHosts` + `managedMcpServers`, not just the MCP array — a partial clear would leave a stale gateway key on disk after "disconnect".
- Claude Desktop disconnect must preserve MCP servers not in the marker's `managedNames` (a user's own MCP entries) — a naive "clear the whole array" would delete them.
- VS Code Copilot Chat / Claude Code disconnect must check **both** stable and Insiders paths and treat a missing directory (one edition not installed) as `removed: false` for that path, not a thrown `ConfigurationError` — `getVsCodeProductDir`/`getVsCodeLanguageModelsPath`/`getVsCodeClaudeCodeSettingsPath` throw on a missing product dir, which the new removal functions must catch and treat as "nothing there," not propagate.
- Malformed/corrupt config files (unreadable JSON/JSONC) at a resolved path must throw an actionable `ConfigurationError` — not silently no-op, which would mask a real problem as "nothing to disconnect."
- Running two target flags together (e.g. `--claude-desktop --vscode`) must produce two independent `TargetResult`s in the summary, with one throwing not affecting the other's outcome or the process exit code beyond `anyFailed`.

---

### Task 1: Claude Desktop connector — `removeDesktopConfig()`

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts:647-680` (export `readManagedMcpState`), add new exported function near `writeDesktopConfig` (after line 937).
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` (add cases; extends existing file).

**Interfaces:**
- Consumes: existing `getManagedMcpStatePath()`, `getDesktopConfigPath(baseDir)`, `reconcileManagedMcpServers(existingServers, managed, previouslyManagedNames)`, `INFERENCE_KEYS` (module-private, already defined at line 17).
- Produces: `export async function readManagedMcpState(statePath: string): Promise<string[]>` (change from module-private to exported, same signature/behavior). `export async function removeDesktopConfig(statePath: string = getManagedMcpStatePath(), baseDir: string = getDesktopBaseDir()): Promise<{ removed: boolean; configPath: string | null }>` — later consumed by Task 4 (`disconnect-orchestrator.ts`).

Test-first: yes — a failing test for `removeDesktopConfig` no-op when the marker state file is absent.

- [ ] **Step 1: Write failing tests** covering: (a) no-op (`removed: false`) when `statePath` doesn't exist; (b) no-op when `managedNames` is empty; (c) no-op when the resolved config file doesn't exist; (d) successful removal — reconciles `managedMcpServers` with an empty managed set (drops every marker-recorded name, keeps a genuine user-added MCP entry), deletes `INFERENCE_KEYS`, `inferenceModels`, `coworkEgressAllowedHosts`, `managedMcpServers` top-level keys, writes atomically, then clears the state file (`writeAtomically(statePath, '')`); (e) unrelated top-level keys and non-managed MCP entries survive removal.
- [ ] **Step 2: Run tests** (`npx vitest run desktop.test.ts`) — expect FAIL, `removeDesktopConfig`/`readManagedMcpState` not exported.
- [ ] **Step 3: Implement.** Change `readManagedMcpState` (line 656) from module-private to `export async function`. Add `removeDesktopConfig` reusing `reconcileManagedMcpServers(existing.managedMcpServers, [], managedNames)` for the surviving array, deleting the same key set `writeDesktopConfig` deletes (lines 891-896), then `writeAtomically(configPath, JSON.stringify({...existing, managedMcpServers: JSON.stringify(reconciled.servers)}, ...))` — but drop `managedMcpServers` entirely rather than write an empty JSON string, matching "delete the full set of CodeMie-written top-level keys." Use `writeAtomically` imported from `./vscode.js`.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 2: VS Code Copilot Chat connector — `removeVsCodeLanguageModelsConfig()`

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode.ts` (add new exported function after `writeVsCodeLanguageModelsConfigAtPath`, line 326).
- Test: `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts` (add cases; extends existing file — verify it exists, else create alongside the existing suite's conventions).

**Interfaces:**
- Consumes: `getVsCodeLanguageModelsPath(insiders)` (line 91, throws `ConfigurationError` if product dir missing), `isManagedProvider` (module-private, line 59), `readProviders` (module-private, line 224), `writeAtomically` (line 255, exported).
- Produces: `export async function removeVsCodeLanguageModelsConfig(): Promise<{ removed: boolean }>` — later consumed by Task 4.

Test-first: yes — a failing test asserting `removed: false` when neither stable nor Insiders location has a CodeMie entry.

- [ ] **Step 1: Write failing tests**: (a) `removed: false` when both `getVsCodeLanguageModelsPath` calls throw `ConfigurationError` (product dir missing) — catch per-path, do not propagate; (b) `removed: false` when a path exists but its array has no `isManagedProvider` entry; (c) `removed: true` and the CodeMie entry filtered out, other providers preserved, when one location has a match; (d) `removed: true` when both stable and Insiders match; (e) a genuinely corrupt JSON array at a resolved path still throws (via `readProviders`'s existing `ConfigurationError`), proving malformed-config errors are not swallowed alongside the missing-product-dir catch.
- [ ] **Step 2: Run tests** — expect FAIL, function not exported.
- [ ] **Step 3: Implement.** For each of `[false, true]` insiders values: resolve the path via a try/catch around `getVsCodeLanguageModelsPath(insiders)` — a thrown `ConfigurationError` here means "not installed," treat as no match for that path and continue; a successful path resolution then calls `readProviders(path)` (whose own throws for corrupt JSON must propagate). Filter out `isManagedProvider` entries; if any were removed, `writeAtomically(path, JSON.stringify(filtered, ...))`. Track whether any of the two locations changed for the aggregate `removed` result.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: VS Code Claude Code connector — `removeVsCodeClaudeCodeConfig()`

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode-claude-code.ts` (add new exported function after `writeVsCodeClaudeCodeConfig`, line 248).
- Test: `src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts` (add cases; extends existing file).

**Interfaces:**
- Consumes: `getVsCodeClaudeCodeSettingsPath(insiders)` (line 38, throws `ConfigurationError` if product dir missing), `readSettings` (module-private, line 65), `MANAGED_ENV_VAR_NAMES` (module-level Set, line 19), `jsonc-parser`'s `modify`/`applyEdits` (already imported), `writeAtomically` (imported from `./vscode.js`).
- Produces: `export async function removeVsCodeClaudeCodeConfig(): Promise<{ removed: boolean }>` — later consumed by Task 4.

Test-first: yes — a failing test asserting `removed: false` when `claudeCode.environmentVariables` has neither managed key.

- [ ] **Step 1: Write failing tests**: (a) `removed: false` when both stable/Insiders product dirs are missing (catch per-path, same pattern as Task 2); (b) `removed: false` when a settings file exists but `claudeCode.environmentVariables` has no `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` entries; (c) `removed: true`, both managed entries stripped from `environmentVariables`, other env vars and top-level settings/comments preserved, using targeted `modify()`/`applyEdits()` (not full re-serialize); (d) `removed: true` when both stable and Insiders match; (e) corrupt/unparseable JSONC at a resolved path throws (via `readSettings`'s existing `ConfigurationError`), not swallowed.
- [ ] **Step 2: Run tests** — expect FAIL.
- [ ] **Step 3: Implement.** For each of `[false, true]` insiders values: try/catch around `getVsCodeClaudeCodeSettingsPath(insiders)`, treating a thrown `ConfigurationError` as no match for that path. On a resolved path, `readSettings(path)`; if `environmentVariables` contains either managed key, filter them out and apply via `modify(raw, ['claudeCode.environmentVariables'], filtered, { formattingOptions: detectFormattingOptions(raw) })` + `applyEdits`, then `writeAtomically`. Aggregate `removed` across both locations.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 4: Rewrite `disconnect-orchestrator.ts` to four-target `TargetResult` dispatch

**Files:**
- Modify: `src/cli/commands/proxy/disconnect-orchestrator.ts` (full rewrite of `DisconnectTargets`, `DISCONNECT_TARGET_LIST`, `disconnectTargets`).
- Test: `src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts` (restructure — target set and reporting shape both change).

**Interfaces:**
- Consumes: `removeCodexDesktopConfig` (unchanged), `removeDesktopConfig` (Task 1), `removeVsCodeLanguageModelsConfig` (Task 2), `removeVsCodeClaudeCodeConfig` (Task 3).
- Produces: `export interface DisconnectTargets { claudeDesktop?: boolean; vscode?: boolean; vscodeClaudeCode?: boolean; codexDesktop?: boolean; }`; `export async function disconnectTargets(opts: DisconnectOptions): Promise<void>` (signature unchanged) — consumed by Task 5.

Test-first: yes — a failing test for the four-flag `DISCONNECT_TARGET_LIST` help text and independent per-target dispatch.

- [ ] **Step 1: Write failing tests**, following the existing dynamic-import-after-mock pattern (`vi.resetModules()` in `beforeEach`, `vi.doMock('../connectors/<file>.js', ...)`): (a) no-target prints all four flags; (b) each of the four targets independently prints `✓ <label> disconnected` on `removed: true`; (c) each prints a dim no-op line on `removed: false`; (d) one target throwing sets `process.exitCode = 1` while a sibling target in the same invocation still reports its own outcome (mock one connector to reject, another to resolve `removed: true`, assert both console lines appear and `process.exitCode === 1`); (e) codex-desktop's existing backup-fallback message still fires unchanged.
- [ ] **Step 2: Run tests** — expect FAIL against the current single-target implementation.
- [ ] **Step 3: Implement.** Define local `TargetResult { label, ok, error }` and `printSummary` (mirror `connect-orchestrator.ts:374-390`). Add one `runX(targets): Promise<TargetResult>` per target following the codex-desktop try/catch shape (lines 37-57 of the current file) — no-op path logs via `chalk.dim` and returns `{ label, ok: true }` without adding to a "failed" count; error path logs via `logger.warn` + returns `{ label, ok: false, error: message }`. Dispatch: build `results: TargetResult[]` by pushing the result of each requested target's `runX`, independently (no early return on failure). After all requested targets run, if any result's underlying call threw, `process.exitCode = 1`. Update `DISCONNECT_TARGET_LIST` to list all four flags, mirroring `TARGET_LIST` in `connect-orchestrator.ts:264-279`.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 5: CLI wiring — `disconnect` subcommand flags

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:316-322`.

**Interfaces:**
- Consumes: `DisconnectTargets` (Task 4), `disconnectTargets` (Task 4, signature unchanged).
- Produces: none (leaf task).

Test-first: no — this is a 6-line Commander option-declaration change with no new branching logic; behavior is exercised end-to-end by Task 4's orchestrator tests plus manual `--help` inspection is out of scope per the no-manual-verification constraint.

- [ ] **Step 1: Replace lines 316-322** — add `.option('--claude-desktop', 'Remove the CodeMie MCP entries and gateway config from Claude Desktop')`, `.option('--vscode', "Remove CodeMie's entry from VS Code Copilot Chat models (chatLanguageModels.json)")`, `.option('--vscode-claude-code', "Remove CodeMie's ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN from the VS Code Claude Code extension")` alongside the existing `--codex-desktop` option, and update the `.action()` callback's opts type and `targets` object to pass all four booleans through to `disconnectTargets`.
- [ ] **Step 2: Commit.**
