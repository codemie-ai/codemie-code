# GitHub Copilot CLI analytics integration — Design

**Date:** 2026-07-28
**Branch:** `feat/copilot-cli-analytics`
**Status:** Draft — awaiting approval
**Grounding:** `phase0-spike.md` (empirical on-disk findings), `technical-analysis.md` (codebase)

## Problem

`codemie analytics` prices token usage for `claude`, `claude-acp`, `claude-desktop`, `codex`,
`gemini`, `kimi`, and `opencode` by reading each agent's local transcripts. **GitHub Copilot CLI is
absent** — `copilot` appears nowhere in `src/`. A developer who runs the agentic `copilot` command
sees none of that work in the report: no sessions, no tokens, no cost, no presence in any chart.

We want Copilot CLI sessions discovered from local disk, parsed into the unified `ParsedSession`,
priced from `pricing.json`, folded into the session list / per-model breakdown / totals, and
**visible as a first-class agent in the report UI**.

## Scope

**In scope:** GitHub **Copilot CLI** — the agentic `copilot` command from the `@github/copilot`
package.

**Out of scope:** the `gh copilot suggest/explain` extension (keeps no session state), the VS Code
and JetBrains Copilot extensions (no reliable local per-developer token data), GitHub's cloud
Copilot Metrics / Usage / billing REST APIs (org-admin only, aggregate), and OTel-based ingestion
(`~/.copilot/otel/`, opt-in and off by default — absent on a real install).

CodeMie does **not** gain the ability to install, launch, configure, or proxy Copilot. This is an
analytics-ingestion feature only.

---

## Decisions

| # | Decision |
|---|---|
| D1 | Cost shows **both**: a token-derived USD estimate (primary, cross-agent comparable) **and** `totalPremiumRequests` |
| D2 | Sessions with no token data are **listed, unpriced, and flagged** — not hidden |
| D3 | Sessions missing `session.shutdown` are **rebuilt from per-turn events and marked partial** |
| D4 | Report UI gets a **brand color + a "GitHub Copilot CLI" display label** |
| D5 | **Analytics-only plugin** — no install / launch / config-sync / BYOK |
| D6 | Premium requests live on the **session record + existing detail modal**; no new panels |
| D7 | Extract **tokens + cost + core metrics** (tools, file ops, lines changed) |
| D8 | Internal agent key is **`copilot-cli`**; display label **GitHub Copilot CLI** |
| D9 | **Analytics-only agents are exempt from the ownership gate** |
| D10 | The report measures **all AI coding spend on the machine**, regardless of who launched the session |
| D11 | Map `skill.invoked` → `metrics.skillInvocations` so Copilot sessions **classify in the Source column** |
| D12 | Unpriced reasons surface in the **detail modal + per-agent coverage counts** |

---

## Design

### 1. Data source

Copilot CLI persists per-session state under `~/.copilot/session-state/<uuid>/` (honor
`COPILOT_HOME` when set, else `~/.copilot`):

- **`workspace.yaml`** — present in 100% of session dirs (78/78 observed). Supplies `id`, `cwd`,
  `git_root`, `repository`, `branch`, `created_at`, `updated_at`, and a human-readable `name`.
  This is the **discovery manifest**: everything `SessionDescriptor` needs, at ~350 bytes, without
  opening a multi-megabyte transcript.
- **`events.jsonl`** — present in 54/78. JSONL; every line `{ type, data, id, parentId, timestamp }`.

Discovery reads only `workspace.yaml`; transcripts are parsed only for sessions that survive
filtering. This matters — observed transcripts reach 1.5 MB and one session had 434 turns.

### 2. Token extraction — a two-tier strategy

**Tier 1 (primary): `session.shutdown`.** Carries the authoritative per-model rollup:

```jsonc
{
  "shutdownType": "routine",
  "totalPremiumRequests": 3,
  "codeChanges": { "linesAdded": 0, "linesRemoved": 0, "filesModified": [] },
  "modelMetrics": {
    "gpt-5.4": {
      "requests": { "count": 22, "cost": 3 },
      "usage": { "inputTokens": 1431122, "outputTokens": 10684,
                 "cacheReadTokens": 1235968, "cacheWriteTokens": 0, "reasoningTokens": 4422 }
    }
  }
}
```

**Tier 2 (fallback): per-turn `assistant.message`.** Each carries `model` + `outputTokens`.
Summing them reproduces the shutdown totals **exactly** — verified on a mixed-model session:
`gpt-5.2` 173 180 output / 374 turns and `claude-sonnet-4.5` 27 215 output / 60 turns both matched
`modelMetrics` to the token. Tier 2 recovers **output tokens and request counts only**; no event
carries per-turn input or cache tokens.

**Tier 3: neither available** ⇒ session listed, unpriced, with a reason (D2).

