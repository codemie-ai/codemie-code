import chalk from 'chalk';
import ora from 'ora';
import { logger } from '@/utils/logger.js';
import { createErrorContext, formatErrorForUser, PartialRegistrationError } from '@/utils/errors.js';

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

/**
 * Runs `operation` behind a spinner and **rethrows** the original error after
 * invoking `onError`, in deliberate contrast to `executeWithSpinner`, which
 * swallows the failure and returns `null` (a `null` a caller easily reads as
 * "skip this one" and reports as success). Use this variant wherever a failed
 * write must abort the run.
 */
export async function executeWithSpinnerStrict<T>(
  spinnerMessage: string,
  operation: () => Promise<T>,
  successMessage: string,
  errorMessage: string,
  onError?: (error: unknown) => void
): Promise<T> {
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
    throw error;
  }
}

/**
 * Writes items sequentially and stops at the first failure, so a caller never
 * reports success for items that were never written. There is no rollback:
 * items already written before the failure stay written on disk.
 */
export async function registerAllOrAbort<TItem, TResult>(
  items: TItem[],
  nameOf: (item: TItem) => string,
  writeOne: (item: TItem) => Promise<TResult>
): Promise<TResult[]> {
  const results: TResult[] = [];
  const written: string[] = [];

  for (const item of items) {
    try {
      const result = await writeOne(item);
      results.push(result);
      written.push(nameOf(item));
    } catch (error) {
      throw new PartialRegistrationError(written, error);
    }
  }

  return results;
}

/**
 * Records the items a batch already wrote before it aborted, so the saved config
 * never claims less than what exists on disk (an artifact with no config entry can
 * neither be listed nor unregistered). A failure to save is logged and swallowed:
 * it must never mask the registration error the caller is about to rethrow.
 */
export async function persistPartialWrites<T>(
  written: T[],
  untouched: T[],
  save: (items: T[]) => Promise<void>
): Promise<void> {
  if (written.length === 0) {
    return;
  }

  try {
    await save([...untouched, ...written]);
  } catch (error) {
    logger.error('Failed to record partially written registrations', { error });
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
