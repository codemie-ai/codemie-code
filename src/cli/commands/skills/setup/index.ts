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

async function showDisclaimer(): Promise<boolean> {
  const ANSI = {
    CLEAR_SCREEN: '\x1B[2J\x1B[H',
    SHOW_CURSOR: '\x1B[?25h',
  } as const;

  const KEY = {
    ENTER: '\r',
    ESC: '\x1B',
    CTRL_C: '\x03',
  } as const;

  const lines = [
    '',
    chalk.yellow('  ⚠  Skills are installed without tools or MCP servers.'),
    '',
    chalk.white('  If you need tools or MCP servers with your skill:'),
    chalk.white('  1. Go to ') + chalk.cyan('https://codemie.lab.epam.com/assistants'),
    chalk.white('  2. Create an assistant and attach your skill to it'),
    chalk.white('  3. Run: ') + chalk.cyan('codemie assistants setup') + chalk.white(' to install the assistant as a skill'),
    '',
    chalk.dim('  Press Enter to continue  ·  Ctrl+C to exit'),
    '',
  ];

  process.stdout.write(lines.join('\n'));

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.stdout.write(ANSI.SHOW_CURSOR + ANSI.CLEAR_SCREEN);
    }

    process.stdin.on('data', (key: string) => {
      if (key === KEY.ENTER) {
        cleanup();
        resolve(true);
      } else if (key === KEY.ESC || key === KEY.CTRL_C) {
        cleanup();
        resolve(false);
      }
    });
  });
}

async function setupSkills(options: { profile?: string }): Promise<void> {
  // Resolve profile name first so both load and save use the same profile.
  // Without this, ConfigLoader.load() may pull a different global activeProfile
  // than the local config's activeProfile, causing codemieSkills to be invisible.
  const profileName = options.profile ?? await ConfigLoader.getActiveProfileName() ?? 'default';
  const config = await ConfigLoader.load(process.cwd(), { name: profileName });
  const client = await getAuthenticatedClient(config);

  // Show disclaimer before skill selection
  const proceed = await showDisclaimer();
  if (!proceed) {
    console.log(chalk.dim('\nNo changes made.\n'));
    return;
  }

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
