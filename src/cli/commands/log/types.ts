/**
 * Log command types and interfaces
 */

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Parsed log entry from debug log file
 */
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  agent: string;
  sessionId: string;
  profile: string | null;
  message: string;
  rawLine: string;
}

/**
 * Session metadata from session JSON file
 */
export interface SessionMetadata {
  sessionId: string;
  agentName: string;
  provider: string;
  startTime: number;
  endTime?: number;
  status: 'active' | 'completed' | 'failed';
  workingDirectory: string;
  gitBranch?: string;
}

/**
 * Filter options for log queries
 */
export interface LogFilter {
  sessionId?: string;
  agent?: string;
  profile?: string;
  level?: LogLevel;
  fromDate?: Date;
  toDate?: Date;
  pattern?: string;
  isRegex?: boolean;
}

/**
 * Log command options (from commander)
 */
export interface LogOptions {
  session?: string;
  agent?: string;
  profile?: string;
  level?: string;
  from?: string;
  to?: string;
  last?: string;
  grep?: string;
  lines?: number;
  verbose?: boolean;
  format?: 'text' | 'json' | 'jsonl';
  noColor?: boolean;
  output?: string;
  // Clean command options
  days?: number;
  sessions?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  // List-sessions options
  sort?: 'time' | 'duration' | 'agent';
  reverse?: boolean;
}

/**
 * Output format options
 */
export interface OutputFormat {
  format: 'text' | 'json' | 'jsonl';
  colorize: boolean;
  verbose: boolean;
}

/**
 * Cleanup statistics
 */
export interface CleanupStats {
  debugLogsDeleted: number;
  sessionsDeleted: number;
  bytesFreed: number;
  oldestFileDate?: Date;
  newestFileDate?: Date;
}

/**
 * Session list entry (for list-sessions command)
 */
export interface SessionListEntry {
  sessionId: string;
  agentName: string;
  startTime: Date;
  duration?: number;
  status: string;
  workingDirectory: string;
  gitBranch?: string;
}
