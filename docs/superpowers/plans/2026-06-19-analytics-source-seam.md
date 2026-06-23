# Analytics Source Seam Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project policy adaptations (AGENTS.md + user preference override the writing-plans defaults):**
> - **No TDD-first steps.** Tests are written/run only on explicit user request. Each task validates with `npx tsc --noEmit` (typecheck) and `npm run lint`.
> - **No per-task `git commit` steps.** Commit only when the user explicitly asks; deliver a single summary at the end.
> - Existing OTEL tests (`__tests__/otel-loader.test.ts`, `__tests__/otel-report.integration.test.ts`) call `loadOtelSessions` directly, which is **unchanged in signature**, so they keep passing. Run `npm test -- analytics` to confirm only if the user asks.

**Goal:** Introduce an `AnalyticsSource` seam so the CLI is agnostic to where analytics data comes from, and move the (unreleased) OTEL surface from loose `--source`/`--otel-file` flags onto an `analytics otel` subcommand — making future Prometheus/Loki/Langfuse backends a one-file drop-in.

**Architecture:** Define `AnalyticsSource.load() → { rawSessions, cost? }`. `SessionsSource` wraps the existing `MetricsDataLoader` + native-loader merge (cost omitted, enriched later only for reports). `OtelSource` wraps `loadOtelSessions` (cost authoritative, returned up-front). `index.ts` becomes a thin CLI layer: a default command (sessions) plus an `otel` subcommand, both sharing one `applyCommonOptions()` set, both delegating to a single `runAnalytics(options, source)`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), commander, Vitest (existing only).

**Back-compat anchor:** `--report` / `--report-format` / `--open` / filters are released → preserved on the default command unchanged. `--source` / `--otel-file` / `--user` are new on this branch and **unreleased** → replaced by the subcommand with no alias needed.

---

## File Structure

**Create:**
- `src/cli/commands/analytics/sources/types.ts` — `AnalyticsSource`, `SourceLoadOptions`, `SourceResult` + a header note reserving the future-backend shape.
- `src/cli/commands/analytics/sources/sessions-source.ts` — `SessionsSource` (local + native).
- `src/cli/commands/analytics/sources/otel-source.ts` — `OtelSource` (flattened OTEL file).

**Modify:**
- `src/utils/errors.ts` — add `AnalyticsSourceError`.
- `src/cli/commands/analytics/data-loader.ts:16,33` — `export` `SessionStartEvent` / `SessionEndEvent`.
- `src/cli/commands/analytics/otel-loader.ts` — typed event factory (drop `as unknown as`), fix `lookupTranscriptCwd` `{}`→`undefined`.
- `src/cli/commands/analytics/types.ts` — drop `source`/`otelFile` from `AnalyticsOptions`; add `OtelCommandOptions`.
- `src/cli/commands/analytics/index.ts` — `applyCommonOptions`, `runAnalytics`, default + `otel` subcommand.

---

## Task 1: Error class + export event types

**Files:**
- Modify: `src/utils/errors.ts`
- Modify: `src/cli/commands/analytics/data-loader.ts:16`, `:33`

- [ ] **Step 1: Add `AnalyticsSourceError`** to `src/utils/errors.ts` (after `PathSecurityError`, before the npm section):

```ts
export class AnalyticsSourceError extends CodeMieError {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsSourceError';
  }
}
```

- [ ] **Step 2: Export the two event interfaces** so the OTEL loader can construct typed values. In `src/cli/commands/analytics/data-loader.ts` change:

```ts
interface SessionStartEvent {
```
to
```ts
export interface SessionStartEvent {
```
and
```ts
interface SessionEndEvent {
```
to
```ts
export interface SessionEndEvent {
```

- [ ] **Step 3: Typecheck.** Run `npx tsc --noEmit`. Expected: PASS (these are additive/visibility-only).

---

## Task 2: Source seam types

**Files:**
- Create: `src/cli/commands/analytics/sources/types.ts`

- [ ] **Step 1: Write the seam.**

