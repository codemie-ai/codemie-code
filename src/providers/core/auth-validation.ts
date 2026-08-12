/**
 * Shared authentication validation error handling
 *
 * Centralizes logic for displaying auth errors and prompting for re-authentication
 */

import chalk from 'chalk';
import type { AuthValidationResult, ProviderSetupSteps } from './types.js';
import type { CodeMieConfigOptions } from '../../env/types.js';
import { isNonInteractiveEnvironment } from '../../utils/interactive.js';

/**
 * Handle authentication validation failure
 *
 * Prompts for re-authentication if available and an interactive TTY is
 * attached. In a non-interactive environment (no TTY — CI, automation,
 * piped input) the interactive prompt is skipped entirely to avoid hanging
 * or crashing (ERR_USE_AFTER_CLOSE); the provider is treated the same way
 * as one with no promptForReauth implementation at all.
 *
 * Returns true if re-authentication succeeded, false otherwise.
 *
 * @param validationResult - The validation result from validateAuth()
 * @param setupSteps - Provider setup steps (for promptForReauth)
 * @param config - Provider configuration
 * @returns True if re-authentication succeeded, false if declined, skipped, or not available
 */
export async function handleAuthValidationFailure(
  validationResult: AuthValidationResult,
  setupSteps: ProviderSetupSteps | null,
  config: CodeMieConfigOptions
): Promise<boolean> {
  // Prompt for re-auth if the provider supports it AND we can actually prompt
  if (setupSteps?.promptForReauth && !isNonInteractiveEnvironment()) {
    return await setupSteps.promptForReauth(config);
  }

  // No re-auth available (or no TTY to prompt on), show full error with instructions
  console.log(chalk.red(`\n✗ ${validationResult.error}\n`));
  return false;
}
