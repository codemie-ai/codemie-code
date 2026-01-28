/**
 * List Assistants Command
 *
 * Unified command to view, register, and unregister CodeMie assistants
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import type { Assistant, AssistantBase, CodeMieClient } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { createErrorContext, formatErrorForUser } from '@/utils/errors.js';
import { registerClaudeSubagent, unregisterClaudeSubagent } from './generators/claude-agent-generator.js';
import type { CodemieAssistant, ProviderProfile } from '@/env/types.js';
import { MESSAGES, COMMAND_NAMES, ACTIONS, type ActionType } from './constants.js';
import { getAuthenticatedClient, promptReauthentication } from '@/utils/auth.js';

interface ListCommandOptions {
  profile?: string;
  project?: string;
  allProjects?: boolean;
  verbose?: boolean;
}

interface AssistantChoice {
  name: string;
  value: string;
  short: string;
  checked: boolean;
}

interface RegistrationChanges {
  toRegister: Assistant[];
  toUnregister: CodemieAssistant[];
}

/**
 * Create assistants list command
 */
export function createAssistantsListCommand(): Command {
  const command = new Command(COMMAND_NAMES.LIST);

  command
    .description(MESSAGES.LIST.COMMAND_DESCRIPTION)
    .option('--profile <name>', MESSAGES.LIST.OPTION_PROFILE)
    .option('--project <project>', MESSAGES.LIST.OPTION_PROJECT)
    .option('--all-projects', MESSAGES.LIST.OPTION_ALL_PROJECTS)
    .option('-v, --verbose', MESSAGES.SHARED.OPTION_VERBOSE)
    .action(async (options: ListCommandOptions) => {
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
 * Check if error is authentication error
 */
function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('401') || error.message.includes('403'));
}

/**
 * Manage assistants - unified list/register/unregister
 */
async function manageAssistants(options: ListCommandOptions): Promise<void> {
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
    sortedAssistants,
    registeredIds
  );

  if (action === ACTIONS.CANCEL) {
    console.log(chalk.dim(MESSAGES.LIST.NO_CHANGES_MADE));
    return;
  }

  // 6. Apply changes
  await applyChanges(selectedIds, sortedAssistants, registeredAssistants, config, profileName);
}

/**
 * Sort assistants with registered ones first
 */
function sortAssistantsByRegistration(
  assistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[]
): (Assistant | AssistantBase)[] {
  const registeredIds = new Set(registeredAssistants.map(a => a.id));
  const registered = assistants.filter(a => registeredIds.has(a.id));
  const unregistered = assistants.filter(a => !registeredIds.has(a.id));
  return [...registered, ...unregistered];
}

/**
 * Display message when no assistants are found
 */
function displayNoAssistantsMessage(options: ListCommandOptions, config: ProviderProfile): void {
  console.log(chalk.yellow(MESSAGES.LIST.NO_ASSISTANTS));

  const filterProject = options.project || config.codeMieProject;
  if (filterProject) {
    console.log(chalk.dim(MESSAGES.LIST.FILTERED_BY_PROJECT(chalk.cyan(filterProject))));
    console.log(chalk.dim(`Try ${chalk.cyan(MESSAGES.LIST.TRY_ALL_PROJECTS)}${MESSAGES.LIST.HINT_TRY_ALL}`));
  }
}

/**
 * Get project filter from options or config
 */
function getProjectFilter(options: ListCommandOptions, config: ProviderProfile): string | undefined {
  if (options.allProjects) {
    return undefined;
  }
  return options.project || config.codeMieProject;
}

/**
 * Fetch assistants from backend
 */
async function fetchAssistants(
  client: CodeMieClient,
  options: ListCommandOptions,
  config: ProviderProfile
): Promise<(Assistant | AssistantBase)[]> {
  const spinner = ora(MESSAGES.LIST.SPINNER_FETCHING).start();

  try {
    const filters: Record<string, unknown> = {
      my_assistants: true
    };

    const projectFilter = getProjectFilter(options, config);
    if (projectFilter) {
      filters.project = projectFilter;
      logger.debug('Filtering assistants by project', { project: projectFilter });
    }

    const assistants = await client.assistants.list({
      filters,
      minimal_response: false
    });
    spinner.succeed(chalk.green(MESSAGES.LIST.SUCCESS_FOUND(assistants.length)));
    return assistants;
  } catch (error) {
    spinner.fail(chalk.red(MESSAGES.LIST.ERROR_FETCH_FAILED));
    logger.error('Assistant list API call failed', { error });

    if (isAuthenticationError(error)) {
      await promptReauthentication(config);
    }

    throw error;
  }
}

/**
 * Build display info for assistant choice
 */
function buildAssistantDisplayInfo(assistant: Assistant): string {
  const projectInfo = assistant.project ? chalk.dim(` [${assistant.project}]`) : '';
  const firstLine = assistant.name + projectInfo;

  const descriptionInfo = assistant.description ? chalk.dim(`\n   ${assistant.description}`) : '';

  return firstLine + descriptionInfo;
}

/**
 * Create assistant choices for selection prompt
 */
function createAssistantChoices(
  assistants: (Assistant | AssistantBase)[],
  registeredIds: Set<string>
): AssistantChoice[] {
  return assistants.map(assistant => {
    const a = assistant as Assistant;
    const isRegistered = registeredIds.has(a.id);
    const displayName = buildAssistantDisplayInfo(a);

    return {
      name: displayName,
      value: a.id,
      short: a.name,
      checked: isRegistered
    };
  });
}