```ts
/**
 * Analytics source seam.
 *
 * Every data backend implements {@link AnalyticsSource}: it loads its data and returns the
 * same {@link SourceResult} the aggregate → report pipeline consumes, so the CLI stays
 * agnostic to where the data came from.
 *
 * Today: {@link SessionsSource} (local ~/.codemie + native logs) and OtelSource
 * (flattened otel-events.jsonl). Future remote backends (Prometheus, Loki, Langfuse) become
 * one new `AnalyticsSource` + one thin `analytics <name>` subcommand each, with connection
 * URL + auth resolved from the `.codemie` config/profile (never CLI flags) — e.g.
 *   "analyticsSources": { "prod-langfuse": { "type": "langfuse", "url": "…", "authEnv": "LANGFUSE_TOKEN" } }
 * where `authEnv` names the env var holding the token. No connector code exists yet.
 */
import type { RawSessionData } from '../data-loader.js';
import type { AnalyticsFilter } from '../types.js';
import type { SessionCostIndex, CostSummary } from '../cost/types.js';

export interface SourceLoadOptions {
  filter: AnalyticsFilter;
  /** Sessions source only: skip native agent-log discovery. Ignored by other sources. */
  scanNative?: boolean;
}

export interface SourceResult {
  rawSessions: RawSessionData[];
  /**
   * Authoritative cost, present only when the source carries it in its own data
   * (e.g. OTEL `cost_usd`). Omitted when cost must be derived later from correlated logs
   * (local sessions → cost-enricher); the runner enriches in that case.
   */
  cost?: { index: SessionCostIndex; summary: CostSummary };
}

export interface AnalyticsSource {
  load(opts: SourceLoadOptions): Promise<SourceResult>;
}
```

- [ ] **Step 2: Typecheck.** Run `npx tsc --noEmit`. Expected: PASS.

---

## Task 3: SessionsSource

**Files:**
- Create: `src/cli/commands/analytics/sources/sessions-source.ts`

- [ ] **Step 1: Implement** (lifts the original sessions branch from `index.ts` verbatim; cost omitted — runner enriches when a report is wanted):

```ts
import { MetricsDataLoader } from '../data-loader.js';
import { logger } from '../../../../utils/logger.js';
import type { AnalyticsSource, SourceLoadOptions, SourceResult } from './types.js';

/**
 * Local-session source: ~/.codemie tracked sessions merged with discovered native agent
 * logs (plain `claude` etc.). Cost is omitted here and derived by the cost-enricher only
 * when a report is requested, matching the original analytics behavior.
 */
export class SessionsSource implements AnalyticsSource {
  async load(opts: SourceLoadOptions): Promise<SourceResult> {
    const loader = new MetricsDataLoader();
    const rawSessions = loader.loadSessions(opts.filter);

    // Discover native agent logs (not tracked by CodeMie) and merge so analytics reflect
    // ALL usage. Deduped against tracked logs inside the loader.
    if (opts.scanNative !== false) {
      try {
        const { loadNativeSessions } = await import('../native-loader.js');
        const natives = (await loadNativeSessions(opts.filter)).filter((s) =>
          loader.sessionMatchesFilter(s, opts.filter)
        );
        rawSessions.push(...natives);
      } catch (error) {
        logger.debug('Native session discovery failed (continuing with tracked sessions):', error);
      }
    }
    return { rawSessions };
  }
}
```

- [ ] **Step 2: Typecheck.** Run `npx tsc --noEmit`. Expected: PASS.

---

## Task 4: OtelSource

**Files:**
- Create: `src/cli/commands/analytics/sources/otel-source.ts`

- [ ] **Step 1: Implement** (adds the friendly missing-file error — Part-1 review fix — via `AnalyticsSourceError`):

