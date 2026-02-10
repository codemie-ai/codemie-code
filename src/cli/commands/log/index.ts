/**
 * Log command - View and manage logs and sessions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'fs';
import { LogReader, SessionReader } from './reader.js';
import { LogFormatter } from './formatter.js';
import { LogFollower } from './follower.js';
import { LogCleaner } from './cleaner.js';
import type { LogOptions, LogFilter, SessionListEntry } from './types.js';
import { logger } from '../../../utils/logger.js';

export function createLogCommand(): Command {
  const command = new Command('log');

  command
    .description('View and manage debug logs and sessions')
    .option('--session <id>', 'Filter by session ID')
    .option('--agent <name>', 'Filter by agent (claude, gemini, etc.)')
    .option('--profile <name>', 'Filter by profile name')
    .option('--level <level>', 'Filter by log level (debug, info, warn, error)')
    .option('--from <date>', 'Filter from date (YYYY-MM-DD)')
    .option('--to <date>', 'Filter to date (YYYY-MM-DD)')
    .option('--last <duration>', 'Filter last duration (e.g., 7d, 24h, 30m)')
    .option('--grep <pattern>', 'Search pattern (supports regex)')
    .option('-n, --lines <number>', 'Number of lines to show (default: 50)', '50')
    .option('-v, --verbose', 'Show full details including session IDs and profiles')
    .option('--format <format>', 'Output format (text, json, jsonl)', 'text')
    .option('--no-color', 'Disable color output')
    .option('-o, --output <path>', 'Write to file instead of stdout')
    .action(async (options: LogOptions) => {
      try {
        await viewDebugLogs(options);
      } catch (error) {
        logger.error('Log command failed:', error);
        console.error(chalk.red(`\n✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  // Subcommand: debug (alias for default behavior)
  const debugCommand = new Command('debug');
  debugCommand
    .description('View debug logs (same as default log command)')
    .option('--session <id>', 'Filter by session ID')
    .option('--agent <name>', 'Filter by agent')
    .option('--profile <name>', 'Filter by profile')
    .option('--level <level>', 'Filter by log level')
    .option('--from <date>', 'Filter from date')
    .option('--to <date>', 'Filter to date')
    .option('--last <duration>', 'Filter last duration')
    .option('--grep <pattern>', 'Search pattern')
    .option('-n, --lines <number>', 'Number of lines', '50')
    .option('-v, --verbose', 'Show full details')
    .option('--format <format>', 'Output format', 'text')
    .option('--no-color', 'Disable color')
    .option('-o, --output <path>', 'Output file')
    .action(async (options: LogOptions) => {
      try {
        await viewDebugLogs(options);
      } catch (error) {
        logger.error('Debug log command failed:', error);
        console.error(chalk.red(`\n✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  command.addCommand(debugCommand);

  // Subcommand: session <id>
  const sessionCommand = new Command('session');
  sessionCommand
    .description('View specific session details')
    .argument('<id>', 'Session ID')
    .option('-v, --verbose', 'Show conversation details')
    .option('--format <format>', 'Output format (text, json)', 'text')
    .option('--no-color', 'Disable color')
    .action(async (sessionId: string, options: LogOptions) => {
      try {
        await viewSession(sessionId, options);
      } catch (error) {
        logger.error('Session view failed:', error);
        console.error(chalk.red(`\n✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  command.addCommand(sessionCommand);

  // Subcommand: list-sessions
  const listSessionsCommand = new Command('list-sessions');
  listSessionsCommand
    .description('List all sessions')
    .option('--agent <name>', 'Filter by agent')
    .option('--from <date>', 'Filter from date')
    .option('--to <date>', 'Filter to date')
    .option('--last <duration>', 'Filter last duration')
    .option('--sort <field>', 'Sort by field (time, duration, agent)', 'time')
    .option('--reverse', 'Reverse sort order')
    .option('--format <format>', 'Output format (text, json)', 'text')
    .option('--no-color', 'Disable color')
    .action(async (options: LogOptions) => {
      try {
        await listSessions(options);
      } catch (error) {
        logger.error('List sessions failed:', error);
        console.error(chalk.red(`\n✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  command.addCommand(listSessionsCommand);

  // Subcommand: follow
  const followCommand = new Command('follow');
  followCommand
    .description('Follow logs in real-time (tail -f style)')
    .option('--agent <name>', 'Filter by agent')
    .option('--level <level>', 'Filter by log level')
    .option('--grep <pattern>', 'Search pattern')
    .option('-v, --verbose', 'Show full details')
    .option('--no-color', 'Disable color')
    .action(async (options: LogOptions) => {
      try {
        await followLogs(options);
      } catch (error) {
        logger.error('Follow logs failed:', error);
        console.error(chalk.red(`\n✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  command.addCommand(followCommand);

  // Subcommand: clean
  const cleanCommand = new Command('clean');
  cleanCommand
    .description('Clean up old logs and sessions')
    .option('--days <number>', 'Retention period in days (default: 5)', '5')
    .option('--sessions', 'Also delete old sessions (not just debug logs)')
    .option('--dry-run', 'Preview what would be deleted without actually deleting')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (options: LogOptions) => {
      try {
        await cleanLogs(options);
      } catch (error) {
        logger.error('Clean logs failed:', error);
        console.error(chalk.red(`\n✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  command.addCommand(cleanCommand);

  return command;
}

/**
 * View debug logs
 */
