/**
 * Log reader - Read debug logs and session files
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { getCodemiePath } from '../../../utils/paths.js';
import { parseLogLine, parseSessionMetadata } from './parser.js';
import type { LogEntry, SessionMetadata, LogFilter } from './types.js';

/**
 * Read debug log entries with optional filtering
 */
export class LogReader {
  private logsDir: string;

  constructor(logsDir?: string) {
    this.logsDir = logsDir || getCodemiePath('logs');
  }

  /**
   * Read log entries from specified date range
   * Returns entries in chronological order (oldest first)
   */
  async readLogs(filter?: LogFilter, maxLines?: number): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

    try {
      if (!existsSync(this.logsDir)) {
        return entries;
      }

      // Get list of log files to read
      const logFiles = this.getLogFilesInRange(filter?.fromDate, filter?.toDate);

      // When limiting lines, we need to read from newest files first to ensure we get
      // the most recent entries. We'll read extra files to account for entries being
      // filtered out or spread across files, then sort and take the last N.
      if (maxLines) {
        // Read from newest files first, collecting 3x maxLines to ensure we have enough
        // after filtering and to account for entries spread across multiple files
        const targetEntries = maxLines * 3;
        const reversedFiles = [...logFiles].reverse();

        for (const logFile of reversedFiles) {
          const filePath = join(this.logsDir, logFile);
          const fileEntries = await this.readLogFile(filePath, filter);
          entries.push(...fileEntries);

          // Stop if we have enough entries
          if (entries.length >= targetEntries) {
            break;
          }
        }
      } else {
        // No limit, read all files in order
        for (const logFile of logFiles) {
          const filePath = join(this.logsDir, logFile);
          const fileEntries = await this.readLogFile(filePath, filter);
          entries.push(...fileEntries);
        }
      }

      // Sort all entries by timestamp to maintain chronological order
      entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Apply maxLines limit (take last N entries after sorting)
      if (maxLines && entries.length > maxLines) {
        return entries.slice(-maxLines);
      }

      return entries;
    } catch {
      return entries;
    }
  }

  /**
   * Read a single log file and parse entries
   */
  private async readLogFile(filePath: string, filter?: LogFilter): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

    try {
      const fileStream = createReadStream(filePath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        const entry = parseLogLine(line);
        if (!entry) continue;

        // Apply filters
        if (this.matchesFilter(entry, filter)) {
          entries.push(entry);
        }
      }
    } catch {
      // Skip files that can't be read
    }

    return entries;
  }

  /**
   * Get list of log files that fall within date range
   * Returns files sorted by date (oldest first)
   *
   * Note: Expands date range by ±1 day to catch overnight sessions.
   * Long-running sessions that span midnight may write entries from day N+1
   * into the log file for day N. Entry-level timestamp filtering (in matchesFilter)
   * ensures exact results despite this wider file search.
   */
  private getLogFilesInRange(fromDate?: Date, toDate?: Date): string[] {
    try {
      const files = readdirSync(this.logsDir);

      // Filter debug log files
      const logFiles = files.filter(f => f.match(/^debug-\d{4}-\d{2}-\d{2}\.log$/));

      // If no date filter, return all files
      if (!fromDate && !toDate) {
        return logFiles.sort();
      }

      // Expand date range by ±1 day to catch overnight sessions
      // Entry-level timestamp filtering ensures exact results
      const expandedFromDate = fromDate
        ? new Date(fromDate.getTime() - 24 * 60 * 60 * 1000)
        : undefined;
      const expandedToDate = toDate
        ? new Date(toDate.getTime() + 24 * 60 * 60 * 1000)
        : undefined;

      // Filter by date range
      const filtered = logFiles.filter(file => {
        const dateMatch = file.match(/debug-(\d{4}-\d{2}-\d{2})\.log/);
        if (!dateMatch) return false;

        const fileDate = new Date(dateMatch[1]);
        if (isNaN(fileDate.getTime())) return false;

        // Use expanded range for file filtering
        if (expandedFromDate && fileDate < new Date(expandedFromDate.toISOString().split('T')[0])) {
          return false;
        }

        if (expandedToDate && fileDate > new Date(expandedToDate.toISOString().split('T')[0])) {
          return false;
        }

        return true;
      });

      // Sort by date (oldest first)
      return filtered.sort();
    } catch {
      return [];
    }
  }

  /**
   * Check if log entry matches filter criteria
   */
  private matchesFilter(entry: LogEntry, filter?: LogFilter): boolean {
    if (!filter) return true;

    // Filter by session ID
    if (filter.sessionId && entry.sessionId !== filter.sessionId) {
      return false;
    }

    // Filter by agent
    if (filter.agent && entry.agent !== filter.agent) {
      return false;
    }

    // Filter by profile
    if (filter.profile && entry.profile !== filter.profile) {
      return false;
    }

    // Filter by log level (show level and above)
    if (filter.level) {
      const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
      const entryLevel = levels[entry.level] || 0;
      const filterLevel = levels[filter.level] || 0;
      if (entryLevel < filterLevel) {
        return false;
      }
    }

    // Filter by date range
    if (filter.fromDate && entry.timestamp < filter.fromDate) {
      return false;
    }

    if (filter.toDate && entry.timestamp > filter.toDate) {
      return false;
    }

    // Filter by pattern
    if (filter.pattern) {
      const searchText = `${entry.agent} ${entry.message}`.toLowerCase();
      if (filter.isRegex) {
        try {
          const regex = new RegExp(filter.pattern, 'i');
          if (!regex.test(searchText)) {
            return false;
          }
        } catch {
          // Invalid regex, fallback to string search
          if (!searchText.includes(filter.pattern.toLowerCase())) {
            return false;
          }
        }
      } else {
        if (!searchText.includes(filter.pattern.toLowerCase())) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Get the most recent log file path
   */
  getMostRecentLogFile(): string | null {
    try {
      const today = new Date().toISOString().split('T')[0];
      const logFile = join(this.logsDir, `debug-${today}.log`);
      return existsSync(logFile) ? logFile : null;
    } catch {
      return null;
    }
  }
}

/**
 * Read session metadata and related files
 */
export class SessionReader {
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir || getCodemiePath('sessions');
  }

  /**
   * Read a single session's metadata
   */
  readSession(sessionId: string): SessionMetadata | null {
    try {
      // Try regular session file first
      let sessionFile = join(this.sessionsDir, `${sessionId}.json`);

      // If not found, try completed session file
      if (!existsSync(sessionFile)) {
        sessionFile = join(this.sessionsDir, `completed_${sessionId}.json`);
        if (!existsSync(sessionFile)) {
          return null;
        }
      }

      const content = readFileSync(sessionFile, 'utf-8');
      return parseSessionMetadata(content);
    } catch {
      return null;
    }
  }

  /**
   * List all sessions with optional filtering
   */
  listSessions(filter?: LogFilter): SessionMetadata[] {
    const sessions: SessionMetadata[] = [];

    try {
      if (!existsSync(this.sessionsDir)) {
        return sessions;
      }

      const files = readdirSync(this.sessionsDir);

      // UUID pattern: 8-4-4-4-12 hexadecimal characters
      const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
      const completedPattern = /^completed_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;

      // Filter to only include actual session files (UUID or completed_UUID)
      // Exclude _metrics.jsonl and _conversation.jsonl files
      const sessionFiles = files.filter(f => {
        // Skip non-JSON files
        if (!f.endsWith('.json')) return false;

        // Skip metric and conversation files
        if (f.includes('_metrics') || f.includes('_conversation')) return false;

        // Only include UUID pattern or completed_UUID pattern
        return uuidPattern.test(f) || completedPattern.test(f);
      });

      for (const file of sessionFiles) {
        const sessionId = file.replace('.json', '').replace('completed_', '');
        const session = this.readSession(sessionId);

        if (!session) continue;

        // Apply filters
        if (this.matchesSessionFilter(session, filter)) {
          sessions.push(session);
        }
      }

      // Sort by start time (newest first)
      sessions.sort((a, b) => b.startTime - a.startTime);
    } catch {
      // Directory doesn't exist or can't be read
    }

    return sessions;
  }

  /**
   * Check if session matches filter criteria
   */
  private matchesSessionFilter(session: SessionMetadata, filter?: LogFilter): boolean {
    if (!filter) return true;

    if (filter.sessionId && session.sessionId !== filter.sessionId) {
      return false;
    }

    if (filter.agent && session.agentName !== filter.agent) {
      return false;
    }

    if (filter.fromDate && session.startTime < filter.fromDate.getTime()) {
      return false;
    }

    if (filter.toDate && session.startTime > filter.toDate.getTime()) {
      return false;
    }

    return true;
  }

  /**
   * Get session conversation (JSONL file)
   */
  readSessionConversation(sessionId: string): Array<Record<string, unknown>> {
    try {
      const conversationFile = join(this.sessionsDir, `${sessionId}_conversation.jsonl`);
      if (!existsSync(conversationFile)) {
        return [];
      }

      const content = readFileSync(conversationFile, 'utf-8');
      const lines = content.trim().split('\n');
      const turns: Array<Record<string, unknown>> = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          turns.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }

      return turns;
    } catch {
      return [];
    }
  }

  /**
   * Get total size of all session files
   */
  getTotalSessionsSize(): number {
    let totalBytes = 0;

    try {
      if (!existsSync(this.sessionsDir)) {
        return 0;
      }

      const files = readdirSync(this.sessionsDir);
      for (const file of files) {
        const filePath = join(this.sessionsDir, file);
        try {
          const stats = statSync(filePath);
          totalBytes += stats.size;
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return totalBytes;
  }
}
