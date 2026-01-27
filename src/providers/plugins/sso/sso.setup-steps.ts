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
import ora from 'ora';
import type {
  ProviderSetupSteps,
  ProviderCredentials,
  AuthValidationResult,
  AuthStatus
} from '../../core/types.js';
import type { CodeMieConfigOptions, CodeMieIntegrationInfo } from '../../../env/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { SSOTemplate } from './sso.template.js';
import { CodeMieSSO } from './sso.auth.js';
import { SSOModelProxy } from './sso.models.js';
import { fetchCodeMieUserInfo, fetchCodeMieModels, fetchCodeMieIntegrations } from './sso.http-client.js';
import { logger } from '../../../utils/logger.js';

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

    // === NEW STEP: Fetch applications and select project ===
    let selectedProject: string | undefined;

    try {
      console.log(chalk.cyan('📂 Fetching available projects...\n'));

      // Ensure API URL and cookies are available
      if (!authResult.apiUrl || !authResult.cookies) {
        throw new Error('API URL or cookies not found in authentication result');
      }

      // Fetch user's accessible applications
      const userInfo = await fetchCodeMieUserInfo(
        authResult.apiUrl,
        authResult.cookies
      );

      // Merge applications and applicationsAdmin arrays (deduplicated)
      const applications = userInfo.applications || [];
      const applicationsAdmin = userInfo.applicationsAdmin || [];
      const allProjects = [...new Set([...applications, ...applicationsAdmin])];

      // Validate that user has at least one project
      if (allProjects.length === 0) {
        throw new Error('No projects found for your account. Please contact your administrator.');
      }

      // Sort projects alphabetically (case-insensitive)
      const sortedProjects = allProjects.sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
      );

      // Auto-select if only one project
      if (sortedProjects.length === 1) {
        selectedProject = sortedProjects[0];
        console.log(chalk.green(`✓ Auto-selected project: ${chalk.bold(selectedProject)}\n`));
      } else {
        // Multiple projects - prompt user to select
        console.log(chalk.dim(`Found ${sortedProjects.length} accessible project(s)\n`));

        const projectAnswers = await inquirer.prompt([
          {
            type: 'list',
            name: 'project',
            message: 'Select your project:',
            choices: sortedProjects.map(proj => ({
              name: proj,
              value: proj
            })),
            pageSize: 15
          }
        ]);

        selectedProject = projectAnswers.project;
        console.log(chalk.green(`✓ Selected project: ${chalk.bold(selectedProject)}\n`));
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`✗ Project selection failed: ${errorMsg}\n`));

      // Fail fast - project selection is required
      throw new Error(`Project selection required: ${errorMsg}`);
    }

    // Check for LiteLLM integrations
    let integrations;
    let integrationsFetchError: string | undefined;

    try {
      // Use authResult.cookies directly (same as userInfo fetch) instead of retrieving from storage
      // This ensures we use the same authenticated session for all API calls during setup
      const allIntegrations = await fetchCodeMieIntegrations(
        authResult.apiUrl,
        authResult.cookies
      );

      // Filter by project if specified
      if (selectedProject) {
        integrations = allIntegrations.filter(
          integration => integration.project_name === selectedProject
        );
      } else {
        integrations = allIntegrations;
      }
    } catch (error) {
      // Log error but don't fail setup - integrations are optional
      integrationsFetchError = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`⚠️  Could not fetch integrations: ${integrationsFetchError}\n`));
      integrations = [];
    }

    // Always prompt for integration selection
    let integrationInfo: CodeMieIntegrationInfo | undefined;

    if (integrations.length > 0) {
      const projectLabel = selectedProject ? ` for project "${selectedProject}"` : '';
      console.log(chalk.cyan(`📦 Found ${integrations.length} LiteLLM integration(s)${projectLabel}\n`));
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
      const projectLabel = selectedProject ? ` for project "${selectedProject}"` : '';
      if (integrationsFetchError) {
        console.log(chalk.dim(`ℹ️  Proceeding without LiteLLM integration (fetch failed)\n`));
      } else {
        console.log(chalk.dim(`ℹ️  No LiteLLM integrations configured${projectLabel}\n`));
      }
    }

    return {
      baseUrl: authResult.apiUrl,
      additionalConfig: {
        codeMieUrl,
        codeMieProject: selectedProject,
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
      codeMieProject: credentials.additionalConfig?.codeMieProject as string | undefined,
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
  },

  /**
   * Validate SSO authentication status
   *
   * Checks credential validity, expiration, and API access
   */
  async validateAuth(config: CodeMieConfigOptions): Promise<AuthValidationResult> {
    try {
      const baseUrl = config.codeMieUrl || config.baseUrl;
      if (!baseUrl) {
        return {
          valid: false,
          error: 'No CodeMie URL configured'
        };
      }

      const sso = new CodeMieSSO();
      const credentials = await sso.getStoredCredentials(baseUrl);

      if (!credentials) {
        return {
          valid: false,
          error: `No SSO credentials found for ${baseUrl}. Please run: codemie profile login --url ${baseUrl}`
        };
      }

      // Test API access
      try {
        await fetchCodeMieModels(credentials.apiUrl, credentials.cookies);
      } catch (error) {
        return {
          valid: false,
          error: `API access test failed: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      return {
        valid: true,
        expiresAt: credentials.expiresAt
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  /**
   * Prompt user for re-authentication
   *
   * Interactive re-auth flow when validation fails
   */
  async promptForReauth(config: CodeMieConfigOptions): Promise<boolean> {
    try {
      // Show warning about credentials
      console.log(chalk.yellow('\n⚠️  Authentication required\n'));

      // Prompt user
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Re-authenticate now?',
          default: true
        }
      ]);

      if (!confirm) {
        return false;
      }

      // Run authentication
      const codeMieUrl = config.codeMieUrl;
      if (!codeMieUrl) {
        console.log(chalk.red('\n✗ No CodeMie URL configured\n'));
        return false;
      }

      const spinner = ora('Launching SSO authentication...').start();

      const sso = new CodeMieSSO();
      const result = await sso.authenticate({ codeMieUrl, timeout: 120000 });

      if (result.success) {
        spinner.succeed(chalk.green('SSO authentication successful'));
        return true;
      } else {
        spinner.fail(chalk.red('SSO authentication failed'));
        console.log(chalk.red(`Error: ${result.error}`));
        return false;
      }
    } catch (error) {
      logger.error('Re-authentication failed:', error);
      return false;
    }
  },

  /**
   * Get authentication status for display
   *
   * Returns current auth status information
   */
  async getAuthStatus(config: CodeMieConfigOptions): Promise<AuthStatus> {
    try {
      const baseUrl = config.codeMieUrl || config.baseUrl;
      const sso = new CodeMieSSO();
      const credentials = await sso.getStoredCredentials(baseUrl);

      if (!credentials) {
        return { authenticated: false };
      }

      return {
        authenticated: true,
        expiresAt: credentials.expiresAt,
        apiUrl: credentials.apiUrl
      };
    } catch (error) {
      logger.error('Failed to get auth status:', error);
      return { authenticated: false };
    }
  }
};

// Auto-register setup steps
ProviderRegistry.registerSetupSteps('ai-run-sso', SSOSetupSteps);
