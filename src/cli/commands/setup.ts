import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader, resolveProfileModels } from '../../utils/config.js';
import type { CodeMieConfigOptions, ProviderProfile } from '../../env/types.js';
import { logger } from '../../utils/logger.js';
import { ConfigurationError } from '../../utils/errors.js';
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
import {
  classifyModelForAgent,
  compatibleHarnesses,
  getClassifierAgents,
  getModelRuleFreeAgents,
  getOfferedHarnesses,
  routerAcceptedModels,
  uncoveredHarnesses,
  unsupportedProviderHarnesses
} from '../../agents/core/model-compat.js';
import {
  HARNESS_CHECKBOX_PROMPT,
  HarnessCheckboxPrompt
} from './shared/harness-checkbox-prompt.js';
import { createAssistantsSetupCommand } from './assistants/setup/index.js';
import { createSkillsSetupCommand } from './skills/setup/index.js';

/**
 * Global profile record for a setup result. A subscription profile whose owner
 * declined CodeMie analytics in this run (no CodeMie URL or project) is stored off
 * CodeMie (`codeMieProject: null`), so it never falls back to the shared project.
 */
export function globalProfileFromSetup(providerName: string, config: Partial<CodeMieConfigOptions>): ProviderProfile {
  const declinedCodeMie = ProviderRegistry.getProvider(providerName)?.customProperties?.canStayOffCodeMie === true
    && !config.codeMieUrl && !config.codeMieProject;
  return declinedCodeMie ? { ...(config as ProviderProfile), codeMieProject: null } : (config as ProviderProfile);
}

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

    // Step 3: Harness + model selection
    let selectedModel: string;
    let selectedModels: string[];
    // Harnesses (agents) the profile serves, and the harness-aware context the model step and the
    // coverage gate use. Both stay undefined when the provider auto-picks the model.
    let harnesses: string[] | undefined;
    let harnessCtx: HarnessModelContext | undefined;
    let confirmedModels: string[] = [];
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
      let existingModels = existingProfile ? resolveProfileModels(existingProfile) : undefined;
      // CR-010: the profile's actual active model, threaded through separately
      // so the active-model follow-up defaults to it rather than just the
      // first still-checked id in existingModels.
      const existingActiveModel = existingProfile?.model;

      harnesses = await promptForHarnesses(existingProfile?.harnesses);

      // Catalog entries the provider flags as routers/aliases: unverified, not incompatible, even
      // when the name carries no "router". Best effort - a failed lookup only loses the hint.
      let isRouter: ((id: string) => boolean) | undefined;
      if (models.length > 0 && typeof setupSteps.fetchRouterModels === 'function') {
        try {
          const routerIds = new Set<string>(await setupSteps.fetchRouterModels(credentials));
          isRouter = id => routerIds.has(id);
        } catch (error) {
          logger.debug('Could not fetch router models; using name rules only', error);
        }
      }

      // Ids confirmed in this session survive a coverage-gate retry.
      const sessionConfirmed = new Set<string>(existingProfile?.confirmedModels ?? []);

      for (;;) {
        harnessCtx = buildHarnessContext(harnesses, providerName, [...sessionConfirmed], isRouter);

        // A selected harness the provider offers no compatible model for is a dead end:
        // explain, and never save. Without a catalog only a provider the harness does not
        // support is known to be unsatisfiable (no typed id can ever cover it).
        const unsupported = harnessCtx ? unsupportedProviderHarnesses(harnessCtx.harnesses, providerName) : [];
        const noModel = harnessCtx && models.length > 0
          ? uncoveredHarnesses(harnessCtx.harnesses, models, { provider: providerName, isRouter })
            .filter(h => !unsupported.includes(h))
          : [];
        const deadEnd = harnesses.filter(h => unsupported.includes(h) || noModel.includes(h));
        if (deadEnd.length > 0) {
          const action = await promptForHarnessDeadEnd({ unsupported, uncovered: noModel }, providerName);
          if (action === 'change') {
            harnesses = await promptForHarnesses(harnesses);
            continue;
          }
          console.log(chalk.yellow('Setup cancelled - nothing was saved.'));
          return;
        }

        const result = await promptForModelsSelection(
          models,
          providerTemplate,
          setupSteps,
          credentials,
          existingModels,
          existingActiveModel,
          harnessCtx
        );
        selectedModel = result.activeModel;
        selectedModels = result.models;
        confirmedModels = result.confirmedModels ?? [];
        confirmedModels.forEach(id => sessionConfirmed.add(id));

        // Coverage gate: every selected harness needs at least one non-incompatible model.
        const uncovered = harnessCtx
          ? uncoveredHarnesses(harnessCtx.harnesses, selectedModels, {
            provider: providerName,
            confirmedModels,
            isRouter
          })
          : [];
        if (uncovered.length === 0) break;
        console.log(chalk.red(uncoveredHarnessesMessage(uncovered)));
        existingModels = selectedModels;
      }
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

        // Failed installs can remove the last model a harness had.
        const uncoveredAfterInstall = harnessCtx
          ? uncoveredHarnesses(harnessCtx.harnesses, selectedModels, {
            provider: providerName,
            confirmedModels,
            isRouter: harnessCtx.isRouter
          })
          : [];
        if (uncoveredAfterInstall.length > 0) {
          throw new ConfigurationError(
            `No installed model works with ${formatHarnessList(uncoveredAfterInstall)} - profile not saved`
          );
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
    // Harness metadata: only collected when the provider lets the user pick models.
    config.harnesses = harnesses;
    // Launch has no catalog: ids accepted only through the router hint are persisted as confirmed
    // so launch, switch and status report them unverified instead of incompatible.
    const routerAccepted = harnessCtx
      ? routerAcceptedModels(harnessCtx.harnesses, selectedModels, {
        provider: providerName,
        isRouter: harnessCtx.isRouter
      })
      : [];
    const keptConfirmed = [...new Set([...confirmedModels, ...routerAccepted])]
      .filter(id => selectedModels.includes(id));
    config.confirmedModels = keptConfirmed.length > 0 ? keptConfirmed : undefined;

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
        // Save to global ~/.codemie/ directory. A subscription profile whose owner
        // declined CodeMie analytics in this run is stored off CodeMie (`null`), so it
        // never falls back to the shared project of another profile (EPMCDME-15411).
        await ConfigLoader.saveProfile(finalProfileName!, globalProfileFromSetup(providerName, config));
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
 * Harness-aware context for the model step: the selected agents, the profile's provider and the
 * ids already confirmed despite a name-rule mismatch. Only built when at least one selected
 * harness has a classifier; unrestricted-only selections behave exactly as before.
 */
export interface HarnessModelContext {
  harnesses: string[];
  provider?: string;
  confirmedModels?: string[];
  /** Catalog router hint (ModelInfo.metadata.isRouter), when the provider reports one. */
  isRouter?: (modelId: string) => boolean;
}

function buildHarnessContext(
  harnesses: string[] | undefined,
  provider: string,
  confirmedModels?: string[],
  isRouter?: (modelId: string) => boolean
): HarnessModelContext | undefined {
  if (!harnesses || harnesses.length === 0) return undefined;
  const classifiers = getClassifierAgents();
  const hasRules = harnesses.some(h => classifiers.includes(h));
  if (!hasRules && unsupportedProviderHarnesses(harnesses, provider).length === 0) return undefined;
  return { harnesses, provider, confirmedModels, isRouter };
}

/** Multi-select of the agents (harnesses) the profile will serve; at least one is required. */
export async function promptForHarnesses(existing?: string[]): Promise<string[]> {
  const offered = getOfferedHarnesses();
  const ruleFree = getModelRuleFreeAgents();
  if (ruleFree.length > 0) {
    console.log(chalk.dim(
      `No model rules for: ${ruleFree.map(h => h.name).join(', ')} - any selected model is used as-is.`
    ));
  }
  const { harnesses } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'harnesses',
      message: 'Which agents will use this profile?',
      choices: offered.map(h => ({
        name: h.displayName,
        value: h.name,
        checked: existing?.includes(h.name) ?? false
      })),
      validate: (picked: string[]) => picked.length > 0 || 'Select at least one agent'
    }
  ]);
  return Array.isArray(harnesses) ? harnesses : [];
}