async function viewDebugLogs(options: LogOptions): Promise<void> {
  const filter = parseFilterOptions(options);
  const maxLines = parseInt(String(options.lines || '50'), 10);

  // Read logs
  const reader = new LogReader();
  const entries = await reader.readLogs(filter, maxLines);

  // Format output
  const formatter = new LogFormatter({
    format: (options.format as 'text' | 'json' | 'jsonl') || 'text',
    colorize: options.noColor !== true,
    verbose: options.verbose || false
  });

  let output: string;
  switch (options.format) {
    case 'json':
      output = formatter.formatJSON(entries);
      break;
    case 'jsonl':
      output = formatter.formatJSONL(entries);
      break;
    default:
      output = formatter.formatText(entries);
  }

  // Output to file or stdout
  if (options.output) {
    writeFileSync(options.output, output);
    console.log(chalk.green(`\n✓ Logs written to ${options.output}\n`));
  } else {
    console.log(output);
  }
}

/**
 * View specific session details
 */
async function viewSession(sessionId: string, options: LogOptions): Promise<void> {
  const reader = new SessionReader();

  // Read session metadata
  const session = reader.readSession(sessionId);
  if (!session) {
    console.error(chalk.red(`\n✗ Session not found: ${sessionId}\n`));
    process.exit(1);
  }

  // Read conversation if verbose
  const conversation = options.verbose ? reader.readSessionConversation(sessionId) : undefined;

  // Format output
  const formatter = new LogFormatter({
    format: (options.format as 'text' | 'json') || 'text',
    colorize: options.noColor !== true,
    verbose: options.verbose || false
  });

  if (options.format === 'json') {
    const output = JSON.stringify({ session, conversation }, null, 2);
    console.log(output);
  } else {
    const output = formatter.formatSession(session, conversation);
    console.log(output);
  }
}

/**
 * List all sessions
 */
