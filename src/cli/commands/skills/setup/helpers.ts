import chalk from 'chalk';
import type { SkillDetail, SkillListItem } from 'codemie-sdk';
import type { CodemieSkill } from '@/env/types.js';
import { logger } from '@/utils/logger.js';
import { registerClaudeSkill, unregisterClaudeSkill } from '@/cli/commands/skills/setup/generators/claude-skill-generator.js';
import { registerCodexSkill, unregisterCodexSkill } from '@/cli/commands/skills/setup/generators/codex-skill-generator.js';
import { registerGeminiSkill, unregisterGeminiSkill } from '@/cli/commands/skills/setup/generators/gemini-skill-generator.js';
import { executeWithSpinner, determineChanges as _determineChanges } from '@/cli/commands/shared/helpers.js';
import {
  formatAgentInvocation,
  formatAgentSetupTarget,
  targetsClaude,
  targetsCodex,
  targetsGemini,
  type AgentSetupTarget,
} from '@/cli/commands/shared/agent-targets.js';

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

export async function unregisterSkill(
  skill: CodemieSkill,
  scope: 'global' | 'local' = 'global',
  workingDir?: string,
  target: AgentSetupTarget = ['claude']
): Promise<void> {
  await executeWithSpinner(
    `Unregistering ${chalk.bold(skill.name)}...`,
    async () => {
      if (targetsClaude(target)) {
        await unregisterClaudeSkill(skill.slug, scope, workingDir);
      }
      if (targetsCodex(target)) {
        await unregisterCodexSkill(skill.slug, scope, workingDir);
      }
      if (targetsGemini(target)) {
        await unregisterGeminiSkill(skill.slug, scope, workingDir);
      }
    },
    `Unregistered ${chalk.bold(skill.name)} ${chalk.cyan(`/${skill.slug}`)}`,
    `Failed to unregister ${skill.name}`,
    (error) => logger.error('Skill removal failed', { error, skillId: skill.id, target })
  );
}

export async function registerSkill(
  skill: SkillDetail,
  scope: 'global' | 'local' = 'global',
  workingDir?: string,
  target: AgentSetupTarget = ['claude']
): Promise<CodemieSkill | null> {
  const targetLabel = formatAgentSetupTarget(target);
  const invocationLabel = target
    .map(agent => formatAgentInvocation(skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), agent))
    .join(', ');

  const result = await executeWithSpinner(
    `Registering ${chalk.bold(skill.name)}...`,
    async () => {
      let slug: string | undefined;
      if (targetsClaude(target)) {
        slug = await registerClaudeSkill(skill, scope, workingDir);
      }
      if (targetsCodex(target)) {
        slug = await registerCodexSkill(skill, scope, workingDir);
      }
      if (targetsGemini(target)) {
        slug = await registerGeminiSkill(skill, scope, workingDir);
      }
      return slug;
    },
    `Registered ${chalk.bold(skill.name)} ${chalk.cyan(invocationLabel)} for ${targetLabel}`,
    `Failed to register ${skill.name}`,
    (error) => logger.error('Skill registration failed', { error, skillId: skill.id, target })
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
    agentTargets: target,
  };
}
