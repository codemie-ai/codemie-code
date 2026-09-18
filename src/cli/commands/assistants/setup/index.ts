import { Command } from 'commander';
import chalk from 'chalk';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { ConfigLoader, loadRegisteredAssistants } from '@/utils/config.js';
import { StorageScope } from '@/env/types.js';
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
import { enableVerboseLogging, handleSetupError, registerAllOrAbort } from '@/cli/commands/shared/helpers.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';
import { resolveAgentSetupTargets, parseAgentSetupTarget, type AgentSetupTarget, type TargetAgent } from '@/cli/commands/shared/agent-targets.js';
import { RegistrationItemNotFoundError, ConfigurationError } from '@/utils/errors.js';
import { isHeadlessMode, requireFlag, parseScopeFlag, parseListFlag } from '@/cli/commands/shared/headless.js';
import { resolveIdentifiers } from '@/cli/commands/shared/identifier-resolution.js';

export interface SetupCommandOptions {
  profile?: string;
  project?: string;
  allProjects?: boolean;
  agent?: string;
  verbose?: boolean;
  assistant?: string;
  scope?: string;
  mode?: string;
  yes?: boolean;
}

interface ApplyChangesResult {
  newRegistrations: CodemieAssistant[];
  registered: Assistant[];
  unregistered: CodemieAssistant[];
}

export function createAssistantsSetupCommand(hostAgent?: TargetAgent): Command {
  const command = new Command('setup');

  command
    .description(MESSAGES.SETUP.COMMAND_DESCRIPTION)
    .option('--profile <name>', MESSAGES.SETUP.OPTION_PROFILE)
    .option('--project <project>', MESSAGES.SETUP.OPTION_PROJECT)
    .option('--all-projects', MESSAGES.SETUP.OPTION_ALL_PROJECTS)
    .option('--agent <agents>', 'Target agent(s), comma-separated: claude, codex, gemini')
    .option('--assistant <ids>', MESSAGES.SETUP.OPTION_ASSISTANT)
    .option('--scope <scope>', MESSAGES.SETUP.OPTION_SCOPE)
    .option('--mode <mode>', MESSAGES.SETUP.OPTION_MODE)
    .option('-y, --yes', MESSAGES.SETUP.OPTION_YES)
    .option('-v, --verbose', MESSAGES.SHARED.OPTION_VERBOSE)
    .action(async (options: SetupCommandOptions) => {
      if (options.verbose) {
        enableVerboseLogging();
      }

      try {
        await setupAssistants(options, hostAgent);
      } catch (error: unknown) {
        handleSetupError(error, 'setup assistants');
      }
    });

  return command;
}

async function setupAssistants(options: SetupCommandOptions, hostAgent?: TargetAgent): Promise<void> {
  if (isHeadlessMode(options, process.stdin.isTTY === true)) {
    return setupAssistantsHeadless(options, hostAgent);
  }

  const profileName = options.profile || await ConfigLoader.getActiveProfileName() || 'default';
  const workingDir = process.cwd();
  logger.debug('Setting up assistants', { profileName, options });

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config);
  const registeredAssistants = await loadRegisteredAssistants();
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

  const storageScope = await promptStorageScope({
    title: MESSAGES.SETUP.PROMPT_STORAGE_SCOPE,
    localNote: MESSAGES.SETUP.STORAGE_LOCAL_NOTE,
  });
  const target = await resolveAgentSetupTargets(options.agent, hostAgent);

  const { newRegistrations, registered, unregistered } = await applyChanges(
    selectedIds,
    selectedAssistants,
    registeredAssistants,
    registrationModes,
    storageScope,
    workingDir,
    target
  );

  if (registered.length === 0 && unregistered.length === 0) {
    displaySummary(registered, unregistered, profileName, registeredAssistants);
    return;
  }

  const keptAssistants = registeredAssistants.filter(
    a => selectedIds.includes(a.id) && !newRegistrations.some(n => n.id === a.id)
  );
  const allRegistered = [...keptAssistants, ...newRegistrations];

  await ConfigLoader.saveAssistantsToProjectConfig(workingDir, storageScope, allRegistered);

  displaySummary(registered, unregistered, profileName, allRegistered, ConfigLoader.getConfigLocationLabel(storageScope, workingDir));
}

/**
 * Non-interactive branch of `codemie setup assistants`. Every prompt
 * (assistant selection, mode selection, manual configuration, storage scope,
 * agent target detection/selection) is skipped in favour of flags, validated
 * up front so an invalid or missing flag, or an unresolvable identifier,
 * aborts before any network call or write happens.
 */
