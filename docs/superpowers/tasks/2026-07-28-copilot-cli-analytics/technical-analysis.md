# Technical Analysis — GitHub Copilot CLI analytics integration

**Date:** 2026-07-28
**Companion:** `phase0-spike.md` (empirical Copilot on-disk findings — read that first for the
data-source side; this file covers the codebase side).

> **Provenance note.** This analysis was produced by direct inspection rather than by the
> `tech-analyst` agent. Three dispatched subagents (`tech-analyst`, plus two scoped `Explore`
> agents) each hung without producing output — 2h+ and 1.5h respectively — and were stopped.
> Every claim below was verified by reading the named file at the named line in the current
> working tree. Line numbers are current as of this branch, not inherited from the older
> `docs/superpowers/specs/2026-06-17-copilot-cli-analytics-design.md` draft.

---

## Codebase Findings

### 1. Where sessions enter analytics

```
codemie analytics
  └─ SessionsSource.load()                      sources/sessions-source.ts:11
       ├─ MetricsDataLoader.loadSessions()      (CodeMie-tracked sessions)
       └─ loadNativeSessions(filter)            native-loader.ts
            ├─ realNativeDeps.discover()        native-loader.ts:132
            │    for agentName of NATIVE_AGENTS:
            │      AgentRegistry.getAgent(agentName)?.getSessionAdapter?.()
            │        └─ adapter.discoverSessions({ maxAgeDays })
            ├─ realNativeDeps.parse()           native-loader.ts:155
            │    └─ adapter.parseSessionFile(filePath, sessionId)
            └─ synthesizeRawSession()           native-loader.ts:517
  └─ aggregator → cost-enricher → payload-builder → report-generator / formatter
```

Key facts:

- `native-loader.ts:31` — `const NATIVE_AGENTS = ['claude', 'codex'] as const;`
  *(the older draft claimed `['claude']` at `:27` — stale.)*
- `native-loader.ts:139` — discovery resolves the adapter through the registry:
  `AgentRegistry.getAgent(agentName)?.getSessionAdapter?.()`. **A registered plugin is
  mandatory**; there is no analytics-only bypass.
- `native-loader.ts:507-510` — sessions already tracked by CodeMie are skipped by real-path
  (`tracked.has(deps.realPath(...))`), so native discovery cannot double-count.
- `registry.ts:32-39` — 8 plugins registered today: `CodeMieCode`, `Claude`, `ClaudeAcp`,
  `Gemini`, `OpenCode`, `Codex`, `Kimi`, `KimiAcp`.

### 2. The ownership gate — the highest-risk integration point

```ts
// native-loader.ts:518
if (!deps.hasOwnershipMarker(descriptor.filePath) && raw.startEvent) {
  raw.startEvent.data.provider = 'native-external';
}

// sources/sessions-source.ts:22
.filter((s) => opts.includeExternal || s.startEvent?.data.provider !== 'native-external');
```

`hasOwnershipMarker` (`native-loader.ts:168`) proves CodeMie ownership three ways:

1. a correlation record's `correlation.agentSessionFile` (`~/.codemie/sessions/*.json`),
2. a sidecar marker's `transcriptPath` (`*-codemie-marker.json`),
3. a `codemie_session_start` line within the transcript's **first 4 KB / 10 lines**.

A Copilot CLI session launched by the user satisfies **none** of these, so without an explicit
exemption every Copilot session is tagged `native-external` and dropped by default — the feature
would ship showing nothing. Origin: `2026-07-07-analytics-exclude-external-sessions`
(EPMCDME-13367), whose goal was to stop analytics "blindly scraping" sessions CodeMie doesn't own.
That intent targets agents CodeMie *can* manage. **Decision D9 exempts analytics-only agents.**

No other agent-name allowlist, union type, or validation was found in the analytics path that
would reject `copilot-cli`.

### 3. Cost pipeline — three touch-points, and the convention mismatch

`cost/usage-readers.ts`:

| Function | Line | Role |
|---|---|---|
| `readUsageByModel(agentName, parsed)` | `:453` | per-session display paths; `switch` with `default → new Map()` |
| `gatherUsageDeduped(agentName, parsed, seen)` | `:478` | **run-level totals**; unbranched agents silently return empty ⇒ $0 |
| `gatherDedupedUsageRecords(...)` | (below `:478`) | optional per-turn cost-growth series |

The `gatherUsageDeduped` trap is real: `readUsageByModel` alone yields correct per-session numbers
while report totals stay $0. Copilot is **session-local** (no cross-session replay like Claude's
resumed/forked transcripts), so its branch is a plain `if (a === 'copilot-cli') return readCopilot(parsed);`
alongside `gemini` / `kimi`.

**Convention mismatch (critical).** `cost/cost-calculator.ts:51`:

