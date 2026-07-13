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

export function createAnalyticsCommand(): Command {
  const command = new Command('analytics')
    .description('Display aggregated metrics and analytics from sessions');

  // Default source: local CodeMie-tracked sessions + native agent logs.
  applyCommonOptions(command)
    .option('--no-scan-native', 'Skip native agent-log discovery (use only CodeMie-tracked sessions)')
    .option('--include-external', 'Include non-CodeMie-owned native sessions in output (opt-in; matches pre-fix behavior)')
    .action((options: AnalyticsOptions) => runAnalytics(options, new SessionsSource()));

  // `codemie analytics otel --file <path>` — OTEL file source.
  const otel = new Command('otel')
    .description('Analytics from a flattened OTEL events file (otel-events.jsonl)');
  applyCommonOptions(otel)
    .requiredOption('--file <path>', 'Path to the flattened OTEL events file')
    .option('--user <id>', 'Scope to one user (native user.email or user.id)')
    .action((_options: OtelCommandOptions, command: Command) => {
      // The shared options (--report, --from, …) are registered on BOTH the parent and this
      // subcommand, so commander binds them to the PARENT when they appear after `otel`.
      // optsWithGlobals() merges parent + subcommand options into the full set the runner needs.
      const opts = command.optsWithGlobals() as OtelCommandOptions;
      return runAnalytics(opts, new OtelSource(opts.file, opts.user));
    });
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

async function runAnalytics(options: AnalyticsOptions, source: AnalyticsSource): Promise<void> {
  try {
    const filter = parseFilterOptions(options);
    const { rawSessions, cost } = await source.load({
      filter,
      scanNative: options.scanNative,
      includeExternal: options.includeExternal
    });

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

/**
 * Parse filter options from command line arguments
 */
function parseFilterOptions(options: AnalyticsOptions): AnalyticsFilter {
  const filter: AnalyticsFilter = {};

  if (options.session) {
    filter.sessionId = options.session;
  }

  if (options.project) {
    filter.projectPattern = options.project;
  }

  if (options.agent) {
    filter.agentName = options.agent;
  }

  if (options.branch) {
    filter.branch = options.branch;
  }

  // Parse date filters
  if (options.from) {
    const fromDate = parseDate(options.from);
    if (!fromDate) {
      console.warn(chalk.yellow(`Warning: Invalid --from date "${options.from}", ignoring filter`));
    } else {
      filter.fromDate = fromDate;
    }
  }

  if (options.to) {
    const toDate = parseDate(options.to);
    if (!toDate) {
      console.warn(chalk.yellow(`Warning: Invalid --to date "${options.to}", ignoring filter`));
    } else {
      filter.toDate = toDate;
    }
  }

  // Parse --last duration (e.g., "7d", "24h")
  if (options.last) {
    const duration = parseDuration(options.last);
    if (!duration) {
      console.warn(chalk.yellow(`Warning: Invalid --last duration "${options.last}", ignoring filter`));
    } else {
      filter.fromDate = new Date(Date.now() - duration);
    }
  }

  return filter;
}

/**
 * Parse date string (YYYY-MM-DD) to Date object
 */
function parseDate(dateStr: string): Date | null {
  // Enforce the documented YYYY-MM-DD shape. Without this, `new Date()` accepts ambiguous
  // inputs (MM/DD/YYYY, prose dates) with format-dependent timezone handling, silently
  // producing a wrong filter window instead of triggering the caller's "invalid date" warning.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const date = new Date(dateStr);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse duration string (e.g., "7d", "24h") to milliseconds
 */
function parseDuration(durationStr: string): number | null {
  const match = durationStr.match(/^(\d+)([dhm])$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    default:
      return null;
  }
}
