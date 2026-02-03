/**
 * Assistants Command
 *
 * Parent command for managing CodeMie assistants
 */

import { Command } from 'commander';
import { createAssistantsSetupCommand } from '@/cli/commands/assistants/setup/index.js';
import { createAssistantsChatCommand } from '@/cli/commands/assistants/chat.js';
import { COMMAND_NAMES } from '@/cli/commands/assistants/constants.js';

/**
 * Create assistants command with subcommands
 */
export function createAssistantsCommand(): Command {
  const command = new Command('assistants');

  command
    .description('Manage CodeMie assistants')
    .addCommand(createAssistantsSetupCommand())
    .addCommand(createAssistantsChatCommand());

  // Default action: run setup command (backward compatibility)
  command.action(async () => {
    const setupCommand = command.commands.find(c => c.name() === COMMAND_NAMES.SETUP);
    if (setupCommand) {
      await setupCommand.parseAsync([], { from: 'user' });
    }
  });

  return command;
}
