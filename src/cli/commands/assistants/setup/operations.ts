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
  const spinner = ora(spinnerMessage).start();

  try {
    const result = await operation();
    spinner.succeed(chalk.green(successMessage));
    return result;
  } catch (error) {
    spinner.fail(chalk.red(errorMessage));
    if (onError) {
      onError(error);
    }
    return null;
  }
}

/**
 * Unregister an assistant
 */
export async function unregisterAssistant(assistant: CodemieAssistant): Promise<void> {
  await executeWithSpinner(
    MESSAGES.SETUP.SPINNER_UNREGISTERING(chalk.bold(assistant.name)),
    async () => {
      // Remove Claude subagent from ~/.claude/agents/
      await unregisterClaudeSubagent(assistant.slug);
    },
    MESSAGES.SETUP.SUCCESS_UNREGISTERED(chalk.bold(assistant.name), chalk.cyan(assistant.slug)),
    MESSAGES.SETUP.ERROR_UNREGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant removal failed', { error, assistantId: assistant.id })
  );
}

/**
 * Register an assistant
 */
export async function registerAssistant(assistant: Assistant): Promise<CodemieAssistant | null> {
  const result = await executeWithSpinner(
    MESSAGES.SETUP.SPINNER_REGISTERING(chalk.bold(assistant.name)),
    async () => {
      // Register Claude subagent in ~/.claude/agents/
      // Claude Code will auto-discover it and make it available via @mentions
      await registerClaudeSubagent(assistant);

      return assistant.slug!;
    },
    MESSAGES.SETUP.SUCCESS_REGISTERED(chalk.bold(assistant.name), chalk.cyan(`@${assistant.slug!}`)),
    MESSAGES.SETUP.ERROR_REGISTER_FAILED(assistant.name),
    (error) => logger.error('Assistant generation failed', { error, assistantId: assistant.id })
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
    registeredAt: new Date().toISOString()
  };
}
