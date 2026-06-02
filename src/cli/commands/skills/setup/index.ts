import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigLoader } from '@/utils/config.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { createSkillDataFetcher } from './data.js';
import { promptSkillSelection } from './selection/index.js';
import { determineChanges, registerSkill, unregisterSkill } from './helpers.js';
import { ACTION_TYPE } from './constants.js';
import { enableVerboseLogging, handleSetupError } from '@/cli/commands/shared/helpers.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';
import { resolveAgentSetupTargets, formatAgentSetupTarget, type TargetAgent } from '@/cli/commands/shared/agent-targets.js';
import type { CodemieSkill } from '@/env/types.js';

export type { CodemieSkill };

export function createSkillsSetupCommand(hostAgent?: TargetAgent): Command {
  const command = new Command('setup');

  command
    .description('Manage CodeMie platform skills (view, register, unregister)')
    .option('--profile <name>', 'Profile to use')
    .option('--agent <agents>', 'Target agent(s), comma-separated: claude, codex, gemini')
    .option('-v, --verbose', 'Enable verbose debug output')
    .action(async (options: { profile?: string; agent?: string; verbose?: boolean }) => {
      if (options.verbose) {
        enableVerboseLogging();
      }

      try {
        await setupSkills(options, hostAgent);
      } catch (error: unknown) {
        handleSetupError(error, 'setup skills');
      }
    });

  return command;
}

async function setupSkills(options: { profile?: string; agent?: string }, hostAgent?: TargetAgent): Promise<void> {
  const profileName = options.profile ?? await ConfigLoader.getActiveProfileName() ?? 'default';
  const workingDir = process.cwd();

  const storageScope = await promptStorageScope({
    title: 'Where would you like to save skills configuration?',
    localNote: 'Project-scoped skills will override global ones for this repository.',
  });
  const target = await resolveAgentSetupTargets(options.agent, hostAgent);

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config);
  const registeredSkills: CodemieSkill[] = await ConfigLoader.loadSkillsByScope(storageScope, workingDir, profileName);

  const { selectedIds, action } = await promptSkillSelection(registeredSkills, client);

  if (action === ACTION_TYPE.CANCEL) {
    console.log(chalk.dim('\nNo changes made.\n'));
    return;
  }

  const fetcher = createSkillDataFetcher({ client, registeredSkills });
  const selectedSkills = await fetcher.fetchSkillsByIds(selectedIds, registeredSkills);

  const { toRegister, toUnregister } = determineChanges(selectedIds, selectedSkills, registeredSkills);

  if (toRegister.length === 0 && toUnregister.length === 0) {
    console.log(chalk.yellow('\nNo changes to apply.\n'));
    return;
  }

  for (const skill of toUnregister) {
    await unregisterSkill(skill, storageScope, workingDir, target);
  }

  const newlyRegistered: CodemieSkill[] = [];
  for (const skill of toRegister) {
    const detail = await fetcher.fetchSkillById(skill.id);
    const registered = await registerSkill(detail, storageScope, workingDir, target);
    if (registered) {
      newlyRegistered.push(registered);
    }
  }

  const updatedSkills: CodemieSkill[] = [
    ...registeredSkills.filter(s => selectedIds.includes(s.id)),
    ...newlyRegistered,
  ];

  await ConfigLoader.saveSkillsToProjectConfig(workingDir, storageScope, updatedSkills);

  const configLocation = ConfigLoader.getConfigLocationLabel(storageScope, workingDir);

  console.log('');
  if (newlyRegistered.length > 0) {
    console.log(chalk.green(`✓ Registered ${newlyRegistered.length} skill(s)`));
  }
  if (toUnregister.length > 0) {
    console.log(chalk.yellow(`○ Unregistered ${toUnregister.length} skill(s)`));
  }
  console.log(chalk.dim(`\nSkills saved to: ${configLocation}`));
  console.log(chalk.dim(`Skills are available for ${formatAgentSetupTarget(target)}.\n`));
}
