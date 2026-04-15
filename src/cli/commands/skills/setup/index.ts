/**
 * Setup Skills Command
 *
 * Fetches platform skills and registers them as Claude Code skills
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { createErrorContext, formatErrorForUser } from '@/utils/errors.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { createSkillDataFetcher } from './data.js';
import { promptSkillSelection } from './selection/index.js';
import { determineChanges, registerSkill, unregisterSkill } from './helpers.js';
import { ACTION_TYPE } from './constants.js';
import type { CodemieSkill } from '@/env/types.js';

export type { CodemieSkill };

export function createSkillsSetupCommand(): Command {
  const command = new Command('setup');

  command
    .description('Manage CodeMie platform skills (view, register, unregister)')
    .option('--profile <name>', 'Profile to use')
    .option('-v, --verbose', 'Enable verbose debug output')
    .action(async (options: { profile?: string; verbose?: boolean }) => {
      if (options.verbose) {
        process.env.CODEMIE_DEBUG = 'true';
        const logFilePath = logger.getLogFilePath();
        if (logFilePath) {
          console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
        }
      }

      try {
        await setupSkills(options);
      } catch (error: unknown) {
        const context = createErrorContext(error);
        logger.error('Failed to setup skills', context);
        console.error(formatErrorForUser(context));
        process.exit(1);
      }
    });

  return command;
}

async function setupSkills(options: { profile?: string }): Promise<void> {
  const config = await ConfigLoader.load();
  const client = await getAuthenticatedClient(config);

  // Get currently registered skills
  const registeredSkills: CodemieSkill[] = config.codemieSkills || [];

  // Show interactive selection UI
  const { selectedIds, action } = await promptSkillSelection(registeredSkills, client);

  if (action === ACTION_TYPE.CANCEL) {
    console.log(chalk.dim('\nNo changes made.\n'));
    return;
  }

  // Fetch full details for selected skills
  const fetcher = createSkillDataFetcher({ client, registeredSkills });
  const selectedSkills = await fetcher.fetchSkillsByIds(selectedIds, registeredSkills);

  // Determine changes
  const { toRegister, toUnregister } = determineChanges(selectedIds, selectedSkills, registeredSkills);

  if (toRegister.length === 0 && toUnregister.length === 0) {
    console.log(chalk.yellow('\nNo changes to apply.\n'));
    return;
  }

  // Unregister removed skills
  for (const skill of toUnregister) {
    await unregisterSkill(skill);
  }

  // Register new skills
  const newlyRegistered: CodemieSkill[] = [];
  for (const skill of toRegister) {
    const detail = await fetcher.fetchSkillById(skill.id);
    const registered = await registerSkill(detail);
    if (registered) {
      newlyRegistered.push(registered);
    }
  }

  // Build updated skills list
  const updatedSkills: CodemieSkill[] = [
    ...registeredSkills.filter(s => selectedIds.includes(s.id)),
    ...newlyRegistered,
  ];

  // Save to config
  const profileName = options.profile || await ConfigLoader.getActiveProfileName() || 'default';
  config.codemieSkills = updatedSkills;
  await ConfigLoader.saveProfile(profileName, config);

  // Summary
  console.log('');
  if (newlyRegistered.length > 0) {
    console.log(chalk.green(`✓ Registered ${newlyRegistered.length} skill(s)`));
  }
  if (toUnregister.length > 0) {
    console.log(chalk.yellow(`○ Unregistered ${toUnregister.length} skill(s)`));
  }
  console.log(chalk.dim('\nSkills are available in Claude Code as /skill-name commands.\n'));
}
