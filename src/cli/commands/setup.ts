import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { ProviderRegistry } from '../../providers/index.js';
import {
  getAllProviderChoices,
  displaySetupSuccess,
  displaySetupError,
  getAllModelChoices,
  displaySetupInstructions
} from '../../providers/integration/setup-ui.js';


export function createSetupCommand(): Command {
  const command = new Command('setup');

  command
    .description('Interactive setup wizard for CodeMie Code')
    .option('--force', 'Force re-setup even if config exists')
    .option('-v, --verbose', 'Enable verbose debug output with detailed API logs')
    .action(async (options: { force?: boolean; verbose?: boolean }) => {
      // Enable debug mode if verbose flag is set
      if (options.verbose) {
        process.env.CODEMIE_DEBUG = 'true';

        // Show log file location
        const logFilePath = logger.getLogFilePath();
        if (logFilePath) {
          console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
        }
      }

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
  console.log(chalk.bold.cyan('\n'));
  console.log(chalk.bold.cyan('╔═══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║   Welcome to CodeMie Code Setup!      ║'));
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
      // Config file exists but no profiles - treat as fresh setup
      console.log(chalk.white("Let's configure your AI assistant.\n"));
    }
  } else {
    // First time setup - will create default profile or ask for name at the end
    console.log(chalk.white("Let's configure your AI assistant.\n"));
  }

  // Step 1: Get all registered providers from ProviderRegistry
  const registeredProviders = ProviderRegistry.getAllProviders();
  const allProviderChoices = getAllProviderChoices(registeredProviders);

  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your LLM provider:\n',
      choices: allProviderChoices,
      pageSize: 15,
      // Default to highest priority provider (SSO has priority 0)
      default: allProviderChoices[0]?.value
    }
  ]);

  // Get setup steps from provider registry
  const setupSteps = ProviderRegistry.getSetupSteps(provider);

  if (!setupSteps) {
    throw new Error(`Provider "${provider}" does not have setup steps configured`);
  }

  // Use plugin-based setup flow
  await handlePluginSetup(provider, setupSteps, profileName, isUpdate);
}

/**
 * Handle plugin-based setup flow
 *
 * Uses ProviderSetupSteps from ProviderRegistry for clean, extensible setup
 */
async function handlePluginSetup(
  providerName: string,
  setupSteps: any,
  profileName: string | null,
  isUpdate: boolean
): Promise<void> {
  try {
    const providerTemplate = ProviderRegistry.getProvider(providerName);

    // Display setup instructions if available
    if (providerTemplate) {
      displaySetupInstructions(providerTemplate);
    }

    // Step 1: Get credentials
    const credentials = await setupSteps.getCredentials(isUpdate);

    // Step 2: Fetch models
    const modelsSpinner = ora('Fetching available models...').start();
    let models: string[] = [];

    try {
      models = await setupSteps.fetchModels(credentials);
      modelsSpinner.succeed(chalk.green(`Found ${models.length} available models`));
    } catch {
      modelsSpinner.warn(chalk.yellow('Could not fetch models - will use manual entry'));
      models = [];
    }

    // Step 3: Model selection
    const selectedModel = await promptForModelSelection(models, providerTemplate);

    // Step 3.5: Install model if provider supports it (e.g., Ollama)
    if (providerTemplate?.supportsModelInstallation && setupSteps.installModel) {
      await setupSteps.installModel(credentials, selectedModel, models);
    }

    // Step 4: Build configuration
    const config = setupSteps.buildConfig(credentials, selectedModel);

    // Step 5: Ask for profile name (if creating new)
    let finalProfileName = profileName;
    if (!isUpdate && profileName === null) {
      finalProfileName = await promptForProfileName(providerName);
    }

    // Step 6: Save profile
    const saveSpinner = ora('Saving profile...').start();

    try {
      config.name = finalProfileName!;
      await ConfigLoader.saveProfile(finalProfileName!, config as any);

      saveSpinner.succeed(chalk.green(`Profile "${finalProfileName}" saved`));

      // Switch to new profile if needed
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

      // Display success
      displaySetupSuccess(finalProfileName!, providerName, selectedModel);

    } catch (error) {
      saveSpinner.fail(chalk.red('Failed to save profile'));
      throw error;
    }

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const providerTemplate = ProviderRegistry.getProvider(providerName);
    displaySetupError(new Error(errorMessage), providerTemplate?.setupInstructions);
    throw error;
  }
}

/**
 * Prompt for profile name
 *
 * Generates unique default name and validates input
 */
async function promptForProfileName(providerName: string): Promise<string> {
  const profiles = await ConfigLoader.listProfiles();
  const existingNames = profiles.map(p => p.name);

  // Suggest a default name based on provider template
  let defaultName = 'default';
  if (existingNames.length > 0) {
    // If profiles exist, use provider's defaultProfileName or provider name
    const providerTemplate = ProviderRegistry.getProvider(providerName);
    defaultName = providerTemplate?.defaultProfileName || providerName;
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

  return newProfileName ? newProfileName.trim() : newProfileName;
}

/**
 * Prompt for model selection with metadata
 *
 * Uses getAllModelChoices for enriched display
 */
async function promptForModelSelection(
  models: string[],
  providerTemplate?: any
): Promise<string> {
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

  // Use getAllModelChoices for enriched display with metadata
  const choices = [
    ...getAllModelChoices(models, providerTemplate),
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

/*
 * Note: Old SSO setup function (handleAiRunSSOSetup) has been removed.
 * It has been replaced by the plugin-based SSOSetupSteps in src/providers/plugins/sso/
 * All SSO setup logic is now handled through the ProviderRegistry plugin system.
 */
