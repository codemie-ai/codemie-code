import chalk from 'chalk';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { CodemieAssistant } from '@/env/types.js';
import { logger } from '@/utils/logger.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';
import { registerClaudeSubagent, unregisterClaudeSubagent } from '@/cli/commands/assistants/setup/generators/claude-agent-generator.js';
import { registerClaudeSkill, unregisterClaudeSkill } from '@/cli/commands/assistants/setup/generators/claude-skill-generator.js';
import { registerCodexAssistantSkill, unregisterCodexAssistantSkill } from '@/cli/commands/assistants/setup/generators/codex-skill-generator.js';
import { registerGeminiAssistantSkill, unregisterGeminiAssistantSkill } from '@/cli/commands/assistants/setup/generators/gemini-skill-generator.js';
import type { RegistrationMode } from '@/cli/commands/assistants/setup/manualConfiguration/types.js';
import { REGISTRATION_MODE } from '@/cli/commands/assistants/setup/manualConfiguration/constants.js';
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
  toRegister: Assistant[];
  toUnregister: CodemieAssistant[];
}

export function determineChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[]
): RegistrationChanges {
  return _determineChanges(selectedIds, allAssistants as Assistant[], registeredAssistants) as RegistrationChanges;
}

export async function unregisterAssistant(
  assistant: CodemieAssistant,
  scope: 'global' | 'local' = 'global',
  workingDir?: string,
  target: AgentSetupTarget = ['claude']
): Promise<void> {
  await executeWithSpinner(
    MESSAGES.SETUP.SPINNER_UNREGISTERING(chalk.bold(assistant.name)),
    async () => {
      if (targetsClaude(target)) {
        await unregisterClaudeSubagent(assistant.slug, scope, workingDir);
        await unregisterClaudeSkill(assistant.slug, scope, workingDir);
      }

      if (targetsCodex(target)) {
        await unregisterCodexAssistantSkill(assistant.slug, scope, workingDir);
      }

      if (targetsGemini(target)) {
        await unregisterGeminiAssistantSkill(assistant.slug, scope, workingDir);
      }
    },
    MESSAGES.SETUP.SUCCESS_UNREGISTERED(chalk.bold(assistant.name), chalk.cyan(assistant.slug)),
    MESSAGES.SETUP.ERROR_UNREGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant removal failed', { error, assistantId: assistant.id, target })
  );
}

export async function registerAssistant(
  assistant: Assistant,
  mode: RegistrationMode = REGISTRATION_MODE.AGENT,
  scope: 'global' | 'local' = 'global',
  workingDir?: string,
  target: AgentSetupTarget = ['claude']
): Promise<CodemieAssistant | null> {
  const modeLabel = mode === REGISTRATION_MODE.SKILL ? 'skill' : 'agent';
  const targetLabel = formatAgentSetupTarget(target);
  const invocationLabel = formatInvocationSummary(assistant.slug!, target);

  const result = await executeWithSpinner(
    MESSAGES.SETUP.SPINNER_REGISTERING(chalk.bold(assistant.name)),
    async () => {
      switch (mode) {
        case REGISTRATION_MODE.AGENT:
          if (targetsClaude(target)) {
            await registerClaudeSubagent(assistant, scope, workingDir);
          }
          if (targetsCodex(target)) {
            await registerCodexAssistantSkill(assistant, scope, workingDir);
          }
          if (targetsGemini(target)) {
            await registerGeminiAssistantSkill(assistant, scope, workingDir);
          }
          break;

        case REGISTRATION_MODE.SKILL:
          if (targetsClaude(target)) {
            await registerClaudeSkill(assistant, scope, workingDir);
          }
          if (targetsCodex(target)) {
            await registerCodexAssistantSkill(assistant, scope, workingDir);
          }
          if (targetsGemini(target)) {
            await registerGeminiAssistantSkill(assistant, scope, workingDir);
          }
          break;
      }

      return assistant.slug!;
    },
    MESSAGES.SETUP.SUCCESS_REGISTERED(chalk.bold(assistant.name), chalk.cyan(invocationLabel) + chalk.dim(` as ${modeLabel} for ${targetLabel}`)),
    MESSAGES.SETUP.ERROR_REGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant generation failed', { error, assistantId: assistant.id, mode, target })
  );

  if (!result) {
    return null;
  }

  return {
    id: assistant.id,
    name: assistant.name,
    slug: assistant.slug!,
    description: assistant.description,
    project: assistant.project,
    registeredAt: new Date().toISOString(),
    registrationMode: mode,
    agentTargets: target,
  };
}

function formatInvocationSummary(slug: string, target: AgentSetupTarget): string {
  return target
    .map(agent => formatAgentInvocation(slug, agent))
    .join(', ');
}
