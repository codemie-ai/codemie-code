import chalk from 'chalk';
import type { SkillDetail, SkillListItem } from 'codemie-sdk';
import type { CodemieSkill } from '@/env/types.js';
import { logger } from '@/utils/logger.js';
import { registerClaudeSkill, unregisterClaudeSkill } from '@/cli/commands/skills/setup/generators/claude-skill-generator.js';
import { executeWithSpinner, determineChanges as _determineChanges } from '@/cli/commands/shared/helpers.js';

export { executeWithSpinner };

export interface RegistrationChanges {
  toRegister: SkillListItem[];
  toUnregister: CodemieSkill[];
}

export function determineChanges(
  selectedIds: string[],
  allSkills: SkillListItem[],
  registeredSkills: CodemieSkill[]
): RegistrationChanges {
  return _determineChanges(selectedIds, allSkills, registeredSkills);
}

export async function unregisterSkill(skill: CodemieSkill, scope: 'global' | 'local' = 'global', workingDir?: string): Promise<void> {
  await executeWithSpinner(
    `Unregistering ${chalk.bold(skill.name)}...`,
    async () => {
      await unregisterClaudeSkill(skill.slug, scope, workingDir);
    },
    `Unregistered ${chalk.bold(skill.name)} ${chalk.cyan(`/${skill.slug}`)}`,
    `Failed to unregister ${skill.name}`,
    (error) => logger.error('Skill removal failed', { error, skillId: skill.id })
  );
}

export async function registerSkill(
  skill: SkillDetail,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<CodemieSkill | null> {
  const result = await executeWithSpinner(
    `Registering ${chalk.bold(skill.name)}...`,
    async () => {
      const slug = await registerClaudeSkill(skill, scope, workingDir);
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
    registeredAt: new Date().toISOString(),
  };
}
