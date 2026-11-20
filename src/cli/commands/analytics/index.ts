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
import type { AnalyticsOptions, AnalyticsFilter, OtelCommandOptions, RootAnalytics } from './types.js';
import type { CostSummary, SessionCostIndex } from './cost/types.js';
import type { InstallOptions } from './sync/types.js';
import type { BootstrapOptions } from './sync/bootstrap/types.js';
import type { ExportFormat } from './report/output-target.js';
import { logger } from '../../../utils/logger.js';
import { parseDateOnly } from '@/utils/date-filter.js';
import { SessionsSource } from './sources/sessions-source.js';
import { OtelSource } from './sources/otel-source.js';
import { createViewCommand } from './view/view-command.js';
import type { AnalyticsSource } from './sources/types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { parseDuration } from './date-args.js';
import { EMAIL_REGEX } from './sync/identity.js';
import { includeExternalFor } from './sync/policy.js';
import type { IncludeExternalPolicy } from './sync/types.js';
import { ConfigurationError } from '../../../utils/errors.js';
import {
  DEPRECATION_REMOVE_ON,
  deprecate,
  registerDeprecation,
  removedOption,
  type DeprecationEntry,
} from '../../deprecation.js';

const BARE_INCLUDE_EXTERNAL = {
  kind: 'deprecated',
  old: 'codemie analytics --include-external',
  replacement: 'codemie analytics --include-external always',
  bareOnly: true,
} as const satisfies DeprecationEntry;

const REMOVED_REPORT_FLAGS: ReadonlyArray<{ flags: string; entry: DeprecationEntry }> = [
  { flags: '--report', entry: { kind: 'removed', old: 'codemie analytics --report', replacement: 'codemie analytics --export', dropOn: DEPRECATION_REMOVE_ON } },
  { flags: '--report-format <format>', entry: { kind: 'removed', old: 'codemie analytics --report-format', replacement: 'codemie analytics --export <format>', dropOn: DEPRECATION_REMOVE_ON } },
  { flags: '--report-output <path>', entry: { kind: 'removed', old: 'codemie analytics --report-output', replacement: 'codemie analytics -o <path>', dropOn: DEPRECATION_REMOVE_ON } },
];

const INCLUDE_EXTERNAL_POLICIES: readonly IncludeExternalPolicy[] = ['windows', 'always', 'never'];
const INCLUDE_EXTERNAL_ACCEPTED = 'windows, always, or never';

/**
 * Resolve the raw `--include-external [policy]` value (undefined: flag absent; true: bare form).
 * Returns the include flag, or `null` after reporting an invalid value (exitCode 1).
 */
function resolveIncludeExternal(raw: string | true | undefined, json: boolean): boolean | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === true) {
    deprecate(BARE_INCLUDE_EXTERNAL, { json });
    return includeExternalFor('always', process.platform);
  }
  if ((INCLUDE_EXTERNAL_POLICIES as readonly string[]).includes(raw)) {
    return includeExternalFor(raw as IncludeExternalPolicy, process.platform);
  }
  const subcommand = raw === 'otel' || raw === 'sync';
  process.stderr.write(
    subcommand
      ? `Error: --include-external takes a policy (${INCLUDE_EXTERNAL_ACCEPTED}), not the subcommand "${raw}" — to run "${raw}", drop --include-external or give it a policy first (e.g. --include-external always ${raw})\n`
      : `Error: invalid --include-external value "${raw}" — use ${INCLUDE_EXTERNAL_ACCEPTED}\n`
  );
  process.exitCode = 1;
  return null;
}

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
    .option(
      '--include-external [policy]',
      `Also count native agent sessions CodeMie did not launch (e.g. plain \`claude\`): ${INCLUDE_EXTERNAL_ACCEPTED}`
    )
    .action((options: AnalyticsOptions & { includeExternal?: string | true }) => {
      const includeExternal = resolveIncludeExternal(options.includeExternal, false);
      if (includeExternal === null) return;
      return runAnalytics({ ...options, includeExternal }, new SessionsSource());
    });
  registerDeprecation(BARE_INCLUDE_EXTERNAL);

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

  // `codemie analytics view --input <export.json>` — numbers, a session trace or the HTML report
  // from an existing export, without reading agent logs.
  command.addCommand(createViewCommand());

  // `codemie analytics sync` — a daily per-user OS job that sends this machine's analytics
  // reports one way to the team's webhook and/or a team git repository. A pure group (no
  // action of its own, no `--from/--to/--last`): everything lives in its four subcommands
  // below.
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
    .description(
      "Send this machine's analytics reports one way to the team's webhook and/or a team git repository on a daily schedule"
    )
    .enablePositionalOptions();

  sync.addCommand(createSyncBootstrapCommand());
  sync.addCommand(createSyncInstallCommand());
  sync.addCommand(createSyncStatusCommand());
  sync.addCommand(createSyncRunCommand());
  sync.addCommand(createSyncUninstallCommand());

  return sync;
}

