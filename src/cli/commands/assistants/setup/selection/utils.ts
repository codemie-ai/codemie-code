/**
 * Selection Helper Utilities
 *
 * Handles choice building, filtering, sorting, and display formatting
 */

import chalk from 'chalk';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';

export interface AssistantChoice {
  name: string;
  value: string;
  short: string;
  checked: boolean;
}

/**
 * Build display info for assistant choice
 */
export function buildAssistantDisplayInfo(assistant: Assistant): string {
  const project = assistant.project;
  const projectName = project && typeof project === 'object' ? (project as { name: string }).name : project as string | undefined;
  const projectInfo = projectName ? chalk.dim(` [${projectName}]`) : '';
  const firstLine = assistant.name + projectInfo;

  const descriptionInfo = assistant.description ? chalk.dim(`\n   ${assistant.description}`) : '';

  return firstLine + descriptionInfo;
}

/**
 * Create assistant choices for selection prompt
 */
export function createAssistantChoices(
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
 * Display message when no assistants are found
 */
export function displayNoAssistantsMessage(
  options: { project?: string; allProjects?: boolean },
  config: ProviderProfile
): void {
  console.log(chalk.yellow(MESSAGES.SETUP.NO_ASSISTANTS));

  const filterProject = options.project || config.codeMieProject;
  if (filterProject && !options.allProjects) {
    console.log(chalk.dim(MESSAGES.SETUP.FILTERED_BY_PROJECT(chalk.cyan(filterProject))));
    console.log(chalk.dim(`Try ${chalk.cyan(MESSAGES.SETUP.TRY_ALL_PROJECTS)}${MESSAGES.SETUP.HINT_TRY_ALL}`));
  }
}

/**
 * Get project filter from options or config
 */
export function getProjectFilter(
  options: { project?: string; allProjects?: boolean },
  config: ProviderProfile
): string | undefined {
  if (options.allProjects) {
    return undefined;
  }
  return options.project || config.codeMieProject;
}
