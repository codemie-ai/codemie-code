/**
 * FCC Setup Steps
 *
 * Interactive setup wizard for FCC (Free Claude Code).
 * Implements ProviderSetupSteps interface for integration with CodeMie CLI setup wizard.
 */

import type { ProviderSetupSteps, ProviderCredentials, SetupContext } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { validateFCCCredentials, getFCCCredentialsFromEnv } from './fcc.auth.js';
import inquirer from 'inquirer';
import chalk from 'chalk';

/**
 * FCC Credentials structure for setup
 */
interface FCCSetupCredentials extends ProviderCredentials {
  fccLiteLLMKey: string;
  fccServerUrl: string;
  authToken: string;
}

/**
 * FCC Setup Steps Implementation
 *
 * This class implements the ProviderSetupSteps interface to integrate
 * FCC provider with the CodeMie CLI setup wizard.
 */
export class FCCSetupStepsImpl implements ProviderSetupSteps {
  name = 'fcc';

  /**
   * Step 1: Get FCC credentials from user
   *
   * Prompts for:
   * - FCC LiteLLM API key (required)
   * - FCC server URL (optional, has default)
   */
  async getCredentials(isUpdate?: boolean, context?: SetupContext): Promise<FCCSetupCredentials> {
    console.log();
    console.log(chalk.bold.cyan('📡 FCC (Free Claude Code) Setup\n'));
    console.log(chalk.dim('  FCC is a  Claude Code deployment via LiteLLM gateway.\n'));

    // Check if we have credentials in env
    const envCredentials = getFCCCredentialsFromEnv();

    // If updating and credentials exist in env, use them as defaults
    const existingKey = envCredentials.fccLiteLLMKey || '';
    const existingUrl = envCredentials.fccServerUrl || '';
    const existingToken = envCredentials.authToken || '';

    // Prompt for FCC LiteLLM API key
    const { fccLiteLLMKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'fccLiteLLMKey',
        message: 'Enter your FCC LiteLLM API key:',
        default: existingKey || undefined,
        validate: (input: string) => {
          if (!input.trim()) return 'FCC LiteLLM API key is required.';
          return true;
        },
      },
    ]);

    // Prompt for server URL (with default)
    const { fccServerUrl } = await inquirer.prompt([
      {
        type: 'input',
        name: 'fccServerUrl',
        message: 'FCC Server URL:',
        default: existingUrl,
        validate: (input: string) => {
          if (!input.trim()) return 'Server URL is required';
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      },
    ]);

    // Prompt for auth token (with default)
    const { authToken } = await inquirer.prompt([
      {
        type: 'input',
        name: 'authToken',
        message: 'Anthropic Auth Token:',
        default: existingToken,
        validate: (input: string) => {
          if (!input.trim()) return 'Auth token is required';
          return true;
        },
      },
    ]);

    // Validate credentials
    const validationResult = await validateFCCCredentials({
      fccLiteLLMKey,
      fccServerUrl,
      authToken,
    });

    if (!validationResult.valid) {
      throw new Error(`Credential validation failed: ${validationResult.errors?.join(', ')}`);
    }

    return {
      fccLiteLLMKey,
      fccServerUrl,
      authToken,
      baseUrl: fccServerUrl,
      apiKey: authToken,  // Map authToken to apiKey for ProviderProfile compatibility
    };
  }

  /**
   * Step 2: Fetch available models from FCC
   *
   * For now, returns Claude models that FCC typically provides
   */
  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    // FCC typically provides Claude models via LiteLLM
    // In future, could fetch from FCC API
    return [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  /**
   * Step 3: Build configuration from credentials
   */
  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions> {
    const fccCreds = credentials as FCCSetupCredentials;

    // Note: FCC-specific fields are stored as extensions to ProviderProfile
    // They will be picked up by exportEnvVars in fcc.template.ts
    const config: Partial<CodeMieConfigOptions> & { fccLiteLLMKey?: string; fccServerUrl?: string } = {
      provider: 'fcc',
      baseUrl: fccCreds.fccServerUrl,
      apiKey: fccCreds.authToken,
      model: selectedModel,
      fccLiteLLMKey: fccCreds.fccLiteLLMKey,
      fccServerUrl: fccCreds.fccServerUrl,
    };

    return config;
  }
}

// Export singleton instance for registry
export const FCCSetupSteps = new FCCSetupStepsImpl();