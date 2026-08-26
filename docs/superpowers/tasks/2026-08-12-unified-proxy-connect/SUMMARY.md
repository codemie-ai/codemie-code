# Unified `codemie proxy connect` — Implementation Summary

**Date**: 2026-08-12
**Branch**: `feature/vscode-claude-noauth-desktop-connect`
**Flow**: sdlc-standard (HITL) · **Complexity**: M (17/36 actual, 18 initial)
**Status**: Complete — changes are in the working tree, **not committed** (per no-per-task-commit preference).

---

## What was built

Unified `codemie proxy connect` into a single command with orthogonal, composable **target flags**, replacing the two overlapping subcommands.

- `codemie proxy connect --claude-desktop` → Claude Desktop config only
- `codemie proxy connect --vscode` → VS Code Copilot BYOK model list only
- `codemie proxy connect --vscode-claude-code` → VS Code Claude Code extension only (now **standalone** — no longer implies Desktop)
- Any combination writes the union over **one daemon lifecycle**, prints a per-target summary, and exits non-zero if any requested target fails.
- Bare `codemie proxy connect` prints a friendly target list and exits 0 (writes nothing).
- `connect desktop` / `connect vscode` remain as **deprecated aliases** — they still work and print a highlighted `chalk.bold.yellow` deprecation notice pointing to the new flag form.
- `--insiders` with only `--claude-desktop` warns (no effect) and continues.

### Design decisions (resolved former open questions)
- **Telemetry**: primary-by-priority (`claude-desktop` > `vscode-claude-code` > `vscode-byok`) collapses onto the **two existing** identities — no new telemetry value, no backend change. Single-target runs spawn a daemon byte-identical to before.
- **Daemon match**: one strict `daemonMatchesRequest` path for every invocation (the loose desktop gate was removed).
- **Partial failure**: each target writer runs in its own try/catch; `process.exitCode = 1` on any failure; daemon kept if ≥1 target succeeded, rolled back only if all failed *and* it was started this run.

---

## Files changed (working tree)

| File | Change |
|---|---|
| `src/cli/commands/proxy/connect-orchestrator.ts` | **new** (~572 lines) — `connectTargets()` orchestrator, `deriveDaemonIdentity`, `ensureDaemon`, per-target dispatch, and the shared helpers moved out of `index.ts` |
| `src/cli/commands/proxy/index.ts` | rewired (+77/−497) — unified `connect` action + two thin deprecated aliases; `enablePositionalOptions()` on `proxy` and `connect` so aliases can reuse `--profile` |
| `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` | **new** — 20 unit tests (identity mapping, daemon lifecycle, dispatch, summary, partial-failure/rollback) |
| `src/cli/commands/proxy/__tests__/connect-wiring.test.ts` | **new** — 4 wiring tests (flag→target mapping, alias notices, option exposure) |

Config writers (`connectors/desktop.ts`, `connectors/vscode.ts`, `connectors/vscode-claude-code.ts`) were **not changed** (out of scope).

---

## Quality gates

- **Code review** (3-lens): final round → request-changes (2 major findings); both fixed; check round → **approve**.
  - **CR-001**: explicit `return;` guard added after `printProxyError` in the `connectTargets` catch (prevents fall-through to dispatch with unassigned `state`/`config`).
  - **CR-002**: per-target summary now printed **unconditionally** per spec §3.4 (+ test).
- **qa-gates**: PASSED — license, lint, typecheck, build, unit, integration, secrets, commitlint. No drift.
- **feature-verification**: skipped (no UI-glob files; CLI-only change).
- Full proxy test suite: **141/141 pass**; `tsc --noEmit` clean; `eslint` clean (0 warnings).

---

## Not done (deliberately)

- **No commits** were made (per preference). The task changes and all planning artifacts under `docs/superpowers/tasks/2026-08-12-unified-proxy-connect/` are uncommitted.
- One review finding was **deferred** (pre-existing, metrics-only): standalone `--vscode-claude-code` with a profile lacking `codeMieUrl` could spawn a never-syncing daemon — depends on unchanged upstream SSO validation, out of scope for this change.
- The two unrelated working-tree config edits (`.claude/settings.json`, `.codemie/codemie-cli.config.json`) were left untouched.

---

## Next steps

- Commit the code + artifacts and open a PR — invoke `mr-creator` (or your preferred PR tool) when ready. Suggested commit scope: the 4 proxy files + the task docs; exclude the unrelated config edits.
- Story: `docs/stories/2026-08-12-unified-proxy-connect.md` (Approved).
