# Report: GitHub Copilot Local Statistics — Draft Handoff

**Status:** Draft, ready for verification and finalization by another team
**Branch:** `feature/Ievgen_Kyvgyla-github-copilot-local-statistics`
**Spec:** [SPEC-copilot-local-statistics.md](SPEC-copilot-local-statistics.md)
**Ports from:** `sl-ai-sdlc-cost-tracking` (`src/parsers/`, Python, Windows-only)

---

## What was delivered

`codemie analytics copilot` — a scan of the artifacts GitHub Copilot already writes on the
local machine, mapped into the existing analytics pipeline as priced sessions.

Four surfaces: **Copilot CLI**, **Copilot Desktop**, **VS Code extension**, **WSL**.

The feature is retroactive by design: the first run prices Copilot history already on disk,
with no prior connect step. That is the capability neither the existing `copilot-cli` plugin
nor the hook-based OTLP adapters can provide.

### Coverage this adds

| Surface | Before | After |
|---|---|---|
| Copilot CLI | `session-state/` transcripts, `copilot-cli-otlp` hooks | `session-store.db` rows incl. `total_nano_aiu` (premium requests) |
| Copilot Desktop | agent key only | `events.jsonl` — its only per-call usage source |
| VS Code extension | hooks with **no token usage at all** | real tokens, credits, and exact chat-mode attribution |
| WSL | nothing | CLI/VS Code-agent homes in running distros |

---

## Decisions and rationale

### 1. Shape: new `AnalyticsSource` + loader, not session adapters, not an OTLP plugin

Chosen because the Python tool and the `otel-loader.ts` / `OtelSource` seam already have the
same shape: flat, already-tokenized rows grouped per session, with cost computed by the source
and returned through `SourceResult.cost` so `cost-enricher` is bypassed.

Rejected alternatives:

- **Session adapters** (`discoverSessions` / `parseSessionFile`) — the contract returns
  `ParsedSession`, from which `usage-readers.ts` re-derives tokens. SQL rows would be reshaped
  into a transcript-like object purely so a reader could turn them back into the numbers
  already in hand, times one new reader per surface.
- **`OtlpAgentAdapter` plugin** — structurally impossible here: Desktop fires no hooks, VS
  Code's hooks carry no tokens, and nothing can backfill history.

A daemon-side producer (the `otlp-spool/copilot-usage-enrichment.ts` pattern) remains a
sensible *second* consumer of these scanners for live backend push, reusing them unchanged.

### 2. Cross-platform from day one, though the source tool was Windows-only

Only the root directory differs per platform; everything below it is identical. The invariant
enforced in code: `copilot-local-paths.ts` is the only module in `copilot-local/` that touches
`process.platform` or a directory-naming env var, and every scanner takes its roots as
arguments.

### 3. SQLite: `node:sqlite` behind a guarded import

Zero new dependencies and no native build, at the cost of needing Node ≥ 22.5 while `engines`
declares `>= 20`. On Node 20 the scan degrades to `events.jsonl` with reason
`sqlite_unavailable`, which still covers every Desktop session. `better-sqlite3` is the
documented fallback if exact premium-request counts on Node 20 turn out to be required.

### 4. Kept off the default report on purpose

`native-loader.ts` already discovers `copilot-cli` sessions from `~/.copilot/session-state/`.
Merging this source into `SessionsSource` without a dedup policy would double-count every CLI
session, so it ships as its own subcommand until that policy is decided.

### 5. One billing formula, one home

Copilot's `inputTokens` **includes** `cacheReadTokens`, while `costBreakdown()` bills `input`
and `cacheRead` separately — passing it through unchanged over-counts input by ~36× on a real
measured session. Rather than reimplement the peeling in the scanners,
`copilotUsageToTokens()` was extracted from `readCopilotCli()` and is now shared. Two copies of
a money formula drift silently into two different dollar figures for the same session.

---

## File inventory

### New — `src/cli/commands/analytics/copilot-local/` (1,965 lines)

| File | Lines | Responsibility |
|---|---|---|
| `copilot-local-paths.ts` | 164 | Platform roots; the only `process.platform` consumer |
| `types.ts` | 126 | `CopilotUsageRow`, health with a closed reason enum, tolerant numeric coercion |
| `copilot-surfaces.ts` | 108 | `client_name` → agent key + surface; bounded `workspace.yaml` read |
| `store-reader.ts` | 331 | `session-store.db`: snapshot copy, allowlisted columns, schema probe |
| `events-reader.ts` | 322 | `events.jsonl`: per-call records, rollup fallback, substring prefilter |
| `vscode-sessions-reader.ts` | 382 | Append-log replay (both `k` forms), chat-mode attribution |
| `wsl-reader.ts` | 173 | Running distros only, per-home isolation |
| `copilot-local-loader.ts` | 336 | Dedupe → group → price → pipeline inputs |
| `index.ts` | 23 | Barrel |

### New — source + CLI

- `sources/copilot-local-source.ts` (73) — `AnalyticsSource` implementation.

### Modified

