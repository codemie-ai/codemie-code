/**
 * Analytics command - display aggregated metrics from sessions
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnalyticsFormatter } from './formatter.js';
import { loadAnalytics } from './analytics-core.js';
import type { AnalyticsOptions, AnalyticsFilter, OtelCommandOptions } from './types.js';
import type { InstallOptions } from './sync/types.js';
import type { ExportFormat } from './report/output-target.js';
import { logger } from '../../../utils/logger.js';
import { SessionsSource } from './sources/sessions-source.js';
import { OtelSource } from './sources/otel-source.js';
import type { AnalyticsSource } from './sources/types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { parseDate, parseDuration } from './date-args.js';
import { EMAIL_REGEX } from './sync/identity.js';

/**
 * Date on which the deprecated analytics report flags (`--report`, `--report-format`,
 * `--report-output`) will be removed.
 */
const LEGACY_FLAGS_REMOVAL_DATE = 'November 1, 2026';

export function createAnalyticsCommand(): Command {
  const command = new Command('analytics')
    .description('Display aggregated metrics and analytics from sessions')
    // Required so a descendant subcommand can redeclare an option name an ancestor also
    // defines with different semantics without the ancestor swallowing it: each level only
    // consumes its own options up to the first non-option argument, then hands the rest
    // down untouched.
    .enablePositionalOptions();

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

  // `codemie analytics sync` — a daily per-user OS job that sends this machine's analytics
  // reports one way to the team's webhook. A pure group (no action of its own, no
  // `--from/--to/--last`): everything lives in its four subcommands below.
  command.addCommand(createSyncCommand());

  return command;
}

/**
 * `codemie analytics sync` — the group description names the one-way delivery; each
 * subcommand's own description says who runs it and what it changes (story AC, "Command
 * surface"). `.enablePositionalOptions()` mirrors the parent command so a subcommand's own
 * option (e.g. `install --include-external`) is never swallowed by an identically-named
 * option on `analytics` or on `sync` itself (D14).
 */
function createSyncCommand(): Command {
  const sync = new Command('sync')
    .description("Send this machine's analytics reports one way to the team's webhook on a daily schedule")
    .enablePositionalOptions();

  sync.addCommand(createSyncInstallCommand());
  sync.addCommand(createSyncStatusCommand());
  sync.addCommand(createSyncRunCommand());
  sync.addCommand(createSyncUninstallCommand());

  return sync;
}

/** `codemie analytics sync install` — registers the daily OS job. Dynamic-imports the
 * install runner so loading `codemie analytics` never pulls in the scheduler module. */
function createSyncInstallCommand(): Command {
  return new Command('install')
    .description('Developer: register the daily delivery job on this machine')
    .option('--webhook <url>', "The team's https webhook URL that receives the daily report")
    .option('--at <HH:MM>', 'Daily run time, 24-hour local time (default: 03:00)')
    .option('--lookback-days <n>', 'Session window looked back on each run, 1-30 (default: 7)')
    .option('--include-external <policy>', 'Native agent sessions CodeMie did not launch: windows, always, or never (default: windows)')
    .action(async (options: InstallOptions) => {
      const { runInstall, createRealInstallDeps } = await import('./sync/install.js');
      process.exitCode = await runInstall(options, createRealInstallDeps());
    });
}

/** `codemie analytics sync status` — reports whether the job is installed and enabled, the
 * current settings, and the outcome of the last run. */
function createSyncStatusCommand(): Command {
  return new Command('status')
    .description('Developer: show whether the delivery job is installed and its last outcome')
    .action(async () => {
      const { runStatus, createRealStatusDeps } = await import('./sync/status.js');
      process.exitCode = await runStatus(createRealStatusDeps());
    });
}

/** `codemie analytics sync run` — sends the pending analytics window to the webhook now.
 * `--scheduled` is passed by the OS job itself (see `bin/codemie.js`/`scheduled-run.ts`) to
 * skip the interactive startup checks; it is hidden from `--help` since developers invoke
 * `run` without it. */
function createSyncRunCommand(): Command {
  return new Command('run')
    .description('Developer or the daily scheduled job: send the pending analytics report to the webhook now')
    .addOption(new Option('--scheduled').hideHelp())
    .action(async () => {
      const { runSync, realSyncDeps } = await import('./sync/run-sync.js');
      process.exitCode = await runSync(realSyncDeps());
    });
}

/** `codemie analytics sync uninstall` — removes the OS job and the settings holding the
 * webhook. The last-sent marker and the run log are kept. */
