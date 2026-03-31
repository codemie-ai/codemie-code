/**
 * Anthropic Subscription Setup Steps
 *
 * Interactive setup flow for native Claude Code authentication.
 */

import inquirer from 'inquirer';
import type { ProviderCredentials, ProviderSetupSteps } from '../../core/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { AnthropicSubscriptionTemplate } from './anthropic-subscription.template.js';
import {
  DEFAULT_CODEMIE_BASE_URL,
  authenticateWithCodeMie,
  promptForCodeMieUrl,
  selectCodeMieProject
} from '../../core/codemie-auth-helpers.js';
import {
  ensureClaudeCliAvailable,
  getClaudeAuthStatus,
  runClaudeBrowserLogin
} from './anthropic-subscription.auth.js';

export const AnthropicSubscriptionSetupSteps: ProviderSetupSteps = {
  name: 'anthropic-subscription',

  async getCredentials(_isUpdate = false): Promise<ProviderCredentials> {
    logger.info('Anthropic Subscription Setup');
    logger.info('This provider uses Claude Code native browser authentication.');
    logger.info('CodeMie will not store an Anthropic API key for this profile.');

    await ensureClaudeCliAvailable();

    const currentStatus = await getClaudeAuthStatus();
    if (!currentStatus.loggedIn) {
      logger.info('Claude Code is not authenticated yet.');
      logger.info('Launching native Claude browser login...');
      await runClaudeBrowserLogin();
    } else {
      logger.success('Claude Code is already authenticated');
    }

    const finalStatus = await getClaudeAuthStatus();
    if (!finalStatus.loggedIn) {
      throw new ConfigurationError('Claude Code authentication is required. Complete `claude auth login` and run setup again.');
    }

    logger.success(`Claude native auth confirmed (${finalStatus.authMethod || 'unknown'})`);

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
      codeMieProject = await selectCodeMieProject(authResult);
      logger.success('Analytics sync enabled for CodeMie platform');
    }

    return {
      baseUrl: AnthropicSubscriptionTemplate.defaultBaseUrl,
      apiKey: '',
      additionalConfig: {
        authMethod: 'manual',
        codeMieUrl,
        codeMieProject
      }
    };
  },

  async fetchModels(_credentials: ProviderCredentials): Promise<string[]> {
    return [...AnthropicSubscriptionTemplate.recommendedModels];
  },

  async selectModel(
    credentials: ProviderCredentials,
    models: string[]
  ): Promise<string | null> {
    if (credentials.additionalConfig?.codeMieUrl) {
      return models[0] || AnthropicSubscriptionTemplate.recommendedModels[0] || 'claude-sonnet-4-6';
    }

    return null;
  },

  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions> {
    return {
      provider: 'anthropic-subscription',
      baseUrl: credentials.baseUrl || AnthropicSubscriptionTemplate.defaultBaseUrl,
      apiKey: '',
      model: selectedModel,
      authMethod: 'manual',
      codeMieUrl: credentials.additionalConfig?.codeMieUrl as string | undefined,
      codeMieProject: credentials.additionalConfig?.codeMieProject as string | undefined,
    };
  }
};

ProviderRegistry.registerSetupSteps('anthropic-subscription', AnthropicSubscriptionSetupSteps);
