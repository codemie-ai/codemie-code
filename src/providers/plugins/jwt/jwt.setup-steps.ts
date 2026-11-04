/**
 * JWT Bearer Authorization Setup Steps
 *
 * Simplified setup flow for JWT authentication.
 * Asks for the API URL and, with a token available, the CodeMie project; the
 * token itself is provided at runtime and never stored.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import type {
  ProviderSetupSteps,
  ProviderCredentials,
  AuthValidationResult
} from '@/providers/core/types.js';
import { ProviderName, AuthMethod } from '@/providers/core/types.js';
import { JWT_TOKEN_DEFAULT_ENV_VAR, resolveJwtToken, resolveJwtTokenEnvVar } from '@/providers/plugins/jwt/jwt.utils.js';
import type { CodeMieConfigOptions } from '@/env/types.js';
import { ensureApiBase, selectCodeMieProject } from '../../core/codemie-auth-helpers.js';

/** Seams for tests. */
export interface JwtProjectStepDeps {
  prompt?: typeof inquirer.prompt;
  select?: typeof selectCodeMieProject;
  env?: NodeJS.ProcessEnv;
}

/**
 * JWT setup project step: lists the account's projects with bearer auth against
 * the URL typed in this run and returns the pick. The token comes from the chosen
 * env var, or is pasted once (hidden; never stored or logged). Skip or failure
 * returns undefined: no project is saved and the profile stays unowned.
 */
export async function selectJwtProfileProject(
  apiUrl: string,
  tokenEnvVar: string,
  deps: JwtProjectStepDeps = {}
): Promise<string | undefined> {
  const prompt = deps.prompt ?? inquirer.prompt;
  const select = deps.select ?? selectCodeMieProject;
  const env = deps.env ?? process.env;

  console.log(chalk.cyan('\n📂 CodeMie project (billing) for this profile\n'));
  let token = env[tokenEnvVar]?.trim() || undefined;
  if (token) {
    const { useEnv } = await prompt([{
      type: 'confirm',
      name: 'useEnv',
      message: `Select the project now using the token in ${tokenEnvVar}?`,
      default: true,
    }]) as { useEnv: boolean };
    if (!useEnv) token = undefined;
  } else {
    const { source } = await prompt([{
      type: 'list',
      name: 'source',
      message: `No token found in ${tokenEnvVar}. How should the project be selected?`,
      choices: [
        { name: 'Paste a token once (not stored)', value: 'paste' },
        { name: 'Skip — select later with `codemie setup` when the token is available', value: 'skip' },
      ],
    }]) as { source: 'paste' | 'skip' };
    if (source === 'paste') {
      const { pasted } = await prompt([{ type: 'password', name: 'pasted', mask: '*', message: 'JWT token:' }]) as { pasted: string };
      token = pasted?.trim() || undefined;
    }
  }

  if (!token) {
    console.log(chalk.yellow('⚠️  No project selected; this profile uses the shared project until you run `codemie setup` again.\n'));
    return undefined;
  }
  try {
    const { project } = await select({ apiUrl, jwtToken: token });
    return project;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`⚠️  Could not list projects (${message}); no project saved.\n`));
    return undefined;
  }
}

export const JWTBearerSetupSteps: ProviderSetupSteps = {
  name: ProviderName.BEARER_AUTH,

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

    let tokenEnvVar = JWT_TOKEN_DEFAULT_ENV_VAR;

    if (tokenConfigAnswers.customEnvVar) {
      const envVarAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'envVar',
          message: 'Environment variable name:',
          default: JWT_TOKEN_DEFAULT_ENV_VAR,
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

    // Step 3: CodeMie project for this profile (EPMCDME-15411)
    const codeMieProject = await selectJwtProfileProject(baseUrl, tokenEnvVar);

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
        codeMieProject,
        authMethod: AuthMethod.JWT,
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
      'claude-sonnet-4-6',
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

    const codeMieProject = credentials.additionalConfig?.codeMieProject as string | undefined;
    return {
      provider: ProviderName.BEARER_AUTH,
      codeMieUrl: credentials.additionalConfig?.codeMieUrl as string | undefined,  // Base URL (user input)
      baseUrl: credentials.baseUrl,  // Full API URL with suffix
      model: selectedModel,
      authMethod: AuthMethod.JWT,
      jwtConfig,
      ...(codeMieProject ? { codeMieProject } : {})
    };
  },

  async validateAuth(config: CodeMieConfigOptions): Promise<AuthValidationResult> {
    // Check if JWT token is available at runtime
    const token = resolveJwtToken(config);

    if (!token) {
      return {
        valid: false,
        error: `JWT token not found in ${resolveJwtTokenEnvVar(config)} environment variable`
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