async function listSessions(options: LogOptions): Promise<void> {
  const filter = parseFilterOptions(options);
  const reader = new SessionReader();

  // Read sessions
  let sessions = reader.listSessions(filter);

  // Convert to list entries
  const entries: SessionListEntry[] = sessions.map(s => ({
    sessionId: s.sessionId,
    agentName: s.agentName,
    startTime: new Date(s.startTime),
    duration: s.endTime ? s.endTime - s.startTime : undefined,
    status: s.status,
    workingDirectory: s.workingDirectory,
    gitBranch: s.gitBranch
  }));

  // Sort
  const sortField = options.sort || 'time';
  entries.sort((a, b) => {
    let comparison = 0;
    switch (sortField) {
      case 'duration':
        comparison = (a.duration || 0) - (b.duration || 0);
        break;
      case 'agent':
        comparison = a.agentName.localeCompare(b.agentName);
        break;
      case 'time':
      default:
        comparison = a.startTime.getTime() - b.startTime.getTime();
    }
    return options.reverse ? -comparison : comparison;
  });

  // Format output
  const formatter = new LogFormatter({
    format: (options.format as 'text' | 'json') || 'text',
    colorize: options.noColor !== true,
    verbose: false
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    const output = formatter.formatSessionList(entries);
    console.log(output);
  }
}

/**
 * Follow logs in real-time
 */
async function followLogs(options: LogOptions): Promise<void> {
  const filter = parseFilterOptions(options);
  const reader = new LogReader();

  const logFile = reader.getMostRecentLogFile();
  if (!logFile) {
    console.error(chalk.red('\n✗ No log file found for today\n'));
    console.error(chalk.dim('Debug logs are created when agents run.\n'));
    process.exit(1);
  }

  const formatter = new LogFormatter({
    format: 'text',
    colorize: options.noColor !== true,
    verbose: options.verbose || false
  });

  console.log(chalk.cyan(`\nFollowing logs: ${logFile}`));
  console.log(chalk.dim('Press Ctrl+C to stop\n'));

  const follower = new LogFollower(formatter, filter);
  await follower.follow(logFile);
}

/**
 * Clean old logs
 */
async function cleanLogs(options: LogOptions): Promise<void> {
  const retentionDays = parseInt(String(options.days || '5'), 10);
  const includeSessions = options.sessions || false;
  const dryRun = options.dryRun || false;

  // Confirmation prompt (unless --yes or --dry-run)
  if (!dryRun && !options.yes) {
    console.log(chalk.yellow('\n⚠️  Warning: This will permanently delete files.\n'));
    console.log(`  Retention period: ${retentionDays} days`);
    console.log(`  Debug logs: Will be deleted`);
    console.log(`  Sessions: ${includeSessions ? 'Will be deleted' : 'Will NOT be deleted'}\n`);
    console.log(chalk.dim('Run with --dry-run to preview what would be deleted.\n'));
    console.log(chalk.dim('Run with --yes to skip this confirmation.\n'));

    process.exit(1);
  }

  // Perform cleanup
  const cleaner = new LogCleaner();
  const stats = cleaner.clean(retentionDays, includeSessions, dryRun);

  // Format output
  const formatter = new LogFormatter({ colorize: options.noColor !== true, format: 'text', verbose: false });
  const output = formatter.formatCleanupStats(stats, dryRun);
  console.log(output);
}

/**
 * Parse filter options from command line arguments
 */
function parseFilterOptions(options: LogOptions): LogFilter {
  const filter: LogFilter = {};

  if (options.session) {
    filter.sessionId = options.session;
  }

  if (options.agent) {
    filter.agent = options.agent;
  }

  if (options.profile) {
    filter.profile = options.profile;
  }

  if (options.level) {
    filter.level = options.level as 'debug' | 'info' | 'warn' | 'error';
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
      // Set to end of day (23:59:59.999) to include all entries from that day
      toDate.setHours(23, 59, 59, 999);
      filter.toDate = toDate;
    }
  }

  // Parse --last duration
  if (options.last) {
    const duration = parseDuration(options.last);
    if (!duration) {
      console.warn(chalk.yellow(`Warning: Invalid --last duration "${options.last}", ignoring filter`));
    } else {
      filter.fromDate = new Date(Date.now() - duration);
    }
  }

  // Parse --grep pattern
  if (options.grep) {
    filter.pattern = options.grep;
    filter.isRegex = false; // Simple string search for now
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
 * Parse duration string (e.g., "7d", "24h", "30m") to milliseconds
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