export async function setupAssistantsHeadless(options: SetupCommandOptions, hostAgent?: TargetAgent): Promise<void> {
  const profileName = options.profile || await ConfigLoader.getActiveProfileName() || 'default';
  const workingDir = process.cwd();
  logger.debug('Setting up assistants (headless)', { profileName, options, hostAgent });

  const assistantIdentifiers = parseListFlag(requireFlag(options.assistant, '--assistant'));
  const storageScope = parseScopeFlag(requireFlag(options.scope, '--scope'));
  const registrationMode = parseRegistrationModeFlag(requireFlag(options.mode, '--mode'));
  requireFlag(options.agent, '--agent');

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config);
  const registeredAssistants = await loadRegisteredAssistants();
  config.codemieAssistants = registeredAssistants;

  const fetcher = createDataFetcher({ config, client, options });
  const catalog = await fetcher.fetchAllVisibleAssistants();

  const resolvedAssistants = resolveIdentifiers('assistant', assistantIdentifiers, catalog);
  const target = parseAgentSetupTarget(options.agent as string);

  // Headless registration is purely additive: it must never unregister an
  // assistant that isn't named in `--assistant`. `applyChanges`/`determineChanges`
  // derive removals from whichever "currently registered" set they're handed, so
  // the selection given to `applyChanges` is the union of the requested ids with
  // the already-registered ids that overlap them (which is exactly the requested
  // ids, de-duplicated, in requested order) — every already-registered assistant
  // outside that scope is withheld from `applyChanges` entirely and reconciled
  // back into the saved list afterwards, untouched.
  const selectedIds = Array.from(new Set(resolvedAssistants.map(assistant => assistant.id)));
  const selectedIdSet = new Set(selectedIds);
  const registeredInScope = registeredAssistants.filter(a => selectedIdSet.has(a.id));
  const untouchedRegistered = registeredAssistants.filter(a => !selectedIdSet.has(a.id));

  const registrationModes = new Map<string, RegistrationMode>(
    selectedIds.map(id => [id, registrationMode])
  );

  const { newRegistrations, registered, unregistered } = await applyChanges(
    selectedIds,
    catalog,
    registeredInScope,
    registrationModes,
    storageScope,
    workingDir,
    target
  );

  if (registered.length === 0 && unregistered.length === 0) {
    displaySummary(registered, unregistered, profileName, registeredAssistants);
    return;
  }

  const allRegistered = [...untouchedRegistered, ...newRegistrations];

  await ConfigLoader.saveAssistantsToProjectConfig(workingDir, storageScope, allRegistered);

  displaySummary(registered, unregistered, profileName, allRegistered, ConfigLoader.getConfigLocationLabel(storageScope, workingDir));
}

function parseRegistrationModeFlag(value: string): RegistrationMode {
  const normalized = value.trim().toLowerCase();

  if (normalized === REGISTRATION_MODE.AGENT || normalized === REGISTRATION_MODE.SKILL) {
    return normalized;
  }

  throw new ConfigurationError(`Invalid --mode: "${value}". Expected "agent" or "skill".`);
}

async function applyChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[],
  registrationModes: Map<string, RegistrationMode>,
  scope: StorageScope = StorageScope.GLOBAL,
  workingDir?: string,
  target: AgentSetupTarget = ['claude']
): Promise<ApplyChangesResult> {
  const { toRegister, toUnregister } = determineChanges(selectedIds, allAssistants, registeredAssistants);
  const selectedSet = new Set(selectedIds);
  const toReregister = registeredAssistants.filter(a => selectedSet.has(a.id));

  if (toRegister.length === 0 && toUnregister.length === 0 && toReregister.length === 0) {
    console.log(chalk.yellow(MESSAGES.SETUP.NO_CHANGES_TO_APPLY));
    return { newRegistrations: registeredAssistants, registered: [], unregistered: [] };
  }

  for (const assistant of [...toUnregister, ...toReregister]) {
    await unregisterAssistant(assistant, scope, workingDir, target);
  }

  const allToRegister = [...toRegister, ...toReregister];

  const newRegistrations = await registerAllOrAbort(
    allToRegister,
    (assistant) => assistant.name,
    async (assistant) => {
      const fullAssistant = getFullAssistant(assistant, allAssistants);
      if (!fullAssistant) {
        throw new RegistrationItemNotFoundError('assistant', assistant.id);
      }

      const mode = registrationModes.get(fullAssistant.id) || REGISTRATION_MODE.AGENT;
      return registerAssistant(fullAssistant, mode, scope, workingDir, target);
    }
  );

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
