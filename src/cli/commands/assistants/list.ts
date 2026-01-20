/**
 * List Assistants Command
 *
 * Lists available CodeMie assistants from the backend using codemie-sdk
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import { logger } from '../../../utils/logger.js';
import { getConfigAndClient } from '../../../utils/sdk-client.js';
import { ConfigurationError, createErrorContext, formatErrorForUser } from '../../../utils/errors.js';

/**
 * Truncate text to specified length with ellipsis
 */
function truncateText(text: string | undefined, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
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
  // 1. Initialize config and client
  const { config, client } = await getConfigAndClient(process.cwd());

  // 2. Determine project filter
  let projectFilter: string | undefined;

  if (options.allProjects) {
    // Explicit --all-projects flag: no filter
    projectFilter = undefined;
    logger.debug('Showing assistants from all projects (--all-projects flag)');
  } else if (options.project) {
    // Explicit --project flag: use that project
    projectFilter = options.project;
    logger.debug('Filtering by explicit project', { project: projectFilter });
  } else if (config.codeMieProject) {
    // No explicit flags: use project from config
    projectFilter = config.codeMieProject;
    logger.debug('Filtering by config project', { project: projectFilter });
  }

  // 3. Fetch assistants from backend
  const spinner = ora('Fetching assistants...').start();

  let assistants: (Assistant | AssistantBase)[];
  try {
    // Build list parameters - only fetch user's own assistants
    const filters: Record<string, unknown> = {
      my_assistants: true // Only show user's own assistants
    };

    // Add project filter if determined
    if (projectFilter) {
      filters.project = projectFilter;
    }

    const listParams = { filters };

    // Access the assistants service through the client
    assistants = await client.assistants.list(listParams);

    spinner.succeed(chalk.green(`Found ${assistants.length} assistant${assistants.length !== 1 ? 's' : ''}`));
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

  // 4. Display results
  if (assistants.length === 0) {
    console.log(chalk.yellow('\nNo assistants found.'));
    if (projectFilter) {
      console.log(chalk.dim(`Filtered by project: ${chalk.cyan(projectFilter)}`));
      console.log(chalk.dim(`Try ${chalk.cyan('codemie setup assistants --all-projects')} to see all assistants.\n`));
    }
    return;
  }

  // Show active filter information if applicable
  if (projectFilter) {
    console.log(chalk.dim(`\nFiltered by project: ${chalk.cyan(projectFilter)}`));
    if (!options.project && !options.allProjects) {
      console.log(chalk.dim(`(from your config - use ${chalk.cyan('--all-projects')} to see all)\n`));
    }
  }

  console.log(chalk.bold.cyan(`\n📋 Available Assistants:\n`));

  assistants.forEach((assistant, index) => {
    const fullAssistant = assistant as Assistant;
    console.log(`${chalk.white(`${index + 1}.`)} ${chalk.bold(fullAssistant.name)}`);
    console.log(`   ${chalk.dim('ID:')} ${chalk.white(fullAssistant.id)}`);

    if (fullAssistant.project) {
      console.log(`   ${chalk.dim('Project:')} ${chalk.cyan(fullAssistant.project)}`);
    }

    if (fullAssistant.creator) {
      console.log(`   ${chalk.dim('Creator:')} ${chalk.white(fullAssistant.creator)}`);
    }

    if (fullAssistant.llm_model_type) {
      console.log(`   ${chalk.dim('Model:')} ${chalk.yellow(fullAssistant.llm_model_type)}`);
    }

    if (fullAssistant.created_date) {
      const date = new Date(fullAssistant.created_date);
      console.log(`   ${chalk.dim('Created:')} ${chalk.white(date.toLocaleDateString())}`);
    }

    // Show description if available (truncated to 100 chars)
    if (fullAssistant.description) {
      const truncatedDesc = truncateText(fullAssistant.description, 100);
      console.log(`   ${chalk.dim('Description:')} ${chalk.white(truncatedDesc)}`);
    }

    // Show system prompt if available (truncated to 100 chars)
    if (fullAssistant.system_prompt) {
      const truncatedPrompt = truncateText(fullAssistant.system_prompt, 100);
      console.log(`   ${chalk.dim('System Prompt:')} ${chalk.white(truncatedPrompt)}`);
    }

    // Show context types if available
    if (fullAssistant.context && fullAssistant.context.length > 0) {
      const contextTypes = fullAssistant.context.map(c => c.context_type).join(', ');
      console.log(`   ${chalk.dim('Context:')} ${chalk.white(contextTypes)}`);
    }

    // Show toolkits if available
    if (fullAssistant.toolkits && fullAssistant.toolkits.length > 0) {
      const toolkitNames = fullAssistant.toolkits.map(t => t.toolkit).join(', ');
      console.log(`   ${chalk.dim('Toolkits:')} ${chalk.white(toolkitNames)}`);
    }

    // Mark shared/global assistants
    if (fullAssistant.shared) {
      console.log(`   ${chalk.dim('Visibility:')} ${chalk.green('Shared')}`);
    }
    if (fullAssistant.is_global) {
      console.log(`   ${chalk.dim('Scope:')} ${chalk.green('Global')}`);
    }

    console.log(''); // Empty line between assistants
  });

  // Display summary and next steps
  console.log(chalk.dim('─'.repeat(60)));
  console.log(chalk.bold('\n💡 Next Steps:\n'));
  console.log(chalk.white('  • Use an assistant ID with your CodeMie agent'));
  console.log(chalk.white('  • Run') + chalk.cyan(' codemie setup') + chalk.white(' to configure profiles'));
  if (projectFilter) {
    console.log(chalk.white('  • Show all projects:') + chalk.cyan(' codemie setup assistants --all-projects'));
  }
  console.log('');
}
