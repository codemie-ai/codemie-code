/**
 * Registration Operations Module
 *
 * Handles registration/unregistration business logic for skills
 */

import chalk from 'chalk';
import ora from 'ora';
import type { SkillDetail, SkillListItem } from 'codemie-sdk';
import type { CodemieSkill } from '@/env/types.js';
import { logger } from '@/utils/logger.js';
import { registerClaudeSkill, unregisterClaudeSkill } from '@/cli/commands/skills/setup/generators/claude-skill-generator.js';

export interface RegistrationChanges {
  toRegister: SkillListItem[];
  toUnregister: CodemieSkill[];
}

/**
 * Determine which skills to register and unregister
 */
export function determineChanges(
  selectedIds: string[],
  allSkills: SkillListItem[],
  registeredSkills: CodemieSkill[]
): RegistrationChanges {
  const selectedSet = new Set(selectedIds);
  const registeredIds = new Set(registeredSkills.map(s => s.id));

  const toRegister = allSkills.filter(
    s => selectedSet.has(s.id) && !registeredIds.has(s.id)
  );

  const toUnregister = registeredSkills.filter(s => !selectedSet.has(s.id));

  return { toRegister, toUnregister };
}

/**
 * Execute skill operation with spinner
 */
async function executeWithSpinner<T>(
  spinnerMessage: string,
  operation: () => Promise<T>,
  successMessage: string,
  errorMessage: string,
  onError?: (error: unknown) => void
): Promise<T | null> {
  const isVerbose = process.env.CODEMIE_DEBUG === 'true';
  const spinner = ora(spinnerMessage).start();

  try {
    const result = await operation();
    if (isVerbose) {
      spinner.succeed(chalk.green(successMessage));
    } else {
      spinner.clear();
      spinner.stop();
    }
    return result;
  } catch (error) {
    if (isVerbose) {
      spinner.fail(chalk.red(errorMessage));
    } else {
      spinner.clear();
      spinner.stop();
    }
    if (onError) {
      onError(error);
    }
    return null;
  }
}

/**
 * Unregister a skill
 * Removes Claude skill file
 */
export async function unregisterSkill(skill: CodemieSkill): Promise<void> {
  await executeWithSpinner(
    `Unregistering ${chalk.bold(skill.name)}...`,
    async () => {
      await unregisterClaudeSkill(skill.slug);
    },
    `Unregistered ${chalk.bold(skill.name)} ${chalk.cyan(`/${skill.slug}`)}`,
    `Failed to unregister ${skill.name}`,
    (error) => logger.error('Skill removal failed', { error, skillId: skill.id })
  );
}

/**
 * Register a skill
 */
export async function registerSkill(
  skill: SkillDetail
): Promise<CodemieSkill | null> {
  const result = await executeWithSpinner(
    `Registering ${chalk.bold(skill.name)}...`,
    async () => {
      const slug = await registerClaudeSkill(skill);
      return slug;
    },
    `Registered ${chalk.bold(skill.name)} ${chalk.cyan(`/${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)}`,
    `Failed to register ${skill.name}`,
    (error) => logger.error('Skill registration failed', { error, skillId: skill.id })
  );

  if (!result) {
    return null;
  }

  return {
    id: skill.id,
    name: skill.name,
    slug: result,
    description: skill.description,
    project: skill.project,
    registeredAt: new Date().toISOString()
  };
}
