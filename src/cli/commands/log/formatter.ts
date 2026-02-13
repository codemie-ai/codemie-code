/**
 * Log formatter - Output formatting for logs and sessions
 */

import chalk from 'chalk';
import type { LogEntry, SessionMetadata, SessionListEntry, OutputFormat, CleanupStats } from './types.js';

/**
 * Format log entries for console output
 */
export class LogFormatter {
  private format: OutputFormat;

  constructor(format?: Partial<OutputFormat>) {
    this.format = {
      format: format?.format || 'text',
      colorize: format?.colorize ?? true,
      verbose: format?.verbose ?? false
    };
  }

  /**
   * Format log entries as text
   */
  formatText(entries: LogEntry[]): string {
    if (entries.length === 0) {
      return this.colorize(chalk.yellow('\nNo logs found matching the specified criteria.\n'));
    }

    const lines: string[] = [];

    for (const entry of entries) {
      lines.push(this.formatLogEntry(entry));
    }

    return lines.join('\n');
  }

  /**
   * Format a single log entry
   * Returns the raw log line exactly as written to the file
   */
  private formatLogEntry(entry: LogEntry): string {
    // Return raw line without transformation to preserve all metadata
    // (timestamp, level, agent, session ID, profile, context like [hook], etc.)
    return entry.rawLine;
  }

  /**
   * Format timestamp
   */
  private formatTimestamp(date: Date): string {
    const timeStr = date.toISOString();
    return this.colorize(chalk.dim(timeStr));
  }

  /**
   * Format log level with color
   */
  private formatLevel(level: string): string {
    const levelUpper = level.toUpperCase().padEnd(5);

    switch (level) {
      case 'error':
        return this.colorize(chalk.red(levelUpper));
      case 'warn':
        return this.colorize(chalk.yellow(levelUpper));
      case 'info':
        return this.colorize(chalk.green(levelUpper));
      case 'debug':
      default:
        return this.colorize(chalk.blue(levelUpper));
    }
  }

  /**
   * Format log entries as JSON
   */
  formatJSON(entries: LogEntry[]): string {
    const formatted = entries.map(entry => ({
      timestamp: entry.timestamp.toISOString(),
      level: entry.level,
      agent: entry.agent,
      sessionId: entry.sessionId,
      profile: entry.profile,
      message: entry.message
    }));

    return JSON.stringify(formatted, null, 2);
  }

  /**
   * Format log entries as JSONL
   */
  formatJSONL(entries: LogEntry[]): string {
    const lines = entries.map(entry => {
      const obj = {
        timestamp: entry.timestamp.toISOString(),
        level: entry.level,
        agent: entry.agent,
        sessionId: entry.sessionId,
        profile: entry.profile,
        message: entry.message
      };
      return JSON.stringify(obj);
    });

    return lines.join('\n');
  }