```ts
import { existsSync } from 'node:fs';
import { AnalyticsSourceError } from '../../../../utils/errors.js';
import type { AnalyticsSource, SourceLoadOptions, SourceResult } from './types.js';

/**
 * OTEL source: a flattened otel-events.jsonl file. Cost is authoritative (native
 * `cost_usd`), so it is returned up-front and bypasses the cost-enricher.
 */
export class OtelSource implements AnalyticsSource {
  constructor(private readonly file: string, private readonly user?: string) {}

  async load(opts: SourceLoadOptions): Promise<SourceResult> {
    if (!existsSync(this.file)) {
      throw new AnalyticsSourceError(`OTEL file not found: ${this.file}`);
    }
    const { loadOtelSessions } = await import('../otel-loader.js');
    const res = loadOtelSessions({
      file: this.file,
      filter: { user: this.user, since: opts.filter.fromDate, until: opts.filter.toDate },
    });
    return { rawSessions: res.rawSessions, cost: { index: res.costIndex, summary: res.summary } };
  }
}
```

- [ ] **Step 2: Typecheck.** Run `npx tsc --noEmit`. Expected: PASS.

---

## Task 5: OTEL loader fixes (Part-1 review items)

**Files:**
- Modify: `src/cli/commands/analytics/otel-loader.ts:27` (import), `:296-314` (cwd), `:418-445` (buildRawSession)

- [ ] **Step 1: Import the now-exported event types.** Change line 27:

```ts
import type { RawSessionData } from './data-loader.js';
```
to
```ts
import type { RawSessionData, SessionStartEvent, SessionEndEvent } from './data-loader.js';
```

- [ ] **Step 2: Drop the double cast** in `buildRawSession` — construct typed events, return a typed `RawSessionData`:

```ts
export function buildRawSession(sessionId: string, sessionEvents: OtelEvent[], cwd: CwdInfo | undefined, projectLabel: string): RawSessionData {
  const times = sessionEvents.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const startTime = times.length ? Math.min(...times) : 0;
  const endTime = times.length ? Math.max(...times) : 0;
  const workingDirectory = cwd?.cwd || projectLabel;
  const startEvent: SessionStartEvent = {
    recordId: sessionId,
    type: 'session_start',
    timestamp: startTime,
    codeMieSessionId: sessionId,
    agentName: 'claude',
    syncStatus: 'synced',
    data: { provider: 'claude', workingDirectory, startTime },
  };
  const endEvent: SessionEndEvent = {
    recordId: `${sessionId}-end`,
    type: 'session_end',
    timestamp: endTime,
    codeMieSessionId: sessionId,
    agentName: 'claude',
    syncStatus: 'synced',
    data: { endTime, duration: Math.max(0, endTime - startTime), totalTurns: 0 },
  };
  return { sessionId, startEvent, endEvent, deltas: buildDeltas(sessionEvents, cwd) };
}
```

- [ ] **Step 3: Fix the cwd fallback bug.** In `lookupTranscriptCwd`, the trailing `return {};` (transcript found but no cwd/branch in the head) defeats the `?? pluginCwdMap` fallback in `loadOtelSessions`. Change the final `return {};` to:

```ts
  return undefined;
```

