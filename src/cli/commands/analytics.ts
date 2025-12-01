import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadAnalyticsConfig } from '../../analytics/config.js';
import { logger } from '../../utils/logger.js';
import {
  readAnalyticsForLocalDate,
  readAnalyticsForLocalDateRange,
  filterEvents,
  calculateStats,
  exportToCSV,
  exportToJSON,
  listAnalyticsFiles,
  clearOldAnalytics,
  formatFileSize,
  type AnalyticsFilters
} from '../../utils/analytics-reader.js';
import { getLocalToday, getDefaultLocalDateRange, getLocalDateString } from '../../utils/date-formatter.js';
import { AgentRegistry } from '../../agents/registry.js';

export function createAnalyticsCommand(): Command {
  const command = new Command('analytics');

  command
    .description('Analytics management and insights')
    .addCommand(createStatusCommand())
    .addCommand(createStatsCommand())
    .addCommand(createExportCommand())
    .addCommand(createClearCommand());

  return command;
}

function createStatusCommand(): Command {
  const command = new Command('status');

  command
    .description('Show analytics configuration and today\'s statistics')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const config = loadAnalyticsConfig();

        // JSON output
        if (options.json) {
          const today = getLocalToday();
          const todayEvents = await readAnalyticsForLocalDate(today);
          const stats = todayEvents.length > 0 ? calculateStats(todayEvents) : null;

          console.log(JSON.stringify({
            config,
            todayStats: stats
          }, null, 2));
          return;
        }

        // Human-readable output
        console.log(chalk.bold.cyan('\n📊 Analytics Configuration\n'));

        // Configuration
        console.log(chalk.cyan('Status:          ') + (config.enabled ? chalk.green('Enabled') : chalk.red('Disabled')));
        console.log(chalk.cyan('Target:          ') + chalk.white(config.target));
        console.log(chalk.cyan('Local Path:      ') + chalk.white(config.localPath));

        if (config.remoteEndpoint) {
          console.log(chalk.cyan('Remote Endpoint: ') + chalk.white(config.remoteEndpoint));
        }

        console.log(chalk.cyan('Flush Interval:  ') + chalk.white(`${config.flushInterval}ms`));
        console.log(chalk.cyan('Buffer Size:     ') + chalk.white(`${config.maxBufferSize} events`));

        // Today's statistics
        console.log(chalk.bold.cyan('\n📈 Today\'s Statistics\n'));

        const today = getLocalToday();
        const todayEvents = await readAnalyticsForLocalDate(today);

        if (todayEvents.length === 0) {
          console.log(chalk.white('No analytics data for today yet.\n'));
          return;
        }

        const stats = calculateStats(todayEvents);

        console.log(chalk.cyan('Sessions:        ') + chalk.white(stats.totalSessions));
        console.log(chalk.cyan('API Calls:       ') + chalk.white(stats.apiRequests));
        console.log(chalk.cyan('Success Rate:    ') + chalk.white(`${stats.successRate.toFixed(1)}%`));
        console.log(chalk.cyan('Avg Latency:     ') + chalk.white(`${Math.round(stats.avgLatency)}ms`));

        if (Object.keys(stats.agentUsage).length > 0) {
          console.log(chalk.bold.cyan('\nAgent Activity:\n'));
          Object.entries(stats.agentUsage)
            .sort(([, a], [, b]) => b.sessions - a.sessions)
            .slice(0, 5)
            .forEach(([, usage]) => {
              console.log(`  ${chalk.white(usage.displayName.padEnd(20))} ${chalk.white(usage.sessions)} sessions, ${chalk.white(usage.apiCalls)} API calls`);
            });
        }

        console.log();
      } catch (error: unknown) {
        logger.error('Failed to show analytics status:', error);
        process.exit(1);
      }
    });

  return command;
}

