/**
 * List Assistants Command
 *
 * Unified command to view, register, and unregister CodeMie assistants
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { ConfigLoader } from '@/utils/config.js';
import { ConfigurationError, createErrorContext, formatErrorForUser } from '@/utils/errors.js';
import { generateAssistantSkill, removeAssistantSkill } from '@/utils/skill-generator.js';
import type { RegisteredAssistant } from '@/env/types.js';

/**
 * Create assistants list command
 */
export function createAssistantsListCommand(): Command {
  const command = new Command('list');

  command
    .description('Manage CodeMie assistants (view, register, unregister)')
    .option('--profile <name>', 'Select profile to configure')
    .option('--project <project>', 'Filter assistants by project name')
    .option('--all-projects', 'Show assistants from all projects')
    .option('-v, --verbose', 'Enable verbose debug output')
    .action(async (options: {
      profile?: string;
      project?: string;
      allProjects?: boolean;
      verbose?: boolean;
    }) => {
      if (options.verbose) {
        process.env.CODEMIE_DEBUG = 'true';
        const logFilePath = logger.getLogFilePath();
        if (logFilePath) {
          console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
        }
      }

      try {
        await manageAssistants(options);
      } catch (error: unknown) {
        const context = createErrorContext(error);
        logger.error('Failed to manage assistants', context);
        console.error(formatErrorForUser(context));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Manage assistants - unified list/register/unregister
 */
async function manageAssistants(options: {
  profile?: string;
  project?: string;
  allProjects?: boolean;
}): Promise<void> {
  // 1. Load current profile
  const config = await ConfigLoader.load();
  const profileName = options.profile || await ConfigLoader.getActiveProfileName() || 'default';

  logger.debug('Managing assistants', { profileName, options });

  // 2. Get authenticated client and fetch assistants from backend
  const client = await getCodemieClient();
  const backendAssistants = await fetchAssistants(client, options, config);

  // 3. Get currently registered assistants
  const registeredAssistants = config.codeMieAssistants || [];
  const registeredIds = new Set(registeredAssistants.map(a => a.id));

  // 4. Separate and sort: registered first, then unregistered
  const registered = backendAssistants.filter(a => registeredIds.has(a.id));
  const unregistered = backendAssistants.filter(a => !registeredIds.has(a.id));
  const sortedAssistants = [...registered, ...unregistered];

  if (sortedAssistants.length === 0) {
    console.log(chalk.yellow('\nNo assistants found.'));
    if (options.project || config.codeMieProject) {
      const filterProject = options.project || config.codeMieProject;
      console.log(chalk.dim(`Filtered by project: ${chalk.cyan(filterProject)}`));
      console.log(chalk.dim(`Try ${chalk.cyan('--all-projects')} to see all assistants.\n`));
    }
    return;
  }

  // 5. Prompt user selection with Update/Cancel
  const { selectedIds, action } = await promptAssistantSelection(
    sortedAssistants,
    registeredIds,
    registeredAssistants
  );

  if (action === 'cancel') {
    console.log(chalk.dim('\nNo changes made.\n'));
    return;
  }

  // 6. Apply changes
  await applyChanges(selectedIds, sortedAssistants, registeredAssistants, config, profileName);
}

/**
 * Fetch assistants from backend
 */
async function fetchAssistants(
  client: Awaited<ReturnType<typeof getCodemieClient>>,
  options: { project?: string; allProjects?: boolean },
  config: any
): Promise<(Assistant | AssistantBase)[]> {
  const spinner = ora('Fetching assistants...').start();

  try {
    const filters: Record<string, unknown> = {
      my_assistants: true
    };

    if (!options.allProjects) {
      const projectFilter = options.project || config.codeMieProject;
      if (projectFilter) {
        filters.project = projectFilter;
        logger.debug('Filtering assistants by project', { project: projectFilter });
      }
    }

    const assistants = await client.assistants.list({ filters });
    spinner.succeed(chalk.green(`Found ${assistants.length} assistant${assistants.length === 1 ? '' : 's'}`));
    return assistants;
  } catch (error) {
    spinner.fail(chalk.red('Failed to fetch assistants'));
    logger.error('Assistant list API call failed', { error });

    if (error instanceof Error && (error.message.includes('401') || error.message.includes('403'))) {
      throw new ConfigurationError(
        'Authentication expired. Please run "codemie setup" again.'
      );
    }

    throw error;
  }
}

/**
 * Prompt user to select assistants with Update/Cancel
 */
async function promptAssistantSelection(
  assistants: (Assistant | AssistantBase)[],
  registeredIds: Set<string>,
  registeredAssistants: RegisteredAssistant[]
): Promise<{ selectedIds: string[]; action: 'update' | 'cancel' }> {
  const registeredMap = new Map(registeredAssistants.map(a => [a.id, a]));

  const choices = assistants.map(assistant => {
    const a = assistant as Assistant;
    const isRegistered = registeredIds.has(a.id);
    const reg = registeredMap.get(a.id);

    const projectInfo = a.project ? chalk.dim(` (${a.project})`) : '';
    const modelInfo = a.llm_model_type ? chalk.dim(` [${a.llm_model_type}]`) : '';
    const slugInfo = reg?.slug ? chalk.dim(` - /${reg.slug}`) : '';

    return {
      name: a.name + projectInfo + modelInfo + slugInfo,
      value: a.id,
      short: a.name,
      checked: isRegistered
    };
  });

  const { selectedIds } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedIds',
      message: 'Select assistants to register (space to toggle, enter when done):',
      choices,
      pageSize: 15
    }
  ]);

  // Ask for action
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'Update - Apply changes', value: 'update' },
        { name: 'Cancel - Discard changes', value: 'cancel' }
      ]
    }
  ]);

  return { selectedIds, action };
}

