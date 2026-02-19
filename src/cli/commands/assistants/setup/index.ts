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
import type { CodemieAssistant } from '@/env/types.js';
import { MESSAGES, ACTIONS } from '@/cli/commands/assistants/constants.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { promptAssistantSelection } from '@/cli/commands/assistants/setup/selection/index.js';
import { determineChanges, registerAssistant, unregisterAssistant } from '@/cli/commands/assistants/setup/helpers.js';
import { createDataFetcher } from '@/cli/commands/assistants/setup/data.js';
import { promptModeSelection, CONFIGURATION_CHOICE } from '@/cli/commands/assistants/setup/configuration/index.js';
import { promptManualConfiguration } from '@/cli/commands/assistants/setup/manualConfiguration/index.js';
import type { RegistrationMode } from '@/cli/commands/assistants/setup/manualConfiguration/types.js';
import { REGISTRATION_MODE } from '@/cli/commands/assistants/setup/manualConfiguration/constants.js';
import { displaySummary } from '@/cli/commands/assistants/setup/summary/index.js';
import { ACTION_TYPE } from '@/cli/commands/assistants/setup/constants.js';

export interface SetupCommandOptions {
  profile?: string;
  project?: string;
  allProjects?: boolean;
  verbose?: boolean;
}

interface ApplyChangesResult {
  newRegistrations: CodemieAssistant[];
  registered: Assistant[];
  unregistered: CodemieAssistant[];
}

/**
 * Create assistants setup command
 */
export function createAssistantsSetupCommand(): Command {
  const command = new Command('setup');

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
        await setupAssistants(options);
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
  logger.error('Failed to setup assistants', context);
  console.error(formatErrorForUser(context));
  process.exit(1);
}

/**
 * Setup assistants - unified list/register/unregister
 */
async function setupAssistants(options: SetupCommandOptions): Promise<void> {
  // Load config and profile
  const config = await ConfigLoader.load();
  const profileName = options.profile || await ConfigLoader.getActiveProfileName() || 'default';
  logger.debug('Setting up assistants', { profileName, options });

  // Get authenticated client and current registrations
  const client = await getAuthenticatedClient(config);
  const registeredAssistants = config.codemieAssistants || [];
  const registeredIds = new Set(registeredAssistants.map(a => a.id));

  // Prompt user to select assistants
  const { selectedIds, action } = await promptAssistantSelection(registeredIds, config, options, client);
  if (action === ACTIONS.CANCEL) {
    console.log(chalk.dim(MESSAGES.SETUP.NO_CHANGES_MADE));
    return;
  }

  // Fetch full details for selected assistants
  const fetcher = createDataFetcher({ config, client, options });
  const selectedAssistants = await fetcher.fetchAssistantsByIds(selectedIds, []);

  // Configure registration modes (skip if no assistants selected)
  let registrationModes = new Map<string, RegistrationMode>();

  if (selectedAssistants.length > 0) {
    // Loop to allow going back
    let configurationComplete = false;

    while (!configurationComplete) {
      // Step 1: Show mode selection screen (Subagents, Skills, Manual)
      const { choice, cancelled, back } = await promptModeSelection();

      if (cancelled) {
        console.log(chalk.dim(MESSAGES.SETUP.NO_CHANGES_MADE));
        return;
      }

      if (back) {
        // Go back to selection screen
        return setupAssistants(options);
      }

      // Step 2: Handle choice
      if (choice === CONFIGURATION_CHOICE.SUBAGENTS) { // Bulk register all as agents
        for (const assistant of selectedAssistants) {
          registrationModes.set(assistant.id, REGISTRATION_MODE.AGENT);
        }
        configurationComplete = true;
      } else if (choice === CONFIGURATION_CHOICE.SKILLS) { // Bulk register all as skills
        for (const assistant of selectedAssistants) {
          registrationModes.set(assistant.id, REGISTRATION_MODE.SKILL);
        }
        configurationComplete = true;
      } else { // Manual configuration - show individual configuration screen
        const { registrationModes: modes, action: configAction } = await promptManualConfiguration(
          selectedAssistants as Assistant[],
          registeredIds,
          registeredAssistants
        );

        if (configAction === ACTION_TYPE.CANCEL) {
          console.log(chalk.dim(MESSAGES.SETUP.NO_CHANGES_MADE));
          return;
        }

        if (configAction === ACTION_TYPE.BACK) {
          // Go back to configuration mode selection
          continue;
        }

        registrationModes = modes;
        configurationComplete = true;
      }
    }
  }

  // Apply changes and get summary data
  const { newRegistrations, registered, unregistered } = await applyChanges(
    selectedIds,
    selectedAssistants,
    registeredAssistants,
    registrationModes
  );

  // Update config
  config.codemieAssistants = newRegistrations;
  await ConfigLoader.saveProfile(profileName, config);

  // Display summary
  displaySummary(registered, unregistered, profileName, config);
}

/**
 * Apply registration changes
 * Returns new registrations and lists of what changed
 */
async function applyChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[],
  registrationModes: Map<string, RegistrationMode>
): Promise<ApplyChangesResult> {
  // Determine what needs to change
  const { toRegister, toUnregister } = determineChanges(selectedIds, allAssistants, registeredAssistants);
  const selectedSet = new Set(selectedIds);
  const toReregister = registeredAssistants.filter(a => selectedSet.has(a.id));

  if (toRegister.length === 0 && toUnregister.length === 0 && toReregister.length === 0) {
    console.log(chalk.yellow(MESSAGES.SETUP.NO_CHANGES_TO_APPLY));
    return { newRegistrations: registeredAssistants, registered: [], unregistered: [] };
  }

  // Unregister: both removed assistants and those needing re-registration
  const toUnregisterAll = [...toUnregister, ...toReregister];
  for (const assistant of toUnregisterAll) {
    await unregisterAssistant(assistant);
  }

  // Register all selected assistants with their configured modes
  const newRegistrations: CodemieAssistant[] = [];
  const allToRegister = [...toRegister, ...toReregister];

  for (const assistant of allToRegister) {
    const fullAssistant = getFullAssistant(assistant, allAssistants);
    if (!fullAssistant) continue;

    const mode = registrationModes.get(fullAssistant.id) || REGISTRATION_MODE.AGENT;
    const registered = await registerAssistant(fullAssistant, mode);
    if (registered) {
      newRegistrations.push(registered);
    }
  }

  // Return results for summary
  return {
    newRegistrations,
    registered: [...toRegister, ...getFullAssistants(toReregister, allAssistants)],
    unregistered: toUnregister
  };
}

/**
 * Get full assistant details from the list
 */
function getFullAssistant(
  assistant: Assistant | CodemieAssistant,
  allAssistants: (Assistant | AssistantBase)[]
): Assistant | null {
  // Check if it's already a full Assistant (has registeredAt = it's a CodemieAssistant)
  if ('registeredAt' in assistant) {
    return allAssistants.find(a => a.id === assistant.id) as Assistant || null;
  }
  return assistant as Assistant;
}

/**
 * Get full assistant details for multiple assistants
 */
function getFullAssistants(
  assistants: CodemieAssistant[],
  allAssistants: (Assistant | AssistantBase)[]
): Assistant[] {
  return assistants
    .map(a => getFullAssistant(a, allAssistants))
    .filter((a): a is Assistant => a !== null);
}