function createStatsCommand(): Command {
  const command = new Command('stats');

  const defaultRange = getDefaultLocalDateRange(7);

  command
    .description('Show analytics statistics')
    .option('--from <date>', 'Start date (YYYY-MM-DD, local timezone)', defaultRange.from)
    .option('--to <date>', 'End date (YYYY-MM-DD, local timezone)', defaultRange.to)
    .option('--agent <name>', 'Filter by agent name')
    .action(async (options: { from: string; to: string; agent?: string }) => {
      try {
        // Validate agent filter against registry
        if (options.agent) {
          const agentNames = AgentRegistry.getAgentNames();
          if (!agentNames.includes(options.agent)) {
            const availableAgents = AgentRegistry.getAllAgents()
              .map(a => `${a.name} (${a.displayName})`)
              .join(', ');
            logger.error(`Unknown agent: ${options.agent}`);
            console.log(chalk.yellow(`\nAvailable agents: ${availableAgents}\n`));
            process.exit(1);
          }
        }

        console.log(chalk.bold.cyan('\n📊 Analytics Statistics\n'));
        console.log(chalk.white(`Date Range: ${options.from} to ${options.to} (local timezone)`));
        if (options.agent) {
          const adapter = AgentRegistry.getAgent(options.agent);
          const displayName = adapter?.displayName || options.agent;
          console.log(chalk.white(`Agent: ${displayName}`));
        }
        console.log();

        // Read events using local dates
        const events = await readAnalyticsForLocalDateRange(options.from, options.to);

        if (events.length === 0) {
          console.log(chalk.yellow('No analytics data found for the specified period.\n'));
          return;
        }

        // Apply filters
        const filters: AnalyticsFilters = {};
        if (options.agent) {
          filters.agent = options.agent;
        }
        const filteredEvents = filterEvents(events, filters);

        if (filteredEvents.length === 0) {
          console.log(chalk.yellow('No events match the specified filters.\n'));
          return;
        }

        // Calculate statistics
        const stats = calculateStats(filteredEvents);

        // Display overview
        console.log(chalk.bold.cyan('📋 Overview\n'));
        console.log(chalk.cyan('Sessions:        ') + chalk.white(stats.totalSessions));
        console.log(chalk.cyan('API Calls:       ') + chalk.white(stats.apiRequests));
        if (stats.apiErrors > 0) {
          console.log(chalk.cyan('API Errors:      ') + chalk.red(stats.apiErrors));
        }

        // Display performance
        console.log(chalk.bold.cyan('\n⚡ Performance\n'));
        console.log(chalk.cyan('Avg Latency:     ') + chalk.white(`${Math.round(stats.avgLatency)}ms`));
        console.log(chalk.cyan('Success Rate:    ') + chalk.white(`${stats.successRate.toFixed(1)}%`));

        // Display agent usage
        if (Object.keys(stats.agentUsage).length > 0) {
          console.log(chalk.bold.cyan('\n🤖 Agent Usage\n'));
          const totalApiCalls = Object.values(stats.agentUsage).reduce((sum, usage) => sum + usage.apiCalls, 0);
          Object.entries(stats.agentUsage)
            .sort(([, a], [, b]) => b.apiCalls - a.apiCalls)
            .forEach(([, usage]) => {
              const percentage = totalApiCalls > 0 ? ((usage.apiCalls / totalApiCalls) * 100).toFixed(1) : '0.0';
              console.log(`  ${chalk.white(usage.displayName.padEnd(20))} ${chalk.white(usage.sessions.toString().padStart(3))} sessions  ${chalk.white(usage.apiCalls.toString().padStart(4))} API calls  (${percentage}%)`);
            });
        }

        // Display model usage
        if (Object.keys(stats.modelUsage).length > 0) {
          console.log(chalk.bold.cyan('\n🎯 Model Usage\n'));
          const totalApiCalls = Object.values(stats.modelUsage).reduce((sum, usage) => sum + usage.apiCalls, 0);
          Object.entries(stats.modelUsage)
            .sort(([, a], [, b]) => b.apiCalls - a.apiCalls)
            .slice(0, 10)
            .forEach(([model, usage]) => {
              const percentage = ((usage.apiCalls / totalApiCalls) * 100).toFixed(1);
              console.log(`  ${chalk.white(model.padEnd(30))} ${chalk.white(usage.apiCalls.toString().padStart(4))} calls  (${percentage}%)`);
            });
        }

        console.log();
      } catch (error: unknown) {
        logger.error('Failed to show analytics stats:', error);
        process.exit(1);
      }
    });

  return command;
}

