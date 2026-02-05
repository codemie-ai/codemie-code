/**
 * Registration Operations Module
 *
 * Handles registration/unregistration business logic
 */

import chalk from 'chalk';
import ora from 'ora';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { CodemieAssistant } from '@/env/types.js';
import { logger } from '@/utils/logger.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';
import { registerClaudeSubagent, unregisterClaudeSubagent } from '@/cli/commands/assistants/setup/generators/claude-agent-generator.js';
import { registerClaudeSkill, unregisterClaudeSkill } from '@/cli/commands/assistants/setup/generators/claude-skill-generator.js';
import type { RegistrationMode } from '@/cli/commands/assistants/setup/manualConfiguration/types.js';
import { REGISTRATION_MODE } from '@/cli/commands/assistants/setup/manualConfiguration/constants.js';

export interface RegistrationChanges {
  toRegister: Assistant[];
  toUnregister: CodemieAssistant[];
}

/**
 * Determine which assistants to register and unregister
 */
export function determineChanges(
  selectedIds: string[],
  allAssistants: (Assistant | AssistantBase)[],
  registeredAssistants: CodemieAssistant[]
): RegistrationChanges {
  const selectedSet = new Set(selectedIds);
  const registeredIds = new Set(registeredAssistants.map(a => a.id));

  const toRegister = allAssistants.filter(
    a => selectedSet.has(a.id) && !registeredIds.has(a.id)
  ) as Assistant[];

  const toUnregister = registeredAssistants.filter(a => !selectedSet.has(a.id));

  return { toRegister, toUnregister };
}

/**
 * Execute assistant operation with spinner
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
 * Unregister an assistant
 * Removes both Claude agent and skill files
 */
export async function unregisterAssistant(assistant: CodemieAssistant): Promise<void> {
  await executeWithSpinner(
    MESSAGES.SETUP.SPINNER_UNREGISTERING(chalk.bold(assistant.name)),
    async () => {
      await unregisterClaudeSubagent(assistant.slug);
      await unregisterClaudeSkill(assistant.slug);
    },
    MESSAGES.SETUP.SUCCESS_UNREGISTERED(chalk.bold(assistant.name), chalk.cyan(assistant.slug)),
    MESSAGES.SETUP.ERROR_UNREGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant removal failed', { error, assistantId: assistant.id })
  );
}

/**
 * Register an assistant with specified registration mode
 * @param mode - 'agent' (Claude agent only) or 'skill' (Claude skill only)
 */
export async function registerAssistant(
  assistant: Assistant,
  mode: RegistrationMode = REGISTRATION_MODE.AGENT
): Promise<CodemieAssistant | null> {
  const modeLabel = mode === REGISTRATION_MODE.SKILL ? 'skill' : 'agent';

  const result = await executeWithSpinner(
    MESSAGES.SETUP.SPINNER_REGISTERING(chalk.bold(assistant.name)),
    async () => {
      switch (mode) {
        case REGISTRATION_MODE.AGENT:
          await registerClaudeSubagent(assistant);
          break;

        case REGISTRATION_MODE.SKILL:
          await registerClaudeSkill(assistant);
          break;
      }

      return assistant.slug!;
    },
    MESSAGES.SETUP.SUCCESS_REGISTERED(chalk.bold(assistant.name), chalk.cyan(`@${assistant.slug!}`) + chalk.dim(` as ${modeLabel}`)),
    MESSAGES.SETUP.ERROR_REGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant generation failed', { error, assistantId: assistant.id, mode })
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
    registrationMode: mode
  };
}
