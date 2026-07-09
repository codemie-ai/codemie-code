# Design — Session-exit analytics report finalizer

**Date:** 2026-07-09
**Run:** 20260709-0134-analytics-finalizer
**Work item:** docs/superpowers/work-items/session-exit-analytics-report.md
**Baseline branch:** fix/analytics-session-filter

## Problem

When a user exits a codemie-claude / codemie-codex / codemie-opencode session, CodeMie should
automatically produce a per-session analytics JSON report — the same output as
`codemie analytics --report --session <id> --report-format json --report-output ./docs/codemie/analytics/codemie-analytics-<session_id>.json` —
without the user running a separate command. It must be part of session finalization, invoked
programmatically (in-process), enabled by default for those three agents, disable-able via a
codemie-level flag, and must never break session exit.

## Goals / Acceptance

- Auto-generate the JSON report on session exit for claude/codex/opencode (default on).
- Programmatic/in-process call — reuse the existing report logic, no subprocess, no new top-level command.
- Params: session = just-finished session id; format = json; output = `<cwd>/docs/codemie/analytics/codemie-analytics-<session_id>.json`.
- `--no-analytics-report` codemie-level flag disables it (per agent invocation).
- Report-generation failure is non-fatal — exit still completes.

## Non-goals (YAGNI)

- No configurable output path / format for the auto-report (the CLI `analytics --report` command still offers full flexibility). The auto-report path & format are fixed to the requirement.
- No new report content — reuses the exact JSON payload the CLI `--report --report-format json` produces.
- No opt-in for gemini/kimi/other agents in this change (metadata makes it trivial to add later).
- No config-file / env-profile toggle beyond the CLI flag (not requested).

## Architecture

Three touch points, each with one clear responsibility:

### 1. Programmatic report API — `src/cli/commands/analytics/report/session-report.ts` (new)

A single exported async function that generates a session-scoped report **without any CLI side
effects** (no formatter tables, no `console.log`, no `process.exit`). It reuses the same building
blocks the CLI uses so it is genuinely "the `analytics --report` functionality":

```ts
export interface SessionReportOptions {
  sessionId: string;
  outputPath: string;              // absolute or cwd-relative
  format?: 'json' | 'html' | 'both'; // default 'json'
  scanNative?: boolean;            // default true
}
export interface SessionReportResult {
  written: string[];               // paths actually written
  sessions: number;                // sessions included (0 ⇒ nothing written)
}
export async function generateSessionReport(
  options: SessionReportOptions
): Promise<SessionReportResult>;
```