/** `codemie analytics sync bootstrap` — the team lead's one-time setup: choose where the
 * team's reports go (a Teams webhook, a git repository, or both), connect a Teams channel and
 * SharePoint folder to a Power Automate flow for the webhook, test-push to the repository for
 * git, then print the `sync install` command for the team's developers. Installs nothing on
 * the lead's own machine. With
 * `--webhook` and/or `--git-repo`, runs non-interactively (no prompts, no TTY required); without it and with a
 * TTY, runs the guided wizard. Dynamic-imports the runner so loading `codemie analytics`
 * never pulls in the guided wizard's prompter or the webhook client. */
function createSyncBootstrapCommand(): Command {
  return new Command('bootstrap')
    .description(
      'Lead: choose where your team delivers reports (Teams webhook, git repository, or both), set it up, then print the install command for your team (installs nothing on this machine)'
    )
    .option(
      '--webhook <url>',
      "The flow's https trigger URL: runs non-interactively instead of the guided wizard, testing delivery before printing the install command"
    )
    .option(
      '--webhook-b64 <value>',
      'The same trigger URL encoded as base64url, for shells that mangle a raw URL (use instead of --webhook)'
    )
    .option('--git-repo <url>', 'URL of a team git repository to push the daily report into (the other possible delivery target; runs non-interactively, test-pushing before printing the install command)')
    .option('--git-branch <name>', 'Branch to push to (default: the repository\'s default branch)')
    .option('--git-path <dir>', 'Repo-relative directory the report is pushed under (default: the repository root)')
    .option('--lookback-days <n>', 'Fixed session window for the printed install command, 1-30 (default: follows the CLI default)')
    .option('--include-external <policy>', 'Native agent sessions CodeMie did not launch: windows, always, or never (default: never)')
    .action(async (options: BootstrapOptions) => {
      const { runBootstrap, createRealBootstrapDeps } = await import('./sync/bootstrap/run-bootstrap.js');
      process.exitCode = await runBootstrap(options, createRealBootstrapDeps());
    });
}

/** `codemie analytics sync install` — registers the daily OS job. Dynamic-imports the
 * install runner so loading `codemie analytics` never pulls in the scheduler module. */
function createSyncInstallCommand(): Command {
  return new Command('install')
    .description('Developer: register the daily delivery job on this machine')
    .option(
      '--webhook <url>',
      "The team's https webhook URL that receives the daily report (one of two possible delivery targets, alongside --git-repo; at least one is required)"
    )
    .option('--webhook-b64 <value>', 'The webhook URL encoded as base64url, as printed by `sync bootstrap` (use instead of --webhook)')
    .option('--git-repo <url>', 'URL of a team git repository to push the daily report into (the other possible delivery target)')
    .option('--git-branch <name>', 'Branch to push to (default: the repository\'s default branch)')
    .option('--git-path <dir>', 'Repo-relative directory the report is pushed under (default: the repository root)')
    .option('--format <json>', "Report export format for every configured delivery target (default and only accepted value: json)")
    .option('--at <HH:MM>', 'Daily run time, 24-hour local time (default: 03:00)')
    .option('--lookback-days <n>', 'Session window looked back on each run, 1-30 (default: 7)')
    .option('--include-external <policy>', 'Native agent sessions CodeMie did not launch: windows, always, or never (default: never)')
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
    .description(
      'Developer or the daily scheduled job: send the pending analytics report to the configured webhook and/or team git repository now'
    )
    .addOption(new Option('--scheduled').hideHelp())
    .action(async () => {
      const { runSync, realSyncDeps } = await import('./sync/run-sync.js');
      process.exitCode = await runSync(realSyncDeps());
    });
}

