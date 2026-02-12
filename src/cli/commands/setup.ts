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
import { FirstTimeExperience } from '../first-time.js';
import { AgentRegistry } from '../../agents/registry.js';
import type { VersionCompatibilityResult } from '../../agents/core/types.js';
import { createAssistantsSetupCommand } from './assistants/setup/index.js';


export function createSetupCommand(): Command {
  const command = new Command('setup');

  command
    .description('Interactive setup wizard for CodeMie Code')
    .option('--force', 'Force re-setup even if config exists')
    .option('-v, --verbose', 'Enable verbose debug output with detailed API logs')
    .addCommand(createAssistantsSetupCommand().name('assistants'))
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
  // Show ecosystem introduction
  FirstTimeExperience.showEcosystemIntro();

  // Check if config already exists (both global and local)
  const hasGlobalConfig = await ConfigLoader.hasGlobalConfig();
  const hasLocalConfig = await ConfigLoader.hasLocalConfig();
  let profileName: string | null = null;
  let isUpdate = false;
  let storageLocation: 'global' | 'local' = 'global';

  // Determine setup mode
  if (!force && (hasGlobalConfig || hasLocalConfig)) {
    const profiles = await ConfigLoader.listProfiles();

    if (profiles.length > 0) {
      console.log(chalk.cyan('\n📋 Existing Profiles:\n'));
      profiles.forEach(({ name, active, profile }) => {
        const activeMarker = active ? chalk.green('● ') : chalk.white('○ ');
        console.log(`${activeMarker}${chalk.white(name)} (${profile.provider})`);
      });
      console.log('');

      // If local config exists in current directory, show indicator
      if (hasLocalConfig) {
        console.log(chalk.yellow(`Local configuration detected in current directory\n`));
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

        // For updates, use existing storage location (detect from current state)
        storageLocation = hasLocalConfig ? 'local' : 'global';
      } else {
        // Adding new profile - ask where to store it
        console.log(chalk.white('\nConfiguring new profile...\n'));

        const { storage } = await inquirer.prompt([
          {
            type: 'list',
            name: 'storage',
            message: 'Where would you like to store this configuration?',
            choices: [
              {
                name: `${chalk.cyan('Global')} ${chalk.dim('(~/.codemie/) - Available across all repositories')}`,
                value: 'global'
              },
              {
                name: `${chalk.yellow('Local')} ${chalk.dim('(.codemie/) - Only for this repository')}`,
                value: 'local'
              }
            ],
            default: 'global'
          }
        ]);
        storageLocation = storage;

        if (storageLocation === 'local') {
          console.log(chalk.dim('\nNote: This will create a project-specific configuration.'));
          console.log(chalk.dim('Missing fields will fallback to your global config.\n'));
        }
      }
    } else {
      // Config file exists but no profiles - treat as fresh setup
      console.log(chalk.white("Let's configure your AI assistant.\n"));

      // Ask for storage location for fresh setup too
      const { storage } = await inquirer.prompt([
        {
          type: 'list',
          name: 'storage',
          message: 'Where would you like to store this configuration?',
          choices: [
            {
              name: `${chalk.cyan('Global')} ${chalk.dim('(~/.codemie/) - Available across all repositories')}`,
              value: 'global'
            },
            {
              name: `${chalk.yellow('Local')} ${chalk.dim('(.codemie/) - Only for this repository')}`,
              value: 'local'
            }
          ],
          default: 'global'
        }
      ]);
      storageLocation = storage;
    }
  } else {
    // First time setup - ask for storage location
    console.log(chalk.white("Let's configure your AI assistant.\n"));

    const { storage } = await inquirer.prompt([
      {
        type: 'list',
        name: 'storage',
        message: 'Where would you like to store this configuration?',
        choices: [
          {
            name: `${chalk.cyan('Global')} ${chalk.dim('(~/.codemie/) - Available across all repositories')}`,
            value: 'global'
          },
          {
            name: `${chalk.yellow('Local')} ${chalk.dim('(.codemie/) - Only for this repository')}`,
            value: 'local'
          }
        ],
        default: 'global'
      }
    ]);
    storageLocation = storage;

    if (storageLocation === 'local') {
      console.log(chalk.dim('\nNote: This will create a project-specific configuration.'));
      console.log(chalk.dim('Missing fields will fallback to your global config.\n'));
    }
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
  await handlePluginSetup(provider, setupSteps, profileName, isUpdate, storageLocation);
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
  isUpdate: boolean,
  storageLocation: 'global' | 'local' = 'global'
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

    // Step 3.6: Auto-configure model tiers for Claude
    let modelTiers: { haikuModel?: string; sonnetModel?: string; opusModel?: string } = {};
    const claudeAgent = AgentRegistry.getAgent('claude');
    if (claudeAgent) {
      const claudeMetadata = (claudeAgent as any).metadata;
      const supportsClaude = claudeMetadata?.supportedProviders?.includes(providerName);
      if (supportsClaude) {
        modelTiers = await autoSelectModelTiers(models, selectedModel);
      }
    }

    // Step 4: Build configuration
    const config = setupSteps.buildConfig(credentials, selectedModel);

    // Merge model tiers into config
    if (modelTiers.haikuModel) config.haikuModel = modelTiers.haikuModel;
    if (modelTiers.sonnetModel) config.sonnetModel = modelTiers.sonnetModel;
    if (modelTiers.opusModel) config.opusModel = modelTiers.opusModel;

    // Step 5: Ask for profile name (if creating new)
    let finalProfileName = profileName;
    if (!isUpdate && profileName === null) {
      finalProfileName = await promptForProfileName(providerName);
    }

    // Step 6: Save profile
    const saveSpinner = ora('Saving profile...').start();

    try {
      config.name = finalProfileName!;
      const workingDir = process.cwd();

      if (storageLocation === 'local') {
        // Save to local .codemie/ directory
        await ConfigLoader.initProjectConfig(workingDir, {
          profileName: finalProfileName!,
          ...config
        });

        const configPath = `${workingDir}/.codemie/codemie-cli.config.json`;
        saveSpinner.succeed(chalk.green(`Profile "${finalProfileName}" saved to local config`));
        console.log(chalk.dim(`  Location: ${configPath}`));

        // For local configs, the profile is automatically active if it's the only one or if it's being created
        // Check if we should prompt to activate it
        if (!isUpdate) {
          const profiles = await ConfigLoader.listProfiles(workingDir);
          const activeProfile = await ConfigLoader.getActiveProfileName(workingDir);

          if (profiles.length > 1 && activeProfile !== finalProfileName) {
            const { switchToNew } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'switchToNew',
                message: `Switch to profile "${finalProfileName}" as active in local config?`,
                default: true
              }
            ]);

            if (switchToNew) {
              await ConfigLoader.switchProfile(finalProfileName!, workingDir);
              console.log(chalk.green(`✓ Switched to profile "${finalProfileName}" in local config`));
            }
          }
        }
      } else {
        // Save to global ~/.codemie/ directory
        await ConfigLoader.saveProfile(finalProfileName!, config as any);
        saveSpinner.succeed(chalk.green(`Profile "${finalProfileName}" saved to global config`));

        // Switch to new profile if needed (for global configs)
        if (!isUpdate) {
          const activeProfile = await ConfigLoader.getActiveProfileName(workingDir);
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
              await ConfigLoader.switchProfile(finalProfileName!, workingDir);
              console.log(chalk.green(`✓ Switched to profile "${finalProfileName}"`));
            }
          }
        }
      }

      // Display success
      displaySetupSuccess(finalProfileName!, providerName, selectedModel);

      // Show next steps based on storage location
      if (storageLocation === 'local') {
        console.log(chalk.cyan('\n💡 Next steps:'));
        console.log(chalk.white('   This repository will now use project-specific settings'));
        console.log(chalk.white('   View config: '), chalk.blueBright('codemie profile status --show-sources'));
        console.log(chalk.white('   Edit config: '), chalk.blueBright('cat .codemie/codemie-cli.config.json'));
        console.log();
      }

      // Check and install Claude if needed (only during first-time setup, not updates)
      if (!isUpdate && storageLocation === 'global') {
        await checkAndInstallClaude();
      }

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

