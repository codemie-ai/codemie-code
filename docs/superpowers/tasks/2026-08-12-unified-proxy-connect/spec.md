# Unified `codemie proxy connect` with Target Flags — Design Spec

**Date**: 2026-08-12
**Branch**: `feature/vscode-claude-noauth-desktop-connect`
**Story**: `docs/stories/2026-08-12-unified-proxy-connect.md`
**Complexity**: M (18/36)

---

## 1. Goal

Replace the two overlapping subcommands `codemie proxy connect desktop` and
`codemie proxy connect vscode` with a single `codemie proxy connect` command that takes
**orthogonal, composable target flags**. A single invocation configures exactly the targets the
user names — one or several — over one daemon lifecycle, reports a per-target result, and exits
non-zero if any requested target failed. The old subcommands remain as deprecated aliases that
still work and print a highlighted notice pointing to the new form.

Out of scope: changing what each config writer produces; a `disconnect`/uninstall counterpart; an
`--all` flag; an interactive picker; new target types; telemetry/backend changes.

---

## 2. Command Surface

```
codemie proxy connect [target flags] [modifiers]
```

### Target flags (orthogonal — any combination)
| Flag | Configures | Writer (unchanged) | Output file |
|---|---|---|---|
| `--claude-desktop` | Claude Desktop app | `writeDesktopConfig()` (`connectors/desktop.ts`) | `claude_desktop_config.json` |
| `--vscode` | VS Code Copilot Chat models (BYOK) | `writeVsCodeLanguageModelsConfig()` (`connectors/vscode.ts`) | `User/chatLanguageModels.json` |
| `--vscode-claude-code` | VS Code Claude Code extension | `writeVsCodeClaudeCodeConfig()` (`connectors/vscode-claude-code.ts`) | `User/settings.json` |

`--vscode-claude-code` is now a **standalone target** — it no longer implies the Desktop config.

### Modifiers (shared)
- `--profile <name>` — CodeMie profile to use
- `--force` — existing force semantics
- `--verbose` — existing verbose semantics
- `--insiders` — target VS Code Insiders; applies to `--vscode` / `--vscode-claude-code` only

### Bare `connect` (no target flag)
Prints a user-friendly target list with examples, **writes nothing**, starts no daemon, and
**exits 0** (help-like, not an error):

```
Select at least one target to configure:

  --claude-desktop       Claude Desktop app (MCP servers)
  --vscode               VS Code Copilot Chat models (BYOK)
  --vscode-claude-code   VS Code Claude Code extension

Examples:
  codemie proxy connect --claude-desktop
  codemie proxy connect --vscode --vscode-claude-code
  codemie proxy connect --claude-desktop --vscode --insiders

Run 'codemie proxy connect --help' for all options.
```

No `--all` convenience flag.

---

## 3. Architecture

### 3.1 One orchestrator, thin command wrappers

Replace the two ~200-line action bodies in `src/cli/commands/proxy/index.ts` with a single
orchestration function — proposed `connectTargets(options)` — extracted into its own module (e.g.
`src/cli/commands/proxy/connect-orchestrator.ts`). It owns the whole lifecycle:

```
connectTargets({ targets, profile, insiders, force, verbose }):
  1. resolve SSO proxy config            (resolveSsoProxyConfig)
  2. derive daemon telemetry identity    (§3.3, from the active target set)
  3. ensure the daemon                   (single reconciled match → spawn → health; §3.2)
  4. for each requested target, run its writer in its own try/catch, capturing {target, ok, error}
  5. print the per-target summary         (§3.4)
  6. set process.exitCode and roll back the daemon per the rules in §3.4
```

Three thin callers build a target set and delegate to it:
- the unified `connect` action (targets from the parsed flags),
- the deprecated `connect desktop` alias (`{ claudeDesktop: true }`),
- the deprecated `connect vscode` alias (`{ vscode: true }`).

This removes the duplicated daemon scaffolding, shrinks `index.ts`, and gives the
currently-untested orchestration a single testable unit.

### 3.2 Daemon match — reconcile the two strategies into one

