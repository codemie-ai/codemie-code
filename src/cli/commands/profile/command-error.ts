import chalk from 'chalk';
import { logger } from '@/utils/logger.js';
import { getErrorMessage } from '@/utils/errors.js';

/**
 * Thrown when the user cancels an interactive profile picker (Esc / Ctrl+C).
 */
export class ProfileSelectionCancelledError extends Error {
  constructor() {
    super('Profile selection cancelled.');
    this.name = 'ProfileSelectionCancelledError';
  }
}

/**
 * A user cancel: the custom profile picker, or Ctrl+C in an inquirer prompt
 * (which rejects with an error named ExitPromptError).
 */
function isUserCancellation(error: unknown): boolean {
  return error instanceof ProfileSelectionCancelledError
    || (error instanceof Error && error.name === 'ExitPromptError');
}

/**
 * Report a failed command and exit. The details always go to the log file;
 * the user sees the reason in red (exit 1), or "Cancelled." for a user cancel
 * (exit 0), without needing CODEMIE_DEBUG.
 */
export function exitWithCommandError(label: string, error: unknown): never {
  logger.error(`${label}:`, error);

  if (isUserCancellation(error)) {
    console.log(chalk.yellow('\nCancelled.\n'));
    process.exit(0);
  }

  console.error(chalk.red(`✗ ${label}: ${getErrorMessage(error)}`));
  process.exit(1);
}