Token telemetry is **version-gated**: every observed CLI `1.0.x` session had complete data; no
`0.0.x` session had any. Detection is driven by *presence of data*, never by parsing a version
string — `copilotVersion` is recorded for diagnostics only.

### 3. Pricing — the convention mismatch

Copilot normalizes every provider to the **OpenAI convention**: `inputTokens` is **inclusive** of
`cacheReadTokens`, even for Anthropic models. The repo's `costBreakdown`
(`cost/cost-calculator.ts:51`) bills `usage.input` at full rate **in addition to** `usage.cacheRead`
— i.e. it assumes the **exclusive** (Anthropic) convention.

The reader must therefore decompose:

```ts
const cacheRead     = m.usage.cacheReadTokens  ?? 0;
const cacheCreation = m.usage.cacheWriteTokens ?? 0;
const freshInput    = Math.max(0, m.usage.inputTokens - cacheRead);
const input         = Math.max(0, freshInput - cacheCreation);

usage = { input, output: m.usage.outputTokens ?? 0, cacheRead, cacheCreation,
          cacheCreation1h: 0, total: input + output + cacheRead + cacheCreation };
```

**Documented assumptions** (each stated because it is an inference, not a measurement):

- `cacheReadTokens ⊆ inputTokens` — **strongly evidenced**. On a 2-request cold-start session
  (`inputTokens` 34 257, `cacheReadTokens` 16 896), the inclusive reading is self-consistent while
  the exclusive one requires a 404-output-token turn to contribute ~17 k of fresh input. Getting
  this wrong over-counts input **~36×** on a measured session.
- `cacheWriteTokens ⊆ freshInput` — **consistent with observed data**: on the Claude session, fresh
  input is 150 012 and cache-write is 125 660, which fits. Subtracting avoids double-billing and
  can never over-bill.
- `reasoningTokens ⊆ outputTokens` — OpenAI convention; corroborated by per-turn `outputTokens`
  summing exactly to `modelMetrics.outputTokens`. Reasoning is recorded for display but **never
  billed separately**.
- `cacheCreation1h: 0` — Copilot exposes no cache-TTL split, so all writes price in the 5m bucket.

**No `pricing.json` or `model-normalizer.ts` changes.** All five observed model strings
(`gpt-5.2`, `gpt-5.4`, `gpt-5-mini`, `claude-sonnet-4.5`, `claude-sonnet-4.6`) resolve to existing
keys via the lowercase + dot→dash fold. Copilot emits no vendor prefix, so no strip rule is needed.

USD is an **estimate**. Copilot bills in premium requests — 434 API requests cost 3 premium
requests, and 60 `claude-sonnet-4.5` requests cost 0 — so a token-derived figure will not equal
GitHub's invoice. It exists to make Copilot comparable to the other agents (D10).

### 4. Plugin and session adapter (new)

`src/agents/plugins/copilot-cli/`:

- **`copilot-cli.plugin.ts`** — minimal `BaseAgentAdapter` subclass (the base declares no abstract
  members). Metadata: `name: 'copilot-cli'`, `displayName: 'GitHub Copilot CLI'`,
  `npmPackage: '@github/copilot'`, `cliCommand: 'copilot'`, `dataPaths: { home: '.copilot' }`.
  Flagged **analytics-only** (see §5). No install/launch/version-check behavior.
- **`copilot-cli.session.ts`** — `CopilotCliSessionAdapter implements SessionAdapter`, modeled on
  `CodexSessionAdapter` (`codex.session.ts:53-141`):
  - `discoverSessions(options)` — enumerate `session-state/*/`, read each `workspace.yaml`, emit
    `SessionDescriptor { sessionId, filePath: <dir>/events.jsonl, projectPath: cwd ?? git_root,
    createdAt, updatedAt, agentName: 'copilot-cli' }`. Honor `maxAgeDays` (default 30), `cwd`, and
    `limit`; sort `createdAt` descending. Skip dirs with no `events.jsonl`.
  - `parseSessionFile(filePath, sessionId)` — tolerant JSONL read (drop unparseable lines, never
    throw), producing `ParsedSession` with `metadata` from `session.start`/`workspace.yaml`,
    normalized `messages`, and `metrics` (§6).
  - `registerProcessor` / `processSession` — same orchestration boilerplate as Codex.

Registered in `src/agents/registry.ts` alongside the existing 8 plugins. Registration is
**mandatory**: `native-loader.ts:139` resolves adapters via
`AgentRegistry.getAgent(name)?.getSessionAdapter?.()`.

### 5. The ownership exemption (D9) — load-bearing

`native-loader.ts:518` tags any natively-discovered session lacking a CodeMie ownership marker as
`provider = 'native-external'`, and `sources/sessions-source.ts:22` **filters those out** unless
`--include-external` is passed. `hasOwnershipMarker` proves ownership via a correlation record, a
sidecar marker, or a `codemie_session_start` line in the transcript's first 4 KB.