/** `codemie analytics sync uninstall` — removes the OS job and the settings holding the
 * webhook and/or team git repository target. The last-sent marker(s), the run log and the
 * git target's working copy are kept. */
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
    .option('--from <date>', 'Start date, inclusive (YYYY-MM-DD, UTC)')
    .option('--to <date>', 'End date, inclusive: the whole day (YYYY-MM-DD, UTC)')
    .option('--last <duration>', 'Filter sessions from last duration (e.g., 7d, 24h)')
    .option('-v, --verbose', 'Show detailed session-level breakdown')
    .option('--export [format]', 'Write report: html (default), json, or both')
    .option('-o, --output <path>', 'Output file or directory (default: ./codemie-analytics-YYYY-MM-DD.{ext})')
    .option('--open', 'Open the generated HTML report in the default browser')
    .option('--redact', 'Omit prompt text (session titles) and absolute paths from the exported report, for sharing outside this machine')
    .addOption(removedOption(REMOVED_REPORT_FLAGS[0].entry, REMOVED_REPORT_FLAGS[0].flags))
    .addOption(removedOption(REMOVED_REPORT_FLAGS[1].entry, REMOVED_REPORT_FLAGS[1].flags))
    .addOption(removedOption(REMOVED_REPORT_FLAGS[2].entry, REMOVED_REPORT_FLAGS[2].flags));
}

/**
 * The session counts over the sessions the report keeps: a dropped empty session is priced in neither
 * count. The total cost stays the source's: a dropped session has no tokens, so no cost.
 */
function keptCostSummary(summary: CostSummary, index: SessionCostIndex, analytics: RootAnalytics): CostSummary {
  const kept = new Set(analytics.projects.flatMap((p) => p.branches.flatMap((b) => b.sessions.map((s) => s.sessionId))));
  const priced = [...kept].filter((id) => index.get(id)?.priced === true);
  return {
    ...summary,
    pricedSessions: priced.length,
    totalSessions: kept.size,
  };
}

export async function runAnalytics(options: AnalyticsOptions, source: AnalyticsSource): Promise<void> {
  try {
    // `--report*` are removed stubs: using one already failed (exitCode 1, naming the replacement).
    if (usedRemovedReportFlag(options)) return;
    const output = options.output;
    const exportOpt = options.export;

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
    formatter.displayCost(keptCostSummary(costResult.summary, costResult.index, analytics));

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
    process.exitCode = 1;
  }
}

/** Commander binds a removed `--report*` stub's value under its camelCase name. */
function usedRemovedReportFlag(options: AnalyticsOptions): boolean {
  const bag = options as unknown as Record<string, unknown>;
  return ['report', 'reportFormat', 'reportOutput'].some((k) => bag[k] !== undefined);
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
    const fromDate = parseDateOnly(options.from, 'from');
    if (!fromDate) {
      throw new ConfigurationError(`Invalid --from date "${options.from}" — use YYYY-MM-DD (UTC)`);
    }
    filter.fromDate = fromDate;
  }

  if (options.to) {
    const toDate = parseDateOnly(options.to, 'to');
    if (!toDate) {
      throw new ConfigurationError(`Invalid --to date "${options.to}" — use YYYY-MM-DD (UTC)`);
    }
    filter.toDate = toDate;
  }

  // Parse --last duration (e.g., "7d", "24h")
  if (options.last) {
    const duration = parseDuration(options.last);
    if (!duration) {
      throw new ConfigurationError(`Invalid --last duration "${options.last}" — use a number and a unit, e.g. 7d, 24h, 30m`);
    }
    filter.fromDate = new Date(Date.now() - duration);
    filter.toDate = new Date();
  }

  return filter;
}

