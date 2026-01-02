import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeLogArgs } from './sanitize.js';
import { getCodemiePath } from './codemie-home.js';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

export interface LogContext {
  agent?: string;
  sessionId?: string;
  profile?: string;
  provider?: string;
  model?: string;
}

class Logger {
  private sessionId: string = ''; // Will be set by agent
  private agentName: string | null = null;
  private profileName: string | null = null;
  private logFilePath: string | null = null;
  private logFileInitialized = false;
  private writeStream: fs.WriteStream | null = null;

  constructor() {}

  /**
   * Set agent name for log formatting
   */
  setAgentName(name: string): void {
    this.agentName = name;
  }

  /**
   * Get agent name
   */
  getAgentName(): string | null {
    return this.agentName;
  }

  /**
   * Set profile name for log formatting
   */
  setProfileName(name: string): void {
    this.profileName = name;
  }

  /**
   * Get profile name
   */
  getProfileName(): string | null {
    return this.profileName;
  }

  /**
   * Initialize log file path and create write stream
   * Log file format: ~/.codemie/logs/debug-YYYY-MM-DD.log
   * Also performs cleanup of old log files (older than 5 days)
   */
  private initializeLogFile(): void {
    if (this.logFileInitialized) return;

    try {
      const logsDir = getCodemiePath('logs');

      // Create directory synchronously
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      // Clean up old log files (older than 5 days)
      this.cleanupOldLogs(logsDir);

      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      this.logFilePath = path.join(logsDir, `debug-${today}.log`);

      // Create write stream with append mode
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });

      this.logFileInitialized = true;
    } catch {
      // If we can't create log directory, disable file logging
      this.logFilePath = null;
      this.writeStream = null;
      this.logFileInitialized = true;
    }
  }

  /**
   * Remove log files older than 5 days
   * Runs synchronously during logger initialization
   */
  private cleanupOldLogs(logsDir: string): void {
    try {
      const files = fs.readdirSync(logsDir);
      const now = Date.now();
      const fiveDaysAgo = now - (5 * 24 * 60 * 60 * 1000); // 5 days in milliseconds

      for (const file of files) {
        // Only process debug log files with date pattern
        if (!file.match(/^debug-\d{4}-\d{2}-\d{2}\.log$/)) {
          continue;
        }

        const filePath = path.join(logsDir, file);
        const stats = fs.statSync(filePath);

        // Delete if older than 5 days
        if (stats.mtimeMs < fiveDaysAgo) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // Silently fail - cleanup is not critical
    }
  }

  /**
   * Write a log entry to the debug log file (synchronous)
   * Format: [YYYY-MM-DD HH:MM:SS.mmm] [LEVEL] [AGENT] [SESSION_ID] [PROFILE] message
   * Automatically sanitizes sensitive data before writing
   * Always writes to file regardless of debug mode
   */
  private writeToLogFile(level: string, message: string, ...args: unknown[]): void {
    if (!this.logFileInitialized) {
      this.initializeLogFile();
    }

    if (!this.writeStream) return;

    try {
      const timestamp = new Date().toISOString();

      // Build log prefix using agent/session/profile set at startup
      const agentName = this.agentName || 'system';

      let prefix = `[${timestamp}] [${level.toUpperCase()}] [${agentName}] [${this.sessionId}]`;

      // Add profile if set
      if (this.profileName) {
        prefix += ` [${this.profileName}]`;
      }

      // Sanitize args before writing to file
      const sanitizedArgs = sanitizeLogArgs(...args);

      const argsStr = sanitizedArgs.length > 0 ? ' ' + sanitizedArgs.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      ).join(' ') : '';
      const logEntry = `${prefix} ${message}${argsStr}\n`;

      this.writeStream.write(logEntry);
    } catch {
      // Silently fail if we can't write to log file
    }
  }

  /**
   * Flush and close the write stream
   */
  close(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  /**
   * Set the session ID (used when agent initializes with a specific session ID)
   * @param sessionId - The session ID to use
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Get the current session ID (UUID)
   * @returns Session ID (always available)
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Check if debug mode is enabled
   * Debug mode controls console output visibility, not file logging
   * @returns true if CODEMIE_DEBUG environment variable is set to 'true' or '1'
   */
  isDebugMode(): boolean {
    return process.env.CODEMIE_DEBUG === 'true' || process.env.CODEMIE_DEBUG === '1';
  }

  /**
   * Get the current log file path
   * @returns Log file path or null if not initialized/disabled
   */
  getLogFilePath(): string | null {
    if (!this.logFileInitialized) {
      this.initializeLogFile();
    }
    return this.logFilePath;
  }

  debug(message: string, ...args: unknown[]): void {

    // Only console output when CODEMIE_DEBUG is enabled
    if (this.isDebugMode()) {
      // Write to log file
      this.writeToLogFile('debug', message, ...args);
      // Build console prefix using agent/session/profile set at startup
      const agentName = this.agentName || 'system';

      let prefix = `[DEBUG] [${agentName}] [${this.sessionId}]`;

      // Add profile if set
      if (this.profileName) {
        prefix += ` [${this.profileName}]`;
      }

      console.log(chalk.dim(`${prefix} ${message}`), ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    // Always write to log file
    this.writeToLogFile('info', message, ...args);
  }

  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green(`✓ ${message}`), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    // Always write to log file
    this.writeToLogFile('warn', message, ...args);
  }

  error(message: string, error?: Error | unknown): void {
    let errorDetails = '';
    if (error) {
      if (error instanceof Error) {
        errorDetails = error.message;
        if (error.stack) {
          errorDetails += `\n${error.stack}`;
        }
      } else {
        errorDetails = String(error);
      }
    }

    // Always write to log file
    this.writeToLogFile('error', message, errorDetails);

    if (this.isDebugMode()) {
        // Console output
        console.error(chalk.red(`✗ ${message}`));
        if (error) {
            if (error instanceof Error) {
                console.error(chalk.red(error.message));
                if (error.stack) {
                    console.error(chalk.white(error.stack));
                }
            } else {
                console.error(chalk.red(String(error)));
            }
        }
    }
  }
}

export const logger = new Logger();