async function promptForHarnessDeadEnd(
  stuck: { unsupported: string[]; uncovered: string[] },
  provider: string
): Promise<'change' | 'cancel'> {
  if (stuck.unsupported.length > 0) {
    console.log(chalk.yellow(
      `\n⚠ Provider "${provider}" is not supported by ${formatHarnessList(stuck.unsupported)}.`
    ));
  }
  if (stuck.uncovered.length > 0) {
    console.log(chalk.yellow(
      `\n⚠ Provider "${provider}" offers no model that works with ${formatHarnessList(stuck.uncovered)}.`
    ));
  }
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to continue?',
      choices: [
        { name: 'Change the selected agents', value: 'change' },
        { name: 'Cancel (re-run `codemie setup` to choose a different provider)', value: 'cancel' }
      ]
    }
  ]);
  return action === 'change' ? 'change' : 'cancel';
}

/** Registers the live-highlighting checkbox once; false when inquirer cannot register prompts. */
function registerHarnessCheckbox(): boolean {
  const registrar = inquirer as unknown as { registerPrompt?: (name: string, prompt: unknown) => void };
  if (typeof registrar.registerPrompt !== 'function') return false;
  registrar.registerPrompt(HARNESS_CHECKBOX_PROMPT, HarnessCheckboxPrompt);
  return true;
}

