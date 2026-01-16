/**
 * Analytics command - display aggregated metrics from sessions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { MetricsDataLoader } from './data-loader.js';
import { AnalyticsAggregator } from './aggregator.js';
import { AnalyticsFormatter } from './formatter.js';
import { AnalyticsExporter } from './exporter.js';
import type { AnalyticsOptions, AnalyticsFilter } from './types.js';
import { logger } from '../../../utils/logger.js';

export function createAnalyticsCommand(): Command {
  const command = new Command('analytics');

  command
    .description('Display aggregated metrics and analytics from sessions')
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
    .action(async (options: AnalyticsOptions) => {
      try {
        // Parse filter options
        const filter = parseFilterOptions(options);

        // Load data
        const loader = new MetricsDataLoader();
        const rawSessions = loader.loadSessions(filter);

        if (rawSessions.length === 0) {
          console.log(chalk.yellow('\nNo sessions found matching the specified criteria.'));
          console.log(chalk.dim('Run with different filters or check that metrics are being collected.\n'));
          return;
        }

        // Aggregate data (normalize models unless --verbose flag is set)
        const analytics = AnalyticsAggregator.aggregate(rawSessions, !options.verbose);

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

        console.log('');
      } catch (error) {
        logger.error('Analytics command failed:', error);
        console.error(chalk.red(`\n✗ Failed to generate analytics: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  return command;
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
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return null;
    }
    return date;
  } catch {
    return null;
  }
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
