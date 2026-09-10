# Technical Research

**Task**: proxy connect cursor-ide analytics
**Generated**: 2026-09-10T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

"`codemie proxy connect --cursor-ide` command should just say that 'Only analytics is supported'"

---

## 2. Codebase Findings

### Existing Implementations

- No `--cursor-ide` (or `cursorIde`) option currently exists anywhere in `src/`. A repo-wide grep for `cursor-ide` / `cursorIde` / `cursor_ide` returns no matches. This is a new flag, not a modification of existing behavior.
- The only unrelated "cursor" hits in `src/` are: terminal-cursor ANSI handling in `src/cli/commands/shared/selection/interactive-prompt.ts` (`cursorIndex`, `ANSI.CURSOR_HOME_CLEAR`), and an existing, unrelated "Cursor" **editor** concept used by the `codemie assistants`/`skills` setup flows (`src/cli/commands/shared/agent-targets.ts`, `src/cli/commands/assistants/setup/**`, `src/cli/commands/skills/lib/agent-detection.ts`) which detect a `.cursor/` directory for skill/rule installation. None of that code is wired to `proxy connect`.
- `.ai-run/guides/integration/external-integrations.md:287` documents "Best-effort agent auto-detection (`--agent cursor` if `.cursor/` present)" for the skills/assistants domain — a separate command family, not proxy.
- No existing "analytics-only" support for Cursor was found in `src/telemetry/` or elsewhere; a grep for `-i cursor` under `src/telemetry` and `src/analytics` returns nothing. The claim "Only analytics is supported" is the informational message the task wants printed, not a reference to already-implemented Cursor telemetry ingestion.

### Architecture and Layers Affected

- **CLI command layer**: `src/cli/commands/proxy/index.ts` — this is where the unified `connect` command (`createProxyCommand()`) declares all target flags (`--claude-desktop`, `--vscode`, `--vscode-claude-code`, `--codex-desktop`, plus shared `--profile`, `--force`, `--verbose`, `--insiders`, `--model`) via Commander `.option(...)` calls (lines 290-299) and dispatches to `connectTargets()` in its `.action()` (lines 300-314).
- **Orchestration layer**: `src/cli/commands/proxy/connect-orchestrator.ts` — `connectTargets()` (the single entry point all target flags funnel into) builds a `ConnectTargets` object, resolves the SSO profile, starts/reuses the proxy daemon, and dispatches to per-target runner functions (`runClaudeDesktop`, `runVscodeByok`, `runVscodeClaudeCode`, `runCodexDesktop`). `ConnectTargets` (lines 56-61) and `hasAnyTarget()` (line 282) currently enumerate exactly four targets; Cursor is not one of them.
- No repository/model or persistence layer is implicated — this is purely a CLI presentation/dispatch concern.

### Integration Points

- `UnifiedConnectOptions` interface in `src/cli/commands/proxy/index.ts` (lines 33-43) is the Commander options bag passed into the action; any new flag must be added both as a `.option(...)` declaration and as a field on this interface.
- `connect-orchestrator.ts` imports connectors under `./connectors/` (`desktop.ts`, `vscode.ts`, `vscode-claude-code.ts`, `codex-desktop.ts`, `managed-mcp-remote.ts`) — these are the actual config-writing integrations for each supported target. A Cursor target, if it ever did real work, would live here; the task explicitly says it should not.
- `daemon-manager.ts` (`checkStatus`, `spawnDaemon`, `stopDaemon`, `readState`, `writeState`) backs the shared local proxy daemon lifecycle that every real target shares via `ensureDaemon()`.

### Patterns and Conventions

- **Existing "no-op / informational note" pattern already present in this same file**, directly reusable for the new message:
  - `connectTargets()` prints an "options with no effect" note without touching the daemon or profile logic, e.g. (`connect-orchestrator.ts:600-608`):
    ```ts
    if (insiders && !targets.vscode && !targets.vscodeClaudeCode) {
      console.log(chalk.yellow('Note: --insiders has no effect without a VS Code target (--vscode / --vscode-claude-code).'));
    }
    if (opts.model && !targets.codexDesktop) {
      console.log(chalk.yellow('Note: --model has no effect without --codex-desktop.'));
    }
    ```
  - Bare invocation with no target flags already short-circuits before any daemon/profile work: `hasAnyTarget()` check at the top of `connectTargets()` (lines 592-595) prints `TARGET_LIST` and returns immediately — this is the closest existing precedent for "flag recognized, but no proxy connect side effects occur."
