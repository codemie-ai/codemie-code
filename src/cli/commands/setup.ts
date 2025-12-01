import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { checkProviderHealth } from '../../utils/health-checker.js';
import { fetchAvailableModels } from '../../utils/model-fetcher.js';
import { CodeMieSSO } from '../../utils/sso-auth.js';
import { fetchCodeMieModels } from '../../utils/codemie-model-fetcher.js';
import { validateCodeMieIntegrations } from '../../utils/codemie-integration-validator.js';

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
    name: 'Google Gemini (Direct API Access)',
    value: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-pro', 'gemini-1.5-flash']
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
  const hasConfig = await ConfigLoader.hasGlobalConfig();
  let profileName: string | null = null;
  let isUpdate = false;

  if (!force && hasConfig) {
    const profiles = await ConfigLoader.listProfiles();

    if (profiles.length > 0) {
      console.log(chalk.cyan('\n📋 Existing Profiles:\n'));
      profiles.forEach(({ name, active, profile }) => {
        const activeMarker = active ? chalk.green('● ') : chalk.white('○ ');
        console.log(`${activeMarker}${chalk.white(name)} (${profile.provider})`);
      });
      console.log('');
    }

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Add a new profile', value: 'add' },
          { name: 'Update an existing profile', value: 'update' },
          { name: 'Cancel', value: 'cancel' }
        ]
      }
    ]);

    if (action === 'cancel') {
      console.log(chalk.yellow('\nSetup cancelled.\n'));
      return;
    }

    if (action === 'update') {
      const { selectedProfile } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedProfile',
          message: 'Select profile to update:',
          choices: profiles.map(p => ({ name: p.name, value: p.name }))
        }
      ]);
      profileName = selectedProfile;
      isUpdate = true;
      console.log(chalk.white(`\nUpdating profile: ${chalk.cyan(profileName)}\n`));
    } else {
      // Adding new profile - will ask for name at the end
      console.log(chalk.white('\nConfiguring new profile...\n'));
    }
  } else {
    // First time setup - will create default profile or ask for name at the end
    console.log(chalk.white("Let's configure your AI assistant.\n"));
  }

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
    await handleAiRunSSOSetup(profileName, isUpdate);
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
    console.log(chalk.white('AWS Bedrock requires AWS access credentials and region configuration.'));
    console.log(chalk.white('AWS credentials can be configured in multiple ways:\n'));
    console.log(chalk.white('  1. AWS CLI profiles (recommended): ~/.aws/credentials'));
    console.log(chalk.white('  2. Environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY'));
    console.log(chalk.white('  3. IAM roles (for EC2/ECS instances)\n'));

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
      console.log(chalk.white('Please configure AWS credentials before proceeding:\n'));
      console.log(chalk.cyan('  Option 1: Install and configure AWS CLI'));
      console.log(chalk.white('    $ ') + chalk.green('aws configure'));
      console.log(chalk.white('    Enter your AWS Access Key ID and Secret Access Key\n'));
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
    process.env.AWS_REGION = awsRegion ? awsRegion.trim() : awsRegion;
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    if (useProfile && awsProfile) {
      process.env.AWS_PROFILE = awsProfile ? awsProfile.trim() : awsProfile;
    }

    console.log(chalk.green('\n✓ Bedrock configuration set'));
    console.log(chalk.white('  AWS_REGION=' + (awsRegion ? awsRegion.trim() : awsRegion)));
    if (useProfile && awsProfile) {
      console.log(chalk.white('  AWS_PROFILE=' + (awsProfile ? awsProfile.trim() : awsProfile)));
    }
    console.log(chalk.white('  CLAUDE_CODE_USE_BEDROCK=1\n'));

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
    baseUrl = answers.baseUrl ? answers.baseUrl.trim() : answers.baseUrl;
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
    if (customUrl && customUrl.trim() !== '') {
      baseUrl = customUrl.trim();
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
    apiKey = apiKeyInput ? apiKeyInput.trim() : apiKeyInput;
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
      { name: chalk.white('Custom model (manual entry)...'), value: 'custom' }
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
      model = customModel ? customModel.trim() : customModel;
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
    model = modelInput ? modelInput.trim() : modelInput;
  }

  // Step 3: Ask for profile name (if creating new)
  if (!isUpdate && profileName === null) {
    const profiles = await ConfigLoader.listProfiles();
    const existingNames = profiles.map(p => p.name);

    // Suggest a default name based on provider
    let defaultName = 'default';
    if (existingNames.length > 0) {
      // If profiles exist, suggest provider-based name
      defaultName = provider === 'ai-run-sso' ? 'codemie-sso' : provider;
      // Make it unique if needed
      let counter = 1;
      let suggestedName = defaultName;
      while (existingNames.includes(suggestedName)) {
        suggestedName = `${defaultName}-${counter}`;
        counter++;
      }
      defaultName = suggestedName;
    }

    const { newProfileName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'newProfileName',
        message: 'Enter a name for this profile:',
        default: defaultName,
        validate: (input: string) => {
          if (!input.trim()) return 'Profile name is required';
          if (existingNames.includes(input.trim())) {
            return 'A profile with this name already exists';
          }
          return true;
        }
      }
    ]);
    profileName = newProfileName ? newProfileName.trim() : newProfileName;
  }

  // Step 4: Enable analytics by default (only for first-time setup)
  let enableAnalytics = false;
  if (!isUpdate) {
    const profiles = await ConfigLoader.listProfiles();
    const isFirstProfile = profiles.length === 0;

    if (isFirstProfile) {
      enableAnalytics = true;
    }
  }

  // Step 5: Save configuration as profile
  const profile: Partial<CodeMieConfigOptions> = {
    name: profileName!,
    provider,
    baseUrl,
    apiKey,
    model,
    timeout: 300,
    debug: false
  };

  const spinner = ora('Saving profile...').start();

  try {
    await ConfigLoader.saveProfile(profileName!, profile as any);

    // Save analytics config if this is first profile
    if (enableAnalytics !== false) {
      const config = await ConfigLoader.loadMultiProviderConfig();
      if (!config.analytics) {
        config.analytics = {
          enabled: enableAnalytics,
          target: 'local',
          localPath: '~/.codemie/analytics',
          flushInterval: 5000,
          maxBufferSize: 100
        };
        await ConfigLoader.saveMultiProviderConfig(config);
      }
    }

    spinner.succeed(chalk.green(`Profile "${profileName}" saved to ~/.codemie/config.json`));

    // If this is a new profile, ask if user wants to switch to it
    if (!isUpdate) {
      const activeProfile = await ConfigLoader.getActiveProfileName();
      if (activeProfile !== profileName) {
        const { switchToNew } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'switchToNew',
            message: `Switch to profile "${profileName}" as active?`,
            default: true
          }
        ]);

        if (switchToNew) {
          await ConfigLoader.switchProfile(profileName!);
          console.log(chalk.green(`✓ Switched to profile "${profileName}"`));
        }
      }
    }
  } catch (error: unknown) {
    spinner.fail(chalk.red('Failed to save profile'));
    throw error;
  }

  // Success message
  console.log(chalk.bold.green(`\n✅ Profile "${profileName}" configured successfully!\n`));
  console.log(chalk.cyan(`🔗 Provider: ${provider}`));
  console.log(chalk.cyan(`🤖 Model: ${model}`));
  console.log(chalk.cyan(`📁 Config: ~/.codemie/config.json\n`));
  console.log(chalk.bold(`🚀 Ready to use! Try: ${chalk.white('codemie-code "test task"')}\n`));
}

