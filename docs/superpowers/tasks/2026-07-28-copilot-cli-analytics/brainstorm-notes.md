# Brainstorm notes — Copilot CLI analytics

Working scratchpad for Stage 3. Confirmed decisions accumulate here and graduate into `spec.md`.

## Scope (confirmed, round 0)

GitHub **Copilot CLI** — the agentic `copilot` command from `@github/copilot`.
Explicitly **not** `gh copilot suggest/explain`, not the VS Code / JetBrains extensions,
not GitHub's cloud Copilot Metrics / billing REST APIs.

## Confirmed decisions (round 1)

| # | Question | Decision |
|---|---|---|
| D1 | Cost figure for Copilot sessions | **Both** — token-derived USD as the primary, cross-agent-comparable number (reusing `pricing.json` like every other agent), **plus** `totalPremiumRequests` surfaced as a Copilot-specific metric. USD is an estimate, not GitHub's bill. |
| D2 | Sessions with no token data (CLI `0.0.x`, and dirs with no transcript) | **List them, unpriced and clearly flagged.** Metadata comes from `workspace.yaml` (project, repo, branch, timestamps). Cost/tokens blank + a reason marker. Totals stay honest; activity stays visible. |
| D3 | Sessions missing `session.shutdown` (SIGKILL / still running) | **Rebuild from per-turn `assistant.message` events and mark the session partial.** Recovers output tokens + request counts per model exactly (spike-validated). Input/cache are unrecoverable, so the session must be flagged partial rather than presented as a complete total. |
| D4 | Report UI | **Brand color + display label.** Add a GitHub Copilot entry to `AGENT_COLORS` (`report/client/app.js:22`) and a proper display label so it reads "GitHub Copilot CLI" instead of the raw agent key. No new report panels; the rest of the report is already data-driven. |

## Confirmed decisions (round 2)

| # | Question | Decision |
|---|---|---|
| D5 | Plugin scope | **Analytics-only plugin.** Register the minimum needed for session discovery + transcript parsing. No install / launch / config-sync / BYOK-proxy support — CodeMie does not manage or run Copilot. Registration itself is non-negotiable: `native-loader.ts:139` resolves adapters via `AgentRegistry.getAgent(name)?.getSessionAdapter?.()`, so there is no analytics-only bypass. |
| D6 | Premium-request placement | **Session record + existing per-session detail modal.** No new report panels. Copilot-only fields render in the modal alongside the token/cost breakdown and flow into JSON/CSV exports. |
| D7 | Metrics depth | **Tokens + cost + core metrics** — tool executions, file operations, and lines changed, so Copilot sessions populate the activity / tools / code-churn views instead of appearing as cost-only rows with empty charts. **Not** in v1: feeding `skill.invoked` into `detectSessionSource` (deferred). |
| D8 | Agent key | **`copilot-cli`** — explicitly disambiguates the CLI from the VS Code / JetBrains extensions. (Chosen over the repo's bare-name convention, which would have given `copilot`.) User-facing label: **GitHub Copilot CLI**. |

## Confirmed decisions (round 3) — the blocking one

| # | Question | Decision |
|---|---|---|
| D9 | Ownership gate | **Exempt analytics-only agents.** Mark the plugin analytics-only and skip `native-external` tagging for it so Copilot sessions are included by default. `--include-external` keeps its current meaning for Claude/Codex. |
| D10 | What the report measures | **All AI coding spend on the machine**, regardless of who launched the session — consistent with already covering gemini/kimi/opencode and with the "make Copilot visible" goal. |

### Why D9 is load-bearing

`native-loader.ts:518` tags any natively-discovered session lacking a CodeMie ownership marker as
`provider = 'native-external'`, and `sources/sessions-source.ts:22` filters those out unless
`--include-external` is passed:

```ts
// native-loader.ts:518
if (!deps.hasOwnershipMarker(descriptor.filePath) && raw.startEvent) {
  raw.startEvent.data.provider = 'native-external';
}

// sources/sessions-source.ts:22
.filter((s) => opts.includeExternal || s.startEvent?.data.provider !== 'native-external');
```

`hasOwnershipMarker` (`native-loader.ts:168`) proves ownership three ways: a correlation record's
`agentSessionFile`, a sidecar marker's `transcriptPath`, or a `codemie_session_start` line within
the transcript's first 4 KB. Under D5 (analytics-only — CodeMie never launches Copilot) a Copilot
session satisfies **none** of them. Without D9 the feature ships and shows nothing by default:
100% of Copilot sessions silently dropped.

The gate came from `2026-07-07-analytics-exclude-external-sessions` (EPMCDME-13367), whose stated
goal was to stop analytics "blindly scraping" sessions CodeMie doesn't own. That intent targets
agents CodeMie *can* manage; it does not extend to an agent CodeMie never manages.

## Grounded technical facts (from `phase0-spike.md`)

- Discovery manifest: `~/.copilot/session-state/<uuid>/workspace.yaml` — present in 78/78 dirs.
- Transcript: `events.jsonl` — present in 54/78.
- Primary token source: `session.shutdown.data.modelMetrics` (per-model buckets).
- Fallback token source: `assistant.message.data.{model,outputTokens}` — output only.
- **Pricing trap:** Copilot's `inputTokens` is *inclusive* of `cacheReadTokens` (OpenAI
  convention, applied even to Claude models). The repo's `costBreakdown`
  (`cost/cost-calculator.ts:51`) bills `input` at full rate **and** `cacheRead` separately —
  i.e. it assumes the *exclusive* convention. A Copilot reader must therefore compute
  `input = max(0, inputTokens − cacheReadTokens)` before populating `TokenUsage`.
  Getting this wrong over-counts input by ~36× on a real session.