Today the two bodies disagree on when to reuse a running daemon:
- `desktop` gates only on `telemetryMode !== 'claude-desktop'` (loose),
- `vscode` does a full inline match on profile/project/provider/targetUrl +
  `getEffectiveClientType() === 'vscode-byok'` (strict).

**Adopt the strict match as the single path** for every invocation, parameterized by the requested
identity from §3.3. Promote it to one shared matcher — the existing `daemonMatchesRequest` helper
(used by neither today) is the natural home; if its shape does not fit, factor the `vscode` inline
match into a shared function and call it from all callers. The loose desktop gate is removed.

Health check (`checkProxyHealth`) and the `startedInThisRun` rollback idiom are preserved: if this
run spawned the daemon and setup fails fatally, stop it (§3.4).

### 3.3 Telemetry identity — primary by priority, mapped onto existing values

Priority order: **`claude-desktop` > `vscode-claude-code` > `vscode-byok`**. Because the two
Anthropic-gateway targets (Desktop app and Claude Code extension) consume the identical
`ANTHROPIC_BASE_URL`/token gateway — and `--vscode-claude-code` today already piggybacks on the
claude-desktop daemon — the priority collapses onto the **two existing** identities. **No new
telemetry value is introduced.**

| Active target set | Daemon identity |
|---|---|
| includes `--claude-desktop` or `--vscode-claude-code` (with or without `--vscode`) | `telemetryMode: 'claude-desktop'` |
| `--vscode` only | `clientType: 'vscode-byok'` |

Consequence: every single-target run spawns a daemon **byte-identical** to today's behavior
(`desktop` → `claude-desktop`; `vscode` → `vscode-byok`; standalone `vscode-claude-code` → the
`claude-desktop` gateway it already used). This is also what preserves the deprecated-alias surface
(§3.5) and the live integration test (§5).

### 3.4 Per-target result + partial-failure semantics (new behavior)

Each requested writer runs independently in its own `try/catch` (generalizing the existing
non-fatal `--vscode-claude-code` handling). After all requested targets run, print a summary:

```
Targets configured:
  ✓ Claude Desktop
  ✗ VS Code (Copilot models)  — <one-line reason>
```

Exit / rollback rules:
- **Any** requested target failed → `process.exitCode = 1`. (New — today errors route through
  `printProxyError` and never set an exit code.)
- **All** requested targets failed **and** the daemon was started in this run → stop the daemon
  (`startedInThisRun` rollback).
- **At least one** target succeeded → keep the daemon running (it is serving the successful target),
  even though the exit code is non-zero.
- The daemon **startup itself** fails (before any target write) → hard failure: roll back if started
  this run, call `printProxyError`, exit non-zero. Same as today.

### 3.5 Deprecated aliases

`connect desktop` and `connect vscode` remain registered subcommands, each a thin wrapper:
- `desktop` → `connectTargets({ claudeDesktop: true, ... })`
- `vscode` → `connectTargets({ vscode: true, ... })`

Each prints a **highlighted** (chalk bold/yellow) deprecation notice **before** doing its work:
```
⚠ 'codemie proxy connect desktop' is deprecated — use 'codemie proxy connect --claude-desktop' instead.
⚠ 'codemie proxy connect vscode'  is deprecated — use 'codemie proxy connect --vscode' instead.
```

- Aliases keep only their **originally-released** modifiers (`--profile`, `--verbose`, `--force`,
  `--insiders`).
- The new `--vscode-claude-code` flag lives **only** on unified `connect`. It was unreleased as a
  `desktop` sub-flag, so the alias intentionally drops it — nothing shipped depends on it.
- `vscode` alias still resolves to the `vscode-byok` identity, keeping the integration-test surface
  intact (§5).

### 3.6 `--insiders` with no VS Code target

`--insiders` only affects the VS Code config location. If passed with **only** `--claude-desktop`
(no VS Code target), print a warning and continue — do not error:
```
Note: --insiders has no effect without a VS Code target (--vscode / --vscode-claude-code).
```

---

## 4. Data Flow