async function handleAiRunSSOSetup(profileName: string | null, isUpdate: boolean): Promise<void> {
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

  // Trim the URL to ensure no leading/trailing spaces
  const trimmedCodeMieUrl = codeMieUrl ? codeMieUrl.trim() : codeMieUrl;

  // Step 2: Proceed directly to SSO authentication (no connectivity check)
  // Following the same pattern as codemie-ide-plugin which trusts the SSO endpoint

  // Step 3: Launch SSO Authentication
  console.log(chalk.white('\nStarting SSO authentication...\n'));
  const authSpinner = ora('Launching browser for authentication...').start();

  try {
    const sso = new CodeMieSSO();
    const authResult = await sso.authenticate({ codeMieUrl: trimmedCodeMieUrl, timeout: 120000 });

    if (!authResult.success) {
      authSpinner.fail(chalk.red('SSO authentication failed'));
      console.log(chalk.red(`  Error: ${authResult.error}\n`));
      return;
    }

    authSpinner.succeed(chalk.green('SSO authentication successful'));

    // Step 4a: Validate CodeMie integrations
    const integrationsSpinner = ora('Checking CodeMie integrations...').start();

    let selectedIntegration: { id: string; alias: string } | null;
    try {
      selectedIntegration = await validateCodeMieIntegrations(authResult, integrationsSpinner);
      if (selectedIntegration) {
        integrationsSpinner.succeed(chalk.green('CodeMie integration selected'));
      } else {
        integrationsSpinner.info(chalk.white('Continuing without integration'));
      }
    } catch {
      integrationsSpinner.stop();
      // Error details already displayed by validateCodeMieIntegrations
      return;
    }

    // Step 4b: Fetch available models from CodeMie
    const modelsSpinner = ora('Fetching available models from CodeMie...').start();

    try {
      const models = await fetchCodeMieModels(authResult.apiUrl!, authResult.cookies!);
      modelsSpinner.succeed(chalk.green(`Found ${models.length} available models`));

      // Step 5: Model selection
      const selectedModel = await promptForModelSelection(models);

      // Step 6: Ask for profile name (if creating new)
      let finalProfileName = profileName;
      if (!isUpdate && profileName === null) {
        const profiles = await ConfigLoader.listProfiles();
        const existingNames = profiles.map(p => p.name);

        // Suggest a default name
        let defaultName = 'codemie-sso';
        if (existingNames.length > 0) {
          let counter = 1;
          let suggestedName = defaultName;
          while (existingNames.includes(suggestedName)) {
            suggestedName = `${defaultName}-${counter}`;
            counter++;
          }
          defaultName = suggestedName;
        } else {
          defaultName = 'default';
        }

        const { newProfileName } = await inquirer.prompt([
          {
            type: 'input',
            name: 'newProfileName',
            message: 'Enter a name for this profile:',
            default: defaultName,
            validate: (input: string) => {
              if (!input.trim()) return 'Profile name is required';
              if (existingNames.includes(input.trim())) {
                return 'A profile with this name already exists';
              }
              return true;
            }
          }
        ]);
        finalProfileName = newProfileName ? newProfileName.trim() : newProfileName;
      }

      // Step 6.5: Enable analytics by default (only for first-time setup)
      let enableAnalytics = false;
      if (!isUpdate) {
        const profiles = await ConfigLoader.listProfiles();
        const isFirstProfile = profiles.length === 0;

        if (isFirstProfile) {
          enableAnalytics = true;
        }
      }

      // Step 7: Save configuration as profile
      const profile: Partial<CodeMieConfigOptions> = {
        name: finalProfileName!,
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl: trimmedCodeMieUrl,
        baseUrl: authResult.apiUrl,
        apiKey: 'sso-authenticated',
        model: selectedModel,
        timeout: 300,
        debug: false
      };

      // Only add integration if one was selected
      if (selectedIntegration) {
        profile.codeMieIntegration = selectedIntegration;
      }

      const saveSpinner = ora('Saving profile...').start();
      await ConfigLoader.saveProfile(finalProfileName!, profile as any);

      // Save analytics config if this is first profile
      if (enableAnalytics !== false) {
        const config = await ConfigLoader.loadMultiProviderConfig();
        if (!config.analytics) {
          config.analytics = {
            enabled: enableAnalytics,
            target: 'local',
            localPath: '~/.codemie/analytics',
            flushInterval: 5000,
            maxBufferSize: 100
          };
          await ConfigLoader.saveMultiProviderConfig(config);
        }
      }

      saveSpinner.succeed(chalk.green(`Profile "${finalProfileName}" saved to ~/.codemie/config.json`));

      // If this is a new profile, ask if user wants to switch to it
      if (!isUpdate) {
        const activeProfile = await ConfigLoader.getActiveProfileName();
        if (activeProfile !== finalProfileName) {
          const { switchToNew } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'switchToNew',
              message: `Switch to profile "${finalProfileName}" as active?`,
              default: true
            }
          ]);

          if (switchToNew) {
            await ConfigLoader.switchProfile(finalProfileName!);
            console.log(chalk.green(`✓ Switched to profile "${finalProfileName}"`));
          }
        }
      }

      // Success message
      console.log(chalk.bold.green(`\n✅ Profile "${finalProfileName}" configured successfully!\n`));
      console.log(chalk.cyan(`🔗 Connected to: ${trimmedCodeMieUrl}`));
      console.log(chalk.cyan(`🔑 Authentication: SSO (session stored securely)`));
      console.log(chalk.cyan(`🤖 Selected Model: ${selectedModel}`));
      console.log(chalk.cyan(`📁 Config saved to: ~/.codemie/config.json\n`));
      console.log(chalk.bold(`🚀 Ready to use! Try: ${chalk.white('codemie-code "test task"')}\n`));

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

      // Ask for profile name (if creating new)
      let finalProfileName = profileName;
      if (!isUpdate && profileName === null) {
        const profiles = await ConfigLoader.listProfiles();
        const existingNames = profiles.map(p => p.name);

        let defaultName = 'codemie-sso';
        if (existingNames.length > 0) {
          let counter = 1;
          let suggestedName = defaultName;
          while (existingNames.includes(suggestedName)) {
            suggestedName = `${defaultName}-${counter}`;
            counter++;
          }
          defaultName = suggestedName;
        } else {
          defaultName = 'default';
        }

        const { newProfileName } = await inquirer.prompt([
          {
            type: 'input',
            name: 'newProfileName',
            message: 'Enter a name for this profile:',
            default: defaultName,
            validate: (input: string) => {
              if (!input.trim()) return 'Profile name is required';
              if (existingNames.includes(input.trim())) {
                return 'A profile with this name already exists';
              }
              return true;
            }
          }
        ]);
        finalProfileName = newProfileName ? newProfileName.trim() : newProfileName;
      }

      // Enable analytics by default (only for first-time setup)
      let enableAnalytics = false;
      if (!isUpdate) {
        const profiles = await ConfigLoader.listProfiles();
        const isFirstProfile = profiles.length === 0;

        if (isFirstProfile) {
          enableAnalytics = true;
        }
      }

      // Save config with manual model as profile
      const profile: Partial<CodeMieConfigOptions> = {
        name: finalProfileName!,
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl: trimmedCodeMieUrl,
        baseUrl: authResult.apiUrl,
        apiKey: 'sso-authenticated',
        model: manualModel ? manualModel.trim() : manualModel,
        timeout: 300,
        debug: false
      };

      // Only add integration if one was selected
      if (selectedIntegration) {
        profile.codeMieIntegration = selectedIntegration;
      }

      await ConfigLoader.saveProfile(finalProfileName!, profile as any);

      // Save analytics config if this is first profile
      if (enableAnalytics !== false) {
        const config = await ConfigLoader.loadMultiProviderConfig();
        if (!config.analytics) {
          config.analytics = {
            enabled: enableAnalytics,
            target: 'local',
            localPath: '~/.codemie/analytics',
            flushInterval: 5000,
            maxBufferSize: 100
          };
          await ConfigLoader.saveMultiProviderConfig(config);
        }
      }

      console.log(chalk.green(`\n✅ Profile "${finalProfileName}" saved with manual model selection.\n`));
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
    return manualModel ? manualModel.trim() : manualModel;
  }

  // Add custom option at the end
  const choices = [
    ...models,
    { name: chalk.white('Custom model (manual entry)...'), value: 'custom' }
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
    return customModel ? customModel.trim() : customModel;
  }

  return selectedModel;
}
