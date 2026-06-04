/**
 * Shared authentication utilities for assistants commands
 */

import chalk from 'chalk';
import {
  type CodeMieClient,
  type AuthConfig,
  AnalyticsService,
  AssistantService,
  ConversationService,
  DatasourceService,
  FileService,
  IntegrationService,
  LLMService,
  SkillService,
  TaskService,
  UserService,
  CategoryService,
  WorkflowService,
} from 'codemie-sdk';
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
  if (config.authMethod === 'jwt') {
    const tokenEnvVar = config.jwtConfig?.tokenEnvVar || 'CODEMIE_JWT_TOKEN';
    const token = process.env[tokenEnvVar] || config.jwtConfig?.token;
    if (!token) {
      throw new ConfigurationError(
        `JWT token not found in ${tokenEnvVar} environment variable. ` +
        'Provide it via the environment variable or set it in your profile configuration.'
      );
    }
    const authCfg: AuthConfig = {
      apiDomain: config.baseUrl ?? '',
      tokenGetter: async () => token,
      verifySSL: process.env.CODEMIE_INSECURE !== '1',
    };
    return {
      analytics: new AnalyticsService(authCfg),
      assistants: new AssistantService(authCfg),
      conversations: new ConversationService(authCfg),
      datasources: new DatasourceService(authCfg),
      files: new FileService(authCfg),
      integrations: new IntegrationService(authCfg),
      llms: new LLMService(authCfg),
      skills: new SkillService(authCfg),
      tasks: new TaskService(authCfg),
      users: new UserService(authCfg),
      categories: new CategoryService(authCfg),
      workflows: new WorkflowService(authCfg),
    } as unknown as CodeMieClient;
  }

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