/**
 * Dim "[codex, claude · unverified]" suffix naming the selected harnesses a model works with.
 * Agents in `missing` (no checked model covers them yet) are highlighted.
 */
function harnessLabel(id: string, ctx: HarnessModelContext, confirmed: Set<string>, missing: string[] = []): string {
  const opts = { provider: ctx.provider, confirmedModels: [...confirmed], isRouter: ctx.isRouter };
  const works = compatibleHarnesses(ctx.harnesses, id, opts);
  const unverified = works.some(h => classifyModelForAgent(h, id, opts) === 'unverified');
  const names = works.map(h => (missing.includes(h) ? chalk.bgYellow(chalk.black(h)) : chalk.dim(h)));
  return chalk.dim('  [') + names.join(chalk.dim(', ')) + chalk.dim(`${unverified ? ' · unverified' : ''}]`);
}

/** Put the label on the first line of a (possibly multi-line) choice name. */
function withHarnessLabel(name: string, label: string): string {
  const newline = name.indexOf('\n');
  return newline === -1 ? name + label : name.slice(0, newline) + label + name.slice(newline);
}

/**
 * A typed (catalog-less / custom / searched) id is accepted silently when it is not incompatible
 * for at least one selected harness. Otherwise warn and require explicit confirmation; a confirmed
 * id is recorded in `confirmed`. Without a harness context every id is accepted.
 */
async function acceptTypedModel(
  id: string,
  ctx: HarnessModelContext | undefined,
  confirmed: Set<string>
): Promise<boolean> {
  if (!ctx) return true;
  const opts = { provider: ctx.provider, confirmedModels: [...confirmed], isRouter: ctx.isRouter };
  if (compatibleHarnesses(ctx.harnesses, id, opts).length > 0) return true;

  console.log(chalk.yellow(
    `⚠ "${id}" does not look compatible with ${ctx.harnesses.join(', ')} - it may fail at launch.`
  ));
  const { confirmIncompatible } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmIncompatible',
      message: `Use "${id}" anyway?`,
      default: false
    }
  ]);
  if (confirmIncompatible) {
    confirmed.add(id);
    return true;
  }
  return false;
}

/** Quoted, comma-separated agent names for messages: "codex", "gemini". */
function formatHarnessList(harnesses: string[]): string {
  return harnesses.map(h => `"${h}"`).join(', ');
}

/** One message naming every selected agent that still lacks a compatible model. */
function uncoveredHarnessesMessage(uncovered: string[]): string {
  return `✗ No selected model works with ${formatHarnessList(uncovered)}. ` +
    `Add a model for ${uncovered.length > 1 ? 'each of them' : uncovered[0]} (or remove ` +
    `${uncovered.length > 1 ? 'them' : 'it'} from the selected agents) to continue.`;
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
 * One manual/search model entry: offers to search (when supported) or enter a model name
 * manually. `message`/`defaultModel` let the harness-aware caller steer the manual prompt.
 */
async function enterOneModel(
  providerTemplate: any,
  setupSteps: any,
  credentials: any,
  message: string,
  defaultModel: string | undefined
): Promise<string> {
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
        return searched;
      }
      // User backed out of search - fall through to manual entry
    }
  }

  const { manualModel } = await inquirer.prompt([
    {
      type: 'input',
      name: 'manualModel',
      message,
      default: defaultModel,
      validate: (input: string) => input.trim() !== '' || 'Model name is required'
    }
  ]);
  return manualModel ? manualModel.trim() : manualModel;
}

