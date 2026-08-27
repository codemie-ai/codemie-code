
import type { ProviderSetupSteps, ProviderCredentials, SetupContext } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { validateFCCCredentials, getFCCCredentialsFromEnv } from './fcc.auth.js';
import inquirer from 'inquirer';
import chalk from 'chalk';

interface FCCSetupCredentials extends ProviderCredentials {
  fccLiteLLMKey: string;
  fccServerUrl: string;
  authToken: string;
}


export class FCCSetupStepsImpl implements ProviderSetupSteps {
  name = 'fcc';

  async getCredentials(isUpdate?: boolean, context?: SetupContext): Promise<FCCSetupCredentials> {
    console.log();
    console.log(chalk.bold.cyan('📡 FCC (Free Claude Code) Setup\n'));
    console.log(chalk.dim('  FCC is a custom Claude Code deployment via LiteLLM gateway with SSO authentication.\n'));


    const envCredentials = getFCCCredentialsFromEnv();


    const existingKey = envCredentials.fccLiteLLMKey || '';
    const existingUrl = envCredentials.fccServerUrl || '';
    const existingToken = envCredentials.authToken || '';

    
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
      apiKey: authToken,  
    };
  }

  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    return [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  
  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions> {
    const fccCreds = credentials as FCCSetupCredentials;

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


export const FCCSetupSteps = new FCCSetupStepsImpl();