```ts
const input      = (usage.input * price.input) / 1_000_000;
const cacheRead  = (usage.cacheRead * price.cacheRead) / 1_000_000;
```

`input` is billed at full rate **in addition to** `cacheRead` — i.e. `TokenUsage.input` is assumed
**exclusive** of cache reads (Anthropic convention). Copilot reports `inputTokens` **inclusive**
of `cacheReadTokens` (OpenAI convention, applied even to Claude models — see `phase0-spike.md` §5).
The reader must therefore subtract:

```ts
input: Math.max(0, m.usage.inputTokens - (m.usage.cacheReadTokens ?? 0))
```

Omitting this over-counts input ~36× on a measured real session.

`TokenUsage` (`cost/types.ts`, built in `cost-calculator.ts:8`) is
`{ input, output, cacheRead, cacheCreation, cacheCreation1h, total }`. Copilot exposes no cache-TTL
split, so `cacheCreation1h: 0` (all writes fall in the 5m bucket, priced at `price.cacheCreation`).

**Pricing table needs no changes** — verified all five observed model strings resolve through
`normalizeModelName` + the lowercase/dot→dash fold to existing `pricing.json` keys:
`gpt-5.2`→`gpt-5-2`, `gpt-5.4`→`gpt-5-4`, `gpt-5-mini`, `claude-sonnet-4.5`→`claude-sonnet-4-5`,
`claude-sonnet-4.6`→`claude-sonnet-4-6`. (162 keys total.)

### 4. Report UI — every place an agent surfaces

The report is **almost entirely data-driven**. `DATA.meta.agents` drives the chips, and per-agent
grouping is `groupBy(fs, s => s.agentName)` (`app.js:389`, `:750`). Consequences:

- An unregistered agent **does** appear — `colorFor()` (`app.js:25`) falls back to a rotating
  `PALETTE`, so no code change is needed merely to be visible.
- **Raw agent keys are rendered directly.** There is **no display-label map anywhere** in the
  analytics pipeline. Confirmed render sites:
  - `app.js:1303` — agent chips: `... + esc(a)`
  - `app.js:444` — Agents·Compare table: `<span class="tag tag-sm" style="text-transform:capitalize">' + esc(a) + '</span>'`
  With `text-transform: capitalize`, the key `copilot-cli` would render as **"Copilot-cli"**.
  Delivering D4's "GitHub Copilot CLI" label therefore requires **introducing** a label map plus a
  `labelFor()` helper and wiring it into both sites.
- `AGENT_COLORS` (`app.js:22`) is the only hardcoded agent surface today. Note it currently has no
  `kimi` entry — pre-existing, unrelated.

**Where Copilot-specific data lands:**

- `report/types.ts:12` — `ReportSessionRecord.agentName`; the record is built at
  `payload-builder.ts:59-90`. Optional Copilot-only fields (`premiumRequests`, partial/unavailable
  markers) belong here — additive, so other agents are unaffected.
- `payload-builder.ts:50` — `AgentCoverage { agentName, total, priced, withLog }`, incremented from
  `cost.hadLog` / `cost.priced`. **D2's "listed but unpriced" flagging maps onto this existing
  mechanism** rather than needing a new one.
- `formatter.ts:163` — terminal output already special-cases `provider === 'native-external'` with
  a yellow warning label; the terminal path breaks down by agent too and needs the same label
  treatment.

### 5. Session adapter contract

`core/session/BaseSessionAdapter.ts`:

- `SessionAdapter` requires `agentName`, `parseSessionFile`, `registerProcessor`, `processSession`;
  `discoverSessions` is **optional** — but mandatory for Copilot, since Copilot sessions are never
  CodeMie-tracked. (Kimi omits it — `kimi.session.ts:49` logs "not implemented yet" — which is why
  only tracked Kimi sessions are priced.)
- `SessionDescriptor` (`core/session/discovery-types.ts`): `{ sessionId, filePath, projectPath?,
  createdAt: number /* epoch ms */, updatedAt?, agentName? }`.
- `ParsedSession` (`BaseSessionAdapter.ts:18`): `{ sessionId, agentName /* display name */,
  agentVersion?, metadata{projectPath,createdAt,updatedAt,repository,branch,gitBranch},
  messages: unknown[], subagents?, metrics? }`.
- `ParsedSession.metrics` already models **everything D7 needs**: `tools`, `toolStatus`,
  `fileOperations[{type,path,linesAdded,linesRemoved,...}]`, `skillInvocations`,
  `agentInvocations`, `commandInvocations`, `userPrompts`.

Note `ParsedSession.agentName` is documented as the *display* name ("Claude Code"), whereas the key
threaded through `native-loader` discovery and into `ReportSessionRecord.agentName` is the internal
key from `NATIVE_AGENTS`. The label work in §4 must target the internal key, not this field.

### 6. Plugin base class