function createSyncUninstallCommand(): Command {
  return new Command('uninstall')
    .description('Developer: remove the delivery job and its settings from this machine')
    .action(async () => {
      const { runUninstall, createRealUninstallDeps } = await import('./sync/uninstall.js');
      process.exitCode = await runUninstall(createRealUninstallDeps());
    });
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
    .option('--open', 'Open the generated HTML report in the default browser')
    .option('--redact', 'Omit prompt text (session titles) and absolute paths from the exported report, for sharing outside this machine')
    .option('--report', `Deprecated: use --export instead (removal planned for ${LEGACY_FLAGS_REMOVAL_DATE})`)
    .option('--report-format <format>', `Deprecated: use --export [format] instead (removal planned for ${LEGACY_FLAGS_REMOVAL_DATE})`)
    .option('--report-output <path>', `Deprecated: use -o/--output instead (removal planned for ${LEGACY_FLAGS_REMOVAL_DATE})`);
}

export async function runAnalytics(options: AnalyticsOptions, source: AnalyticsSource): Promise<void> {
  try {
    // Deprecated flags removed in 1144b247d, restored as aliases so existing scripts keep
    // working. Each prints a warning pointing at its replacement; the new flag wins when both
    // are set:
    //   --report              -> bare --export (html)
    //   --report-format <fmt> -> --export [format]
    //   --report-output <p>   -> -o/--output <p>
    //
    // TODO: retire these aliases on LEGACY_FLAGS_REMOVAL_DATE — drop the three .option()
    // registrations, this whole mapping block, and the report/reportFormat/reportOutput
    // fields in types.ts.
    let output = options.output;
    if (options.reportOutput !== undefined) {
      if (output === undefined) {
        console.log(chalk.yellow(`\n! --report-output is deprecated; use -o/--output instead (will be removed on ${LEGACY_FLAGS_REMOVAL_DATE}).`));
        output = options.reportOutput;
      } else {
        console.log(chalk.yellow('\n! --report-output is deprecated and ignored; -o/--output takes precedence.'));
      }
    }

    let exportOpt = options.export;
    if (options.reportFormat !== undefined) {
      if (exportOpt === undefined) {
        console.log(chalk.yellow(`\n! --report-format is deprecated; use --export [format] instead (will be removed on ${LEGACY_FLAGS_REMOVAL_DATE}).`));
        exportOpt = options.reportFormat;
      } else {
        console.log(chalk.yellow('\n! --report-format is deprecated and ignored; --export takes precedence.'));
      }
    }
    if (options.report) {
      console.log(chalk.yellow(`\n! --report is deprecated; use --export instead (will be removed on ${LEGACY_FLAGS_REMOVAL_DATE}; html is the default format).`));
      if (exportOpt === undefined) {
        exportOpt = true;
      }
    }

    // --export [format] / --open / -o resolution — validated FIRST, before loading any
    // sessions, so an invalid format (csv included) fails closed even when the source would
    // return zero sessions (no enrichment, no summary). `--open` with no `--export` implies
    // html. `-o <path>` with no `--export`/`--open` also implies an export, with the format
    // inferred from the path: ends with `.json` -> json; anything else (.html, a directory
    // target, other) -> html.
    const openFlag = Boolean(options.open);
    let exportFormat: ExportFormat | undefined;
    if (exportOpt !== undefined) {
      const rawFormat = exportOpt === true ? 'html' : exportOpt.toLowerCase();
      if (rawFormat === 'html' || rawFormat === 'json' || rawFormat === 'both') {
        exportFormat = rawFormat;
      } else {
        console.log(chalk.red('\n✗ Invalid export format. Use "html", "json", or "both".'));
        process.exitCode = 1;
        return;
      }
    } else if (openFlag) {
      exportFormat = 'html';
    } else if (output !== undefined) {
      exportFormat = output.toLowerCase().endsWith('.json') ? 'json' : 'html';
    }

    const filter = parseFilterOptions(options);
    const loaded = await loadAnalytics(source, filter, options.includeExternal, !options.verbose);

    if (loaded.kind === 'empty-raw') {
      console.log(chalk.yellow('\nNo sessions found matching the specified criteria.'));
      console.log(chalk.dim('Run with different filters or check that metrics are being collected.\n'));
      return;
    }

    if (loaded.kind === 'empty-aggregate') {
      console.log(chalk.yellow('\nNo analytics data available.'));
      console.log(chalk.dim('Metrics collection may not have been enabled for these sessions.\n'));
      return;
    }

    const { analytics, costResult } = loaded;

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
      const { redactPayload } = await import('./report/redact.js');

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
            validate: (v: string) => EMAIL_REGEX.test(v.trim()) || 'Please enter a valid email address',
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
      const builtPayload = buildPayload(analytics, costIndex, summary, {
        rangeLabel: options.last ?? (options.from || options.to ? 'custom' : 'all'),
        projectFilter: options.project ?? 'all',
        generatedAt: new Date().toISOString(),
        ...(userEmail !== undefined && { userEmail }),
        ...(filter.fromDate !== undefined && { periodStart: filter.fromDate.toISOString() }),
        ...(filter.toDate !== undefined && { periodEnd: filter.toDate.toISOString() }),
      });
      const payload = options.redact ? redactPayload(builtPayload) : builtPayload;

      const targets = resolveOutputTargets(exportFormat, output, process.cwd(), userEmail);
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

