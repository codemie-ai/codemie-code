# Specification: GitHub Copilot Local Statistics

**Status:** Draft — implementation is a draft for another team to verify and finalize
**Created:** 2026-11-18
**Branch:** `feature/Ievgen_Kyvgyla-github-copilot-local-statistics`
**Ports from:** `sl-ai-sdlc-cost-tracking` (`src/parsers/`, Python, Windows-only)

---

## Overview

Read GitHub Copilot usage from the artifacts Copilot already writes on the local machine —
the CLI/Desktop session store, its `events.jsonl` fallback, and the VS Code extension's chat
session logs — and feed them into the existing CodeMie analytics pipeline as priced sessions.

Four surfaces in scope: **Copilot CLI**, **Copilot Desktop**, **VS Code extension**, and
**WSL** (CLI/VS Code-agent homes inside running distros).

The value is *retroactive*: on first run the scan prices Copilot history that already exists
on disk, without the user having connected anything beforehand.

---

## Background

### What CodeMie covers today

| Surface | Current coverage | Gap |
|---|---|---|
| Copilot CLI | `copilot-cli` plugin reads `~/.copilot/session-state/<uuid>/`; `copilot-cli-otlp` hooks | No `session-store.db`; no `total_nano_aiu` (premium requests) |
| Copilot Desktop | `copilot-desktop` agent key exists; shares the CLI store | No scan of its only per-call usage source (`events.jsonl`) |
| VS Code extension | `copilot-chat-otlp` hooks only | **No token usage at all** — AGENTS.md: "no native OTel export is configured, so token usage is unavailable" |
| WSL | none | none |

Verified absent from `src/`: any reader for `session-store.db`, `assistant_usage_events`,
`workspaceStorage`, or `chatSessions`.

### What the Python tool already solved

| Parser | Source | Lines |
|---|---|---|
| `copilot_cli_store.py` | `~/.copilot/session-store.db` → `assistant_usage_events` + `sessions` (schema v8) | 508 |
| `copilot_cli_events.py` | `events.jsonl` → `session.usage_record` / `usage_checkpoint` / `shutdown` | 586 |
| `vscode_sessions.py` | `workspaceStorage/*/chatSessions/*.jsonl` append-log | 425 |
| `vscode_paths.py` | editions × profiles × 3 location kinds | 136 |
| `copilot_cli_wsl.py` | the same store per running distro | 253 |

Not ported: `copilot_cli_turns.py` (ticket-key scanning), `vscode_log.py` (token-free `ccreq`
lines), `intellij_log.py` (JetBrains — out of scope for this branch).

---

## Architecture Decision

### Chosen shape: a new `AnalyticsSource` + loader, modelled on `otel-loader.ts` / `OtelSource`

```
codemie analytics copilot
  → CopilotLocalSource.load()                      sources/copilot-local-source.ts
      → loadCopilotLocalSessions()                 copilot-local/copilot-local-loader.ts
          → store-reader      (session-store.db)
          → events-reader     (events.jsonl, sessions the store missed)
          → vscode-sessions-reader (chatSessions/*.jsonl)
          → wsl-reader        (per running distro)
      → CopilotUsageRow[] grouped by session
      → RawSessionData[] + SessionCostIndex + CostSummary   (cost is authoritative)
  → AnalyticsAggregator → formatter / report       (existing, unchanged)
```

`SourceResult.cost` exists precisely so a source that computed its own cost bypasses
`cost-enricher`. The scanners produce flat, already-tokenized rows — the same shape
`otel-loader.buildCostIndex()` consumes — so the port is a near-mechanical match.

### Why not session adapters (`discoverSessions` / `parseSessionFile`)

The adapter contract returns `ParsedSession`, and `usage-readers.ts` then *re-derives* tokens
from that parsed transcript. Rows from a SQL table would have to be reshaped into a
transcript-like object purely so a reader could turn them back into the numbers already in
hand — plus a new reader per surface. It also drags in the ownership/`native-external` gate
whether or not it is wanted here.

### Why not an `OtlpAgentAdapter` plugin

Structural mismatch, not just extra effort:

- Copilot Desktop fires no hooks at all.
- VS Code Copilot Chat's hooks carry no token usage.
- Nothing can backfill history — the whole point of this feature.
- Requires the proxy daemon plus a `proxy connect` step per surface.

A daemon-side producer (the `otlp-spool/copilot-usage-enrichment.ts` pattern) remains a
sensible **second** consumer of these scanners later, for live backend push. Same parsers, no
rework.

