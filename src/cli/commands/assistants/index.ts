/**
 * Assistants Command
 *
 * Parent command for managing CodeMie assistants
 */

import { Command } from 'commander';
import { createAssistantsChatCommand } from '@/cli/commands/assistants/chat.js';

/**
 * Create assistants command with subcommands
 */
export function createAssistantsCommand(): Command {
  const command = new Command('assistants');

  command
    .description('Manage CodeMie assistants')
    .addCommand(createAssistantsChatCommand());

  return command;
}
