/**
 * Assistants Command
 *
 * Parent command for managing CodeMie assistants
 */

import { Command } from 'commander';
import { createAssistantsListCommand } from './list.js';
import { createAssistantsChatCommand } from './chat.js';
import { COMMAND_NAMES } from './constants.js';

/**
 * Create assistants command with subcommands
 */
export function createAssistantsCommand(): Command {
  const command = new Command('assistants');

  command
    .description('Manage CodeMie assistants')
    .addCommand(createAssistantsListCommand())
    .addCommand(createAssistantsChatCommand());

  // Default action: run list command (backward compatibility)
  command.action(async () => {
    const listCommand = command.commands.find(c => c.name() === COMMAND_NAMES.LIST);
    if (listCommand) {
      await listCommand.parseAsync([], { from: 'user' });
    }
  });

  return command;
}
