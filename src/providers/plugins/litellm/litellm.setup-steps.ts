/**
 * LiteLLM Setup Steps
 *
 * Interactive setup flow for LiteLLM provider.
 */

import type { ProviderSetupSteps, ProviderCredentials } from '../../core/types.js';
import { LiteLLMTemplate } from './litellm.template.js';
import inquirer from 'inquirer';

export const LiteLLMSetupSteps: ProviderSetupSteps = {
  name: 'litellm',

  async getCredentials(_isUpdate = false): Promise<ProviderCredentials> {
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
        message: 'API Key (optional, leave empty if not required):',
        mask: '*'
      }
    ]);

    return {
      baseUrl: answers.baseUrl.trim(),
      apiKey: answers.apiKey?.trim() || 'not-required'
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
      // If fetch fails, return recommended models
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
