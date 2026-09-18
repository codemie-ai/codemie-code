# Unified `codemie proxy connect` with Target Flags — Story

**Date**: 2026-08-12
**Status**: Approved
**Ticket**: —

---

## Context

- The proxy command tree lives in `src/cli/commands/proxy/index.ts`. The `connect` group is created at index.ts:336, with `connect desktop` (index.ts:340) and `connect vscode` (index.ts:553) as separate action bodies.
- Three independent config writers already exist: `writeDesktopConfig()` (`connectors/desktop.ts` → Claude Desktop `claude_desktop_config.json`), `writeVsCodeLanguageModelsConfig()` (`connectors/vscode.ts` → Copilot BYOK `User/chatLanguageModels.json`), and `writeVsCodeClaudeCodeConfig()` (`connectors/vscode-claude-code.ts` → Claude Code extension `User/settings.json`).
- The `--vscode-claude-code` flag currently exists only as a **sub-flag of `connect desktop`** on this feature branch and is **not yet released**; there it always also writes the Desktop config, and the BYOK path and the Claude Code extension path can never be combined in a single invocation. Because the flag is unreleased, moving it to a standalone target on the unified command carries **no backward-compatibility cost** — it is reworked in this same branch.
- `desktop` and `vscode` share only daemon/health helpers; they duplicate the daemon-lifecycle scaffolding and differ in `telemetryMode`/`clientType` (`claude-desktop` vs `vscode-byok`) and daemon-match logic.
- Prior planning artifacts for the `--vscode-claude-code` work sit under `docs/superpowers/tasks/2026-08-11-vscode-claude-noauth-desktop-connect/`; that spec explicitly listed changing `connect vscode` as a non-goal. **This story supersedes that non-goal** by unifying both commands.

---

## Story

**As a** CodeMie Code user wiring my local tools to the CodeMie proxy, **I want** a single `codemie proxy connect` command with orthogonal target flags (`--claude-desktop`, `--vscode`, `--vscode-claude-code`) **so that** I can configure exactly the tools I use — one or several in a single run — without remembering separate `desktop`/`vscode` subcommands or accepting unwanted side-writes.

---

## Background

Two overlapping subcommands (`connect desktop`, `connect vscode`) each start the same daemon but write different configs, and `--vscode-claude-code` is awkwardly nested under `desktop` so it can't be used with the VS Code BYOK models path. Users must know which subcommand owns which config, and can't compose targets. A unified `connect` with independent, composable target flags gives one mental model, one daemon-lifecycle path, and room to add future editor targets — while a highlighted deprecation notice guides existing users off the old subcommands without breaking their scripts.

---

## Acceptance Criteria

- [ ] Given the unified command, when I run `codemie proxy connect --claude-desktop`, then only the Claude Desktop config is written and no VS Code files are touched.
- [ ] Given the unified command, when I run `codemie proxy connect --vscode`, then only the VS Code Copilot BYOK `chatLanguageModels.json` is written.
- [ ] Given the unified command, when I run `codemie proxy connect --vscode-claude-code`, then only the VS Code Claude Code extension `settings.json` is written — a standalone target that does not also write the Desktop config.
- [ ] Given several target flags, when I run `codemie proxy connect --claude-desktop --vscode --vscode-claude-code`, then all three configs are written from a single daemon-lifecycle setup and a per-target success/failure summary is printed.
- [ ] Given no target flags, when I run `codemie proxy connect`, then a user-friendly list of the available targets is printed — each with a short description and example usage — no config files are written, no persistent connection is started, and the command exits successfully.
- [ ] Given `--insiders` alongside a VS Code target, when I run `codemie proxy connect --vscode --insiders`, then the VS Code Insiders config location is targeted.
- [ ] Given an existing config file with unrelated keys/entries, when a target is (re)written, then unrelated keys/entries are preserved (atomic-write behavior retained).
- [ ] **(negative)** Given `--claude-desktop --vscode`, when the VS Code write fails but the Desktop write succeeds, then the Desktop config stays written, the failure is reported in the summary, and the command exits non-zero.
- [ ] **(deprecation)** Given the deprecated `codemie proxy connect desktop`, when I run it, then it behaves as `connect --claude-desktop` AND prints a highlighted deprecation notice naming the new command to use.
- [ ] **(deprecation)** Given the deprecated `codemie proxy connect vscode`, when I run it, then it behaves as `connect --vscode` AND prints a highlighted deprecation notice naming the new command to use.

---

## Out of Scope

- Changing the content/schema each writer produces (Desktop, BYOK, or Claude Code extension config).
- A `disconnect` / uninstall counterpart command.
- An `--all` convenience flag (explicitly declined — explicit target flags only).
- An interactive target picker for the no-flag case.
- Adding new target types beyond the current three.
- Redesigning telemetry attribution for combined targets (see Open Questions).

---

## Open Questions

- Daemon `telemetryMode`/`clientType` when multiple targets run under one invocation: combined mode, a designated primary target, or per-target attribution? (Engineering to resolve.)
- Should `--insiders` passed with only `--claude-desktop` (no VS Code target) warn, or be silently ignored?
- Exact help-text wording to disambiguate `--vscode` (Copilot BYOK model list) from `--vscode-claude-code` (Claude Code extension).