function createExportCommand(): Command {
  const command = new Command('export');

  const defaultRange = getDefaultLocalDateRange(7);

  command
    .description('Export analytics data')
    .option('--format <format>', 'Export format (csv, json)', 'csv')
    .option('--output <path>', 'Output file path', getDefaultExportPath())
    .option('--from <date>', 'Start date (YYYY-MM-DD, local timezone)', defaultRange.from)
    .option('--to <date>', 'End date (YYYY-MM-DD, local timezone)', defaultRange.to)
    .option('--agent <name>', 'Filter by agent name')
    .option('--event-type <type>', 'Filter by event type')
    .action(async (options: {
      format: string;
      output: string;
      from: string;
      to: string;
      agent?: string;
      eventType?: string;
    }) => {
      try {
        // Validate format
        if (!['csv', 'json'].includes(options.format)) {
          logger.error('Invalid format. Use "csv" or "json".');
          process.exit(1);
        }

        // Validate agent filter against registry
        if (options.agent) {
          const agentNames = AgentRegistry.getAgentNames();
          if (!agentNames.includes(options.agent)) {
            const availableAgents = AgentRegistry.getAllAgents()
              .map(a => `${a.name} (${a.displayName})`)
              .join(', ');
            logger.error(`Unknown agent: ${options.agent}`);
            console.log(chalk.yellow(`\nAvailable agents: ${availableAgents}\n`));
            process.exit(1);
          }
        }

        console.log(chalk.bold.cyan('\n📤 Exporting Analytics Data\n'));
        console.log(chalk.white(`Date Range: ${options.from} to ${options.to} (local timezone)`));
        console.log(chalk.white(`Format: ${options.format.toUpperCase()}`));
        if (options.agent) {
          const adapter = AgentRegistry.getAgent(options.agent);
          const displayName = adapter?.displayName || options.agent;
          console.log(chalk.white(`Agent Filter: ${displayName}`));
        }
        if (options.eventType) {
          console.log(chalk.white(`Event Type Filter: ${options.eventType}`));
        }
        console.log();

        // Read events using local dates
        const events = await readAnalyticsForLocalDateRange(options.from, options.to);

        if (events.length === 0) {
          console.log(chalk.yellow('No analytics data found for the specified period.\n'));
          return;
        }

        // Apply filters
        const filters: AnalyticsFilters = {};
        if (options.agent) {
          filters.agent = options.agent;
        }
        if (options.eventType) {
          filters.eventType = options.eventType;
        }
        const filteredEvents = filterEvents(events, filters);

        if (filteredEvents.length === 0) {
          console.log(chalk.yellow('No events match the specified filters.\n'));
          return;
        }

        // Export
        console.log(chalk.white(`Exporting ${filteredEvents.length} analytics records...`));

        if (options.format === 'csv') {
          await exportToCSV(filteredEvents, options.output);
        } else {
          await exportToJSON(filteredEvents, options.output);
        }

        logger.success(`Exported to ${options.output}`);
        console.log(chalk.white(`Total records: ${filteredEvents.length}`));
        console.log();
      } catch (error: unknown) {
        logger.error('Failed to export analytics:', error);
        process.exit(1);
      }
    });

  return command;
}

function createClearCommand(): Command {
  const command = new Command('clear');

  command
    .description('Clear old analytics files')
    .option('--older-than <days>', 'Delete files older than N days', '30')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options: { olderThan: string; yes?: boolean }) => {
      try {
        const days = parseInt(options.olderThan, 10);

        if (isNaN(days) || days < 1) {
          logger.error('Invalid number of days. Must be a positive integer.');
          process.exit(1);
        }

        console.log(chalk.bold.cyan('\n🗑️  Clear Old Analytics\n'));

        // List files that would be deleted
        const files = await listAnalyticsFiles();
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - days);

        const filesToDelete = files.filter(file => new Date(file.date) < threshold);

        if (filesToDelete.length === 0) {
          console.log(chalk.white(`No analytics files older than ${days} days.\n`));
          return;
        }

        const totalSize = filesToDelete.reduce((sum, file) => sum + file.size, 0);

        console.log(chalk.white(`Found ${filesToDelete.length} file(s) older than ${days} days:`));
        console.log();

        filesToDelete.forEach(file => {
          // Display file date (UTC) with local date for reference
          const localDate = getLocalDateString(new Date(file.date + 'T12:00:00.000Z'));
          const dateDisplay = file.date === localDate ? file.date : `${file.date} (local: ${localDate})`;
          console.log(`  ${chalk.white(dateDisplay.padEnd(30))}  ${chalk.white(formatFileSize(file.size).padStart(10))}  ${chalk.white(file.events)} events`);
        });

        console.log();
        console.log(chalk.white(`Total space to be freed: ${formatFileSize(totalSize)}`));
        console.log();

        // Confirm deletion
        if (!options.yes) {
          const { confirm } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: 'Are you sure you want to delete these files?',
              default: false
            }
          ]);

          if (!confirm) {
            console.log(chalk.yellow('\nDeletion cancelled.\n'));
            return;
          }
        }

        // Delete files
        const deletedFiles = await clearOldAnalytics(days);

        logger.success(`Deleted ${deletedFiles.length} file(s)`);
        console.log(chalk.white(`Freed ${formatFileSize(totalSize)}`));
        console.log();
      } catch (error: unknown) {
        logger.error('Failed to clear analytics:', error);
        process.exit(1);
      }
    });

  return command;
}

// Helper functions

function getDefaultExportPath(): string {
  const date = getLocalToday();
  return `analytics-${date}.csv`;
}
