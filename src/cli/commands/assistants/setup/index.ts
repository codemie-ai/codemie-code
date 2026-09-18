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
import {
  enableVerboseLogging,
  handleSetupError,
  persistPartialWrites,
  registerAllOrAbort,
} from '@/cli/commands/shared/helpers.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';
import { resolveAgentSetupTargets, type AgentSetupTarget, type TargetAgent } from '@/cli/commands/shared/agent-targets.js';
import { RegistrationItemNotFoundError, ConfigurationError } from '@/utils/errors.js';
import {
  isHeadlessMode,
  requireFlag,
  parseScopeFlag,
  parseListFlag,
  partitionRegisteredByRequest,
  resolveHeadlessAgentTarget,
} from '@/cli/commands/shared/headless.js';
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

  // The wizard drops every assistant the user deselected, so only the selected
  // ones are carried over alongside whatever the write batch produced.
  const selectedRegistered = registeredAssistants.filter(a => selectedIds.includes(a.id));

  const { registered, unregistered, saved } = await applyChangesAndSave({
    selectedIds,
    allAssistants: selectedAssistants,
    registeredInScope: registeredAssistants,
    carryOver: (written) => withoutWritten(selectedRegistered, written),
    registrationModes,
    scope: storageScope,
    workingDir,
    target,
  });

  if (saved === null) {
    displaySummary(registered, unregistered, profileName, registeredAssistants);
    return;
  }

  displaySummary(registered, unregistered, profileName, saved, ConfigLoader.getConfigLocationLabel(storageScope, workingDir));
}

interface HeadlessAssistantFlags {
  identifiers: string[];
  storageScope: StorageScope;
  registrationMode: RegistrationMode;
  target: AgentSetupTarget;
}

/**
 * Validates and parses every headless input before any network call or write, so a
 * missing or invalid flag aborts with an error naming it. `--agent` may come from
 * the hosting agent (`codemie-<agent> setup assistants`); nothing else is inferred.
 */
function parseHeadlessAssistantFlags(
  options: SetupCommandOptions,
  hostAgent?: TargetAgent
): HeadlessAssistantFlags {
  if (options.project || options.allProjects) {
    throw new ConfigurationError(
      'Non-interactive registration does not support --project/--all-projects. '
      + 'Name the assistants explicitly with --assistant (id, slug, or exact name).'
    );
  }

  return {
    identifiers: parseListFlag(requireFlag(options.assistant, '--assistant')),
    storageScope: parseScopeFlag(requireFlag(options.scope, '--scope')),
    registrationMode: parseRegistrationModeFlag(requireFlag(options.mode, '--mode')),
    target: resolveHeadlessAgentTarget(options.agent, hostAgent),
  };
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

  const { identifiers, storageScope, registrationMode, target } = parseHeadlessAssistantFlags(options, hostAgent);

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config, { nonInteractive: true });
  // Only the scope being written may be read here: the cross-scope merged view
  // would copy the other scope's registrations into this one on save.
  const registeredAssistants = await ConfigLoader.loadAssistantsByScope(storageScope, workingDir);
  config.codemieAssistants = registeredAssistants;

  const fetcher = createDataFetcher({ config, client, options });
  const catalog = await fetcher.fetchAllVisibleAssistants();

  const resolvedAssistants = resolveIdentifiers('assistant', identifiers, catalog);
  const selectedIds = Array.from(new Set(resolvedAssistants.map(assistant => assistant.id)));
  const { inScope } = partitionRegisteredByRequest(registeredAssistants, selectedIds);

  const registrationModes = new Map<string, RegistrationMode>(
    selectedIds.map(id => [id, registrationMode])
  );

  const { registered, unregistered, saved } = await applyChangesAndSave({
    selectedIds,
    allAssistants: catalog,
    registeredInScope: inScope,
    // Headless registration is purely additive: every already-registered
    // assistant the request does not name survives the save untouched.
    carryOver: (written) => withoutWritten(registeredAssistants, written),
    registrationModes,
    scope: storageScope,
    workingDir,
    target,
  });

  if (saved === null) {
    displaySummary(registered, unregistered, profileName, registeredAssistants);
    return;
  }

  displaySummary(registered, unregistered, profileName, saved, ConfigLoader.getConfigLocationLabel(storageScope, workingDir));
}

function withoutWritten(assistants: CodemieAssistant[], written: CodemieAssistant[]): CodemieAssistant[] {
  const writtenIds = new Set(written.map(assistant => assistant.id));
  return assistants.filter(assistant => !writtenIds.has(assistant.id));
}

