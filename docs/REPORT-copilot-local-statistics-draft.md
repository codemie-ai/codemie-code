# Report: GitHub Copilot Local Statistics — Draft Handoff

**Status:** Draft, verified against a real Windows collector bundle (2026-11-18); ready for finalization
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
| `desktop-sessions.ts` | 108 | Desktop-session set from the desktop app's own `data.db` (single-query, allowlisted) |
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

## Verification against real Windows data

A collector bundle from a Windows machine (`collector_debug_bundle_2026-11-18_15-04-45.zip`)
provided a real `~/.copilot` home — `session-store.db` (9,834 usage rows, 96 sessions, schema
v10), 127 `events.jsonl` transcripts, the desktop app's `data.db` — plus the Python tool's own
report JSON for the same machine, which served as ground truth.

### Reconciliation against the Python tool

| Measure | Python tool | This implementation | Verdict |
|---|---|---|---|
| Store rows read | 9,351 | 9,353 at the same instant | match (2-row boundary/dedup difference) |
| Rows at scan time | — | 9,834 | the 483-row gap is data written between their 06:57:15Z run and the 15:04 collection |
| Sessions covered by `events.jsonl` fallback | 6 | 6 | **exact** |
| Desktop sessions | 12 | 12 | **exact** |
| Desktop turns | 54 | 54 | **exact** |
| Desktop cost | $23.76 | $23.87 | 0.5% — different pricing tables |
| Request categories | `chat/agent`, `chat/tool-loop`, `chat/sub-agent`, `feature/compaction` | identical taxonomy | match |

Scanner health on the real data: store 9,834 rows / 0 skipped / 0 errors; events 127 files →
9,558 rows / 0 skipped / 0 errors. Pricing resolved 11 of 12 models; only `mai-code-1.1-flash`
(143K tokens, 0.01% of volume) is unpriced.

### Defects found and fixed

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | `KNOWN_SCHEMA_VERSIONS = {8}` — real stores are **v10** | every real machine reported `schema_drift` | accept 8 and 10 |
| 2 | `sessions.repository` / `sessions.branch` never read; `session.start.data.context` never read | branch and repository were **0 of 9,834** store rows and 0 of 9,558 events rows, so `--branch` could never match | join both columns; read the transcript's `context` block |
| 3 | `request_multiplier` not carried | **15** on 7,342 of 9,834 rows — a premium-request total assuming 1/call is off by more than an order of magnitude | carried as `requestMultiplier`; `usage.cost` carried as `premiumRequestCost`; `totalPremiumRequests()` added |
| 4 | `status` hardcoded `'success'` | `finish_reason` and `content_filter_triggered` exist on every row | derived from the content filter |
| 5 | `requestId` used the store's autoincrement `id` | Copilot's own `event_id` is present on 9,515 of 9,834 rows and is what the OTLP pipeline dedups on | prefer `event_id` |
| 6 | Doc claimed `session.usage_checkpoint` was handled; it was not read | — | marker list and docstring corrected; checkpoint deliberately skipped, as its running totals would double-count the per-call records |
| 7 | Desktop attribution depended entirely on per-session `workspace.yaml` | the bundle had **no** `workspace.yaml` at all, so every Desktop session read as CLI | new `desktop-sessions.ts` reads the desktop app's own `data.db` — one `SELECT id FROM sessions` yields a store-wide Desktop set, no per-session file needed |

Finding 7 is beyond parity with the Python tool, which reads `data.db` only as a cross-check
(`desktop_db_check`) and still depends on `workspace.yaml` for attribution. Both paths now
work: `data.db` takes precedence, `client_name` remains the fallback.

**Privacy note on `data.db`:** it also holds the user's GitHub `access_token`, chat titles and
review threads. The module issues exactly one query, `SELECT id FROM sessions`, and carries an
explicit instruction never to read another table from that file.

### Still unverified against real data

| Surface | Why | What would close it |
|---|---|---|
| VS Code extension | the bundle carried no `chatSessions/*.jsonl` (Python read 145 such files on that machine) | one populated session file |
| WSL | the WSL store lives inside the distro and was not bundled; Python attributed 25,350 calls to `Copilot CLI (WSL:Ubuntu)` | a `.copilot` home from a WSL distro |
| `workspace.yaml` `client_name` | absent from the bundle; present in 179 of 181 session dirs on the machine | one `workspace.yaml` per surface |

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
3. **Remaining artifacts to confirm** — the store, events and Desktop paths are now verified
   against a real machine (see above). Still needed: one populated `chatSessions/*.jsonl` for
   VS Code, a `.copilot` home from a WSL distro, and one `workspace.yaml` per surface.
4. **Decide the default-report merge.** Whether to fold this source into `SessionsSource` and,
   if so, how to dedup against the existing `copilot-cli` discovery in `native-loader.ts`.
5. **Premium requests are carried, not surfaced.** `billedNanoAiu`, `requestMultiplier`,
   `premiumRequestCost` and `reportedCredits` ride on every row, and `totalPremiumRequests()` /
   `totalBilledNanoAiu()` sum them — the real machine accounts for ~112,667 premium requests and
   51,381 AI units — but no report surface displays any of it. Since a Copilot seat bills
   premium requests rather than tokens, this is the only figure that reconciles against an
   invoice, and it is the highest-value follow-up.
7. **`data.db` as a usage source, not just a discriminator.** Its `sessions` table also carries
   `total_input_tokens`, `total_output_tokens`, `total_cached_tokens`, `total_nano_aiu` per
   Desktop session — and 7 of the 13 Desktop sessions on the real machine had no rows in the
   shared store at all. Reading those totals would extend coverage, but needs a double-count
   policy against the store and events rows first.
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