```
CLI parse (Commander)
  ├─ unified `connect`  ─ build target set from flags ─┐
  ├─ `desktop` alias    ─ {claudeDesktop:true} + notice ┤
  └─ `vscode`  alias    ─ {vscode:true} + notice        ┘
                                                        ▼
                                             connectTargets(options)
                                                        │
                    resolveSsoProxyConfig ──────────────┤
                    derive telemetry identity (§3.3) ───┤
                    ensure daemon (match/spawn/health) ─┤ (rollback on fatal setup failure)
                                                        │
                    for target in requested:            │
                      try writer(target) ─ capture ─────┤
                                                        ▼
                    print summary  +  set exitCode  +  conditional rollback (§3.4)
```

---

## 5. Testing Strategy

Tests are written during implementation (Stage 5 TDD). The orchestration being introduced is
currently **untested**, so it is the priority.

Unit coverage (new `connectTargets` orchestrator):
- target-set resolution from flags (each single flag; combinations; none → prints list, exits 0,
  no writes)
- telemetry identity mapping table (§3.3), including the priority collapse for mixed sets
- per-target summary content and ordering
- exit-code rules: all-success → 0; any-failure → 1; all-failure → rollback when started this run
- partial success keeps the daemon; all-failure started-this-run stops it
- `--insiders` warning path when no VS Code target
- deprecated aliases emit the notice and delegate to the correct target set

Regression / preserved surface (MUST NOT break):
- `tests/integration/vscode-models.live.test.ts` hard-codes `codemie proxy connect vscode` and
  asserts `clientType === 'vscode-byok'`. The `vscode` alias must keep that command string valid and
  that client type intact.

Writers themselves (`writeDesktopConfig`, `writeVsCodeLanguageModelsConfig`,
`writeVsCodeClaudeCodeConfig`) are out of scope and unchanged; mock them at the orchestrator boundary.

---

## 6. Risks & Mitigations

| Risk (from technical analysis) | Mitigation in this design |
|---|---|
| Untested orchestration under rewrite | Extract `connectTargets` as one unit; cover it with the §5 unit tests before/while refactoring (TDD) |
| Divergent daemon-match logic | §3.2 — single strict matcher for all callers; remove the loose desktop gate |
| Multi-target telemetry attribution undefined | §3.3 — priority order collapsing onto the two existing identities; no backend change |
| `--vscode-claude-code` had no daemon posture | §3.3 — standalone it reuses the `claude-desktop` gateway identity it already piggybacked on |
| No partial-failure exit semantics | §3.4 — per-target try/catch, summary, `process.exitCode`, conditional rollback |
| Integration test couples to old surface | §3.5 + §5 — `vscode` alias preserves the exact command string and `vscode-byok` identity |

---

## 7. Acceptance Criteria (from the approved story)

- `connect --claude-desktop` writes only the Desktop config; no VS Code files touched.
- `connect --vscode` writes only `chatLanguageModels.json`.
- `connect --vscode-claude-code` writes only the Claude Code extension `settings.json` (standalone).
- `connect --claude-desktop --vscode --vscode-claude-code` writes all three from one daemon
  lifecycle and prints a per-target summary.
- Bare `connect` prints the friendly target list, writes nothing, starts no daemon, exits 0.
- `--insiders` with a VS Code target uses the Insiders config location.
- Existing config files retain unrelated keys/entries (atomic-write behavior unchanged).
- **(negative)** `--claude-desktop --vscode` where the VS Code write fails but Desktop succeeds:
  Desktop stays written, the failure is in the summary, exit code is non-zero.
- **(deprecation)** `connect desktop` behaves as `connect --claude-desktop` and prints the notice.
- **(deprecation)** `connect vscode` behaves as `connect --vscode` and prints the notice.

---

## 8. Resolved Design Decisions (were Open Questions in the story)

1. **Multi-target telemetry attribution** → primary-by-priority, collapsing onto the two existing
   identities (§3.3). No new telemetry value; no backend change.
2. **`--insiders` with only `--claude-desktop`** → warn and continue (§3.6).
3. **Help-text wording** → §2 target-flag descriptions and the bare-`connect` list.
