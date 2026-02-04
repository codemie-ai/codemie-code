/**
 * Setup Assistants Command - Orchestration
 *
 * Unified command to view, register, and unregister CodeMie assistants
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { createErrorContext, formatErrorForUser } from '@/utils/errors.js';
import type { CodemieAssistant, ProviderProfile } from '@/env/types.js';
import { MESSAGES, COMMAND_NAMES, ACTIONS } from '@/cli/commands/assistants/constants.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { fetchAssistants } from '@/cli/commands/assistants/setup/api.js';
import { promptAssistantSelection } from '@/cli/commands/assistants/setup/selection/index.js';
import { sortAssistantsByRegistration, displayNoAssistantsMessage } from '@/cli/commands/assistants/setup/selection/utils.js';
import { determineChanges, registerAssistant, unregisterAssistant } from '@/cli/commands/assistants/setup/operations.js';
import { createDataFetcher } from '@/cli/commands/assistants/setup/data.js';

export interface SetupCommandOptions {
  profile?: string;
  project?: string;
  allProjects?: boolean;
  verbose?: boolean;
}

export interface RegistrationChanges {
  toRegister: Assistant[];
  toUnregister: CodemieAssistant[];
}

/**
 * Create assistants setup command
 */
export function createAssistantsSetupCommand(): Command {
  const command = new Command(COMMAND_NAMES.SETUP);

  command
    .description(MESSAGES.SETUP.COMMAND_DESCRIPTION)
    .option('--profile <name>', MESSAGES.SETUP.OPTION_PROFILE)
    .option('--project <project>', MESSAGES.SETUP.OPTION_PROJECT)
    .option('--all-projects', MESSAGES.SETUP.OPTION_ALL_PROJECTS)
    .option('-v, --verbose', MESSAGES.SHARED.OPTION_VERBOSE)
    .action(async (options: SetupCommandOptions) => {
      if (options.verbose) {
        enableVerboseLogging();
      }

      try {
        await manageAssistants(options);
      } catch (error: unknown) {
        handleError(error);
      }
    });

  return command;
}

/**
 * Enable verbose debug logging
 */
function enableVerboseLogging(): void {
  process.env.CODEMIE_DEBUG = 'true';
  const logFilePath = logger.getLogFilePath();
  if (logFilePath) {
    console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
  }
}

/**
 * Handle command errors
 */
function handleError(error: unknown): never {
  const context = createErrorContext(error);
  logger.error('Failed to manage assistants', context);
  console.error(formatErrorForUser(context));
  process.exit(1);
}

/**
 * Manage assistants - unified list/register/unregister
 */
async function manageAssistants(options: SetupCommandOptions): Promise<void> {
  // 1. Load current profile
  const config = await ConfigLoader.load();
  const profileName = options.profile || await ConfigLoader.getActiveProfileName() || 'default';

  logger.debug('Managing assistants', { profileName, options });

  // 2. Get authenticated client and fetch assistants from backend
  const client = await getAuthenticatedClient(config);
  const backendAssistants = await fetchAssistants(client, options, config);

  // 3. Get currently registered assistants
  const registeredAssistants = config.codemieAssistants || [];

  // 4. Sort assistants: registered first, then unregistered
  const sortedAssistants = sortAssistantsByRegistration(backendAssistants, registeredAssistants);

  if (sortedAssistants.length === 0) {
    displayNoAssistantsMessage(options, config);
    return;
  }

  // 5. Prompt user selection with Update/Cancel
  const registeredIds = new Set(registeredAssistants.map(a => a.id));
  const { selectedIds, action } = await promptAssistantSelection(
    registeredIds,
    config,
    options,
    client
  );

  if (action === ACTIONS.CANCEL) {
    console.log(chalk.dim(MESSAGES.SETUP.NO_CHANGES_MADE));
    return;
  }

  // 6. Fetch full details for selected assistants (in case some are from other pages/tabs)
  const fetcher = createDataFetcher({ config, client, options });
  const selectedAssistants = await fetcher.fetchAssistantsByIds(selectedIds, sortedAssistants);

  // 7. Apply changes
  await applyChanges(selectedIds, selectedAssistants, registeredAssistants, config, profileName);
}

/**
 * Apply registration changes
 */
export async function applyChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[],
  config: ProviderProfile,
  profileName: string
): Promise<void> {
  const { toRegister, toUnregister } = determineChanges(selectedIds, allAssistants, registeredAssistants);

  if (toRegister.length === 0 && toUnregister.length === 0) {
    console.log(chalk.yellow(MESSAGES.SETUP.NO_CHANGES_TO_APPLY));
    return;
  }

  console.log('');

  // Unregister first
  for (const assistant of toUnregister) {
    await unregisterAssistant(assistant);
  }

  // Register new ones
  const newRegistrations: CodemieAssistant[] = [];
  for (const assistant of toRegister) {
    const registered = await registerAssistant(assistant);
    if (registered) {
      newRegistrations.push(registered);
    }
  }

  // Update config
  const selectedSet = new Set(selectedIds);
  const remainingRegistered = registeredAssistants.filter(a => selectedSet.has(a.id));
  config.codemieAssistants = [...remainingRegistered, ...newRegistrations];
  await ConfigLoader.saveProfile(profileName, config);

  // Display summary
  displaySummary(toRegister, toUnregister, profileName, config);
}

/**
 * Display summary of changes
 */
export function displaySummary(
  toRegister: Assistant[],
  toUnregister: CodemieAssistant[],
  profileName: string,
  config: ProviderProfile
): void {
  const totalChanges = toRegister.length + toUnregister.length;
  console.log(chalk.green(MESSAGES.SETUP.SUMMARY_UPDATED(totalChanges)));

  if (toRegister.length > 0) {
    console.log(chalk.dim(MESSAGES.SETUP.SUMMARY_REGISTERED(toRegister.length)));
  }
  if (toUnregister.length > 0) {
    console.log(chalk.dim(MESSAGES.SETUP.SUMMARY_UNREGISTERED(toUnregister.length)));
  }

  console.log(chalk.dim(MESSAGES.SETUP.SUMMARY_PROFILE(profileName)));

  displayCurrentlyRegistered(config);
}

/**
 * Display currently registered assistants
 */
export function displayCurrentlyRegistered(config: ProviderProfile): void {
  if (!config.codemieAssistants || config.codemieAssistants.length === 0) {
    return;
  }

  console.log(chalk.bold(MESSAGES.SETUP.CURRENTLY_REGISTERED));
  config.codemieAssistants.forEach((assistant: CodemieAssistant) => {
    const slugText = chalk.cyan(`/${assistant.slug}`);
    console.log(chalk.white(`  • ${slugText} - ${assistant.name}`));
  });
  console.log('');
}
