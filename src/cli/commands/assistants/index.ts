/**
 * Assistants Command
 *
 * Parent command for managing CodeMie assistants
 */

import { Command } from 'commander';
import { createAssistantsChatCommand } from '@/cli/commands/assistants/chat/index.js';

/**
 * Create assistants command with subcommands
 */
export function createAssistantsCommand(): Command {
  const command = new Command('assistants');

  command
    .description('Chat with CodeMie assistant')
    .addCommand(createAssistantsChatCommand());

  return command;
}
