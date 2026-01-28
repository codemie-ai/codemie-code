/**
 * Shared authentication utilities for assistants commands
 */

import chalk from 'chalk';
import type { CodeMieClient } from 'codemie-sdk';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { ConfigurationError } from '@/utils/errors.js';
import type { ProviderProfile } from '@/env/types.js';
import { ProviderRegistry } from '@/providers/core/registry.js';
import { handleAuthValidationFailure } from '@/providers/core/auth-validation.js';

/**
 * Get authenticated CodeMie client with automatic re-authentication on failure
 *
 * @param config - Provider configuration
 * @returns Authenticated CodeMieClient instance
 * @throws ConfigurationError if authentication fails and user declines re-auth
 */
export async function getAuthenticatedClient(config: ProviderProfile): Promise<CodeMieClient> {
  try {
    return await getCodemieClient();
  } catch (error) {
    if (error instanceof ConfigurationError && error.message.includes('SSO authentication required')) {
      const reauthed = await promptReauthentication(config);
      if (reauthed) {
        // Retry getting client after successful re-authentication
        return await getCodemieClient();
      }
    }
    throw error;
  }
}

/**
 * Prompt user for re-authentication
 *
 * @param config - Provider configuration
 * @returns True if re-authentication succeeded, false otherwise
 * @throws ConfigurationError if re-authentication is not available
 */
export async function promptReauthentication(config: ProviderProfile): Promise<boolean> {
  const setupSteps = ProviderRegistry.getSetupSteps(config.provider || '');

  if (setupSteps?.validateAuth) {
    const validationResult = await setupSteps.validateAuth(config);
    const reauthed = await handleAuthValidationFailure(validationResult, setupSteps, config);

    if (reauthed) {
      console.log(chalk.green('\n✓ Re-authentication successful\n'));
      return true;
    }
  }

  throw new ConfigurationError('Authentication expired. Please re-authenticate.');
}