- **Deprecation-notice pattern** as a second precedent for a flag that prints a message and does *not* do what the flag name might suggest at face value: `printConnectDeprecation()` (`index.ts:52-60`) prints a highlighted `chalk.bold.yellow(...)` line before delegating. A Cursor stub could follow the same "print, then return/skip" shape but without the delegation.
- **Message styling conventions observed** across this file: `chalk.green('✓ ...')` for success, `chalk.yellow('⚠ ...')` / `chalk.yellow('Note: ...')` for warnings/notes, `chalk.red('✗ ...')` for failure, `chalk.dim(...)` for supplementary detail, `chalk.cyan(...)` for informational file/profile lines. All output goes through `console.log`/`console.error`, not `logger.*`, for user-facing text; `logger.*` (from `src/utils/logger.ts`, imported at `connect-orchestrator.ts:18`) is reserved for the debug/audit log file and is paired with `sanitizeLogArgs()` (`src/utils/security.ts`) whenever structured context is logged.
- **Error/exit conventions**: `printProxyError()` (`connect-orchestrator.ts:250-261`) is the single place that logs via `logger.error`, prints a red `✗ ...` line, and calls `process.exit(1)` for command-level failures. Per-target partial failures instead set `process.exitCode = 1` (line 701) without exiting immediately, letting the summary print first. Since "Only analytics is supported" is informational rather than an error, neither of these exit paths is the right model — the closest fit is the plain `console.log` + `return` used for the no-target case and the "Note:" cases, i.e. exit code 0, no daemon interaction, no summary block.
- Commander wiring: options are declared with `.option('--flag-name', 'description')`; multi-word flags map camelCase automatically (`--vscode-claude-code` → `opts.vscodeClaudeCode`), so `--cursor-ide` would map to `opts.cursorIde` with no extra Commander config needed.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/exposed-api.md` documents the CLI surface, including the proxy connect/disconnect endpoints — relevant to keep the new flag's help text and documented surface consistent, but it was not read in full here (this analysis focused on source-of-truth code rather than duplicating the guide's content).
- `.ai-run/guides/integration/external-integrations.md:287` documents Cursor only in the unrelated `--agent cursor` skills-detection context, confirming there is no existing Cursor-proxy documentation to reconcile.
- `docs/ARCHITECTURE-PROXY.md` exists and was recently refreshed (`106e829 docs: refresh ARCHITECTURE-PROXY.md`, current git log) — likely worth a follow-up read/update once the implementation approach is decided, since it documents the proxy's supported client targets.

### Architectural Decisions

- No ADR or inline `NOTE:`/`DECISION:` marker referencing Cursor was found. The existing "shared daemon, per-target dispatch" design (`connect-orchestrator.ts` header comment, lines 1-8) is the operative architectural decision for how targets are composed; a Cursor branch that does nothing to the daemon is consistent with, not a violation of, that design as long as it is short-circuited before `ensureDaemon()` is reached.

### Derived Conventions

- Flags that need to communicate "recognized but not actionable in this way" already exist in this exact file (the `--insiders`-without-VS Code-target and `--model`-without-`--codex-desktop` notes) and print via `chalk.yellow('Note: ...')` before any daemon work begins. This is the most directly reusable convention for the "Only analytics is supported" message.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/index.test.ts` (30.1K) — command wiring/help-text level tests for `createProxyCommand()`.
- `src/cli/commands/proxy/__tests__/connect-wiring.test.ts` — verifies flag-to-`ConnectTargets` mapping for the unified command and deprecated aliases (`unified connect maps target flags to a ConnectTargets set`, `--codex-desktop and --model` mapping test, etc.). This is the natural home for a new "`--cursor-ide` prints the analytics-only message and does not call `connectTargets`'s daemon path" test, following the existing pattern of asserting on the options object / mocked `connectTargets` call.
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` (24.7K) — exercises `connectTargets()` internals (`hasAnyTarget`, per-target runners, daemon lifecycle). No Cursor-related cases exist yet.
- `src/cli/commands/proxy/__tests__/daemon-status-contract.test.ts`, `daemon-manager.test.ts`, `disconnect-orchestrator.test.ts`, `health-check.test.ts`, `watcher.test.ts` — none reference Cursor.

### Testing Framework and Patterns

- Vitest (`describe`/`it`/`expect`/`vi` from `vitest`, per `connect-wiring.test.ts:7`). Tests mock `connectTargets`/`connect-orchestrator` module functions via `vi.mock` and assert on call arguments rather than exercising the real daemon, matching the layering already present in `connect-wiring.test.ts`.

### Coverage Gaps

- No test currently asserts on the "no target flags" (`hasAnyTarget` false) console output, though the code path exists — worth noting as the nearest analog test that a new Cursor test could mirror.
- No test exists for any "informational-only, non-error" flag path outputting a specific message and returning without side effects; the `--insiders`/`--model` "Note:" branches likewise appear untested. A `--cursor-ide` test will be first-of-kind for this exact shape (message-only, zero side effects, exit code 0) and should be added net-new rather than extended from an existing case.

---

## 5. Configuration and Environment

### Environment Variables

- None specific to Cursor or to this flag. General proxy env/config resolution goes through `ConfigLoader` (`src/utils/config.js`) and `ProviderRegistry` (`src/providers/index.js`), both imported in `connect-orchestrator.ts`, but the analytics-only Cursor message would not need to reach either.

### Configuration Files

- No config file governs Cursor-specific behavior in this codebase today. The real targets' config outputs (`~/.codex/config.toml`, Claude Desktop's MCP servers file, VS Code's `settings.json`/`chatLanguageModels.json`) are unrelated to what this task needs.

### Feature Flags and Deployment Concerns

- None found. This is a pure CLI-output change with no deployment, secrets, or feature-flag surface.

---

## 6. Risk Indicators

- Speculative: The natural implementation point is a new `.option('--cursor-ide', ...)` on the `connect` command in `src/cli/commands/proxy/index.ts` plus a field on `UnifiedConnectOptions`, with the actual short-circuit logic living either directly in the command's `.action()` (checked before calling `connectTargets`) or as an early branch inside `connectTargets()` in `connect-orchestrator.ts` alongside the existing `hasAnyTarget()` check — whichever keeps parity with how `--insiders`/`--model` "Note:" messages are already gated ahead of daemon startup.
- Speculative: because `hasAnyTarget()` (line 282) and `describeTargets()` (line 287) both enumerate a fixed four-target list, if `--cursor-ide` is added to `ConnectTargets` at all (rather than being intercepted purely at the CLI-option level before reaching the orchestrator), those two functions and the `TARGET_LIST` help text (lines 265-280) would need to stay consistent with whatever choice is made, or the bare-invocation help text and the real target list will drift.
- Risk: no test currently covers a "message-only, no side effects" flag branch, so a naive implementation could accidentally fall through into `resolveSsoProxyConfig`/`ensureDaemon` if the early-return is misplaced — the existing `hasAnyTarget()` early-return at the very top of `connectTargets()` (before profile resolution) is the safest reference point to mirror.
- Risk (low): `docs/ARCHITECTURE-PROXY.md` and `.ai-run/guides/integration/exposed-api.md` document the proxy's supported connect targets; if `--cursor-ide` is added to the command's `--help` output, these docs may go stale unless updated in the same change (not verified against their exact current content in this pass).

---

## 7. Summary for Complexity Assessment

This task touches exactly one architectural layer in depth — the CLI command/dispatch layer (`src/cli/commands/proxy/index.ts` and `src/cli/commands/proxy/connect-orchestrator.ts`) — and does not require any new connector, daemon, config-writer, or persistence work, since the desired behavior is explicitly "print a message, do nothing else." No `--cursor-ide` flag exists today anywhere in the codebase; this is a greenfield flag addition, not a modification of an existing Cursor connect path. The repository already contains two directly reusable precedents for exactly this shape: the bare-invocation early return (`hasAnyTarget()` guard before any profile/daemon work) and the `chalk.yellow('Note: ...')` messages already used for flags that have "no effect" in certain combinations — both localized to `connect-orchestrator.ts`.

Technical novelty is low: no new patterns, external integrations, or data models are needed, and the change is expressible as a small early-return branch plus a Commander option declaration. Test coverage for this specific shape (informational-only flag, zero side effects, exit code 0) does not exist yet, but the existing Vitest suites (`connect-wiring.test.ts`, `connect-orchestrator.test.ts`) provide a clear, already-established testing pattern to extend. The main risk is not technical difficulty but consistency: whether `--cursor-ide` is intercepted before or after entering `connectTargets()`, and whether the fixed four-target enumerations (`ConnectTargets`, `hasAnyTarget()`, `describeTargets()`, `TARGET_LIST`, and the command's `--help` text) need to acknowledge the new flag without implying it configures anything. Overall this reads as a small, low-risk, single-file-cluster change.

---

## 8. External References

None named by the task.
