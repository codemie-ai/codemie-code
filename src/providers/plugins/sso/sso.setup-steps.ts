/**
 * SSO Provider Setup Steps
 *
 * Implements interactive setup flow for CodeMie SSO provider.
 * Features:
 * - Browser-based SSO authentication
 * - CodeMie URL configuration
 * - LiteLLM integration discovery (optional)
 * - Model fetching from SSO API
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import type {
  ProviderSetupSteps,
  ProviderCredentials
} from '../../core/types.js';
import type { CodeMieConfigOptions, CodeMieIntegrationInfo } from '../../../env/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { SSOTemplate } from './sso.template.js';
import { CodeMieSSO } from './sso.auth.js';
import { SSOModelProxy } from './sso.models.js';

/**
 * SSO setup steps implementation
 */
export const SSOSetupSteps: ProviderSetupSteps = {
  name: 'ai-run-sso',

  /**
   * Step 1: Gather credentials/configuration
   *
   * Prompts for CodeMie URL and performs browser-based authentication
   */
  async getCredentials(): Promise<ProviderCredentials> {
    // Prompt for CodeMie URL
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'codeMieUrl',
        message: 'CodeMie organization URL:',
        default: SSOTemplate.defaultBaseUrl,
        validate: (input: string) => {
          if (!input.trim()) {
            return 'CodeMie URL is required';
          }
          if (!input.startsWith('http://') && !input.startsWith('https://')) {
            return 'Please enter a valid URL starting with http:// or https://';
          }
          return true;
        }
      }
    ]);

    const codeMieUrl = answers.codeMieUrl.trim();

    // Authenticate via browser
    console.log(chalk.cyan('\n🔐 Authenticating via browser...\n'));
    const sso = new CodeMieSSO();
    const authResult = await sso.authenticate({
      codeMieUrl,
      timeout: 120000 // 2 minutes
    });

    if (!authResult.success) {
      throw new Error(`SSO authentication failed: ${authResult.error || 'Unknown error'}`);
    }

    console.log(chalk.green('✓ Authentication successful!\n'));

    // Check for LiteLLM integrations
    const modelProxy = new SSOModelProxy(authResult.apiUrl);
    let integrations;
    let integrationsFetchError: string | undefined;

    try {
      integrations = await modelProxy.fetchIntegrations(codeMieUrl);
    } catch (error) {
      // Log error but don't fail setup - integrations are optional
      integrationsFetchError = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`⚠️  Could not fetch integrations: ${integrationsFetchError}\n`));
      integrations = [];
    }

    // Always prompt for integration selection
    let integrationInfo: CodeMieIntegrationInfo | undefined;

    if (integrations.length > 0) {
      console.log(chalk.cyan(`📦 Found ${integrations.length} LiteLLM integration(s)\n`));
      const integrationAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'integration',
          message: 'Select LiteLLM integration (optional):',
          choices: [
            { name: 'None (use CodeMie models directly)', value: null },
            ...integrations.map(i => ({
              name: `${i.alias} (${i.project_name || 'Default'})`,
              value: { id: i.id, alias: i.alias }
            }))
          ]
        }
      ]);
      integrationInfo = integrationAnswers.integration;
    } else {
      // Show message if no integrations found
      if (integrationsFetchError) {
        console.log(chalk.dim('ℹ️  Proceeding without LiteLLM integration (fetch failed)\n'));
      } else {
        console.log(chalk.dim('ℹ️  No LiteLLM integrations configured\n'));
      }
    }

    return {
      baseUrl: authResult.apiUrl,
      additionalConfig: {
        codeMieUrl,
        codeMieIntegration: integrationInfo,
        apiUrl: authResult.apiUrl
      }
    };
  },

  /**
   * Step 2: Fetch available models
   *
   * Queries SSO API to discover available models
   */
  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    const modelProxy = new SSOModelProxy(credentials.baseUrl);
    const models = await modelProxy.fetchModels({
      codeMieUrl: credentials.additionalConfig?.codeMieUrl,
      baseUrl: credentials.baseUrl
    } as CodeMieConfigOptions);

    return models.map(m => m.id);
  },

  /**
   * Step 3: Build final configuration
   *
   * Transform credentials + model selection into CodeMieConfigOptions
   */
  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions> {
    const config: Partial<CodeMieConfigOptions> = {
      provider: 'ai-run-sso',
      codeMieUrl: credentials.additionalConfig?.codeMieUrl as string | undefined,
      apiKey: "sso-provided",
      baseUrl: credentials.baseUrl,
      model: selectedModel
    };

    // Only include codeMieIntegration if it has a value
    const integration = credentials.additionalConfig?.codeMieIntegration as CodeMieIntegrationInfo | undefined;
    if (integration) {
      config.codeMieIntegration = integration;
    }

    return config;
  }
};

// Auto-register setup steps
ProviderRegistry.registerSetupSteps('ai-run-sso', SSOSetupSteps);
