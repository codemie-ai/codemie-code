/**
 * Moonshot Subscription Setup Steps
 *
 * Interactive setup flow for native Kimi Code authentication.
 */

import inquirer from 'inquirer';
import type { ProviderCredentials, ProviderSetupSteps } from '../../core/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { MoonshotSubscriptionTemplate } from './moonshot-subscription.template.js';
import {
  DEFAULT_CODEMIE_BASE_URL,
  authenticateWithCodeMie,
  promptForCodeMieUrl,
  selectCodeMieProject
} from '../../core/codemie-auth-helpers.js';
import { commandExists } from '../../../utils/processes.js';

export const MoonshotSubscriptionSetupSteps: ProviderSetupSteps = {
  name: 'moonshot-subscription',

  async getCredentials(_isUpdate = false): Promise<ProviderCredentials> {
    logger.info('Moonshot Subscription Setup');
    logger.info('This provider uses Kimi Code native browser authentication.');
    logger.info('CodeMie will not store a Moonshot API key for this profile.');

    const kimiInstalled = await commandExists('kimi');
    if (!kimiInstalled) {
      throw new ConfigurationError(
        'Kimi Code CLI (kimi) was not found on PATH. Install Kimi Code and authenticate before running this setup.'
      );
    }

    logger.success('Kimi Code CLI detected');

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'enableCodeMieAnalytics',
        message: 'Login to CodeMie platform to enable analytics sync?',
        default: false
      }
    ]);

    let codeMieUrl: string | undefined;
    let codeMieProject: string | undefined;
    let userEmail: string | undefined;

    if (answers.enableCodeMieAnalytics) {
      codeMieUrl = await promptForCodeMieUrl(
        DEFAULT_CODEMIE_BASE_URL,
        'CodeMie platform URL for analytics sync:'
      );

      logger.info('Authenticating to CodeMie platform...');
      const authResult = await authenticateWithCodeMie(codeMieUrl, 120000);

      if (!authResult.success) {
        throw new ConfigurationError(`CodeMie authentication failed: ${authResult.error || 'Unknown error'}`);
      }

      logger.success('CodeMie authentication successful');
      logger.info('Fetching available projects...');
      ({ project: codeMieProject, userEmail } = await selectCodeMieProject(authResult));
      logger.success('Analytics sync enabled for CodeMie platform');
    }

    return {
      baseUrl: MoonshotSubscriptionTemplate.defaultBaseUrl,
      apiKey: '',
      additionalConfig: {
        authMethod: 'manual',
        codeMieUrl,
        codeMieProject,
        userEmail
      }
    };
  },

  async fetchModels(_credentials: ProviderCredentials): Promise<string[]> {
    return [...MoonshotSubscriptionTemplate.recommendedModels];
  },

  async selectModel(
    credentials: ProviderCredentials,
    models: string[]
  ): Promise<string | null> {
    if (credentials.additionalConfig?.codeMieUrl) {
      return models[0] || MoonshotSubscriptionTemplate.recommendedModels[0] || null;
    }

    return null;
  },

  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions> {
    return {
      provider: 'moonshot-subscription',
      baseUrl: credentials.baseUrl || MoonshotSubscriptionTemplate.defaultBaseUrl,
      apiKey: '',
      model: selectedModel,
      authMethod: 'manual',
      codeMieUrl: credentials.additionalConfig?.codeMieUrl as string | undefined,
      codeMieProject: credentials.additionalConfig?.codeMieProject as string | undefined,
    };
  }
};

ProviderRegistry.registerSetupSteps('moonshot-subscription', MoonshotSubscriptionSetupSteps);