Internals (mirrors `runAnalytics`'s report branch, minus display/exit):
1. `new SessionsSource().load({ filter: { sessionId }, scanNative })`.
2. If `rawSessions.length === 0` → return `{ written: [], sessions: 0 }` (no throw).
3. `enrichCosts(rawSessions, realDeps)` → `costResult`; `keepSessionIds` = sessions with tokens > 0.
4. `AnalyticsAggregator.aggregate(rawSessions, true, keepSessionIds)`.
5. `buildPayload(analytics, costResult.index, costResult.summary, { rangeLabel, projectFilter, generatedAt })`.
6. Write via `writeReportWithFallback((p) => generateReportJson(payload, p), outputPath, false)`
   (and/or `generateReport` for html when format requires). `generateReportJson` creates parent dirs.
7. Return written paths + `payload.meta.totals.sessions`.

Errors propagate to the caller (which wraps them); this function itself never calls `process.exit`.

> Refactor note: the load→enrich→aggregate→buildPayload sequence is currently inline in
> `runAnalytics`. To avoid duplication we extract the payload-building step into a small shared
> helper (e.g. `buildReportPayload(rawSessions, cost, opts)`) used by BOTH `runAnalytics` and
> `generateSessionReport`. Keep the refactor surgical — same behavior, just deduplicated.

### 2. Finalization hook — `src/agents/core/BaseAgentAdapter.ts`

Add one private helper and call it once from the shared exit path:

```ts
private async maybeWriteSessionReport(env: NodeJS.ProcessEnv): Promise<void> {
  if (!this.metadata.sessionAnalyticsReport) return;                 // agent opted in?
  if (env.CODEMIE_SESSION_ANALYTICS_REPORT === '0') return;          // --no-analytics-report
  const sessionId = env.CODEMIE_SESSION_ID;
  if (!sessionId) return;
  try {
    const { generateSessionReport } = await import('../../cli/commands/analytics/report/session-report.js');
    const outputPath = join(process.cwd(), 'docs/codemie/analytics', `codemie-analytics-${sessionId}.json`);
    const result = await generateSessionReport({ sessionId, outputPath, format: 'json' });
    if (result.sessions > 0) logger.debug(`[${this.displayName}] Session analytics report written: ${result.written.join(', ')}`);
    else logger.debug(`[${this.displayName}] No analytics data for session ${sessionId}; report skipped`);
  } catch (err) {
    logger.warn(`[${this.displayName}] Session analytics report failed (non-fatal)`, { error: err instanceof Error ? err.message : String(err) });
  }
}
```

- Called in `child.on('exit')` **after** `executeAfterRun` (proxy stopped, analytics flushed, 2s grace
  elapsed → the session's native logs/metrics are on disk before we read them).
- Uses `logger` only (never `console`/stdout) → safe in silent/ACP JSON-RPC mode.
- Not called from `child.on('error')` (agent failed to start → no session) — matches "user closes/exits".
- Signal exit (Ctrl-C) funnels through `child.on('exit')`, so it is covered.

### 3. Disable flag — `src/agents/core/AgentCLI.ts`

- Declare `.option('--no-analytics-report', 'Disable the automatic per-session analytics report on exit')`.
  Commander sets `options.analyticsReport = true` by default, `false` when the flag is present.
- Add `'analyticsReport'` to `collectPassThroughArgs`'s `configOnlyOptions` (codemie-level, not passed to the agent binary).
- Propagate to the adapter via env (existing `--status` pattern):
  `if (options.analyticsReport === false) providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT = '0';`

### 4. Agent opt-in — plugin metadata

- Add optional `sessionAnalyticsReport?: boolean` to `AgentMetadata` (`src/agents/core/types.ts`).
- Set `sessionAnalyticsReport: true` in `ClaudePluginMetadata`, `CodexPluginMetadata`,
  `OpenCodePluginMetadata`. (Claude-ACP extends Claude → inherits; acceptable, it also finalizes via the same path.)

## Data flow

```
codemie claude [--no-analytics-report] <args>
  └─ AgentCLI.handleRun: parse flag → providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT='0' if disabled
       └─ BaseAgentAdapter.run: env.CODEMIE_SESSION_ID = randomUUID; spawn agent
            └─ child 'exit': onSessionEnd → cleanup(flush) → afterRun → maybeWriteSessionReport(env)
                 └─ generateSessionReport({sessionId, outputPath, format:'json'})
                      └─ SessionsSource.load({filter:{sessionId}}) → enrichCosts → aggregate → buildPayload → generateReportJson
                           └─ ./docs/codemie/analytics/codemie-analytics-<sessionId>.json
```

## Error handling

- `generateSessionReport` returns `{written:[],sessions:0}` when the session has no data (no throw).
- All failures inside `maybeWriteSessionReport` are caught and logged at `warn`; exit proceeds normally.
- Explicit output path ⇒ `writeReportWithFallback(..., allowFallback=false)`; write errors propagate to the caller's try/catch (still non-fatal to the session).

## Testing (deferred to plan; only on explicit request)

- Unit: `generateSessionReport` — writes JSON for a session with data; returns `sessions:0` and writes nothing when the session is absent; propagates nothing fatal.
- Unit: `maybeWriteSessionReport` gating — skips when metadata flag unset, skips when `CODEMIE_SESSION_ANALYTICS_REPORT==='0'`, skips when no session id, swallows errors.
- Unit: `AgentCLI` — `--no-analytics-report` sets env '0' and is not forwarded to the agent; default leaves it enabled.

## Risks / considerations

- **Default-on writes files into the user's cwd** (`docs/codemie/analytics/`). This is the explicit
  requirement; the disable flag and the "skip when no data" behavior mitigate noise. Not an API break.
- **Read-after-flush timing**: placing the call after `cleanup()` + the existing 2s grace window gives
  the session's native logs/metrics time to land before the report reads them.
