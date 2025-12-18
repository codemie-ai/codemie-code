/**
 * Shared authentication validation error handling
 *
 * Centralizes logic for displaying auth errors and prompting for re-authentication
 */

import chalk from 'chalk';
import type { AuthValidationResult, ProviderSetupSteps } from './types.js';
import type { CodeMieConfigOptions } from '../../env/types.js';

/**
 * Handle authentication validation failure
 *
 * Prompts for re-authentication if available.
 * Returns true if re-authentication succeeded, false otherwise.
 *
 * @param validationResult - The validation result from validateAuth()
 * @param setupSteps - Provider setup steps (for promptForReauth)
 * @param config - Provider configuration
 * @returns True if re-authentication succeeded, false if declined or not available
 */
export async function handleAuthValidationFailure(
  validationResult: AuthValidationResult,
  setupSteps: ProviderSetupSteps | null,
  config: CodeMieConfigOptions
): Promise<boolean> {
  // Prompt for re-auth if provider supports it
  if (setupSteps?.promptForReauth) {
    return await setupSteps.promptForReauth(config);
  }

  // No re-auth available, show full error with instructions
  console.log(chalk.red(`\n✗ ${validationResult.error}\n`));
  return false;
}