| File | Change |
|---|---|
| `cost/usage-readers.ts` | Extracted and exported `copilotUsageToTokens()` |
| `index.ts` | `codemie analytics copilot` subcommand |
| `types.ts` | `CopilotCommandOptions` |
| `agent-labels.ts` | `copilot-vscode` label |
| `report/client/app.js` | Same label + a color, in the client's parallel map |

---

## How to run

```bash
codemie analytics copilot                      # default window
codemie analytics copilot --scan-days 365      # a year of history
codemie analytics copilot --no-wsl --no-vscode # CLI + Desktop only
CODEMIE_DEBUG=true codemie analytics copilot   # per-scanner health lines
```

---

## Verification status

### Exercised during development

Against synthetic fixtures built to the documented shapes. These prove the code's own logic,
**not** that the shapes match what Copilot writes in the field.

| Checked | Result |
|---|---|
| Schema-v8 store, 3 rows / 2 sessions | read; the `turns` table was present and never queried |
| Token peeling | `input 150000 / cacheRead 120000 / cacheWrite 10000` → `input 20000`, `cacheRead 120000`, `cacheCreation 10000` |
| Surface attribution | `github/autopilot` → Desktop vs `github/cli` → CLI, from an **identical** cwd |
| `initiator: agent` | → `chat/tool-loop`, `isTurn: false`; session turn count 1, not 2 |
| `total_nano_aiu` | carried onto the row |
| VS Code array-path update | `{"kind":1,"k":["requests",0,"promptTokens"],"v":83004}` applied over the snapshot |
| VS Code legacy string key | `{"kind":2,"k":"requests",...}` appended |
| `copilot/auto` | resolved via `metadata.resolvedModel` |
| `toolCallRounds` | 3 rounds → `apiCalls: 3` |
| `errorDetails` | → `status: 'error'` |
| Custom chat mode | `modeInstructions.name` → `agentMode`, `isCustomAgent: true` |
| Pricing + aggregation | per-model split, cost series, deltas, `agentInvocations` all populated |
| Live macOS run | 4 scanners ran; store `no_store`, events `absent`, VS Code 0 rows, WSL no distros — clean degradation |

Fixture generators used during development: `/tmp/make-store.mjs`, `/tmp/run-store.mjs`,
`/tmp/run-fixture.mjs`, `/tmp/run-loader.mjs`. Not committed — this repo adds tests only on
explicit request.

### Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, zero warnings |
| `npm run build` | pass |
| Vitest suite | `cost/__tests__/*` pass — run by the pre-commit hook via lint-staged |

### Not establishable on the development machine (macOS)

| Unknown | Why |
|---|---|
| Real token fields in VS Code sessions | All 29 local session files are empty shells — 0 requests, no token fields |
| `session-store.db` schema v8 in the field | No store on this machine; `~/.copilot` holds only `config.json`, `ide/`, `logs/` |
| `events.jsonl` record shapes | Never observed; the Python original also flags `data.modelMetrics` and `data.totalNanoAiu` as unconfirmed assumptions |
| WSL discovery | Windows-only path, never executed |

---

## Open items for the finalizing team

1. **Run the full Vitest suite.** The pre-commit hook already ran the `cost/__tests__/`
   files touched by the `usage-readers.ts` refactor and they passed; the rest of the suite has
   not been run on this branch.
2. **Node's SQLite `ExperimentalWarning`.** Node prints
   `ExperimentalWarning: SQLite is an experimental feature` to stderr on first use, landing in
   the middle of a report on any machine with a store. It cannot be filtered from inside the
   reader: the warning is emitted on a later tick than any scoped `process.on('warning')`
   window, and a scoped listener never receives it at all (verified empirically — a filter was
   written, proven ineffective, and removed rather than left as dead code). Working fixes:
   `NODE_OPTIONS=--disable-warning=ExperimentalWarning` (Node ≥ 21.3, verified), the same flag
   at the `bin/` entry, or raising `engines.node` once `node:sqlite` is stable.
3. **Confirm the field assumptions** against real artifacts, in priority order: a
   `session-store.db` with real CLI usage; a Desktop `events.jsonl`; a populated
   `chatSessions/*.jsonl`; one `workspace.yaml` per surface.
4. **Decide the default-report merge.** Whether to fold this source into `SessionsSource` and,
   if so, how to dedup against the existing `copilot-cli` discovery in `native-loader.ts`.
5. **Premium requests are carried, not surfaced.** `billedNanoAiu` and `reportedCredits` ride
   on every row and `totalBilledNanoAiu()` sums them, but no report surface displays them yet.
   Since a Copilot subscription bills premium requests rather than tokens, these are the only
   figures that reconcile against an invoice — worth a report column.
6. **Session-id collisions across surfaces** are assumed impossible (all UUIDs) and not
   guarded. If a VS Code session id ever collides with a CLI one, their rows would merge into
   one session.

---

## Deliberately out of scope

- JetBrains / IntelliJ (`intellij_log.py`) — different branch.
- Ticket-key extraction from session text (`copilot_cli_turns.py`).
- Token-free `ccreq` request-volume rows (`vscode_log.py`).
- Backend push via a daemon-side producer.
- Unit tests — added only on explicit request in this repo.
