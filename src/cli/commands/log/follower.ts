/**
 * Log follower - Real-time log following (tail -f style)
 */

import { watch, statSync } from 'fs';
import type { FSWatcher } from 'fs';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { parseLogLine } from './parser.js';
import { LogFormatter } from './formatter.js';
import type { LogFilter, LogEntry } from './types.js';

/**
 * Follow logs in real-time
 */
export class LogFollower {
  private watcher: FSWatcher | null = null;
  private lastPosition = 0;
  private formatter: LogFormatter;
  private filter?: LogFilter;

  constructor(formatter: LogFormatter, filter?: LogFilter) {
    this.formatter = formatter;
    this.filter = filter;
  }

  /**
   * Start following log file
   */
  async follow(logFilePath: string): Promise<void> {
    // Read existing content first
    await this.readNewLines(logFilePath, true);

    // Watch for changes
    this.watcher = watch(logFilePath, async (eventType) => {
      if (eventType === 'change') {
        await this.readNewLines(logFilePath, false);
      }
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      this.stop();
      console.log('\nStopped following logs');
      process.exit(0);
    });

    // Keep process alive
    return new Promise(() => {
      // Never resolves - runs until interrupted
    });
  }

  /**
   * Read new lines from log file
   */
  private async readNewLines(logFilePath: string, _isInitial: boolean): Promise<void> {
    try {
      const stats = statSync(logFilePath);
      const currentSize = stats.size;

      // If file was truncated, reset position
      if (currentSize < this.lastPosition) {
        this.lastPosition = 0;
      }

      // Read from last position
      if (currentSize > this.lastPosition) {
        const entries = await this.readFromPosition(logFilePath, this.lastPosition);

        // Apply filter
        const filtered = this.filter
          ? entries.filter(entry => this.matchesFilter(entry))
          : entries;

        // Output entries
        for (const entry of filtered) {
          console.log(this.formatter['formatLogEntry'](entry));
        }

        this.lastPosition = currentSize;
      }
    } catch {
      // File might not exist yet or can't be read
    }
  }

  /**
   * Read log file from specific position
   */
  private async readFromPosition(logFilePath: string, start: number): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

    try {
      const fileStream = createReadStream(logFilePath, { start });
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        const entry = parseLogLine(line);
        if (entry) {
          entries.push(entry);
        }
      }
    } catch {
      // Error reading file
    }

    return entries;
  }

  /**
   * Check if entry matches filter
   */
  private matchesFilter(entry: LogEntry): boolean {
    if (!this.filter) return true;

    if (this.filter.sessionId && entry.sessionId !== this.filter.sessionId) {
      return false;
    }

    if (this.filter.agent && entry.agent !== this.filter.agent) {
      return false;
    }

    if (this.filter.profile && entry.profile !== this.filter.profile) {
      return false;
    }

    if (this.filter.level) {
      const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
      const entryLevel = levels[entry.level] || 0;
      const filterLevel = levels[this.filter.level] || 0;
      if (entryLevel < filterLevel) {
        return false;
      }
    }

    if (this.filter.pattern) {
      const searchText = `${entry.agent} ${entry.message}`.toLowerCase();
      if (this.filter.isRegex) {
        try {
          const regex = new RegExp(this.filter.pattern, 'i');
          if (!regex.test(searchText)) {
            return false;
          }
        } catch {
          if (!searchText.includes(this.filter.pattern.toLowerCase())) {
            return false;
          }
        }
      } else {
        if (!searchText.includes(this.filter.pattern.toLowerCase())) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Stop following
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