A Copilot session satisfies **none** of these, and under D5 never can. **Without this exemption the
feature ships and displays nothing** — 100% of Copilot sessions silently dropped.

Fix: mark analytics-only agents (those CodeMie cannot own) and skip `native-external` tagging for
them. `--include-external` keeps its exact current meaning for Claude/Codex. This preserves the
intent of `2026-07-07-analytics-exclude-external-sessions` (EPMCDME-13367) — *don't silently count
unmanaged runs of an agent CodeMie can manage* — which simply does not apply to an agent CodeMie
never manages.

### 6. Metrics extraction (D7, D11)

`ParsedSession.metrics` already models everything needed. Mapping from `events.jsonl`:

| Copilot event | `metrics` target |
|---|---|
| `tool.execution_start` / `_complete` | `tools` (counts), `toolStatus` (success/failure) |
| `tool.execution_complete` (file tools) | `fileOperations[{ type, path, linesAdded, linesRemoved }]` |
| `session.shutdown.codeChanges` | authoritative `linesAdded` / `linesRemoved` / `filesModified` |
| `skill.invoked` | `skillInvocations` — **feeds `detectSessionSource` for free** (D11) |
| `user.message` | `userPrompts` |

D11 wires `skill.invoked` into `metrics.skillInvocations`, which `detectSessionSource` already
consumes — no detector changes.

**Known limitation (measured, accepted).** The data flows correctly, but Copilot sessions still
classify as **"Pure chat"**. `session-source-detector.ts` matches the `superpowers:` *prefix*
(and `sdlc-factory:` etc.), whereas Copilot writes skill names **un-namespaced** — `brainstorming`,
`writing-plans`, `using-superpowers` — because its plugins resolve skills by bare name. Verified on
two real sessions whose `skillInvocations` are populated with exactly those names.

Loosening the shared detector to substring-match would change how Claude and Codex sessions
classify for the sake of one column, so it is deliberately **not** done here. The skill data is
captured and available; only the classification rule does not fit Copilot's naming. Revisit if
Source-column coverage for Copilot becomes worth the shared-rule change.

### 7. Analytics wiring

- `native-loader.ts:31` — `NATIVE_AGENTS`: add `'copilot-cli'`.
- `usage-readers.ts:453` — `readUsageByModel`: `case 'copilot-cli': return readCopilotCli(parsed);`
- `usage-readers.ts:478` — `gatherUsageDeduped`: `if (a === 'copilot-cli') return readCopilotCli(parsed);`
  **Required for non-zero report totals.** `readUsageByModel` alone yields correct per-session
  numbers while run-level totals stay $0 — the single most likely silent failure.

Copilot is **session-local**: unlike Claude's resumed/forked transcripts, no API response is
replayed across session files, so no cross-session dedup key is needed (same shape as Gemini/Kimi).

Per-turn cost-growth series (`gatherDedupedUsageRecords`) is **deferred** — per-turn events carry
no input tokens, so a series built from them would be misleading. Gemini ships without it too.

### 8. Report UI (D4, D6, D12)

The report is already data-driven — `colorFor()` (`app.js:25`) falls back to a rotating palette, so
an unregistered agent *does* appear, just anonymously. Three changes make Copilot first-class:

1. **Brand color** — add to `AGENT_COLORS` (`app.js:22`). Proposed `#6E7681` (GitHub neutral): it
   is the only non-saturated entry, so it reads as GitHub and cannot collide with any existing
   agent color or `PALETTE` slot. Trivially adjustable.
2. **Display label (new mechanism).** There is **no label map anywhere** in the analytics pipeline
   — raw keys render directly, and `app.js:444` applies `text-transform: capitalize`, so
   `copilot-cli` would read **"Copilot-cli"**. Introduce `AGENT_LABELS` + a `labelFor(agent)`
   helper and wire it into both render sites (`app.js:1303` chips, `app.js:444` Agents·Compare) plus
   the terminal path in `formatter.ts`. Unmapped agents fall back to today's behavior, so no other
   agent changes.
3. **Copilot-specific fields** — extend `ReportSessionRecord` (`report/types.ts:12`, built at
   `payload-builder.ts:59`) with optional `premiumRequests?`, `usagePartial?`, and
   `usageUnavailableReason?`. Rendered in the existing per-session detail modal (D6, D12). Optional
   and additive, so every other agent is untouched.

Aggregate coverage needs **no new mechanism**: `AgentCoverage { agentName, total, priced, withLog }`
already exists at `payload-builder.ts:50`, driven by `cost.hadLog` / `cost.priced` — exactly D2's
"48 of 54 unpriced" story.

Everything downstream — aggregator, cost enricher, report generator, charts, filters — is
agent-agnostic and needs no change once `readCopilotCli` returns a populated `UsageMap`.

