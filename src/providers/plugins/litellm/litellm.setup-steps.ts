/**
 * LiteLLM Setup Steps
 *
 * Interactive setup flow for LiteLLM provider.
 */

import type { ProviderSetupSteps, ProviderCredentials, SetupContext } from '../../core/types.js';
import { LiteLLMTemplate } from './litellm.template.js';
import inquirer from 'inquirer';
import chalk from 'chalk';

export const LiteLLMSetupSteps: ProviderSetupSteps = {
  name: 'litellm',

  async getCredentials(_isUpdate = false, context?: SetupContext): Promise<ProviderCredentials> {
    const enforced = context?.enforcedIntegration;

    if (enforced) {
      console.log(chalk.cyan(`\n🔒 LiteLLM integration required: "${enforced.alias}"`));
      console.log(chalk.dim('   Get your API key from your CodeMie portal (Settings → Integrations).\n'));
    }

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'LiteLLM Proxy URL:',
        default: LiteLLMTemplate.defaultBaseUrl,
        validate: (input: string) => input.trim() !== '' || 'Base URL is required'
      },
      {
        type: 'password',
        name: 'apiKey',
        message: enforced
          ? `API Key for integration "${enforced.alias}" (required):`
          : 'API Key (optional, leave empty if not required):',
        mask: '*',
        validate: enforced
          ? (input: string) =>
              input.trim() !== '' ||
              'API Key is required for this integration. Retrieve it from your CodeMie portal.'
          : undefined
      }
    ]);

    return {
      baseUrl: answers.baseUrl.trim(),
      apiKey: enforced ? (answers.apiKey?.trim() ?? '') : (answers.apiKey?.trim() || 'not-required')
    };
  },

  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    const { LiteLLMModelProxy } = await import('./litellm.models.js');

    const modelProxy = new LiteLLMModelProxy(
      credentials.baseUrl || LiteLLMTemplate.defaultBaseUrl,
      credentials.apiKey
    );

    try {
      const models = await modelProxy.listModels();
      return models.map(m => m.id);
    } catch {
      return LiteLLMTemplate.recommendedModels;
    }
  },

  buildConfig(credentials: ProviderCredentials, selectedModel: string) {
    return {
      provider: 'litellm',
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      model: selectedModel
    };
  }
};
