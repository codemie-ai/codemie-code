import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { FirstTimeExperience } from '../../utils/first-time.js';
import { ChatOpenAI } from '@langchain/openai';

interface ProviderOption {
  name: string;
  value: string;
  baseUrl: string;
  models: string[];
}

const PROVIDERS: ProviderOption[] = [
  {
    name: 'AI/Run CodeMie (Recommended - Unified AI Gateway)',
    value: 'ai-run',
    baseUrl: 'https://ai.run/api/v1',
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
    name: 'Anthropic (Direct API)',
    value: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4', 'claude-opus-4', 'claude-haiku-4']
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

  // Step 1: Choose provider
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your LLM provider:',
      choices: PROVIDERS.map(p => ({ name: p.name, value: p.value }))
    }
  ]);

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

  // Model selection
  if (selectedProvider.models.length > 0) {
    const { selectedModel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedModel',
        message: 'Choose a model:',
        choices: [
          ...selectedProvider.models,
          { name: 'Custom model...', value: 'custom' }
        ]
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

  // Optional: Timeout
  const { timeout } = await inquirer.prompt([
    {
      type: 'number',
      name: 'timeout',
      message: 'Request timeout (seconds):',
      default: 300,
      validate: (input: number) => input > 0 || 'Timeout must be positive'
    }
  ]);

  // Step 3: Test connection
  const { testConnection } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'testConnection',
      message: 'Test connection before saving?',
      default: true
    }
  ]);

  if (testConnection) {
    const spinner = ora('Testing connection...').start();

    try {
      const testConfig: CodeMieConfigOptions = {
        provider,
        baseUrl,
        apiKey,
        model,
        timeout
      };

      await testConnectionToProvider(testConfig);
      spinner.succeed(chalk.green(`Connected successfully to ${model}`));
    } catch (error: unknown) {
      spinner.fail(chalk.red('Connection test failed'));
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`Error: ${errorMessage}\n`));

      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Save configuration anyway?',
          default: false
        }
      ]);

      if (!continueAnyway) {
        console.log(chalk.yellow('\nSetup cancelled.\n'));
        return;
      }
    }
  }

  // Step 4: Save configuration
  const config: Partial<CodeMieConfigOptions> = {
    provider,
    baseUrl,
    apiKey,
    model,
    timeout,
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

/**
 * Test connection to AI provider
 */
async function testConnectionToProvider(config: CodeMieConfigOptions): Promise<void> {
  try {
    const llm = new ChatOpenAI({
      modelName: config.model,
      configuration: {
        baseURL: config.baseUrl,
        apiKey: config.apiKey
      },
      timeout: (config.timeout || 300) * 1000,
      maxRetries: 1
    });

    // Try a simple invocation
    const response = await llm.invoke('Say "test successful"');

    if (!response || !response.content) {
      throw new Error('Empty response from model');
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      // Parse common error types
      if (error.message.includes('401') || error.message.includes('unauthorized')) {
        throw new Error('Invalid API key');
      } else if (error.message.includes('404') || error.message.includes('not found')) {
        throw new Error('Invalid base URL or model not found');
      } else if (error.message.includes('timeout')) {
        throw new Error('Connection timeout - check your network or base URL');
      } else {
        throw new Error(`Connection failed: ${error.message}`);
      }
    }
    throw error;
  }
}
