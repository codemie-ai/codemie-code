/**
 * API Integration Module
 *
 * Handles SDK calls and authentication for assistants setup
 */

import chalk from 'chalk';
import ora from 'ora';
import type { Assistant, AssistantBase, CodeMieClient } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import type { ProviderProfile } from '@/env/types.js';
import { promptReauthentication } from '@/utils/auth.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';

interface FetchOptions {
  project?: string;
  allProjects?: boolean;
}

/**
 * Check if error is authentication error
 */
export function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('401') || error.message.includes('403'));
}

/**
 * Get project filter from options or config
 */
function getProjectFilter(options: FetchOptions, config: ProviderProfile): string | undefined {
  if (options.allProjects) {
    return undefined;
  }
  return options.project || config.codeMieProject;
}

/**
 * Fetch assistants from CodeMie API with filters
 */
export async function fetchAssistants(
  client: CodeMieClient,
  options: FetchOptions,
  config: ProviderProfile
): Promise<(Assistant | AssistantBase)[]> {
  const spinner = ora(MESSAGES.SETUP.SPINNER_FETCHING).start();

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
    spinner.succeed(chalk.green(MESSAGES.SETUP.SUCCESS_FOUND(assistants.length)));
    return assistants;
  } catch (error) {
    spinner.fail(chalk.red(MESSAGES.SETUP.ERROR_FETCH_FAILED));
    logger.error('Assistant list API call failed', { error });

    if (isAuthenticationError(error)) {
      await promptReauthentication(config);
    }

    throw error;
  }
}
