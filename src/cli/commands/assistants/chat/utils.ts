/**
 * Chat Utility Functions
 */

import chalk from 'chalk';
import { logger } from '@/utils/logger.js';
import { EXIT_PROMPTS } from '../constants.js';

/**
 * Check if message is an exit command
 */
export function isExitCommand(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  return EXIT_PROMPTS.includes(normalized as any);
}

/**
 * Enable verbose/debug mode
 */
export function enableVerboseMode(): void {
  process.env.CODEMIE_DEBUG = 'true';
  const logFilePath = logger.getLogFilePath();
  if (logFilePath) {
    console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
  }
}