/**
 * Apply registration changes
 */
async function applyChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: RegisteredAssistant[],
  config: any,
  profileName: string
): Promise<void> {
  const selectedSet = new Set(selectedIds);
  const registeredIds = new Set(registeredAssistants.map(a => a.id));

  // Determine what to register and unregister
  const toRegister = allAssistants.filter(a => selectedSet.has(a.id) && !registeredIds.has(a.id)) as Assistant[];
  const toUnregister = registeredAssistants.filter(a => !selectedSet.has(a.id));

  if (toRegister.length === 0 && toUnregister.length === 0) {
    console.log(chalk.yellow('\nNo changes to apply\n'));
    return;
  }

  console.log('');

  // Unregister first
  for (const assistant of toUnregister) {
    const spinner = ora(`Unregistering ${chalk.bold(assistant.name)}...`).start();
    try {
      await removeAssistantSkill(assistant.name);
      spinner.succeed(chalk.green(`Unregistered ${chalk.bold(assistant.name)} (${chalk.cyan(`/${assistant.slug}`)})`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to unregister ${assistant.name}`));
      logger.error('Skill removal failed', { error, assistantId: assistant.id });
    }
  }

  // Register new ones
  const newRegistrations: RegisteredAssistant[] = [];
  for (const assistant of toRegister) {
    const spinner = ora(`Registering ${chalk.bold(assistant.name)}...`).start();
    try {
      const slug = await generateAssistantSkill(assistant);

      newRegistrations.push({
        id: assistant.id,
        name: assistant.name,
        slug,
        description: assistant.description,
        project: assistant.project,
        llmModelType: assistant.llm_model_type,
        registeredAt: new Date().toISOString()
      });

      spinner.succeed(chalk.green(`Registered ${chalk.bold(assistant.name)} as ${chalk.cyan(`/${slug}`)}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to register ${assistant.name}`));
      logger.error('Skill generation failed', { error, assistantId: assistant.id });
    }
  }

  // Update config
  const remainingRegistered = registeredAssistants.filter(a => selectedSet.has(a.id));
  config.codeMieAssistants = [...remainingRegistered, ...newRegistrations];
  await ConfigLoader.saveProfile(profileName, config);

  // Summary
  const totalChanges = toRegister.length + toUnregister.length;
  console.log(chalk.green(`\n✓ Updated ${totalChanges} assistant${totalChanges === 1 ? '' : 's'}`));
  if (toRegister.length > 0) {
    console.log(chalk.dim(`  Registered: ${toRegister.length}`));
  }
  if (toUnregister.length > 0) {
    console.log(chalk.dim(`  Unregistered: ${toUnregister.length}`));
  }
  console.log(chalk.dim(`  Profile: ${profileName}\n`));

  if (config.codeMieAssistants.length > 0) {
    console.log(chalk.bold('Currently registered assistants:'));
    config.codeMieAssistants.forEach((a: RegisteredAssistant) => {
      console.log(chalk.white(`  • ${chalk.cyan(`/${a.slug}`)} - ${a.name}`));
    });
    console.log('');
  }
}
