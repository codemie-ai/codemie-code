/**
 * Assistants Command
 *
 * Parent command for managing CodeMie assistants
 */

import { Command } from 'commander';
import { createAssistantsListCommand } from './list.js';
import { createAssistantsChatCommand } from './chat.js';

/**
 * Create assistants command with subcommands
 */
export function createAssistantsCommand(): Command {
  const command = new Command('assistants');

  command
    .description('Manage CodeMie assistants');

  // Add subcommands
  command.addCommand(createAssistantsListCommand());
  command.addCommand(createAssistantsChatCommand());

  // Default action: run list command (backward compatibility)
  command.action(async () => {
    const listCommand = command.commands.find(c => c.name() === 'list');
    if (listCommand) {
      await listCommand.parseAsync([], { from: 'user' });
    }
  });

  return command;
}