/**
 * Helper function to parse model version from model name
 * Handles different naming patterns:
 * - claude-4-opus → [4]
 * - claude-opus-4-5-20251101 → [4, 5, 20251101]
 * - claude-4-5-sonnet → [4, 5]
 * - claude-haiku-4-5-20251001 → [4, 5, 20251001]
 * - claude-haiku-4.5 → [4, 5] (dots converted to dashes)
 * - claude-opus-4.6.20260205 → [4, 6, 20260205]
 *
 * @param modelName - The model name to parse
 * @returns Array of version numbers, or empty array if no numbers found
 */
function parseModelVersion(modelName: string): number[] {
  // Normalize dots to dashes for consistent parsing
  // claude-haiku-4.5 → claude-haiku-4-5
  const normalized = modelName.replace(/\./g, '-');

  // Extract all numeric segments from model name
  const numbers = normalized.match(/\d+/g);
  if (!numbers) return [];
  return numbers.map(n => parseInt(n, 10));
}

/**
 * Helper function to compare two model versions
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 *
 * If version parsing fails for either model, falls back to string comparison
 * to ensure consistent ordering (better than random selection).
 *
 * @param a - First model name
 * @param b - Second model name
 * @returns Comparison result: 1 (a > b), -1 (a < b), 0 (equal)
 */
