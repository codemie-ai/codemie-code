/**
 * Log filter engine - Chainable filtering for log entries
 */

import type { LogEntry, LogFilter, LogLevel } from './types.js';

/**
 * Chainable filter engine for log entries
 */
export class LogFilterEngine {
  private filters: Array<(entry: LogEntry) => boolean> = [];

  /**
   * Filter by session ID
   */
  bySession(sessionId: string): this {
    this.filters.push(entry => entry.sessionId === sessionId);
    return this;
  }

  /**
   * Filter by agent name
   */
  byAgent(agent: string): this {
    this.filters.push(entry => entry.agent === agent);
    return this;
  }

  /**
   * Filter by profile name
   */
  byProfile(profile: string): this {
    this.filters.push(entry => entry.profile === profile);
    return this;
  }

  /**
   * Filter by log level (includes specified level and above)
   */
  byLevel(level: LogLevel): this {
    const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const filterLevel = levels[level] || 0;

    this.filters.push(entry => {
      const entryLevel = levels[entry.level] || 0;
      return entryLevel >= filterLevel;
    });

    return this;
  }

  /**
   * Filter by date range
   */
  byDateRange(from?: Date, to?: Date): this {
    if (from) {
      this.filters.push(entry => entry.timestamp >= from);
    }
    if (to) {
      this.filters.push(entry => entry.timestamp <= to);
    }
    return this;
  }

  /**
   * Filter by pattern (string or regex)
   */
  byPattern(pattern: string, isRegex = false): this {
    if (isRegex) {
      try {
        const regex = new RegExp(pattern, 'i');
        this.filters.push(entry => {
          const searchText = `${entry.agent} ${entry.message}`;
          return regex.test(searchText);
        });
      } catch {
        // Invalid regex, fallback to string search
        this.filters.push(entry => {
          const searchText = `${entry.agent} ${entry.message}`.toLowerCase();
          return searchText.includes(pattern.toLowerCase());
        });
      }
    } else {
      this.filters.push(entry => {
        const searchText = `${entry.agent} ${entry.message}`.toLowerCase();
        return searchText.includes(pattern.toLowerCase());
      });
    }
    return this;
  }

  /**
   * Apply all filters to an entry
   */
  apply(entry: LogEntry): boolean {
    return this.filters.every(filter => filter(entry));
  }

  /**
   * Apply filters to an array of entries
   */
  applyAll(entries: LogEntry[]): LogEntry[] {
    return entries.filter(entry => this.apply(entry));
  }

  /**
   * Create filter from LogFilter object
   */
  static fromFilter(filter?: LogFilter): LogFilterEngine {
    const engine = new LogFilterEngine();

    if (!filter) return engine;

    if (filter.sessionId) engine.bySession(filter.sessionId);
    if (filter.agent) engine.byAgent(filter.agent);
    if (filter.profile) engine.byProfile(filter.profile);
    if (filter.level) engine.byLevel(filter.level);
    if (filter.fromDate || filter.toDate) engine.byDateRange(filter.fromDate, filter.toDate);
    if (filter.pattern) engine.byPattern(filter.pattern, filter.isRegex);

    return engine;
  }

  /**
   * Check if filter has any active filters
   */
  hasFilters(): boolean {
    return this.filters.length > 0;
  }

  /**
   * Get count of active filters
   */
  getFilterCount(): number {
    return this.filters.length;
  }
}