---

## Cross-platform design

Only the **root directory** differs between platforms. Everything below it is identical.

| | VS Code user data | Copilot home |
|---|---|---|
| Windows | `%APPDATA%/Code` (fallback `~/AppData/Roaming/Code`) | `~/.copilot` |
| macOS | `~/Library/Application Support/Code` | `~/.copilot` |
| Linux | `$XDG_CONFIG_HOME/Code` (fallback `~/.config/Code`) | `~/.copilot` |

- **Copilot CLI + Desktop are already platform-neutral.** `getCopilotHome()` resolves
  `~/.copilot` and honors `COPILOT_HOME`. The surface is decided by each session's
  `workspace.yaml` `client_name`, never by path.
- **WSL is Windows-only by nature** and degrades to a no-op: distro discovery returns nothing
  elsewhere.
- **Invariant:** `copilot-local-paths.ts` is the *only* module in `copilot-local/` that reads
  `process.platform` or a directory-naming env var. Every scanner takes its roots as
  arguments. This is the one rule that keeps the port from becoming accidentally Windows-only.

Verified on macOS during design: 3 entries under `User/profiles/*`,
`globalStorage/emptyWindowChatSessions` present, 29 `chatSessions/*.jsonl` files, the same
`kind:0`/`kind:1` append-log, `version:3`.

---

## File Changes

### New — `src/cli/commands/analytics/copilot-local/`

| File | Responsibility |
|---|---|
| `copilot-local-paths.ts` | Platform roots: Copilot home, VS Code editions × profiles × 3 location kinds, WSL homes. Only `process.platform` consumer. |
| `types.ts` | `CopilotUsageRow` (the `AiRequest` counterpart), `CopilotScanHealth`, closed `CopilotScanReason` enum, tolerant `toInt`/`toCount`. |
| `copilot-surfaces.ts` | `client_name` → agent key + surface label (reuses `resolveCopilotAgentKey`); bounded `workspace.yaml` read; `initiator` → category. |
| `store-reader.ts` | `session-store.db`: snapshot copy, allowlisted `assistant_usage_events` columns, schema-version probe. |
| `events-reader.ts` | `events.jsonl` fallback for sessions the store does not cover (all Desktop sessions). |
| `vscode-sessions-reader.ts` | `chatSessions/*.jsonl` append-log: `kind:0` snapshot, `kind:1` property update, `kind:2` request batch. |
| `wsl-reader.ts` | Running distros only; each home read in isolation through the store/events readers. |
| `copilot-local-loader.ts` | Orchestrate → dedupe → group by session → `RawSessionData[]` + `SessionCostIndex` + `CostSummary`. |
| `index.ts` | Barrel. |

### New — source + CLI

- `src/cli/commands/analytics/sources/copilot-local-source.ts` — implements `AnalyticsSource`.
- `src/cli/commands/analytics/index.ts` — register `codemie analytics copilot`, mirroring the
  `analytics otel` subcommand at `index.ts:47`.

### Modified

- `src/cli/commands/analytics/cost/usage-readers.ts` — extract and export
  `copilotUsageToTokens()` from `readCopilotCli()`. **Already applied.**
- `src/cli/commands/analytics/agent-labels.ts` — add `copilot-vscode`. The HTML report's
  client bundle (`report/client/app.js`) carries its own copy of this map and must be updated
  in step.

---

## Key semantics to preserve

### Token convention (billing-critical)

Copilot's `inputTokens` **includes** `cacheReadTokens` (OpenAI convention); this repo's
`costBreakdown()` bills `input` and `cacheRead` separately. Passing `inputTokens` through
unchanged over-counts input by ~36× on a real measured session.

`copilotUsageToTokens()` is therefore exported from `usage-readers.ts` and shared, rather than
reimplemented in the scanners — two copies of a billing formula drift silently into two
different dollar figures for the same session.

### Premium requests are not tokens

A Copilot subscription is billed in premium requests, not tokens. `total_nano_aiu` /
`totalNanoAiu` (1e-9 AI unit) and VS Code's `copilotCredits` are the only figures that
reconcile against an invoice, and are carried on every row as `billedNanoAiu` /
`reportedCredits`.

### VS Code append-log schema drift

`kind:1` keys appear in two forms — the legacy string (`"k":"requests"`) and the current JSON
path array (`"k":["requests",2,"promptTokens"]`). The Python original handles both and records
what breaks otherwise: "periodic kind:0 snapshots survived and recent activity vanished
entirely." macOS writes the array form. Both branches must survive the port.