interface ApplyAndSaveParams {
  selectedIds: string[];
  allAssistants: (Assistant | AssistantBase)[];
  registeredInScope: CodemieAssistant[];
  /** Records that must survive the save, given whatever the batch wrote. */
  carryOver: (written: CodemieAssistant[]) => CodemieAssistant[];
  registrationModes: Map<string, RegistrationMode>;
  scope: StorageScope;
  workingDir: string;
  target: AgentSetupTarget;
}

interface ApplyAndSaveResult extends ApplyChangesResult {
  /** The saved list, or null when there was nothing to apply and nothing was saved. */
  saved: CodemieAssistant[] | null;
}

/**
 * Applies the registration batch and saves the config, including when the batch
 * aborts partway: whatever reached disk is recorded before the error propagates,
 * so the config never claims less than what exists.
 */
async function applyChangesAndSave(params: ApplyAndSaveParams): Promise<ApplyAndSaveResult> {
  const { scope, workingDir } = params;
  const save = (items: CodemieAssistant[]): Promise<void> =>
    ConfigLoader.saveAssistantsToProjectConfig(workingDir, scope, items);
  const written: CodemieAssistant[] = [];

  try {
    const result = await applyChanges(
      params.selectedIds,
      params.allAssistants,
      params.registeredInScope,
      params.registrationModes,
      scope,
      workingDir,
      params.target,
      written
    );

    if (result.registered.length === 0 && result.unregistered.length === 0) {
      return { ...result, saved: null };
    }

    const saved = [...params.carryOver(result.newRegistrations), ...result.newRegistrations];
    await save(saved);

    return { ...result, saved };
  } catch (error) {
    await persistPartialWrites(written, params.carryOver(written), save);
    throw error;
  }
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
  target: AgentSetupTarget = ['claude'],
  /** Collects each registration as it reaches disk, so a caller can record a partial batch. */
  writeSink?: CodemieAssistant[]
): Promise<ApplyChangesResult> {
  const { toRegister, toUnregister } = determineChanges(selectedIds, allAssistants, registeredAssistants);
  const selectedSet = new Set(selectedIds);
  const toReregister = registeredAssistants.filter(a => selectedSet.has(a.id));

  if (toRegister.length === 0 && toUnregister.length === 0 && toReregister.length === 0) {
    console.log(chalk.yellow(MESSAGES.SETUP.NO_CHANGES_TO_APPLY));
    return { newRegistrations: registeredAssistants, registered: [], unregistered: [] };
  }

  for (const assistant of toUnregister) {
    await unregisterAssistant(assistant, scope, workingDir, target);
  }

  const allToRegister = [...toRegister, ...toReregister];

  const newRegistrations = await registerAllOrAbort(
    allToRegister,
    (assistant) => assistant.name,
    (assistant) => writeOneAssistant(assistant, {
      allAssistants,
      registrationModes,
      scope,
      workingDir,
      target,
      writeSink,
    })
  );

  return {
    newRegistrations,
    registered: [...toRegister, ...getFullAssistants(toReregister, allAssistants)],
    unregistered: toUnregister,
  };
}

interface WriteAssistantContext {
  allAssistants: (Assistant | AssistantBase)[];
  registrationModes: Map<string, RegistrationMode>;
  scope: StorageScope;
  workingDir?: string;
  target: AgentSetupTarget;
  writeSink?: CodemieAssistant[];
}

async function writeOneAssistant(
  assistant: Assistant | CodemieAssistant,
  context: WriteAssistantContext
): Promise<CodemieAssistant> {
  const { allAssistants, registrationModes, scope, workingDir, target, writeSink } = context;
  const fullAssistant = getFullAssistant(assistant, allAssistants);

  if (!fullAssistant) {
    throw new RegistrationItemNotFoundError('assistant', assistant.id);
  }

  // A re-registration removes its previous artifacts immediately before the
  // replacement is written, never up front for the whole batch: an earlier
  // failure would otherwise leave working registrations deleted and unwritten.
  if ('registeredAt' in assistant) {
    await unregisterAssistant(assistant, scope, workingDir, target);
  }

  const mode = registrationModes.get(fullAssistant.id) || REGISTRATION_MODE.AGENT;
  const registration = await registerAssistant(fullAssistant, mode, scope, workingDir, target);
  writeSink?.push(registration);

  return registration;
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