(So a session whose transcript head lacks cwd/branch falls back to this plugin's own `session.start` event.)

- [ ] **Step 4: Typecheck.** Run `npx tsc --noEmit`. Expected: PASS (typed events satisfy `RawSessionData` with no cast).

---

## Task 6: Options types

**Files:**
- Modify: `src/cli/commands/analytics/types.ts:248-258`

- [ ] **Step 1: Remove the unreleased loose flags and add the subcommand options type.** In `AnalyticsOptions`, delete the three new fields (`source`, `otelFile`, `user`). Then add, after the `AnalyticsOptions` interface:

```ts
/** Options for the `analytics otel` subcommand: the shared base plus OTEL-specific flags. */
export interface OtelCommandOptions extends AnalyticsOptions {
  /** Path to the flattened OTEL events file (required). */
  file: string;
  /** Scope OTEL analytics to one user (matches native user.email or user.id). */
  user?: string;
}
```

> Keep the `scanNative?: boolean` field that already exists on `AnalyticsOptions` (backs `--no-scan-native`).

- [ ] **Step 2: Typecheck.** Run `npx tsc --noEmit`. Expected: FAIL only in `index.ts` (still references removed fields) — fixed in Task 7.

---

## Task 7: CLI restructure (default command + `otel` subcommand)

**Files:**
- Modify: `src/cli/commands/analytics/index.ts:1-236`

- [ ] **Step 1: Replace the imports** (top of file) with:

```ts
/**
 * Analytics command - display aggregated metrics from sessions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { AnalyticsAggregator } from './aggregator.js';
import { AnalyticsFormatter } from './formatter.js';
import { AnalyticsExporter } from './exporter.js';
import type { AnalyticsOptions, AnalyticsFilter, OtelCommandOptions } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SessionsSource } from './sources/sessions-source.js';
import { OtelSource } from './sources/otel-source.js';
import type { AnalyticsSource } from './sources/types.js';
```

- [ ] **Step 2: Replace `createAnalyticsCommand`** with a thin builder: shared options helper + default (sessions) action + `otel` subcommand. Commander runs the parent action when no known subcommand is given, and routes to `otel` when it is — so bare `codemie analytics --report` keeps working.

```ts
export function createAnalyticsCommand(): Command {
  const command = new Command('analytics')
    .description('Display aggregated metrics and analytics from sessions');

  // Default source: local CodeMie-tracked sessions + native agent logs.
  applyCommonOptions(command)
    .option('--no-scan-native', 'Skip native agent-log discovery (use only CodeMie-tracked sessions)')
    .action((options: AnalyticsOptions) => runAnalytics(options, new SessionsSource()));

  // `codemie analytics otel --file <path>` — OTEL file source.
  const otel = new Command('otel')
    .description('Analytics from a flattened OTEL events file (otel-events.jsonl)');
  applyCommonOptions(otel)
    .requiredOption('--file <path>', 'Path to the flattened OTEL events file')
    .option('--user <id>', 'Scope to one user (native user.email or user.id)')
    .action((options: OtelCommandOptions) => runAnalytics(options, new OtelSource(options.file, options.user)));
  command.addCommand(otel);

  return command;
}

/** Filter, report, export, and verbosity options shared by every analytics source. */
function applyCommonOptions(command: Command): Command {
  return command
    .option('--session <id>', 'Filter by session ID')
    .option('--project <pattern>', 'Filter by project path (basename, partial, or full path)')
    .option('--agent <name>', 'Filter by agent name (claude, gemini, etc.)')
    .option('--branch <name>', 'Filter by git branch')
    .option('--from <date>', 'Filter sessions from date (YYYY-MM-DD)')
    .option('--to <date>', 'Filter sessions to date (YYYY-MM-DD)')
    .option('--last <duration>', 'Filter sessions from last duration (e.g., 7d, 24h)')
    .option('-v, --verbose', 'Show detailed session-level breakdown')
    .option('--export <format>', 'Export to file (json or csv)')
    .option('-o, --output <path>', 'Output file path (default: ./codemie-analytics-YYYY-MM-DD.{format})')
    .option('--report', 'Generate a self-contained HTML dashboard')
    .option('--open', 'Open the generated HTML report in the default browser')
    .option('--report-output <path>', 'HTML report output path (default: ./codemie-analytics-YYYY-MM-DD.html)')
    .option('--report-format <format>', 'Report serialization: html, json, or both (default: html)');
}
```

- [ ] **Step 3: Add `runAnalytics`** — the former action body, now source-agnostic. The only structural change vs. the original: data + optional authoritative cost come from `source.load()`, and cost is enriched only when the source did not supply it. Everything from aggregation onward is unchanged.

```ts
async function runAnalytics(options: AnalyticsOptions, source: AnalyticsSource): Promise<void> {
  try {
    const filter = parseFilterOptions(options);
    const { rawSessions, cost } = await source.load({ filter, scanNative: options.scanNative });

    if (rawSessions.length === 0) {
      console.log(chalk.yellow('\nNo sessions found matching the specified criteria.'));
      console.log(chalk.dim('Run with different filters or check that metrics are being collected.\n'));
      return;
    }

    // A report needs cost computed BEFORE aggregation so zero-delta sessions that still carry
    // real usage are retained instead of dropped as "empty".
    const wantReport = Boolean(options.report || options.reportOutput || options.open || options.reportFormat);
    const reportFormat = (options.reportFormat ?? 'html').toLowerCase();
    if (wantReport && reportFormat !== 'html' && reportFormat !== 'json' && reportFormat !== 'both') {
      console.log(chalk.red('\n✗ Invalid report format. Use "html", "json", or "both".'));
      return;
    }

    // Cost: authoritative from the source (OTEL) when present; otherwise enrich from correlated
    // logs, but only when a report needs it. Retain zero-delta sessions with real token usage.
    let costResult = cost;
    let keepSessionIds: Set<string> | undefined;
    if (cost) {
      keepSessionIds = new Set(
        [...cost.index.values()].filter((c) => c.tokens.total > 0).map((c) => c.sessionId)
      );
    } else if (wantReport) {
      const { enrichCosts, realDeps } = await import('./cost/cost-enricher.js');
      costResult = await enrichCosts(rawSessions, realDeps);
      keepSessionIds = new Set(
        [...costResult.index.values()].filter((c) => c.tokens.total > 0).map((c) => c.sessionId)
      );
    }

    // Aggregate data (normalize models unless --verbose flag is set)
    const analytics = AnalyticsAggregator.aggregate(rawSessions, !options.verbose, keepSessionIds);

    if (analytics.totalSessions === 0) {
      console.log(chalk.yellow('\nNo analytics data available.'));
      console.log(chalk.dim('Metrics collection may not have been enabled for these sessions.\n'));
      return;
    }

    // Display results
    const formatter = new AnalyticsFormatter(options.verbose);
    formatter.displayRoot(analytics);
    formatter.displayProjects(analytics.projects);

    // Export if requested
    if (options.export) {
      const format = options.export.toLowerCase();
      if (format !== 'json' && format !== 'csv') {
        console.log(chalk.red('\n✗ Invalid export format. Use "json" or "csv".'));
        return;
      }
      const outputPath = options.output || AnalyticsExporter.getDefaultOutputPath(format, process.cwd());
      if (format === 'json') {
        AnalyticsExporter.exportJSON(analytics, outputPath);
      } else {
        AnalyticsExporter.exportCSV(analytics, outputPath);
      }
    }

    // Generate the report if requested (--report-output and --open imply --report)
    if (wantReport && costResult) {
      const { buildPayload } = await import('./report/payload-builder.js');
      const {
        generateReport,
        generateReportJson,
        getDefaultReportPath,
        getDefaultReportJsonPath,
        writeReportWithFallback
      } = await import('./report/report-generator.js');

      const { index: costIndex, summary } = costResult;
      const payload = buildPayload(analytics, costIndex, summary, {
        rangeLabel: options.last ?? (options.from || options.to ? 'custom' : 'all'),
        projectFilter: options.project ?? 'all',
        generatedAt: new Date().toISOString()
      });

      const cwd = process.cwd();
      let htmlPath: string | undefined;
      let jsonPath: string | undefined;
      let htmlIsDefault = false;
      let jsonIsDefault = false;

      if (reportFormat === 'both') {
        const base = options.reportOutput?.replace(/\.(html|json)$/i, '');
        htmlPath = base ? `${base}.html` : getDefaultReportPath(cwd);
        jsonPath = base ? `${base}.json` : getDefaultReportJsonPath(cwd);
        htmlIsDefault = jsonIsDefault = !base;
      } else if (reportFormat === 'html') {
        htmlPath = options.reportOutput || getDefaultReportPath(cwd);
        htmlIsDefault = !options.reportOutput;
      } else {
        jsonPath = options.reportOutput || getDefaultReportJsonPath(cwd);
        jsonIsDefault = !options.reportOutput;
      }

      if (htmlPath) {
        const result = writeReportWithFallback((p) => generateReport(payload, p), htmlPath, htmlIsDefault);
        htmlPath = result.path;
        if (result.relocatedFrom) {
          console.log(
            chalk.yellow(`\n! ${result.relocatedFrom} is not writable (drive root or read-only volume); using a writable location instead.`)
          );
        }
        console.log(chalk.green(`\n✓ HTML report written to: ${htmlPath}`));
      }
      if (jsonPath) {
        const result = writeReportWithFallback((p) => generateReportJson(payload, p), jsonPath, jsonIsDefault);
        jsonPath = result.path;
        if (result.relocatedFrom) {
          console.log(
            chalk.yellow(`\n! ${result.relocatedFrom} is not writable (drive root or read-only volume); using a writable location instead.`)
          );
        }
        console.log(chalk.green(`\n✓ JSON report written to: ${jsonPath}`));
      }

      const { sessions: totalReportSessions, pricedSessions } = payload.meta.totals;
      if (pricedSessions < totalReportSessions) {
        console.log(
          chalk.dim(
            `  Cost priced for ${pricedSessions}/${totalReportSessions} sessions (native agent logs required for the rest).`
          )
        );
      }

      if (options.open) {
        if (htmlPath) {
          const { openUrlInBrowser } = await import('../../../utils/browser.js');
          await openUrlInBrowser(htmlPath);
        } else {
          console.log(chalk.dim('  --open ignored: no HTML produced (use --report-format html or both).'));
        }
      }
    }

    console.log('');
  } catch (error) {
    logger.error('Analytics command failed:', error);
    console.error(chalk.red(`\n✗ Failed to generate analytics: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exit(1);
  }
}
```

- [ ] **Step 4: Leave `parseFilterOptions` unchanged** (it stays at the bottom of the file).

- [ ] **Step 5: Typecheck.** Run `npx tsc --noEmit`. Expected: PASS (no more references to removed `source`/`otelFile` fields).

---

## Task 8: Validate end to end

**Files:** none (verification only)

- [ ] **Step 1: Lint.** Run `npm run lint`. Expected: zero warnings (project policy).

- [ ] **Step 2: Build.** Run `npm run build`. Expected: PASS.

- [ ] **Step 3: Manual CLI check — default command unchanged.** Run:

```bash
node bin/codemie.js analytics --help
```
Expected: shows shared options AND an `otel` subcommand in the command list.

- [ ] **Step 4: Manual CLI check — OTEL subcommand against the fixture.** Run:

```bash
node bin/codemie.js analytics otel --file src/cli/commands/analytics/__tests__/fixtures/otel-events.sample.jsonl --report --report-output /tmp/otel-seam-check.html
```
Expected: `✓ HTML report written to: /tmp/otel-seam-check.html`; two sessions aggregated.

- [ ] **Step 5: Manual CLI check — missing-file error.** Run:

```bash
node bin/codemie.js analytics otel --file /no/such/file.jsonl
```
Expected: `✗ Failed to generate analytics: OTEL file not found: /no/such/file.jsonl` (no raw `ENOENT`).

- [ ] **Step 6 (optional, only if user asks for tests):** `npm test -- analytics` — existing OTEL tests should still pass (`loadOtelSessions` signature is unchanged).

---

## Self-Review

- **Spec coverage:** seam interface (T2) ✓; sessions impl (T3) ✓; otel impl (T4) ✓; subcommand surface + default-command back-compat (T7) ✓; config shape reserved as doc note (T2 header) ✓; Part-1 fixes — typed events/no cast (T5), cwd fallback (T5), friendly missing-file error (T4) ✓. Out of scope by design: remote connectors, dedup, streaming, privacy redaction (documented as future constraints, not built).
- **Type consistency:** `SourceResult.cost` (`{ index, summary } | undefined`) is produced by `OtelSource` and consumed in `runAnalytics`; `enrichCosts` returns the same `{ index, summary }` shape → assignment to `costResult` type-checks. `OtelCommandOptions.file`/`user` match `OtelSource` constructor args. `applyCommonOptions` is applied to both the parent and `otel`, so both carry identical filter/report flags.
- **No placeholders:** every code step shows complete code; every run step shows the exact command + expected output.
- **Excluded from this work (commit hygiene):** `.codemie/codemie-cli.config.json` (profile switch) and `.claude/settings.json` (plugin toggle) are local env changes, not part of this feature. The `hook.ts` session re-entry change is adjacent (session tracking, not analytics) and untested — decide separately whether it ships on this branch.
