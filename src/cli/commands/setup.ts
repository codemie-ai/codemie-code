import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { FirstTimeExperience } from '../../utils/first-time.js';
import { checkProviderHealth } from '../../utils/health-checker.js';
import { fetchAvailableModels } from '../../utils/model-fetcher.js';
import { CodeMieSSO } from '../../utils/sso-auth.js';
import { fetchCodeMieModels } from '../../utils/codemie-model-fetcher.js';

interface ProviderOption {
  name: string;
  value: string;
  baseUrl: string;
  models: string[];
}

const PROVIDERS: ProviderOption[] = [
  {
    name: 'CodeMie SSO (Recommended - Enterprise Authentication)',
    value: 'ai-run-sso',
    baseUrl: '', // Will be resolved from CodeMie URL
    models: [] // Will be fetched from CodeMie /v1/llm_models endpoint
  },
  {
    name: 'LiteLLM Proxy (OpenAI-compatible Gateway)',
    value: 'litellm',
    baseUrl: 'https://litellm.example.com',
    models: ['claude-4-5-sonnet', 'claude-opus-4', 'gpt-4.1', 'gpt-5']
  },
  {
    name: 'AWS Bedrock (Claude via AWS)',
    value: 'bedrock',
    baseUrl: '',
    models: [
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'us.anthropic.claude-opus-4-0-20250514-v1:0',
      'anthropic.claude-3-5-sonnet-20241022-v2:0'
    ]
  },
  {
    name: 'Azure OpenAI (for GPT models and Codex)',
    value: 'azure',
    baseUrl: '',
    models: []
  }
];

export function createSetupCommand(): Command {
  const command = new Command('setup');

  command
    .description('Interactive setup wizard for CodeMie Code')
    .option('--force', 'Force re-setup even if config exists')
    .action(async (options: { force?: boolean }) => {
      try {
        await runSetupWizard(options.force);
      } catch (error: unknown) {
        logger.error('Setup failed:', error);
        process.exit(1);
      }
    });

  return command;
}

