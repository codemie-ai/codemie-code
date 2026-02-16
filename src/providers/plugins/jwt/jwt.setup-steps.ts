/**
 * JWT Bearer Authorization Setup Steps
 *
 * Simplified setup flow for JWT authentication.
 * Only asks for API URL during setup - token is provided later at runtime.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import type {
  ProviderSetupSteps,
  ProviderCredentials,
  AuthValidationResult
} from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { ensureApiBase } from '../sso/sso.http-client.js';

export const JWTBearerSetupSteps: ProviderSetupSteps = {
  name: 'bearer-auth',

  async getCredentials(_isUpdate?: boolean): Promise<ProviderCredentials> {
    console.log(chalk.cyan('\n🔐 JWT Bearer Authorization Setup\n'));
    console.log(chalk.white('This provider uses JWT tokens for authentication.'));
    console.log(chalk.white('You only need to provide the API URL during setup.\n'));
    console.log(chalk.yellow('ℹ️  JWT token will be provided later via:\n'));
    console.log(chalk.white('  • CLI option: --jwt-token <token>'));
    console.log(chalk.white('  • Environment variable: CODEMIE_JWT_TOKEN=<token>\n'));

    // Step 1: Get API URL
    const urlAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'CodeMie base URL:',
        default: 'https://codemie.lab.epam.com',
        validate: (input: string) => {
          if (!input.trim()) return 'API URL is required';
          if (!input.startsWith('http://') && !input.startsWith('https://')) {
            return 'Please enter a valid URL starting with http:// or https://';
          }
          return true;
        }
      }
    ]);

    // Store user's input (base URL without suffix)
    const codeMieUrl = urlAnswers.baseUrl.trim();

    // Normalize URL - add /code-assistant-api suffix if not present
    const baseUrl = ensureApiBase(codeMieUrl);

    // Step 2: Optional - environment variable name
    console.log(chalk.cyan('\n📝 Token Configuration (Optional)\n'));
    console.log(chalk.white('You can specify a custom environment variable name for the token.'));
    console.log(chalk.white('Default: CODEMIE_JWT_TOKEN\n'));

    const tokenConfigAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'customEnvVar',
        message: 'Use a custom environment variable name?',
        default: false
      }
    ]);

    let tokenEnvVar = 'CODEMIE_JWT_TOKEN';

    if (tokenConfigAnswers.customEnvVar) {
      const envVarAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'envVar',
          message: 'Environment variable name:',
          default: 'CODEMIE_JWT_TOKEN',
          validate: (input: string) => {
            if (!input.trim()) return 'Variable name is required';
            if (!/^[A-Z_][A-Z0-9_]*$/.test(input)) {
              return 'Variable name must be uppercase with underscores only';
            }
            return true;
          }
        }
      ]);

      tokenEnvVar = envVarAnswers.envVar;
    }

    console.log(chalk.green('\n✓ Configuration saved\n'));
    console.log(chalk.cyan('📌 Next Steps:\n'));
    console.log(chalk.white('1. Set your JWT token:'));
    console.log(chalk.cyan(`   export ${tokenEnvVar}="your-jwt-token-here"`));
    console.log(chalk.white('\n2. Run your agent with the token:'));
    console.log(chalk.cyan(`   codemie-claude "your prompt here"`));
    console.log(chalk.white('\n3. Or provide token via CLI:'));
    console.log(chalk.cyan(`   codemie-claude --jwt-token "your-token" "your prompt"\n`));

    // Return configuration (follows SSO pattern)
    return {
      baseUrl,  // Full API URL with suffix
      additionalConfig: {
        codeMieUrl,  // User's input (base URL)
        authMethod: 'jwt',
        jwtConfig: {
          tokenEnvVar
          // Note: No apiUrl needed - baseUrl is used for credential storage
        }
      }
    };
  },

  async fetchModels(_credentials: ProviderCredentials): Promise<string[]> {
    // Return default models - actual model list will be fetched at runtime with JWT token
    // User can override model selection via CLI or config
    return [
      'claude-4-5-sonnet',
      'claude-opus-4-6',
      'claude-4-5-haiku',
      'gpt-4-turbo',
      'gpt-4o',
      'gpt-4o-mini'
    ];
  },

  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions> {
    const jwtConfig = credentials.additionalConfig?.jwtConfig as
      | { tokenEnvVar?: string }
      | undefined;

    return {
      provider: 'bearer-auth',
      codeMieUrl: credentials.additionalConfig?.codeMieUrl as string | undefined,  // Base URL (user input)
      baseUrl: credentials.baseUrl,  // Full API URL with suffix
      model: selectedModel,
      authMethod: 'jwt',
      jwtConfig
    };
  },

  async validateAuth(config: CodeMieConfigOptions): Promise<AuthValidationResult> {
    // Check if JWT token is available at runtime
    const tokenEnvVar = config.jwtConfig?.tokenEnvVar || 'CODEMIE_JWT_TOKEN';
    const token = process.env[tokenEnvVar] || config.jwtConfig?.token;

    if (!token) {
      return {
        valid: false,
        error: `JWT token not found in ${tokenEnvVar} environment variable`
      };
    }

    // Basic JWT format validation
    const parts = token.split('.');
    if (parts.length !== 3) {
      return {
        valid: false,
        error: 'Invalid JWT token format (expected header.payload.signature)'
      };
    }

    // Check token expiration (if parseable)
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      if (payload.exp && Date.now() > payload.exp * 1000) {
        const expiresAt = payload.exp * 1000;
        return {
          valid: false,
          error: `JWT token expired on ${new Date(expiresAt).toISOString()}`,
          expiresAt
        };
      }
    } catch {
      // Non-standard JWT payload - skip expiration check
    }

    // Token is present and valid format
    return { valid: true };
  }
};
