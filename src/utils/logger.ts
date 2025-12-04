import chalk from 'chalk';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sanitizeLogArgs } from './sanitize.js';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

class Logger {
  private sessionId: string;
  private logFilePath: string | null = null;
  private logFileInitialized = false;
  private writeStream: fs.WriteStream | null = null;

  constructor() {
    // Always generate session ID for analytics tracking
    this.sessionId = randomUUID();
  }

  /**
   * Initialize log file path and create write stream
   * Log file format: ~/.codemie/logs/debug-YYYY-MM-DD.log
   */
  private initializeLogFile(): void {
    if (this.logFileInitialized) return;

    try {
      const logsDir = path.join(os.homedir(), '.codemie', 'logs');

      // Create directory synchronously
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

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
   * Write a log entry to the debug log file (synchronous)
   * Format: [YYYY-MM-DD HH:MM:SS.mmm] [LEVEL] message
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

      // Sanitize args before writing to file
      const sanitizedArgs = sanitizeLogArgs(...args);

      const argsStr = sanitizedArgs.length > 0 ? ' ' + sanitizedArgs.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      ).join(' ') : '';
      const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}${argsStr}\n`;

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
    // Always write to log file
    this.writeToLogFile('debug', message, ...args);

    // Only console output when CODEMIE_DEBUG is enabled
    if (this.isDebugMode()) {
      console.log(chalk.dim(`[DEBUG] ${message}`), ...args);
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

    // Console output
    console.warn(chalk.yellow(`⚠ ${message}`), ...args);
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

export const logger = new Logger();