`core/BaseAgentAdapter.ts` (1273 lines) declares **no abstract members** — it is a concrete base
with defaults, so a deliberately minimal analytics-only plugin (metadata + `getSessionAdapter()`)
is viable per D5. Reference implementations: `codex.plugin.ts` / `codex.session.ts` (closest
analog — native-discovered, JSONL, implements `discoverSessions` at `codex.session.ts:113`) and
`opencode/` (most recently added plugin).

`CodexSessionAdapter` (`codex.session.ts:53-141`) is the template to follow: `agentName` field,
constructor validating `metadata.dataPaths.home`, `initializeProcessors()` registering a metrics +
conversations processor, `discoverSessions` applying `maxAgeDays` (default 30) and `limit`, sorting
`b.createdAt - a.createdAt`.

Copilot discovery is **simpler than Codex's**: Codex walks `YYYY/MM/DD` nested directories and
stats mtimes; Copilot has flat `session-state/<uuid>/` directories, and `workspace.yaml` supplies
`created_at`/`updated_at`/`cwd`/`repository`/`branch` directly — no mtime heuristics, no transcript
parse needed during discovery.

---

## Integration Points (summary)

| # | File | Change |
|---|---|---|
| 1 | `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts` | **new** — minimal analytics-only plugin |
| 2 | `src/agents/plugins/copilot-cli/copilot-cli.session.ts` | **new** — `discoverSessions` + `parseSessionFile` |
| 3 | `src/agents/plugins/copilot-cli/session/processors/*` | **new** — metrics + conversations processors |
| 4 | `src/agents/registry.ts:32-39` | register the plugin |
| 5 | `src/cli/commands/analytics/native-loader.ts:31` | add `'copilot-cli'` to `NATIVE_AGENTS` |
| 6 | `src/cli/commands/analytics/native-loader.ts:518` | exempt analytics-only agents from `native-external` tagging (**D9**) |
| 7 | `src/cli/commands/analytics/cost/usage-readers.ts:453` | `readUsageByModel` case |
| 8 | `src/cli/commands/analytics/cost/usage-readers.ts:478` | `gatherUsageDeduped` branch (**$0-totals trap**) |
| 9 | `src/cli/commands/analytics/report/types.ts` + `payload-builder.ts:59` | optional Copilot fields on `ReportSessionRecord` |
| 10 | `src/cli/commands/analytics/report/client/app.js:22` | `AGENT_COLORS` entry |
| 11 | `src/cli/commands/analytics/report/client/app.js:444,1303` | **new** label map + `labelFor()` wiring |
| 12 | `src/cli/commands/analytics/formatter.ts` | terminal-path label treatment |

No change needed: `pricing.json`, `model-normalizer.ts`, `aggregator.ts`, `report-generator.ts`.

---

## Risk Indicators

| Risk | Severity | Mitigation |
|---|---|---|
| Ownership gate drops 100% of Copilot sessions | **Critical** | D9 exemption; regression test asserting a Copilot session survives the default (no `--include-external`) path |
| `inputTokens` inclusive-vs-exclusive mismatch (~36× over-count) | **Critical** | subtract `cacheReadTokens`; unit test with the real measured session numbers |
| `gatherUsageDeduped` not branched ⇒ $0 report totals | High | explicit test asserting run-level totals are non-zero |
| Only `1.0.x` sessions carry tokens (0% of `0.0.x`) | Medium | D2 — list unpriced with reason; drive off presence of data, not a version string |
| `session.shutdown` absent on crash/live sessions | Medium | D3 — per-turn fallback, marked partial |
| `reasoningTokens ⊆ outputTokens`, `cacheWriteTokens ⊆ freshInput` are *assumptions* | Medium | document explicitly; do not double-bill; revisit if GitHub documents the schema |
| Undocumented `events.jsonl` schema, version-fragile | Medium | parse defensively, drop unparseable lines, degrade to unpriced rather than throw |
| `COPILOT_HOME`/`XDG` override not honored ⇒ silent empty discovery | Low | honor env override, fall back to `~/.copilot` |
| 1.5 MB+ transcripts × 78 sessions on every report run | Low | discover from `workspace.yaml`; parse transcripts only for included sessions; honor `maxAgeDays` |

## Open questions (carried into the spec)

1. Is `cacheWriteTokens` a subset of `inputTokens − cacheReadTokens`, or disjoint? Not resolvable
   from observed data. Affects Claude-model Copilot sessions only. Needs a documented assumption.
2. Do `1.0.x` sessions killed non-routinely truly lack `session.shutdown`? All 6 observed sessions
   were `shutdownType: "routine"`. D3's fallback covers it either way.
3. Should `skill.invoked` feed `metrics.skillInvocations` in v1? D7 deferred the Source-column
   integration, but the field already exists on `ParsedSession.metrics` and
   `detectSessionSource` consumes it — so the marginal cost is close to zero.