- `reasoningTokens` ⊂ `outputTokens` (assumed, OpenAI convention) — do **not** bill separately.
- `cacheWriteTokens` is non-zero only for Claude models; no TTL breakdown is available, so
  `cacheCreation1h: 0` (treat all cache writes as the 5m bucket).
- **Model coverage verified:** all five observed model strings
  (`gpt-5.2`, `gpt-5.4`, `gpt-5-mini`, `claude-sonnet-4.5`, `claude-sonnet-4.6`) resolve to
  existing `pricing.json` keys via the lowercase + dot→dash fold. **No new pricing entries.**

## Codebase facts verified directly (design doc line numbers are stale)

- `native-loader.ts:31` — `NATIVE_AGENTS = ['claude', 'codex']` (doc claimed `['claude']` at :27).
- `usage-readers.ts:453` — `readUsageByModel` switch.
- `usage-readers.ts:478` — `gatherUsageDeduped` (the $0-totals trap the doc flagged is real).
- `registry.ts:32-39` — 8 plugins registered today.
- `report/client/app.js:22` — `AGENT_COLORS`; `colorFor()` at :25 already falls back to a
  rotating palette for unknown agents, so an unregistered agent still renders (arbitrary color).
- `report/session-source-detector.ts` — classifies by SDLC *tooling* (sdlc-factory, superpowers,
  openspec, speckit, bmad) from skill/agent/command invocation names, not by agent.

## Open questions for round 2

- **Q-A Plugin scope.** Analytics-only ingestion, or a full `BaseAgentAdapter` plugin that
  CodeMie can also install/launch/configure? The request says "sessions to the analytics
  report", implying analytics-only — but the session-adapter lives inside the agent-plugin
  architecture, so the minimum viable registration needs deciding.
- **Q-B Premium-request placement.** D1 says surface it, D4 says no new panels. Natural
  resolution: the existing per-session detail modal + the session record. Confirm.
- **Q-C Metrics depth.** Copilot events carry tool executions, file ops, permissions, skill
  invocations, and `codeChanges{linesAdded,linesRemoved,filesModified}`. Populate the report's
  activity/tools/files views too, or ship tokens + cost only in v1?
- **Q-D Agent key + label.** `copilot` / `github-copilot` / `copilot-cli` as the internal key;
  display label wording.
- **Q-E Source column.** Copilot supports plugins/skills and emits `skill.invoked` (this
  install has the `superpowers` marketplace plugin). Feed those names into
  `detectSessionSource` so Copilot sessions classify like Claude ones?
