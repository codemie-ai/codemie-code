/**
 * Azure OpenAI Setup Steps
 *
 * Interactive setup flow for Azure OpenAI provider.
 */

import inquirer from 'inquirer';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { ProviderCredentials, ProviderSetupSteps, ValidationResult } from '../../core/types.js';
import { AzureOpenAITemplate } from './azure-openai.template.js';
import { AzureOpenAIModelProxy } from './azure-openai.models.js';

const FALLBACK_AZURE_MODEL = AzureOpenAITemplate.recommendedModels[0] || 'gpt-4o';

export const AzureOpenAISetupSteps: ProviderSetupSteps = {
  name: 'azure-openai',

  async getCredentials(_isUpdate = false): Promise<ProviderCredentials> {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Azure OpenAI endpoint:',
        default: AzureOpenAITemplate.defaultBaseUrl,
        validate: (input: string) => input.trim() !== '' || 'Endpoint is required'
      },
      {
        type: 'password',
        name: 'apiKey',
        message: 'Azure OpenAI API Key:',
        mask: '*',
        validate: (input: string) => input.trim() !== '' || 'API key is required'
      },
      {
        type: 'input',
        name: 'azureApiVersion',
        message: 'Azure OpenAI API version:',
        default: '2024-06-01',
        validate: (input: string) => input.trim() !== '' || 'API version is required'
      }
    ]);

    return {
      baseUrl: answers.baseUrl.trim(),
      apiKey: answers.apiKey.trim(),
      additionalConfig: {
        azureApiVersion: answers.azureApiVersion.trim()
      }
    };
  },

  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    const modelProxy = new AzureOpenAIModelProxy(
      credentials.baseUrl || AzureOpenAITemplate.defaultBaseUrl,
      credentials.apiKey,
      credentials.additionalConfig?.azureApiVersion as string | undefined
    );

    try {
      const deployments = await modelProxy.fetchDeploymentInfos({
        provider: 'azure-openai',
        baseUrl: credentials.baseUrl || AzureOpenAITemplate.defaultBaseUrl,
        apiKey: credentials.apiKey,
        model: 'temp',
        timeout: 300,
        azureApiVersion: credentials.additionalConfig?.azureApiVersion as string | undefined
      } as CodeMieConfigOptions);

      return deployments.map(deployment => deployment.id);
    } catch {
      return AzureOpenAITemplate.recommendedModels.length > 0
        ? AzureOpenAITemplate.recommendedModels
        : [FALLBACK_AZURE_MODEL];
    }
  },

  async selectModel(credentials: ProviderCredentials, _models: string[], _template?: typeof AzureOpenAITemplate): Promise<string | null | undefined> {
    const modelProxy = new AzureOpenAIModelProxy(
      credentials.baseUrl || AzureOpenAITemplate.defaultBaseUrl,
      credentials.apiKey,
      credentials.additionalConfig?.azureApiVersion as string | undefined
    );

    try {
      const deployments = await modelProxy.fetchDeploymentInfos({
        provider: 'azure-openai',
        baseUrl: credentials.baseUrl || AzureOpenAITemplate.defaultBaseUrl,
        apiKey: credentials.apiKey,
        model: 'temp',
        timeout: 300,
        azureApiVersion: credentials.additionalConfig?.azureApiVersion as string | undefined
      } as CodeMieConfigOptions);

      if (deployments.length === 0) {
        return null;
      }

      const deploymentChoices = deployments.map((deployment) => ({
        name: deployment.description
          ? `${deployment.name} — ${deployment.description}`
          : deployment.name,
        value: deployment.id
      }));

      const { selectedDeployment } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedDeployment',
          message: 'Select Azure OpenAI deployment:',
          choices: deploymentChoices,
          pageSize: 15
        }
      ]);

      return selectedDeployment;
    } catch {
      return null;
    }
  },

  buildConfig(credentials: ProviderCredentials, selectedModel: string): Partial<CodeMieConfigOptions> {
    return {
      provider: 'azure-openai',
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      model: selectedModel,
      azureDeployment: selectedModel,
      azureApiVersion: credentials.additionalConfig?.azureApiVersion as string | undefined
    };
  },

  async validate(config: Partial<CodeMieConfigOptions>): Promise<ValidationResult> {
    if (!config.baseUrl) {
      return { valid: false, errors: ['Azure OpenAI endpoint is required'] };
    }

    if (!config.apiKey) {
      return { valid: false, errors: ['Azure OpenAI API key is required'] };
    }

    if (!config.azureApiVersion) {
      return { valid: false, errors: ['Azure OpenAI API version is required'] };
    }

    return { valid: true };
  }
};
