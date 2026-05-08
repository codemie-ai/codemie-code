import chalk from 'chalk';
import ora from 'ora';
import { logger } from '@/utils/logger.js';
import { createErrorContext, formatErrorForUser } from '@/utils/errors.js';

export async function executeWithSpinner<T>(
  spinnerMessage: string,
  operation: () => Promise<T>,
  successMessage: string,
  errorMessage: string,
  onError?: (error: unknown) => void
): Promise<T | null> {
  const isVerbose = process.env.CODEMIE_DEBUG === 'true';
  const spinner = ora(spinnerMessage).start();

  try {
    const result = await operation();
    if (isVerbose) {
      spinner.succeed(chalk.green(successMessage));
    } else {
      spinner.clear();
      spinner.stop();
    }
    return result;
  } catch (error) {
    if (isVerbose) {
      spinner.fail(chalk.red(errorMessage));
    } else {
      spinner.clear();
      spinner.stop();
    }
    if (onError) {
      onError(error);
    }
    return null;
  }
}

export function determineChanges<
  TItem extends { id: string },
  TRegistered extends { id: string }
>(
  selectedIds: string[],
  allItems: TItem[],
  registeredItems: TRegistered[]
): { toRegister: TItem[]; toUnregister: TRegistered[] } {
  const selectedSet = new Set(selectedIds);
  const registeredIds = new Set(registeredItems.map(item => item.id));

  return {
    toRegister: allItems.filter(item => selectedSet.has(item.id) && !registeredIds.has(item.id)),
    toUnregister: registeredItems.filter(item => !selectedSet.has(item.id)),
  };
}

export function enableVerboseLogging(): void {
  process.env.CODEMIE_DEBUG = 'true';
  const logFilePath = logger.getLogFilePath();
  if (logFilePath) {
    console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
  }
}

export function handleSetupError(error: unknown, label = 'setup'): never {
  const context = createErrorContext(error);
  logger.error(`Failed to ${label}`, context);
  console.error(formatErrorForUser(context));
  process.exit(1);
}