function compareModelVersions(a: string, b: string): number {
  const versionA = parseModelVersion(a);
  const versionB = parseModelVersion(b);

  // If either version couldn't be parsed, fall back to string comparison
  if (versionA.length === 0 || versionB.length === 0) {
    logger.debug('Version parsing failed, falling back to string comparison', {
      modelA: a,
      modelB: b,
      parsedA: versionA,
      parsedB: versionB
    });
    return a.localeCompare(b);
  }

  const maxLength = Math.max(versionA.length, versionB.length);

  for (let i = 0; i < maxLength; i++) {
    const numA = versionA[i] || 0;
    const numB = versionB[i] || 0;

    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  return 0;
}

/**
 * Automatically select model tiers for Claude (haiku/sonnet/opus)
 *
 * Selection logic:
 * 1. Check if ANTHROPIC_DEFAULT_*_MODEL env vars are already set - use those if present
 * 2. Otherwise, auto-select from available models:
 *    - Haiku: latest haiku model
 *    - Sonnet: use the user-selected model (passed as selectedModel)
 *    - Opus: latest opus model
 *
 * Latest = highest version number parsed from model name
 */
async function autoSelectModelTiers(
  models: string[],
  selectedModel: string
): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string }> {
  // Check if environment variables are already set
  const envHaiku = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  const envSonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const envOpus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

  // If all env vars are set, use those
  if (envHaiku && envSonnet && envOpus) {
    logger.debug('Using model tiers from environment variables', {
      haiku: envHaiku,
      sonnet: envSonnet,
      opus: envOpus
    });
    return {
      haikuModel: envHaiku,
      sonnetModel: envSonnet,
      opusModel: envOpus
    };
  }

  // Otherwise, auto-select from available models
  const result: { haikuModel?: string; sonnetModel?: string; opusModel?: string } = {};

  // Filter models by type
  const haikuModels = models.filter(m => m.toLowerCase().includes('haiku'));
  const opusModels = models.filter(m => m.toLowerCase().includes('opus'));

  // Select latest haiku model (or use env var if set)
  if (envHaiku) {
    result.haikuModel = envHaiku;
    logger.debug('Using haiku model from environment variable', { model: envHaiku });
  } else if (haikuModels.length > 0) {
    // Sort haiku models by version (descending) and pick the latest
    // Even if version parsing fails, sorting will still work (falls back to string comparison)
    const sortedHaiku = [...haikuModels].sort((a, b) => compareModelVersions(b, a));
    const latestHaiku = sortedHaiku[0];
    result.haikuModel = latestHaiku;
    logger.debug('Auto-selected haiku model', {
      selected: latestHaiku,
      candidates: haikuModels,
      sortedOrder: sortedHaiku
    });
  }

  // Use selected model as sonnet tier (or env var if set)
  if (envSonnet) {
    result.sonnetModel = envSonnet;
    logger.debug('Using sonnet model from environment variable', { model: envSonnet });
  } else {
    result.sonnetModel = selectedModel;
    logger.debug('Using selected model as sonnet tier', { model: selectedModel });
  }

  // Select latest opus model (or use env var if set)
  if (envOpus) {
    result.opusModel = envOpus;
    logger.debug('Using opus model from environment variable', { model: envOpus });
  } else if (opusModels.length > 0) {
    // Sort opus models by version (descending) and pick the latest
    // Even if version parsing fails, sorting will still work (falls back to string comparison)
    const sortedOpus = [...opusModels].sort((a, b) => compareModelVersions(b, a));
    const latestOpus = sortedOpus[0];
    result.opusModel = latestOpus;
    logger.debug('Auto-selected opus model', {
      selected: latestOpus,
      candidates: opusModels,
      sortedOrder: sortedOpus
    });
  }

  return result;
}