/**
 * Prompt user to select assistants with Update/Cancel
 */
async function promptAssistantSelection(
  assistants: (Assistant | AssistantBase)[],
  registeredIds: Set<string>,
): Promise<{ selectedIds: string[]; action: ActionType }> {
  const choices = createAssistantChoices(assistants, registeredIds);

  const { selectedIds } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedIds',
      message: MESSAGES.LIST.PROMPT_SELECT,
      choices,
      pageSize: 15
    }
  ]);

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: MESSAGES.LIST.PROMPT_ACTION,
      choices: [
        { name: MESSAGES.LIST.ACTION_UPDATE, value: ACTIONS.UPDATE },
        { name: MESSAGES.LIST.ACTION_CANCEL, value: ACTIONS.CANCEL }
      ]
    }
  ]);

  return { selectedIds, action };
}

/**
 * Determine which assistants to register and unregister
 */
function determineChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[]
): RegistrationChanges {
  const selectedSet = new Set(selectedIds);
  const registeredIds = new Set(registeredAssistants.map(a => a.id));

  const toRegister = allAssistants.filter(
    a => selectedSet.has(a.id) && !registeredIds.has(a.id)
  ) as Assistant[];

  const toUnregister = registeredAssistants.filter(a => !selectedSet.has(a.id));

  return { toRegister, toUnregister };
}

/**
 * Execute assistant operation with spinner
 */
async function executeWithSpinner<T>(
  spinnerMessage: string,
  operation: () => Promise<T>,
  successMessage: string,
  errorMessage: string,
  onError?: (error: unknown) => void
): Promise<T | null> {
  const spinner = ora(spinnerMessage).start();

  try {
    const result = await operation();
    spinner.succeed(chalk.green(successMessage));
    return result;
  } catch (error) {
    spinner.fail(chalk.red(errorMessage));
    if (onError) {
      onError(error);
    }
    return null;
  }
}

/**
 * Unregister an assistant
 */
async function unregisterAssistant(assistant: CodemieAssistant): Promise<void> {
  await executeWithSpinner(
    MESSAGES.LIST.SPINNER_UNREGISTERING(chalk.bold(assistant.name)),
    async () => {
      // Remove Claude subagent from ~/.claude/agents/
      await unregisterClaudeSubagent(assistant.slug);
    },
    MESSAGES.LIST.SUCCESS_UNREGISTERED(chalk.bold(assistant.name), chalk.cyan(assistant.slug)),
    MESSAGES.LIST.ERROR_UNREGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant removal failed', { error, assistantId: assistant.id })
  );
}

/**
 * Register an assistant
 */
async function registerAssistant(assistant: Assistant): Promise<CodemieAssistant | null> {
  const result = await executeWithSpinner(
    MESSAGES.LIST.SPINNER_REGISTERING(chalk.bold(assistant.name)),
    async () => {
      // Register Claude subagent in ~/.claude/agents/
      // Claude Code will auto-discover it and make it available via @mentions
      await registerClaudeSubagent(assistant);

      return assistant.slug!;
    },
    MESSAGES.LIST.SUCCESS_REGISTERED(chalk.bold(assistant.name), chalk.cyan(`@${assistant.slug!}`)),
    MESSAGES.LIST.ERROR_REGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant generation failed', { error, assistantId: assistant.id })
  );

  if (!result) {
    return null;
  }

  return {
    id: assistant.id,
    name: assistant.name,
    slug: assistant.slug!,
    description: assistant.description,
    project: assistant.project,
    registeredAt: new Date().toISOString()
  };
}

/**
 * Display summary of changes
 */
function displaySummary(
  toRegister: Assistant[],
  toUnregister: CodemieAssistant[],
  profileName: string,
  config: ProviderProfile
): void {
  const totalChanges = toRegister.length + toUnregister.length;
  console.log(chalk.green(MESSAGES.LIST.SUMMARY_UPDATED(totalChanges)));

  if (toRegister.length > 0) {
    console.log(chalk.dim(MESSAGES.LIST.SUMMARY_REGISTERED(toRegister.length)));
  }
  if (toUnregister.length > 0) {
    console.log(chalk.dim(MESSAGES.LIST.SUMMARY_UNREGISTERED(toUnregister.length)));
  }

  console.log(chalk.dim(MESSAGES.LIST.SUMMARY_PROFILE(profileName)));

  displayCurrentlyRegistered(config);
}

/**
 * Display currently registered assistants
 */
function displayCurrentlyRegistered(config: ProviderProfile): void {
  if (!config.codemieAssistants || config.codemieAssistants.length === 0) {
    return;
  }

  console.log(chalk.bold(MESSAGES.LIST.CURRENTLY_REGISTERED));
  config.codemieAssistants.forEach((assistant: CodemieAssistant) => {
    const slugText = chalk.cyan(`/${assistant.slug}`);
    console.log(chalk.white(`  • ${slugText} - ${assistant.name}`));
  });
  console.log('');
}

/**
 * Apply registration changes
 */
async function applyChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[],
  config: ProviderProfile,
  profileName: string
): Promise<void> {
  const { toRegister, toUnregister } = determineChanges(selectedIds, allAssistants, registeredAssistants);

  if (toRegister.length === 0 && toUnregister.length === 0) {
    console.log(chalk.yellow(MESSAGES.LIST.NO_CHANGES_TO_APPLY));
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
