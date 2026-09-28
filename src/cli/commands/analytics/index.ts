/**
 * Analytics command - display aggregated metrics from sessions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnalyticsAggregator } from './aggregator.js';
import { AnalyticsFormatter } from './formatter.js';
import type { AnalyticsOptions, AnalyticsFilter, OtelCommandOptions } from './types.js';
import type { ExportFormat } from './report/output-target.js';
import { logger } from '../../../utils/logger.js';
import { SessionsSource } from './sources/sessions-source.js';
import { OtelSource } from './sources/otel-source.js';
import type { AnalyticsSource } from './sources/types.js';
import { ConfigLoader } from '../../../utils/config.js';

export function createAnalyticsCommand(): Command {
  const command = new Command('analytics')
    .description('Display aggregated metrics and analytics from sessions');

  // Default source: local CodeMie-tracked sessions + native agent logs.
  applyCommonOptions(command)
    .option('--include-external', 'Also count native agent sessions CodeMie did not launch (e.g. plain `claude`)')
    .action((options: AnalyticsOptions) => runAnalytics(options, new SessionsSource()));

  // `codemie analytics otel --file <path>` — OTEL file source.
  const otel = new Command('otel')
    .description('Analytics from a flattened OTEL events file (otel-events.jsonl)');
  applyCommonOptions(otel)
    .requiredOption('--file <path>', 'Path to the flattened OTEL events file')
    .option('--user <id>', 'Scope to one user (native user.email or user.id)')
    .action((_options: OtelCommandOptions, command: Command) => {
      // The shared options (--export, --from, …) are registered on BOTH the parent and this
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
    .option('--export [format]', 'Write report: html (default), json, or both')
    .option('-o, --output <path>', 'Output file or directory (default: ./codemie-analytics-YYYY-MM-DD.{ext})')
    .option('--open', 'Open the generated HTML report in the default browser');
}

export async function runAnalytics(options: AnalyticsOptions, source: AnalyticsSource): Promise<void> {
  try {
    // --export [format] / --open / -o resolution — validated FIRST, before loading any
    // sessions, so an invalid format (csv included) fails closed even when the source would
    // return zero sessions (no enrichment, no summary). `--open` with no `--export` implies
    // html. `-o <path>` with no `--export`/`--open` also implies an export, with the format
    // inferred from the path: ends with `.json` -> json; anything else (.html, a directory
    // target, other) -> html.
    const openFlag = Boolean(options.open);
    let exportFormat: ExportFormat | undefined;
    if (options.export !== undefined) {
      const rawFormat = options.export === true ? 'html' : options.export.toLowerCase();
      if (rawFormat === 'html' || rawFormat === 'json' || rawFormat === 'both') {
        exportFormat = rawFormat;
      } else {
        console.log(chalk.red('\n✗ Invalid export format. Use "html", "json", or "both".'));
        process.exitCode = 1;
        return;
      }
    } else if (openFlag) {
      exportFormat = 'html';
    } else if (options.output !== undefined) {
      exportFormat = options.output.toLowerCase().endsWith('.json') ? 'json' : 'html';
    }

    const filter = parseFilterOptions(options);
    const { rawSessions, cost } = await source.load({
      filter,
      includeExternal: options.includeExternal
    });

    if (rawSessions.length === 0) {
      console.log(chalk.yellow('\nNo sessions found matching the specified criteria.'));
      console.log(chalk.dim('Run with different filters or check that metrics are being collected.\n'));
      return;
    }

    // Cost computed BEFORE aggregation so zero-delta sessions that still carry real usage are
    // retained instead of dropped as "empty". Authoritative from the source (OTEL) when present;
    // otherwise always enriched from correlated native logs. Both branches populate the same
    // shape, so `costResult` narrows without a throw or a non-null assertion.
    let costResult: NonNullable<typeof cost>;
    if (cost) {
      costResult = cost;
    } else {
      const { enrichCosts, realDeps } = await import('./cost/cost-enricher.js');
      costResult = await enrichCosts(rawSessions, realDeps);
    }
    const keepSessionIds = new Set(
      [...costResult.index.values()].filter((c) => c.tokens.total > 0).map((c) => c.sessionId)
    );

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
    formatter.displayCost(costResult.summary);

    // Write the report (--export [format] / -o / --open).
    if (exportFormat) {
      const { buildPayload } = await import('./report/payload-builder.js');
      const { generateReport, generateReportJson, writeReportWithFallback } = await import('./report/report-generator.js');
      const { resolveOutputTargets } = await import('./report/output-target.js');

      // Load user email for report metadata and filename; non-fatal if config is unavailable.
      let userEmail: string | undefined;
      try {
        const cfg = await ConfigLoader.loadMultiProviderConfig();
        userEmail = cfg.userEmail || undefined;
      } catch {
        // omit email gracefully
      }

      if (userEmail === undefined && process.stdout.isTTY) {
        console.log(chalk.yellow('\n  Warning: your email is not configured. It will be included in the report metadata and saved for future runs.'));
        try {
          const { email } = await inquirer.prompt<{ email: string }>([{
            type: 'input',
            name: 'email',
            message: 'Enter your email address:',
            validate: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) || 'Please enter a valid email address',
          }]);
          userEmail = email.trim();
          await ConfigLoader.saveUserEmail(userEmail).catch(() => { /* non-fatal */ });
        } catch (err) {
          if (err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError')) {
            console.log(chalk.dim('\n  Report generation cancelled.'));
            return;
          }
          throw err;
        }
      }

      const { index: costIndex, summary } = costResult;
      const payload = buildPayload(analytics, costIndex, summary, {
        rangeLabel: options.last ?? (options.from || options.to ? 'custom' : 'all'),
        projectFilter: options.project ?? 'all',
        generatedAt: new Date().toISOString(),
        ...(userEmail !== undefined && { userEmail }),
        ...(filter.fromDate !== undefined && { periodStart: filter.fromDate.toISOString() }),
        ...(filter.toDate !== undefined && { periodEnd: filter.toDate.toISOString() }),
      });

      const targets = resolveOutputTargets(exportFormat, options.output, process.cwd(), userEmail);
      let htmlPath = targets.html;
      let jsonPath = targets.json;

      if (htmlPath) {
        if (targets.isDefault) {
          const result = writeReportWithFallback((p) => generateReport(payload, p), htmlPath, true);
          htmlPath = result.path;
          if (result.relocatedFrom) {
            console.log(
              chalk.yellow(`\n! ${result.relocatedFrom} is not writable (drive root or read-only volume); using a writable location instead.`)
            );
          }
        } else {
          mkdirSync(dirname(htmlPath), { recursive: true });
          generateReport(payload, htmlPath);
        }
        console.log(chalk.green(`\n✓ HTML report written to: ${htmlPath}`));
      }
      if (jsonPath) {
        if (targets.isDefault) {
          const result = writeReportWithFallback((p) => generateReportJson(payload, p), jsonPath, true);
          jsonPath = result.path;
          if (result.relocatedFrom) {
            console.log(
              chalk.yellow(`\n! ${result.relocatedFrom} is not writable (drive root or read-only volume); using a writable location instead.`)
            );
          }
        } else {
          mkdirSync(dirname(jsonPath), { recursive: true });
          generateReportJson(payload, jsonPath);
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

      if (openFlag) {
        if (htmlPath) {
          const { openUrlInBrowser } = await import('../../../utils/browser.js');
          await openUrlInBrowser(htmlPath);
        } else {
          console.log(chalk.dim('  --open ignored: no HTML produced (use --export html or both).'));
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
      filter.toDate = new Date();
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