  /**
   * Format session metadata for display
   */
  formatSession(session: SessionMetadata, conversation?: Array<Record<string, unknown>>): string {
    const lines: string[] = [];

    lines.push(this.colorize(chalk.bold.cyan('\nSession Details\n')));

    lines.push(this.formatKeyValue('Session ID', session.sessionId));
    lines.push(this.formatKeyValue('Agent', session.agentName));
    lines.push(this.formatKeyValue('Provider', session.provider));
    lines.push(this.formatKeyValue('Status', this.formatStatus(session.status)));
    lines.push(this.formatKeyValue('Working Directory', session.workingDirectory));

    if (session.gitBranch) {
      lines.push(this.formatKeyValue('Git Branch', session.gitBranch));
    }

    lines.push(this.formatKeyValue('Start Time', new Date(session.startTime).toISOString()));

    if (session.endTime) {
      lines.push(this.formatKeyValue('End Time', new Date(session.endTime).toISOString()));
      const duration = this.formatDuration(session.endTime - session.startTime);
      lines.push(this.formatKeyValue('Duration', duration));
    } else {
      lines.push(this.formatKeyValue('Duration', 'In progress'));
    }

    if (conversation && conversation.length > 0) {
      lines.push('');
      lines.push(this.colorize(chalk.bold.cyan('Conversation Summary\n')));
      lines.push(this.formatKeyValue('Total Turns', conversation.length.toString()));
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Format session list as table
   */
  formatSessionList(sessions: SessionListEntry[]): string {
    if (sessions.length === 0) {
      return this.colorize(chalk.yellow('\nNo sessions found.\n'));
    }

    const lines: string[] = [];
    lines.push(this.colorize(chalk.bold.cyan('\nSessions\n')));

    // Table header
    const header = this.colorize(chalk.bold(
      'SESSION ID        AGENT       START TIME            DURATION    STATUS      DIRECTORY'
    ));
    lines.push(header);
    lines.push(this.colorize(chalk.dim('─'.repeat(120))));

    // Table rows
    for (const session of sessions) {
      const id = session.sessionId.substring(0, 16).padEnd(16);
      const agent = session.agentName.padEnd(11);
      const startTime = session.startTime.toISOString().padEnd(21);
      const duration = session.duration
        ? this.formatDuration(session.duration).padEnd(11)
        : 'in progress'.padEnd(11);
      const status = this.formatStatus(session.status).padEnd(11);
      const dir = this.truncatePath(session.workingDirectory, 40);

      lines.push(`${id} ${agent} ${startTime} ${duration} ${status} ${dir}`);
    }

    lines.push('');
    lines.push(this.colorize(chalk.dim(`Total: ${sessions.length} session(s)`)));
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Format cleanup statistics
   */
  formatCleanupStats(stats: CleanupStats, isDryRun: boolean): string {
    const lines: string[] = [];

    const title = isDryRun
      ? this.colorize(chalk.bold.yellow('\nCleanup Preview (Dry Run)\n'))
      : this.colorize(chalk.bold.green('\nCleanup Complete\n'));

    lines.push(title);

    lines.push(this.formatKeyValue('Debug Logs Deleted', stats.debugLogsDeleted.toString()));
    lines.push(this.formatKeyValue('Sessions Deleted', stats.sessionsDeleted.toString()));
    lines.push(this.formatKeyValue('Space Freed', this.formatBytes(stats.bytesFreed)));

    if (stats.oldestFileDate) {
      lines.push(this.formatKeyValue('Oldest File Date', stats.oldestFileDate.toISOString().split('T')[0]));
    }

    if (stats.newestFileDate) {
      lines.push(this.formatKeyValue('Newest File Date', stats.newestFileDate.toISOString().split('T')[0]));
    }

    if (isDryRun) {
      lines.push('');
      lines.push(this.colorize(chalk.yellow('Run without --dry-run to perform actual cleanup.')));
    }

    lines.push('');

    return lines.join('\n');
  }

  /**
   * Format key-value pair
   */
  private formatKeyValue(key: string, value: string): string {
    const keyFormatted = this.colorize(chalk.bold(key.padEnd(20)));
    return `${keyFormatted}: ${value}`;
  }

  /**
   * Format status with color
   */
  private formatStatus(status: string): string {
    switch (status) {
      case 'completed':
        return this.colorize(chalk.green(status));
      case 'failed':
        return this.colorize(chalk.red(status));
      case 'active':
        return this.colorize(chalk.yellow(status));
      default:
        return status;
    }
  }

  /**
   * Format duration in milliseconds to human-readable string
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * Truncate path to max length
   */
  private truncatePath(path: string, maxLength: number): string {
    if (path.length <= maxLength) return path;
    return '...' + path.substring(path.length - maxLength + 3);
  }

  /**
   * Apply colorization conditionally
   */
  private colorize(text: string): string {
    return this.format.colorize ? text : this.stripAnsi(text);
  }

  /**
   * Strip ANSI color codes
   */
  private stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[\d+m/g, '');
  }
}
