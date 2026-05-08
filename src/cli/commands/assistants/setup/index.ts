import { Command } from 'commander';
import chalk from 'chalk';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
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
import { enableVerboseLogging, handleSetupError } from '@/cli/commands/shared/helpers.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';

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
        handleSetupError(error, 'setup assistants');
      }
    });

  return command;
}

async function setupAssistants(options: SetupCommandOptions): Promise<void> {
  const profileName = options.profile || await ConfigLoader.getActiveProfileName() || 'default';
  const workingDir = process.cwd();
  logger.debug('Setting up assistants', { profileName, options });

  const storageScope = await promptStorageScope({
    title: MESSAGES.SETUP.PROMPT_STORAGE_SCOPE,
    localNote: MESSAGES.SETUP.STORAGE_LOCAL_NOTE,
  });

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config);
  const registeredAssistants = await ConfigLoader.loadAssistantsByScope(storageScope, workingDir, profileName);
  config.codemieAssistants = registeredAssistants;

  const { selectedIds, action } = await promptAssistantSelection(config, options, client);
  if (action === ACTIONS.CANCEL) {
    console.log(chalk.dim(MESSAGES.SETUP.NO_CHANGES_MADE));
    return;
  }

  const fetcher = createDataFetcher({ config, client, options });
  const selectedAssistants = await fetcher.fetchAssistantsByIds(selectedIds, []);

  let registrationModes = new Map<string, RegistrationMode>();

  if (selectedAssistants.length > 0) {
    let configurationComplete = false;

    while (!configurationComplete) {
      const { choice, cancelled, back } = await promptModeSelection();

      if (cancelled) {
        console.log(chalk.dim(MESSAGES.SETUP.NO_CHANGES_MADE));
        return;
      }

      if (back) {
        return setupAssistants(options);
      }

      if (choice === CONFIGURATION_CHOICE.SUBAGENTS) {
        for (const assistant of selectedAssistants) {
          registrationModes.set(assistant.id, REGISTRATION_MODE.AGENT);
        }
        configurationComplete = true;
      } else if (choice === CONFIGURATION_CHOICE.SKILLS) {
        for (const assistant of selectedAssistants) {
          registrationModes.set(assistant.id, REGISTRATION_MODE.SKILL);
        }
        configurationComplete = true;
      } else {
        const registeredIds = new Set(registeredAssistants.map(a => a.id));

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
          continue;
        }

        registrationModes = modes;
        configurationComplete = true;
      }
    }
  }

  const { newRegistrations, registered, unregistered } = await applyChanges(
    selectedIds,
    selectedAssistants,
    registeredAssistants,
    registrationModes,
    storageScope,
    workingDir
  );

  config.codemieAssistants = newRegistrations;

  if (registered.length === 0 && unregistered.length === 0) {
    displaySummary(registered, unregistered, profileName, config);
    return;
  }

  let configLocation: string;

  if (storageScope === 'local') {
    await ConfigLoader.saveAssistantsToProjectConfig(workingDir, profileName, newRegistrations);
    configLocation = `${workingDir}/.codemie/codemie-cli.config.json`;
  } else {
    await ConfigLoader.saveProfile(profileName, config);
    configLocation = `global (~/.codemie/codemie-cli.config.json)`;
  }

  displaySummary(registered, unregistered, profileName, config, configLocation);
}

async function applyChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[],
  registrationModes: Map<string, RegistrationMode>,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<ApplyChangesResult> {
  const { toRegister, toUnregister } = determineChanges(selectedIds, allAssistants, registeredAssistants);
  const selectedSet = new Set(selectedIds);
  const toReregister = registeredAssistants.filter(a => selectedSet.has(a.id));

  if (toRegister.length === 0 && toUnregister.length === 0 && toReregister.length === 0) {
    console.log(chalk.yellow(MESSAGES.SETUP.NO_CHANGES_TO_APPLY));
    return { newRegistrations: registeredAssistants, registered: [], unregistered: [] };
  }

  for (const assistant of [...toUnregister, ...toReregister]) {
    await unregisterAssistant(assistant, scope, workingDir);
  }

  const newRegistrations: CodemieAssistant[] = [];
  const allToRegister = [...toRegister, ...toReregister];

  for (const assistant of allToRegister) {
    const fullAssistant = getFullAssistant(assistant, allAssistants);
    if (!fullAssistant) continue;

    const mode = registrationModes.get(fullAssistant.id) || REGISTRATION_MODE.AGENT;
    const registered = await registerAssistant(fullAssistant, mode, scope, workingDir);
    if (registered) {
      newRegistrations.push(registered);
    }
  }

  return {
    newRegistrations,
    registered: [...toRegister, ...getFullAssistants(toReregister, allAssistants)],
    unregistered: toUnregister,
  };
}

function getFullAssistant(
  assistant: Assistant | CodemieAssistant,
  allAssistants: (Assistant | AssistantBase)[]
): Assistant | null {
  if ('registeredAt' in assistant) {
    return allAssistants.find(a => a.id === assistant.id) as Assistant || null;
  }
  return assistant as Assistant;
}

function getFullAssistants(
  assistants: CodemieAssistant[],
  allAssistants: (Assistant | AssistantBase)[]
): Assistant[] {
  return assistants
    .map(a => getFullAssistant(a, allAssistants))
    .filter((a): a is Assistant => a !== null);
}
