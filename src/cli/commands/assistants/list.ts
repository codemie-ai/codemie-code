/**
 * List Assistants Command
 *
 * Lists available CodeMie assistants from the backend using codemie-sdk
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { ConfigLoader } from '@/utils/config.js';
import { ConfigurationError, createErrorContext, formatErrorForUser } from '@/utils/errors.js';

/**
 * Truncate text to specified length with ellipsis
 */
function truncateText(text: string | undefined, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Determine project filter based on options and config
 */
async function determineProjectFilter(options: {
  project?: string;
  allProjects?: boolean;
}): Promise<string | undefined> {
  if (options.allProjects) {
    logger.debug('Showing assistants from all projects (--all-projects flag)');
    return undefined;
  }

  if (options.project) {
    logger.debug('Filtering by explicit project', { project: options.project });
    return options.project;
  }

  // Load config to get project
  try {
    const config = await ConfigLoader.load();
    if (config.codeMieProject) {
      logger.debug('Filtering by config project', { project: config.codeMieProject });
      return config.codeMieProject;
    }
  } catch (error) {
    logger.debug('No config found, showing all projects', { error });
  }

  return undefined;
}

/**
 * Fetch assistants from backend with project filter
 */
async function fetchAssistants(
  client: ReturnType<typeof getCodemieClient> extends Promise<infer T> ? T : never,
  projectFilter: string | undefined
): Promise<(Assistant | AssistantBase)[]> {
  const spinner = ora('Fetching assistants...').start();

  try {
    const filters: Record<string, unknown> = {
      my_assistants: true
    };

    if (projectFilter) {
      filters.project = projectFilter;
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
 * Display assistant details
 */
function displayAssistant(assistant: Assistant | AssistantBase, index: number): void {
  const a = assistant as Assistant;
  const number = index + 1;
  const createdDate = a.created_date ? new Date(a.created_date).toLocaleDateString() : '';
  const contextTypes = a.context?.map(c => c.context_type).join(', ') || '';
  const toolkitNames = a.toolkits?.map(t => t.toolkit).join(', ') || '';
  const visibility = a.shared ? chalk.green('Shared') : chalk.white('Private');
  const scope = a.is_global ? chalk.green('Global') : chalk.white('Project');

  console.log(chalk.white(number + '.') + ' ' + chalk.bold(a.name || ''));
  console.log('   ' + chalk.dim('ID:') + ' ' + chalk.white(a.id || ''));
  console.log('   ' + chalk.dim('Project:') + ' ' + chalk.cyan(a.project || ''));
  console.log('   ' + chalk.dim('Creator:') + ' ' + chalk.white(a.creator || ''));
  console.log('   ' + chalk.dim('Model:') + ' ' + chalk.yellow(a.llm_model_type || ''));
  console.log('   ' + chalk.dim('Created:') + ' ' + chalk.white(createdDate));
  console.log('   ' + chalk.dim('Description:') + ' ' + chalk.white(truncateText(a.description, 100)));
  console.log('   ' + chalk.dim('System Prompt:') + ' ' + chalk.white(truncateText(a.system_prompt, 100)));
  console.log('   ' + chalk.dim('Context:') + ' ' + chalk.white(contextTypes));
  console.log('   ' + chalk.dim('Toolkits:') + ' ' + chalk.white(toolkitNames));
  console.log('   ' + chalk.dim('Visibility:') + ' ' + visibility);
  console.log('   ' + chalk.dim('Scope:') + ' ' + scope);
  console.log('');
}

/**
 * Display empty results message
 */
function displayEmptyResults(projectFilter: string | undefined): void {
  console.log(chalk.yellow('\nNo assistants found.'));
  if (projectFilter) {
    console.log(chalk.dim(`Filtered by project: ${chalk.cyan(projectFilter)}`));
  }
}

/**
 * Display filter information header
 */
function displayFilterInfo(
  projectFilter: string | undefined,
  options: { project?: string; allProjects?: boolean }
): void {
  if (!projectFilter) return;

  console.log(chalk.dim(`\nFiltered by project: ${chalk.cyan(projectFilter)}`));
  if (!options.project && !options.allProjects) {
    console.log(chalk.dim(`(from your config - use ${chalk.cyan('--all-projects')} to see all)\n`));
  }
}

/**
 * Display summary and next steps
 */
function displaySummary(): void {
  console.log(chalk.dim('─'.repeat(60)));
  console.log(chalk.bold('\n💡 Next Steps:\n'));
  console.log(chalk.white('  • Use an assistant ID with your CodeMie agent'));
  console.log(chalk.white('  • Run') + chalk.cyan(' codemie setup') + chalk.white(' to configure profiles'));
  console.log('');
}

/**
 * Create assistants command
 */
export function createAssistantsCommand(): Command {
  const command = new Command('assistants');

  command
    .description('List available CodeMie assistants')
    .option('--project <project>', 'Filter assistants by project name (overrides config)')
    .option('--all-projects', 'Show assistants from all projects (ignores config project)')
    .option('-v, --verbose', 'Enable verbose debug output')
    .action(async (options: { project?: string; allProjects?: boolean; verbose?: boolean }) => {
      // Enable debug mode if verbose flag is set
      if (options.verbose) {
        process.env.CODEMIE_DEBUG = 'true';
        const logFilePath = logger.getLogFilePath();
        if (logFilePath) {
          console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
        }
      }

      try {
        await listAssistants(options);
      } catch (error: unknown) {
        const context = createErrorContext(error);
        logger.error('Failed to list assistants', context);
        console.error(formatErrorForUser(context));
        process.exit(1);
      }
    });

  return command;
}

/**
 * List assistants from CodeMie backend
 */
async function listAssistants(options: {
  project?: string;
  allProjects?: boolean;
}): Promise<void> {
  const client = await getCodemieClient();
  const projectFilter = await determineProjectFilter(options);
  const assistants = await fetchAssistants(client, projectFilter);

  if (assistants.length === 0) {
    displayEmptyResults(projectFilter);
    return;
  }

  displayFilterInfo(projectFilter, options);
  console.log(chalk.bold.cyan(`\n📋 Available Assistants:\n`));
  assistants.forEach((assistant, index) => displayAssistant(assistant, index));
  displaySummary();
}