/**
 * Empty-catalog model entry. Without a harness context it returns a single model. With one it
 * keeps asking until every selected harness has a non-incompatible model, so a multi-harness
 * profile can be set up without a catalog.
 */
async function promptForManualOrSearchModel(
  providerTemplate: any,
  setupSteps: any,
  credentials: any,
  harnessCtx?: HarnessModelContext,
  confirmed: Set<string> = new Set(),
  preselected: string[] = []
): Promise<{ models: string[]; activeModel: string; confirmedModels?: string[] }> {
  const recommended: string[] = providerTemplate?.recommendedModels ?? [];
  // Confirmed typed ids from an earlier pass are kept, so a coverage-gate retry does not drop them.
  const picked: string[] = harnessCtx ? preselected.filter(id => confirmed.has(id)) : [];

  // No typed id can cover a harness the provider does not support: fail instead of re-asking forever.
  const stuck = harnessCtx ? unsupportedProviderHarnesses(harnessCtx.harnesses, harnessCtx.provider) : [];
  if (stuck.length > 0) {
    throw new ConfigurationError(
      `Provider "${harnessCtx?.provider}" is not supported by ${formatHarnessList(stuck)} - change the selected agents or the provider`
    );
  }

  let asked = false;
  for (;;) {
    const opts = { provider: harnessCtx?.provider, confirmedModels: [...confirmed], isRouter: harnessCtx?.isRouter };
    const uncovered = harnessCtx && picked.length > 0
      ? uncoveredHarnesses(harnessCtx.harnesses, picked, opts)
      : [];
    if (asked && picked.length > 0 && uncovered.length === 0) break;

    // Say why we are asking again; the first prompt needs no explanation.
    if (asked && uncovered.length > 0) {
      console.log(chalk.yellow(
        `✗ No entered model works with ${formatHarnessList(uncovered)}. Every selected agent needs at least one model.`
      ));
    }

    const targets = uncovered.length > 0 ? uncovered : harnessCtx?.harnesses;
    const defaultModel = harnessCtx && targets
      ? recommended.find(m => compatibleHarnesses(targets, m, opts).length > 0)
      : recommended[0] || 'gpt-5.5';
    const message = uncovered.length > 0
      ? (uncovered.length > 1
        ? `Still no model for ${uncovered.join(', ')} - enter one (it covers whichever it fits):`
        : `Enter a model for ${uncovered[0]}:`)
      : 'Enter model name manually:';

    const id = await enterOneModel(providerTemplate, setupSteps, credentials, message, defaultModel);
    asked = true;
    if (!(await acceptTypedModel(id, harnessCtx, confirmed))) continue;
    if (!picked.includes(id)) picked.push(id);
    if (!harnessCtx) break;
  }

  const confirmedModels = [...confirmed].filter(id => picked.includes(id));
  const extra = confirmedModels.length > 0 ? { confirmedModels } : {};
  if (picked.length === 1) {
    return { models: picked, activeModel: picked[0], ...extra };
  }
  const activeModel = await promptForActiveModel(picked, undefined, undefined, harnessCtx, confirmed);
  return { models: picked, activeModel, ...extra };
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
  preselectedActive?: string,
  harnessCtx?: HarnessModelContext,
  confirmed: Set<string> = new Set()
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
      // A model not compatible with every harness stays selectable; it is only labeled.
      choices: harnessCtx
        ? alreadyChecked.map(id => ({ name: id + harnessLabel(id, harnessCtx, confirmed), value: id }))
        : alreadyChecked,
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
  preselectedActive?: string,
  harnessCtx?: HarnessModelContext
): Promise<{ models: string[]; activeModel: string; confirmedModels?: string[] }> {
  const canSearch = typeof setupSteps?.searchModel === 'function';
  // Ids the user confirmed despite a mismatch (already-confirmed ones seed the set).
  const confirmed = new Set<string>(harnessCtx?.confirmedModels ?? []);

  if (models.length === 0) {
    return promptForManualOrSearchModel(providerTemplate, setupSteps, credentials, harnessCtx, confirmed, preselected);
  }

  // A confirmed typed id is not in the fetched catalog; keep it as a choice so a retry does not
  // silently drop it from the pre-checked selection.
  const retained = (preselected ?? []).filter(id => confirmed.has(id) && !models.includes(id));
  if (retained.length > 0) {
    models = [...models, ...retained];
  }

  // Models incompatible with every selected harness are hidden; the rest are labeled.
  const isVisible = (id: string): boolean =>
    !harnessCtx ||
    compatibleHarnesses(harnessCtx.harnesses, id, {
      provider: harnessCtx.provider,
      confirmedModels: [...confirmed],
      isRouter: harnessCtx.isRouter
    }).length > 0;
  const confirmedResult = (picked: string[]): { confirmedModels?: string[] } => {
    const kept = [...confirmed].filter(id => picked.includes(id));
    return kept.length > 0 ? { confirmedModels: kept } : {};
  };

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
    const plainChoices = getAllModelChoices(models.filter(isVisible), providerTemplate, recommendedOverrideIds);
    const plainNames = new Map<string, string>(plainChoices.map(choice => [choice.value, choice.name]));
    const coverageOpts = (): { provider?: string; confirmedModels: string[]; isRouter?: (id: string) => boolean } => ({
      provider: harnessCtx?.provider,
      confirmedModels: [...confirmed],
      isRouter: harnessCtx?.isRouter
    });
    const baseChoices = plainChoices.map(choice => ({
      ...choice,
      name: harnessCtx
        ? withHarnessLabel(
          choice.name,
          harnessLabel(choice.value, harnessCtx, confirmed, uncoveredHarnesses(harnessCtx.harnesses, [...checked], coverageOpts()))
        )
        : choice.name,
      checked: checked.has(choice.value)
    }));
    const choices = [
      ...baseChoices,
      { name: chalk.white('Custom model (manual entry)...'), value: 'custom' },
      ...(canSearch ? [{ name: chalk.cyan('🔍 Search Ollama library...'), value: 'search' }] : [])
    ];

    // With a harness context the rows re-label live: agents no checked model covers are highlighted.
    const liveRows = harnessCtx && registerHarnessCheckbox()
      ? {
        type: HARNESS_CHECKBOX_PROMPT,
        missingFor: (picked: string[]): string[] =>
          uncoveredHarnesses(harnessCtx.harnesses, picked.filter(id => id !== 'custom' && id !== 'search'), coverageOpts()),
        liveLabel: (value: string, missing: string[]): string | undefined => {
          const plain = plainNames.get(value);
          return plain === undefined ? undefined : withHarnessLabel(plain, harnessLabel(value, harnessCtx, confirmed, missing));
        }
      }
      : { type: 'checkbox' };

    const { selectedModels } = await inquirer.prompt([
      {
        ...liveRows,
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
      if (searched && await acceptTypedModel(searched, harnessCtx, confirmed)) {
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
      const trimmed = customModel ? customModel.trim() : '';
      if (trimmed && await acceptTypedModel(trimmed, harnessCtx, confirmed)) {
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

    // Check coverage here, before the active-model prompt, and name every agent still missing a model.
    const missing = harnessCtx
      ? uncoveredHarnesses(harnessCtx.harnesses, alreadyChecked, {
        provider: harnessCtx.provider,
        confirmedModels: [...confirmed],
        isRouter: harnessCtx.isRouter
      })
      : [];
    if (missing.length > 0) {
      console.log(chalk.red(uncoveredHarnessesMessage(missing)));
      checked = new Set(alreadyChecked);
      continue;
    }

    if (alreadyChecked.length === 1) {
      return { models: alreadyChecked, activeModel: alreadyChecked[0], ...confirmedResult(alreadyChecked) };
    }

    const activeModel = await promptForActiveModel(
      alreadyChecked,
      preselected,
      preselectedActive,
      harnessCtx,
      confirmed
    );
    return { models: alreadyChecked, activeModel, ...confirmedResult(alreadyChecked) };
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