/**
 * Check and install Claude Code if needed
 * Called during first-time setup to ensure Claude is installed with supported version
 */
async function checkAndInstallClaude(): Promise<void> {
  try {
    const claude = AgentRegistry.getAgent('claude');
    if (!claude) {
      // Claude agent not found in registry, skip installation
      return;
    }

    const isInstalled = await claude.isInstalled();

    if (!isInstalled) {
      // Claude not installed - prompt to install
      console.log();
      console.log(chalk.yellow('○ Claude Code is not installed'));
      console.log();

      const { installClaude } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'installClaude',
          message: 'Would you like to install Claude Code now?',
          default: true,
        },
      ]);

      if (installClaude) {
        const spinner = ora('Installing Claude Code (supported version)...').start();

        try {
          // Install supported version
          if (claude.installVersion) {
            await claude.installVersion('supported');
          } else {
            await claude.install();
          }

          const installedVersion = await claude.getVersion();
          const versionStr = installedVersion ? ` v${installedVersion}` : '';

          spinner.succeed(chalk.green(`Claude Code${versionStr} installed successfully`));

          // Show next steps
          console.log();
          console.log(chalk.cyan('💡 Next steps:'));
          console.log(chalk.white('   Interactive mode:'), chalk.blueBright('codemie-claude'));
          console.log(chalk.white('   Single task:'), chalk.blueBright('codemie-claude --task "your task"'));
          console.log();
        } catch (error: unknown) {
          spinner.fail(chalk.red('Failed to install Claude Code'));
          logger.error('Claude installation failed during setup', { error });
          console.log();
          console.log(chalk.yellow('You can install it manually later using:'));
          console.log(chalk.blueBright('  codemie install claude --supported'));
          console.log();
        }
      } else {
        console.log();
        console.log(chalk.gray('Skipped Claude Code installation'));
        console.log(chalk.yellow('You can install it later using:'), chalk.blueBright('codemie install claude --supported'));
        console.log();
      }
    } else {
      // Claude installed - check version compatibility with timeout protection
      if (claude.checkVersionCompatibility) {
        try {
          // Add timeout protection to avoid blocking setup if version check hangs
          const compat = await Promise.race([
            claude.checkVersionCompatibility(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Version check timeout')), 3000)
            )
          ]) as VersionCompatibilityResult;

          if (compat.isNewer) {
            // Installed version is newer than supported
            console.log();
            console.log(chalk.yellow(`⚠️  Claude Code v${compat.installedVersion} is installed`));
            console.log(chalk.yellow(`   CodeMie has only tested and verified v${compat.supportedVersion}`));
            console.log();
            console.log(chalk.white('   To install the supported version:'));
            console.log(chalk.blueBright('   codemie install claude --supported'));
            console.log();
          } else if (compat.compatible) {
            // Version is compatible (same or older than supported)
            console.log();
            console.log(chalk.green(`✓ Claude Code v${compat.installedVersion} is installed`));
            console.log();
          }
        } catch (error) {
          // Silently skip version check if it fails - don't block setup
          logger.debug('Claude version check skipped during setup', { error });
          console.log();
          console.log(chalk.green(`✓ Claude Code is installed`));
          console.log();
        }
      } else {
        // No version check available, just show installed message
        console.log();
        console.log(chalk.green(`✓ Claude Code is installed`));
        console.log();
      }
    }
  } catch (error) {
    // Don't fail setup if Claude check/install fails
    logger.error('Error checking/installing Claude:', error);
  }
}

/*
 * Note: Old SSO setup function (handleAiRunSSOSetup) has been removed.
 * It has been replaced by the plugin-based SSOSetupSteps in src/providers/plugins/sso/
 * All SSO setup logic is now handled through the ProviderRegistry plugin system.
 */