async function runSetupWizard(force?: boolean): Promise<void> {
  console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║   Welcome to CodeMie Code Setup!     ║'));
  console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

  // Check if config already exists
  if (!force && await ConfigLoader.hasGlobalConfig()) {
    const { proceed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: 'Configuration already exists. Do you want to reconfigure?',
        default: false
      }
    ]);

    if (!proceed) {
      console.log(chalk.yellow('\nSetup cancelled. Use --force to reconfigure.\n'));
      return;
    }
  }

  console.log(chalk.dim("Let's configure your AI assistant.\n"));

  // Step 1: Choose provider (ai-run-sso is now first/default)
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your LLM provider:',
      choices: PROVIDERS.map(p => ({ name: p.name, value: p.value })),
      default: 'ai-run-sso' // Make SSO the default
    }
  ]);

  if (provider === 'ai-run-sso') {
    await handleAiRunSSOSetup();
    return; // Early return for SSO flow
  }

  const selectedProvider = PROVIDERS.find(p => p.value === provider)!;

  // Step 2: Provider details
  let baseUrl = selectedProvider.baseUrl;
  let apiKey = '';
  let model = selectedProvider.models[0] || '';

  // Special handling for AWS Bedrock
  if (provider === 'bedrock') {
    console.log(chalk.bold.cyan('\n📝 AWS Bedrock Configuration\n'));
    console.log(chalk.dim('AWS Bedrock requires AWS access credentials and region configuration.'));
    console.log(chalk.dim('AWS credentials can be configured in multiple ways:\n'));
    console.log(chalk.dim('  1. AWS CLI profiles (recommended): ~/.aws/credentials'));
    console.log(chalk.dim('  2. Environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY'));
    console.log(chalk.dim('  3. IAM roles (for EC2/ECS instances)\n'));

    // Check if AWS credentials might be available
    const hasAwsCli = await (async () => {
      try {
        const { exec } = await import('../../utils/exec.js');
        await exec('aws', ['--version']);
        return true;
      } catch {
        return false;
      }
    })();

    const hasAwsEnvVars = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

    if (!hasAwsCli && !hasAwsEnvVars) {
      console.log(chalk.yellow('⚠️  AWS CLI not detected and no AWS environment variables found.\n'));
      console.log(chalk.dim('Please configure AWS credentials before proceeding:\n'));
      console.log(chalk.cyan('  Option 1: Install and configure AWS CLI'));
      console.log(chalk.white('    $ ') + chalk.green('aws configure'));
      console.log(chalk.dim('    Enter your AWS Access Key ID and Secret Access Key\n'));
      console.log(chalk.cyan('  Option 2: Set environment variables'));
      console.log(chalk.white('    $ ') + chalk.green('export AWS_ACCESS_KEY_ID="your-access-key"'));
      console.log(chalk.white('    $ ') + chalk.green('export AWS_SECRET_ACCESS_KEY="your-secret-key"\n'));

      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue with Bedrock setup anyway?',
          default: false
        }
      ]);

      if (!continueAnyway) {
        console.log(chalk.yellow('\nBedrock setup cancelled. Please configure AWS credentials first.\n'));
        process.exit(0);
      }
    } else if (hasAwsCli) {
      console.log(chalk.green('✓ AWS CLI detected\n'));
    } else if (hasAwsEnvVars) {
      console.log(chalk.green('✓ AWS environment variables detected\n'));
    }

    // Ask for AWS configuration
    const { awsRegion, awsProfile, useProfile } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useProfile',
        message: 'Use AWS CLI profile?',
        default: hasAwsCli,
        when: hasAwsCli
      },
      {
        type: 'input',
        name: 'awsProfile',
        message: 'AWS profile name:',
        default: 'default',
        when: (answers: any) => answers.useProfile
      },
      {
        type: 'input',
        name: 'awsRegion',
        message: 'AWS Region:',
        default: 'us-west-2',
        validate: (input: string) => input.trim() !== '' || 'AWS region is required'
      }
    ]);

    // Set environment variables for Bedrock
    process.env.AWS_REGION = awsRegion;
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    if (useProfile && awsProfile) {
      process.env.AWS_PROFILE = awsProfile;
    }

    console.log(chalk.green('\n✓ Bedrock configuration set'));
    console.log(chalk.dim('  AWS_REGION=' + awsRegion));
    if (useProfile && awsProfile) {
      console.log(chalk.dim('  AWS_PROFILE=' + awsProfile));
    }
    console.log(chalk.dim('  CLAUDE_CODE_USE_BEDROCK=1\n'));

    // For Bedrock, we don't need base URL or API key (uses AWS credentials)
    baseUrl = 'bedrock';
    apiKey = 'bedrock'; // Placeholder
  } else if (!baseUrl) {
    // Custom provider - ask for base URL
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Enter API base URL:',
        validate: (input: string) => input.trim() !== '' || 'Base URL is required'
      }
    ]);
    baseUrl = answers.baseUrl;
  } else {
    // Prompt for base URL directly (no default)
    const { customUrl } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customUrl',
        message: `Enter base URL (default: ${baseUrl}):`,
        validate: (input: string) => {
          // Allow empty input to use default
          if (input.trim() === '') return true;
          // Otherwise validate it's not just whitespace
          return input.trim() !== '' || 'Base URL is required';
        }
      }
    ]);

    // Use custom URL if provided, otherwise keep default
    if (customUrl.trim() !== '') {
      baseUrl = customUrl;
    }
  }

  // API Key (skip for Bedrock as it uses AWS credentials)
  if (provider !== 'bedrock') {
    const { apiKeyInput } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKeyInput',
        message: 'Enter your API key:',
        mask: '*',
        validate: (input: string) => input.trim() !== '' || 'API key is required'
      }
    ]);
    apiKey = apiKeyInput;
  }

  // Step 2.5: Validate credentials and fetch models
  let availableModels: string[] = [];

  if (provider !== 'bedrock') {
    const healthSpinner = ora('Validating credentials...').start();

    try {
      const healthCheck = await checkProviderHealth(baseUrl, apiKey);

      if (!healthCheck.success) {
        healthSpinner.fail(chalk.red('Validation failed'));
        console.log(chalk.red(`  Error: ${healthCheck.message}\n`));

        const { continueAnyway } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continueAnyway',
            message: 'Continue with setup anyway?',
            default: false
          }
        ]);

        if (!continueAnyway) {
          console.log(chalk.yellow('\nSetup cancelled. Please check your credentials.\n'));
          return;
        }
      } else {
        healthSpinner.succeed(chalk.green('Credentials validated'));

        // Fetch available models
        const modelsSpinner = ora('Fetching available models...').start();

        try {
          availableModels = await fetchAvailableModels({
            provider,
            baseUrl,
            apiKey,
            model: 'temp', // Temporary, not used for fetching
            timeout: 300
          });

          if (availableModels.length > 0) {
            modelsSpinner.succeed(chalk.green(`Found ${availableModels.length} available models`));
          } else {
            modelsSpinner.warn(chalk.yellow('No models found - will use manual entry'));
          }
        } catch {
          modelsSpinner.warn(chalk.yellow('Could not fetch models - will use manual entry'));
          availableModels = [];
        }
      }
    } catch (error) {
      healthSpinner.fail(chalk.red('Validation error'));
      console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}\n`));

      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue with setup anyway?',
          default: false
        }
      ]);

      if (!continueAnyway) {
        console.log(chalk.yellow('\nSetup cancelled.\n'));
        return;
      }
    }
  }

  // Model selection
  // Use fetched models if available, otherwise fall back to provider defaults
  const modelChoices = availableModels.length > 0
    ? availableModels
    : selectedProvider.models;

  if (modelChoices.length > 0) {
    // Add custom option at the end
    const choices = [
      ...modelChoices,
      { name: chalk.dim('Custom model (manual entry)...'), value: 'custom' }
    ];

    const { selectedModel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedModel',
        message: availableModels.length > 0
          ? `Choose a model (${availableModels.length} available):`
          : 'Choose a model:',
        choices,
        pageSize: 15
      }
    ]);

    if (selectedModel === 'custom') {
      const { customModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customModel',
          message: 'Enter model name:',
          validate: (input: string) => input.trim() !== '' || 'Model is required'
        }
      ]);
      model = customModel;
    } else {
      model = selectedModel;
    }
  } else {
    const { modelInput } = await inquirer.prompt([
      {
        type: 'input',
        name: 'modelInput',
        message: 'Enter model name:',
        validate: (input: string) => input.trim() !== '' || 'Model is required'
      }
    ]);
    model = modelInput;
  }

  // Step 3: Save configuration (credentials already validated)
  const config: Partial<CodeMieConfigOptions> = {
    provider,
    baseUrl,
    apiKey,
    model,
    timeout: 300, // Default timeout for most users
    debug: false
  };

  const spinner = ora('Saving configuration...').start();

  try {
    await ConfigLoader.saveGlobalConfig(config);
    spinner.succeed(chalk.green('Configuration saved to ~/.codemie/config.json'));
  } catch (error: unknown) {
    spinner.fail(chalk.red('Failed to save configuration'));
    throw error;
  }

  // Success message - use first-time experience utility
  FirstTimeExperience.showPostSetupMessage();
}

async function handleAiRunSSOSetup(): Promise<void> {
  console.log(chalk.bold.cyan('\n🔐 CodeMie SSO Configuration\n'));

  // Step 1: Get CodeMie URL
  const { codeMieUrl } = await inquirer.prompt([
    {
      type: 'input',
      name: 'codeMieUrl',
      message: 'Enter CodeMie URL:',
      default: 'https://codemie.lab.epam.com',
      validate: (input: string) => {
        const trimmed = input.trim();
        if (!trimmed) return 'CodeMie URL is required';
        if (!trimmed.startsWith('http')) return 'URL must start with http:// or https://';
        try {
          new URL(trimmed);
          return true;
        } catch {
          return 'Please enter a valid URL';
        }
      }
    }
  ]);

  // Step 2: Proceed directly to SSO authentication (no connectivity check)
  // Following the same pattern as codemie-ide-plugin which trusts the SSO endpoint

  // Step 3: Launch SSO Authentication
  console.log(chalk.dim('\nStarting SSO authentication...\n'));
  const authSpinner = ora('Launching browser for authentication...').start();

  try {
    const sso = new CodeMieSSO();
    const authResult = await sso.authenticate({ codeMieUrl, timeout: 120000 });

    if (!authResult.success) {
      authSpinner.fail(chalk.red('SSO authentication failed'));
      console.log(chalk.red(`  Error: ${authResult.error}\n`));
      return;
    }

    authSpinner.succeed(chalk.green('SSO authentication successful'));

    // Step 4: Fetch available models from CodeMie
    const modelsSpinner = ora('Fetching available models from CodeMie...').start();

    try {
      const models = await fetchCodeMieModels(authResult.apiUrl!, authResult.cookies!);
      modelsSpinner.succeed(chalk.green(`Found ${models.length} available models`));

      // Step 5: Model selection
      const selectedModel = await promptForModelSelection(models);

      // Step 6: Save configuration
      const config: Partial<CodeMieConfigOptions> = {
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl,
        baseUrl: authResult.apiUrl,
        apiKey: 'sso-authenticated', // Placeholder - auth via cookies
        model: selectedModel,
        timeout: 300,
        debug: false
      };

      const saveSpinner = ora('Saving configuration...').start();
      await ConfigLoader.saveGlobalConfig(config);
      saveSpinner.succeed(chalk.green('Configuration saved to ~/.codemie/config.json'));

      // Success message
      console.log(chalk.bold.green('\n✅ CodeMie SSO setup completed successfully!\n'));
      console.log(chalk.cyan(`🔗 Connected to: ${codeMieUrl}`));
      console.log(chalk.cyan(`🔑 Authentication: SSO (session stored securely)`));
      console.log(chalk.cyan(`🤖 Selected Model: ${selectedModel}`));
      console.log(chalk.cyan(`📁 Config saved to: ~/.codemie/config.json\n`));
      console.log(chalk.bold(`🚀 Ready to use! Try: ${chalk.white('codemie-code --task "explore current repository"')}\n`));
      console.log(chalk.dim(`   Or start interactive mode: ${chalk.white('codemie-code')}\n`));
      console.log(chalk.yellow(`💡 Install additional agents with: ${chalk.white('codemie install claude')}\n`));

    } catch (error) {
      modelsSpinner.fail(chalk.red('Failed to fetch models'));
      console.log(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}\n`));

      // Continue with manual model entry
      const { manualModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'manualModel',
          message: 'Enter model name manually:',
          default: 'claude-4-5-sonnet',
          validate: (input: string) => input.trim() !== '' || 'Model name is required'
        }
      ]);

      // Save config with manual model
      const config: Partial<CodeMieConfigOptions> = {
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl,
        baseUrl: authResult.apiUrl,
        apiKey: 'sso-authenticated',
        model: manualModel,
        timeout: 300,
        debug: false
      };

      await ConfigLoader.saveGlobalConfig(config);
      console.log(chalk.green('\n✅ Configuration saved with manual model selection.\n'));
    }

  } catch (error) {
    authSpinner.fail(chalk.red('Authentication error'));
    console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}\n`));
    return;
  }
}

async function promptForModelSelection(models: string[]): Promise<string> {
  if (models.length === 0) {
    const { manualModel } = await inquirer.prompt([
      {
        type: 'input',
        name: 'manualModel',
        message: 'No models found. Enter model name manually:',
        default: 'claude-4-5-sonnet',
        validate: (input: string) => input.trim() !== '' || 'Model name is required'
      }
    ]);
    return manualModel;
  }

  // Add custom option at the end
  const choices = [
    ...models,
    { name: chalk.dim('Custom model (manual entry)...'), value: 'custom' }
  ];

  const { selectedModel } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedModel',
      message: `Choose a model (${models.length} available):`,
      choices,
      pageSize: 15
    }
  ]);

  if (selectedModel === 'custom') {
    const { customModel } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customModel',
        message: 'Enter model name:',
        validate: (input: string) => input.trim() !== '' || 'Model is required'
      }
    ]);
    return customModel;
  }

  return selectedModel;
}
