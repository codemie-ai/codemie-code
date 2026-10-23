import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader, resolveProfileModels } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { ProviderRegistry } from '../../providers/index.js';
import {
  getAllProviderChoices,
  displaySetupSuccess,
  displaySetupError,
  getAllModelChoices
} from '../../providers/integration/setup-ui.js';
import { FirstTimeExperience } from '../first-time.js';
import { AgentRegistry } from '../../agents/registry.js';
import type { VersionCompatibilityResult } from '../../agents/core/types.js';
import { createAssistantsSetupCommand } from './assistants/setup/index.js';
import { createSkillsSetupCommand } from './skills/setup/index.js';

export function createSetupCommand(): Command {
  const command = new Command('setup');

  command
    .description('Interactive setup wizard for CodeMie Code')
    .option('--force', 'Force re-setup even if config exists')
    .option('-v, --verbose', 'Enable verbose debug output with detailed API logs')
    .addCommand(createAssistantsSetupCommand().name('assistants'))
    .addCommand(createSkillsSetupCommand().name('skills'))
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
export async function handlePluginSetup(
  providerName: string,
  setupSteps: any,
  profileName: string | null,
  isUpdate: boolean,
  storageLocation: 'global' | 'local' = 'global'
): Promise<void> {
  try {
    const providerTemplate = ProviderRegistry.getProvider(providerName);

    // Step 1: Get credentials
    const credentials = await setupSteps.getCredentials(isUpdate);

    // Step 2: Fetch models
    const modelsSpinner = ora('Fetching available models...').start();
    let models: string[] = [];

    try {
      models = await setupSteps.fetchModels(credentials);
      modelsSpinner.succeed(chalk.green(`Found ${models.length} available models`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      modelsSpinner.warn(chalk.yellow(`Could not fetch models: ${message} - will use manual entry`));
      models = [];
    }

    // Step 3: Model selection
    let selectedModel: string;
    let selectedModels: string[];
    const preselectedModel = setupSteps.selectModel
      ? await setupSteps.selectModel(credentials, models, providerTemplate)
      : undefined;

    if (preselectedModel) {
      selectedModel = preselectedModel;
      selectedModels = [preselectedModel];
      logger.success(`Model selected automatically: ${selectedModel}`);
    } else {
      // On an update, pre-check the existing profile's models so removing the
      // active model (or adding more) starts from what's already configured.
      const existingProfile = isUpdate && profileName
        ? (await ConfigLoader.getProfile(profileName)) ?? {}
        : undefined;
      const existingModels = existingProfile ? resolveProfileModels(existingProfile) : undefined;
      // CR-010: the profile's actual active model, threaded through separately
      // so the active-model follow-up defaults to it rather than just the
      // first still-checked id in existingModels.
      const existingActiveModel = existingProfile?.model;
      const result = await promptForModelsSelection(
        models,
        providerTemplate,
        setupSteps,
        credentials,
        existingModels,
        existingActiveModel
      );
      selectedModel = result.activeModel;
      selectedModels = result.models;
    }

    // Step 3.5: Install model if provider supports it (e.g., Ollama) — once per selected model.
    // CR-007: a single failed install must not abort the whole setup before any
    // profile is saved - each install is isolated, failures are collected and
    // surfaced, and the profile is still saved with whichever models succeeded.
    if (providerTemplate?.supportsModelInstallation && setupSteps.installModel) {
      const failedModelIds: string[] = [];
      for (const modelId of selectedModels) {
        try {
          await setupSteps.installModel(credentials, modelId, models);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to install model "${modelId}": ${message}`);
          failedModelIds.push(modelId);
        }
      }

      if (failedModelIds.length > 0) {
        selectedModels = selectedModels.filter(id => !failedModelIds.includes(id));
        if (selectedModels.length === 0) {
          throw new Error(`Failed to install all selected models: ${failedModelIds.join(', ')}`);
        }
        console.log(
          chalk.yellow(`⚠ Could not install: ${failedModelIds.join(', ')} - continuing with the rest`)
        );
        if (!selectedModels.includes(selectedModel)) {
          selectedModel = selectedModels[0];
        }
      }
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

    const userEmail = credentials.additionalConfig?.userEmail as string | undefined;
    if (userEmail) {
      await ConfigLoader.saveUserEmail(userEmail);
    }

    // Merge model tiers into config
    config.haikuModel = modelTiers.haikuModel;
    config.sonnetModel = modelTiers.sonnetModel;
    config.opusModel = modelTiers.opusModel;
    // Never persist a single-entry `models` array — keep the legacy shape
    // for single-model profiles so existing consumers see no new field.
    config.models = selectedModels.length > 1 ? selectedModels : undefined;

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
 * Empty-catalog model entry: offers to search (when supported) or enter a
 * model name manually, returning a single-model selection either way.
 */
async function promptForManualOrSearchModel(
  providerTemplate: any,
  setupSteps: any,
  credentials: any
): Promise<{ models: string[]; activeModel: string }> {
  const canSearch = typeof setupSteps?.searchModel === 'function';

  if (canSearch) {
    const { entryMethod } = await inquirer.prompt([
      {
        type: 'list',
        name: 'entryMethod',
        message: 'No models found. How would you like to choose a model?',
        choices: [
          { name: chalk.cyan('🔍 Search Ollama library...'), value: 'search' },
          { name: 'Enter model name manually', value: 'manual' }
        ]
      }
    ]);

    if (entryMethod === 'search') {
      const searched = await setupSteps.searchModel(credentials);
      if (searched) {
        return { models: [searched], activeModel: searched };
      }
      // User backed out of search - fall through to manual entry
    }
  }

  const { manualModel } = await inquirer.prompt([
    {
      type: 'input',
      name: 'manualModel',
      message: 'Enter model name manually:',
      default: providerTemplate?.recommendedModels?.[0] || 'gpt-5.5',
      validate: (input: string) => input.trim() !== '' || 'Model name is required'
    }
  ]);
  const result = manualModel ? manualModel.trim() : manualModel;
  return { models: [result], activeModel: result };
}

/**
 * Follow-up "which model should be active?" prompt, asked only when 2+
 * models ended up checked. Defaults to the profile's actual active model
 * (preselectedActive) when it is still checked - falling back to the first
 * still-checked preselected id, then the first checked id - rather than
 * always defaulting to the first still-checked stored id (CR-010).
 */
async function promptForActiveModel(
  alreadyChecked: string[],
  preselected?: string[],
  preselectedActive?: string
): Promise<string> {
  const defaultActive =
    preselectedActive && alreadyChecked.includes(preselectedActive)
      ? preselectedActive
      : preselected?.find(id => alreadyChecked.includes(id)) ?? alreadyChecked[0];

  const { activeModel } = await inquirer.prompt([
    {
      type: 'list',
      name: 'activeModel',
      message: 'Which model should be active?',
      choices: alreadyChecked,
      default: defaultActive
    }
  ]);

  return activeModel;
}

/**
 * Prompt for a multi-model selection with a default-active-model follow-up.
 *
 * Mirrors the single-choice picker's catalog handling (empty-catalog manual/
 * search entry, live recommendations, "Custom model" / "Search Ollama
 * library" entries), but lets the user check 2+ models and then asks which
 * one should be active when more than one was picked.
 *
 * @param preselectedActive - the profile's actual active model (profile.model)
 * on an update, used as the active-model follow-up's default - see CR-010.
 */
export async function promptForModelsSelection(
  models: string[],
  providerTemplate?: any,
  setupSteps?: any,
  credentials?: any,
  preselected?: string[],
  preselectedActive?: string
): Promise<{ models: string[]; activeModel: string }> {
  const canSearch = typeof setupSteps?.searchModel === 'function';

  if (models.length === 0) {
    return promptForManualOrSearchModel(providerTemplate, setupSteps, credentials);
  }

  // Live-computed recommendations (fits this machine + agent-ready + most
  // popular) when the provider supports it; falls back to the template's
  // static recommendedModels inside getAllModelChoices otherwise.
  let recommendedOverrideIds: Set<string> | undefined;
  if (typeof setupSteps?.getRecommendedModels === 'function') {
    const recommendSpinner = ora('Finding recommended models...').start();
    try {
      const recommended = await setupSteps.getRecommendedModels(models, credentials);
      recommendedOverrideIds = new Set(recommended);
      recommendSpinner.stop();
    } catch {
      recommendSpinner.stop();
      // Non-fatal - just show the list without recommendations.
    }
  }

  // `checked` tracks the currently-checked set across re-prompts (custom
  // entry, Ollama search, or an empty confirmation all loop back here
  // instead of returning).
  let checked = new Set<string>(preselected ?? []);

  for (;;) {
    const baseChoices = getAllModelChoices(models, providerTemplate, recommendedOverrideIds).map(choice => ({
      ...choice,
      checked: checked.has(choice.value)
    }));
    const choices = [
      ...baseChoices,
      { name: chalk.white('Custom model (manual entry)...'), value: 'custom' },
      ...(canSearch ? [{ name: chalk.cyan('🔍 Search Ollama library...'), value: 'search' }] : [])
    ];

    const { selectedModels } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedModels',
        message: `Choose models (${models.length} available):`,
        choices,
        pageSize: 15
      }
    ]);

    const picks: string[] = Array.isArray(selectedModels) ? selectedModels : [];
    const alreadyChecked = picks.filter(id => id !== 'custom' && id !== 'search');

    if (picks.includes('search')) {
      const searched = await setupSteps.searchModel(credentials);
      checked = new Set(alreadyChecked);
      if (searched) {
        checked.add(searched);
        // CR-009: extend the choices source itself so the next render's
        // checkbox actually has a matching choice for this id - inquirer's
        // checkbox can never return a value that isn't one of its choices.
        if (!models.includes(searched)) {
          models = [...models, searched];
        }
      }
      continue;
    }

    if (picks.includes('custom')) {
      const { customModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customModel',
          message: 'Enter model name:',
          validate: (input: string) => input.trim() !== '' || 'Model is required'
        }
      ]);
      checked = new Set(alreadyChecked);
      if (customModel) {
        const trimmed = customModel.trim();
        checked.add(trimmed);
        // CR-009: same reasoning as the search branch above.
        if (!models.includes(trimmed)) {
          models = [...models, trimmed];
        }
      }
      continue;
    }

    if (alreadyChecked.length === 0) {
      // AC5: an empty confirmation re-prompts rather than returning.
      checked = new Set();
      continue;
    }

    if (alreadyChecked.length === 1) {
      return { models: alreadyChecked, activeModel: alreadyChecked[0] };
    }

    const activeModel = await promptForActiveModel(alreadyChecked, preselected, preselectedActive);
    return { models: alreadyChecked, activeModel };
  }
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
export async function autoSelectModelTiers(
  models: string[],
  selectedModel: string
): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string }> {
  // Check if environment variables are already set
  const envHaiku = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  const envSonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const envOpus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

  // Auto-select from available models with validation against env vars
  const result: { haikuModel?: string; sonnetModel?: string; opusModel?: string } = {};

  // Filter models by type
  const haikuModels = models.filter(m => m.toLowerCase().includes('haiku'));
  const sonnetModels = models.filter(m => m.toLowerCase().includes('sonnet'));
  const opusModels = models.filter(m => m.toLowerCase().includes('opus'));

  // Select latest haiku model (or use env var if set and valid)
  if (envHaiku && haikuModels.includes(envHaiku)) {
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

  // Select sonnet model: prefer env var (if valid), then selectedModel if it's sonnet-class, then
  // auto-select the latest sonnet model from the available list (same pattern as haiku/opus).
  // This ensures the Custom Sonnet slot in Claude Code's /model picker is always populated
  // with a real sonnet model when one is provisioned, regardless of which tier the user
  // selected as their primary model (EPMCDME-12779).
  if (envSonnet && sonnetModels.includes(envSonnet)) {
    result.sonnetModel = envSonnet;
    logger.debug('Using sonnet model from environment variable', { model: envSonnet });
  } else if (selectedModel.toLowerCase().includes('sonnet')) {
    result.sonnetModel = selectedModel;
    logger.debug('Using selected model as sonnet tier', { model: selectedModel });
  } else if (sonnetModels.length > 0) {
    const sortedSonnet = [...sonnetModels].sort((a, b) => compareModelVersions(b, a));
    const latestSonnet = sortedSonnet[0];
    result.sonnetModel = latestSonnet;
    logger.debug('Auto-selected sonnet model', {
      selected: latestSonnet,
      candidates: sonnetModels,
      sortedOrder: sortedSonnet
    });
  } else {
    logger.debug('No sonnet model available — sonnet tier not assigned', { availableModels: models });
  }

  // Select latest opus model (or use env var if set and valid)
  if (envOpus && opusModels.includes(envOpus)) {
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
