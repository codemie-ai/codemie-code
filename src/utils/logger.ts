import { Console } from 'node:console';
import { Writable } from 'node:stream';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { sanitizeLogArgs } from './security.js';
import { getCodemiePath } from './paths.js';

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
  private currentLogDate: string | null = null;
  private isRotating: boolean = false;
  private consoleSink: Console = console;

  constructor() {}

  /**
   * Send every console-bound level (success, status, notice, debug, error in debug mode)
   * to one stream, e.g. stderr in a process whose stdout is a protocol channel.
   * `null` drops console output entirely, e.g. in a process whose stdout and stderr both
   * belong to another program. The file sink is unaffected.
   */
  setConsoleStream(stream: NodeJS.WritableStream | null): void {
    const target =
      stream ??
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        }
      });
    this.consoleSink = new Console(target, target);
  }

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
      this.currentLogDate = today;

      // Create write stream with append mode
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });

      // createWriteStream opens the file ASYNCHRONOUSLY, so a logs directory that
      // disappears between this call and the open surfaces as an 'error' event —
      // never as a throw the try/catch above can see. With no listener attached
      // Node treats it as an unhandled error and takes the whole process down, so
      // an ephemeral CODEMIE_HOME (a temp dir in tests, a sandbox that cleans up
      // under us) could kill the CLI purely because logging failed. Logging must
      // never be fatal: degrade to console-only instead.
      this.writeStream.on('error', () => {
        this.writeStream = null;
        this.logFilePath = null;
      });

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
   * Rotate log file if date has changed
   * Handles long-running sessions that span midnight
   * Non-blocking, fire-and-forget - failures fall back to continuing with old file
   */
  private async rotateLogFileIfNeeded(): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    if (this.currentLogDate === today || this.isRotating) {
      return; // No rotation needed or already rotating
    }

    this.isRotating = true;

    try {
      // Close old stream
      if (this.writeStream) {
        await new Promise<void>((resolve) => {
          this.writeStream!.end(() => resolve());
        });
      }

      // Reset and reinitialize
      this.logFileInitialized = false;
      this.writeStream = null;
      this.currentLogDate = null;

      this.initializeLogFile();
    } catch {
      // Silently fail - continue using old file
    } finally {
      this.isRotating = false;
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

    // Check if date changed (async rotation, non-blocking)
    // Fire-and-forget - worst case we write a few entries to old file
    const today = new Date().toISOString().split('T')[0];
    if (this.currentLogDate && this.currentLogDate !== today && !this.isRotating) {
      this.rotateLogFileIfNeeded().catch(() => {
        // Silently fail - continue using old file
      });
    }

    // Defensive check: Skip write if rotation is in progress or stream is not writable
    // This prevents ERR_STREAM_WRITE_AFTER_END race condition when log rotation occurs
    // Race scenario: rotateLogFileIfNeeded() closes stream while writeToLogFile() tries to write
    if (this.isRotating || !this.writeStream.writable) {
      // Skip this write - next log call will use the new rotated stream
      return;
    }

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
   * Returns a Promise that resolves once the file is flushed and its handle released;
   * the next write opens the log file again under the current CODEMIE_HOME
   * Waits for any in-progress rotation to complete before closing
   */
  async close(): Promise<void> {
    // Wait for any in-progress rotation to complete
    // This prevents race conditions where close() is called during rotation
    const maxWaitTime = 5000; // 5 seconds max wait
    const startTime = Date.now();
    while (this.isRotating && (Date.now() - startTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const stream = this.writeStream;
    this.writeStream = null;
    this.logFilePath = null;
    this.currentLogDate = null;
    this.logFileInitialized = false;
    if (!stream || stream.closed) return;

    // 'close', not the end() callback ('finish'): only 'close' means the fd is released.
    await new Promise<void>((resolve) => {
      stream.once('close', () => resolve());
      stream.end();
    });
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

      this.consoleSink.error(chalk.dim(`${prefix} ${message}`), ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    // Always write to log file
    this.writeToLogFile('info', message, ...args);
  }

  success(message: string, ...args: unknown[]): void {
    this.writeToLogFile('info', stripAnsi(message), ...args);
    this.consoleSink.log(chalk.green(`✓ ${message}`), ...args);
  }

  /** A plain console status line, no prefix; the log file gets the same message at level info. */
  status(message: string): void {
    this.writeToLogFile('info', stripAnsi(message));
    this.consoleSink.log(message);
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
        this.consoleSink.error(chalk.red(`✗ ${message}`));
        if (error) {
            if (error instanceof Error) {
                this.consoleSink.error(chalk.red(error.message));
                if (error.stack) {
                    this.consoleSink.error(chalk.white(error.stack));
                }
            } else {
                this.consoleSink.error(chalk.red(String(error)));
            }
        }
    }
  }

  notice(message: string, ...args: unknown[]): void {
    // Always write to log file
    this.writeToLogFile('notice', message, ...args);

    // Always print to console, regardless of debug mode — this is the one
    // logger level meant to surface real failures to a normal terminal run.
    const logPath = this.getLogFilePath();
    const suffix = logPath ? ` (see ${logPath})` : '';
    const sanitizedArgs = sanitizeLogArgs(...args);
    this.consoleSink.warn(chalk.yellow(`⚠ ${message}${suffix}`), ...sanitizedArgs);
  }
}

export const logger = new Logger();
