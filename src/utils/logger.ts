import chalk from 'chalk';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

class Logger {
  private debugEnabled: boolean;
  private debugLogFile: string | null = null;

  constructor() {
    this.debugEnabled = process.env.CODEMIE_DEBUG === 'true' || process.env.CODEMIE_DEBUG === '1';
    if (this.debugEnabled) {
      this.initializeDebugLogging().catch(() => {
        // Silent failure - logging to file is optional
      });
    }
  }

  private async initializeDebugLogging(): Promise<void> {
    const baseDir = join(homedir(), '.codemie', 'debug');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionDir = join(baseDir, `session-${timestamp}`);
    const filename = 'application.log';

    try {
      await fs.mkdir(sessionDir, { recursive: true });
      this.debugLogFile = join(sessionDir, filename);
    } catch {
      this.debugLogFile = null;
    }
  }

  /**
   * Get the current debug session directory
   * @returns Session directory path or null if debug is not enabled
   */
  getDebugSessionDir(): string | null {
    if (!this.debugLogFile) return null;
    return join(this.debugLogFile, '..');
  }

  private async writeToFile(level: string, message: string, ...args: unknown[]): Promise<void> {
    if (!this.debugLogFile) return;

    try {
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : ''}\n`;
      await fs.appendFile(this.debugLogFile, logLine, 'utf-8');
    } catch {
      // Silent failure
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.debugEnabled) {
      this.writeToFile('debug', message, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    console.log(chalk.blueBright(message), ...args);
    if (this.debugEnabled) {
      this.writeToFile('info', message, ...args);
    }
  }

  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green(`✓ ${message}`), ...args);
    if (this.debugEnabled) {
      this.writeToFile('info', `✓ ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(chalk.yellow(`⚠ ${message}`), ...args);
    if (this.debugEnabled) {
      this.writeToFile('warn', `⚠ ${message}`, ...args);
    }
  }

  error(message: string, error?: Error | unknown): void {
    console.error(chalk.red(`✗ ${message}`));
    if (this.debugEnabled) {
      this.writeToFile('error', `✗ ${message}`);
    }

    if (error) {
      if (error instanceof Error) {
        console.error(chalk.red(error.message));
        if (this.debugEnabled) {
          this.writeToFile('error', error.message);
          if (error.stack) {
            console.error(chalk.white(error.stack));
            this.writeToFile('error', error.stack);
          }
        }
      } else {
        console.error(chalk.red(String(error)));
        if (this.debugEnabled) {
          this.writeToFile('error', String(error));
        }
      }
    }
  }
}

export const logger = new Logger();
