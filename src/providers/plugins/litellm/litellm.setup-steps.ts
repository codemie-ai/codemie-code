/**
 * LiteLLM Setup Steps
 *
 * Interactive setup flow for LiteLLM provider.
 */

import type { ProviderSetupSteps, ProviderCredentials, SetupContext } from '../../core/types.js';
import { LiteLLMTemplate } from './litellm.template.js';
import inquirer from 'inquirer';

export const LiteLLMSetupSteps: ProviderSetupSteps = {
  name: 'litellm',

  async getCredentials(_isUpdate = false, context?: SetupContext): Promise<ProviderCredentials> {
    const enforced = context?.enforcedIntegration;

    // No dedicated enforcement banner here — the spec-mandated `📌` banner is
    // printed once by the setup wizard before this step runs. Surface the
    // portal URL directly in the API-key prompt and validator so the user has
    // a concrete link to reach the credential.
    const portalHint = enforced?.codeMieUrl
      ? ` — retrieve it from ${enforced.codeMieUrl}`
      : '';

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
          ? `API Key for integration "${enforced.alias}" (required)${portalHint}:`
          : 'API Key (optional, leave empty if not required):',
        mask: '*',
        validate: enforced
          ? (input: string) =>
              input.trim() !== '' ||
              `API Key is required for this integration${portalHint || ' — retrieve it from your CodeMie portal'}.`
          : undefined
      }
    ]);

    const key = answers.apiKey?.trim();
    if (enforced && !key) throw new Error('API Key is required for this integration.');
    return {
      baseUrl: answers.baseUrl.trim(),
      apiKey: enforced ? key : (key || 'not-required')
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