### Surface attribution

`client_name` is authoritative and cwd-invariant: `github/autopilot` → Desktop,
`vscode-agent-host` → VS Code's Copilot CLI agent (stays on the `copilot-cli` key, matching
`copilot-cli-otlp`), anything else → CLI. The cwd heuristic is a fallback only; it mislabels a
Desktop session opened on a project folder.

### Double-counting guards

- A session covered by the store is excluded from the `events.jsonl` pass (`coveredSessionIds`).
- VS Code sessions reachable from both the shared `User` root and a `User/profiles/*` root are
  deduped by request id.
- **Open risk:** `native-loader.ts:47` already discovers `copilot-cli` sessions from
  `session-state/`. Merging this source into the default `SessionsSource` would double-count
  CLI sessions. Mitigation: ship behind its own `analytics copilot` subcommand first; decide
  the merge/dedup policy as a separate step.

---

## SQLite decision

`session-store.db` is SQLite and the repo has no SQLite dependency.

**Chosen:** `node:sqlite` via guarded dynamic import, degrading to the `events.jsonl` path when
unavailable, recorded as the `sqlite_unavailable` scan reason.

| Option | Verdict |
|---|---|
| `node:sqlite` (guarded) | **Chosen.** Zero dependencies, zero native build, cross-platform free. Needs Node ≥ 22.5; `engines` says `>= 20`, so Node 20 loses `total_nano_aiu` for CLI — but *not* Desktop, which never writes the store. |
| `better-sqlite3` | Fallback if exact premium requests on Node 20 are required. `keytar` sets the native-dep precedent, but prebuilds across win/mac/linux × x64/arm64 are a support burden that grows with each new platform. |
| Pure-JS page parser | Rejected — disproportionate. |

Open the DB from a **snapshot copy** (`session-store.db` plus `-wal`/`-shm`), as the Python
original does: the live file is locked and WAL-mode while Copilot runs.

---

## Security and privacy

Per `.ai-run/guides/security/security-practices.md` and the Python original's constraints:

- Read only allowlisted columns. `turns` text, `sessions.summary` and
  `session_files.file_path` are never queried.
- `events.jsonl` and VS Code session files contain prompt and response text. Prefilter lines by
  substring before `JSON.parse`, and keep only numeric fields plus the model id.
- `workspace.yaml` is read only as far as `client_name`, stopping before the prompt-derived
  `name`/`summary`.
- Scan health carries a closed reason enum — never a path, home key, hash, or user name.
- Every scanner degrades: an absent root, a denied read, or a malformed file is counted and
  skipped, never raised.

---

## Out of scope for this draft

- JetBrains / IntelliJ (`intellij_log.py`) — different branch.
- Ticket-key extraction from session text (`copilot_cli_turns.py`).
- Token-free `ccreq` request-volume rows (`vscode_log.py`).
- Backend push via a daemon-side producer — a later consumer of the same scanners.
- Merging into the default `SessionsSource` (see double-counting guards).

---

## Verification status

The other team owns verification. What this machine (macOS) could and could not establish:

| Established here | Not establishable here |
|---|---|
| VS Code directory layout, profiles, 3 location kinds | Token fields in real sessions — all 29 local files are empty shells (0 requests, no token fields) |
| `kind:0`/`kind:1` append-log format, array-form keys, `version:3` | `session-store.db` schema v8 — no store on this machine |
| `~/.copilot` exists but holds only `config.json`, `ide/`, `logs/` | `events.jsonl` record shapes; `session.shutdown` / `usage_checkpoint` field paths (the Python original flags these as unconfirmed assumptions) |

**Most useful artifacts to hand over for verification**, in priority order:

1. `~/.copilot/session-store.db` from a machine with real CLI usage — confirms schema v8,
   column set, and `total_nano_aiu` units.
2. A Desktop session's `~/.copilot/session-state/<uuid>/events.jsonl` — the only Desktop usage
   source, and the one with unconfirmed field paths.
3. One populated `workspaceStorage/*/chatSessions/*.jsonl` with non-empty `requests` —
   confirms `promptTokens`/`completionTokens`/`copilotCredits` and `toolCallRounds`.
4. A `session-state/<uuid>/workspace.yaml` per surface (CLI, Desktop, VS Code agent) —
   confirms the `client_name` values driving surface attribution.