---

## Edge cases

- **`COPILOT_HOME` set** — sessions live under `$COPILOT_HOME/session-state`. Honor it; fall back
  to `~/.copilot`. Getting this wrong yields a silent empty result.
- **Session dir with no `events.jsonl`** (24/78 observed, all pre-schema) — nothing to parse.
  Listed unpriced from `workspace.yaml` alone, with a reason.
- **Malformed / partially-written JSONL** — drop unparseable lines; never throw. A live session's
  last line may be truncated mid-write.
- **Mixed models in one session** — `/model` mid-session is supported and observed (`gpt-5.2` +
  `claude-sonnet-4.5` in one session). Per-model accumulation handles it; `modelMetrics` is
  natively keyed by model.
- **Multiple `session.shutdown` events** — not observed, but if a session is resumed, prefer the
  last, or sum per-model. Must not double-count.
- **`requests.cost: 0`** — legitimate (an included model on the user's plan), not missing data.
  Distinguish absent from zero.
- **Very large transcripts** — 1.5 MB / 434 turns observed. Discovery must not parse them; only
  sessions surviving `maxAgeDays`/`cwd` filtering get read.
- **Clock/timezone** — `workspace.yaml` timestamps are ISO-8601 UTC; `SessionDescriptor.createdAt`
  is epoch ms. Convert explicitly.

## Out of scope (documented, not introduced)

- VS Code / JetBrains Copilot extension analytics.
- Cloud Copilot Metrics / Usage / billing REST APIs.
- OTel ingestion (`~/.copilot/otel/`) — opt-in, absent by default.
- Mapping premium requests / AI credits to a true billed USD figure.
- Per-turn cost-growth series for Copilot (§7).
- Any install / launch / configure / BYOK-proxy capability for Copilot.

## Implementation notes (discovered during build, not anticipated by this spec)

Two assumptions in §6 were wrong about the real `events.jsonl` shape and were corrected during
implementation. Both were caught only by running against real sessions — the unit-test fixtures had
encoded the assumptions rather than reality.

1. **`tool.execution_complete` carries no tool name and no status string.** It has `toolCallId`,
   a boolean `success`, and `error`/`result`. The tool **name and arguments live on
   `tool.execution_start`**, so the two events must be paired by `toolCallId`. Before the fix, tool
   metrics were silently empty for every session.
2. **`parsed.messages` must also carry Claude-shaped per-turn records.** `synthesizeRawSession`
   derives turns, models, timestamps, cwd and branch by treating `messages` as Claude-shaped, so
   per-model usage rows alone yielded 1 turn per session and no models. `messages` now holds both:
   `readCopilotCli` filters on `model` + `usage`, turn counting filters on `type === 'assistant'` —
   orthogonal filters over one array, so no second synthesizer was needed.

Also: `session.shutdown.codeChanges` line totals are **merged into** the per-file operations
gathered from tool arguments rather than appended, so a path recorded by both is not double-counted.

## User-visible effect

Copilot CLI sessions appear in `codemie analytics` and `--report` as **GitHub Copilot CLI**, with
their own brand color, token totals, per-model breakdown, an estimated USD cost, premium-request
counts, project/branch attribution, tool and file-change metrics, and Source-column classification.
Sessions without recoverable usage data are listed and clearly marked rather than hidden. Existing
agents are unaffected. Reports rebuild from raw transcripts each run, so historical Copilot
sessions already on disk are picked up with no migration.

## Testing (Vitest — on explicit request only, per repo policy)

- **`readCopilotCli`** — per-model accumulation; **the cache-inclusive decomposition, asserted with
  the real measured numbers** (`inputTokens` 1 431 122 / `cacheReadTokens` 1 235 968 ⇒ `input`
  195 154, not 1 431 122); `reasoningTokens` never billed separately; malformed-entry guard.
- **`gatherUsageDeduped`** — Copilot branch returns populated totals (regression guard against the
  $0-totals trap).
- **Ownership exemption** — a discovered Copilot session survives the **default** path with no
  `--include-external`; a Claude session without a marker still does not. This is the regression
  guard for the failure mode that would make the whole feature appear to do nothing.
- **`copilot-cli.session`** — `discoverSessions` enumerates `session-state/*/`, honors
  `COPILOT_HOME` and `maxAgeDays`, skips dirs without `events.jsonl`; `parseSessionFile` maps a
  fixture `events.jsonl` to `ParsedSession`; tier-2 fallback produces output-only usage marked
  partial; empty/malformed input degrades gracefully.
- **Pricing** — each observed model string resolves to its expected existing `pricing.json` key.
- **Report payload** — Copilot fields are optional and absent for other agents; `labelFor()` returns
  "GitHub Copilot CLI" for `copilot-cli` and falls back unchanged for unmapped agents.
