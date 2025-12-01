import chalk from 'chalk';
import { randomUUID } from 'crypto';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

class Logger {
  private sessionId: string;

  constructor() {
    // Always generate session ID for analytics tracking
    this.sessionId = randomUUID();
  }

  /**
   * Get the current session ID (UUID)
   * @returns Session ID (always available)
   */
  getSessionId(): string {
    return this.sessionId;
  }

  debug(_message: string, ..._args: unknown[]): void {
    // No-op: debug logging removed
  }

  info(message: string, ...args: unknown[]): void {
    console.log(chalk.blueBright(message), ...args);
  }

  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green(`✓ ${message}`), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(chalk.yellow(`⚠ ${message}`), ...args);
  }

  error(message: string, error?: Error | unknown): void {
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
