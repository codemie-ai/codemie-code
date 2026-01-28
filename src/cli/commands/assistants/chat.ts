/**
 * Assistants Chat Command
 *
 * Send messages to configured CodeMie assistant
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { logger } from '@/utils/logger.js';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { ConfigLoader } from '@/utils/config.js';
import { ConfigurationError, createErrorContext, formatErrorForUser } from '@/utils/errors.js';

/**
 * Create assistants chat command
 */
export function createAssistantsChatCommand(): Command {
  const command = new Command('chat');

  command
    .description('Send a message to your configured CodeMie assistant')
    .argument('[message]', 'Message to send to the assistant')
    .option('--assistant-id <id>', 'Override configured assistant with specific ID')
    .option('-v, --verbose', 'Enable verbose debug output')
    .action(async (message: string | undefined, options: {
      assistantId?: string;
      verbose?: boolean;
    }) => {
      if (options.verbose) {
        process.env.CODEMIE_DEBUG = 'true';
        const logFilePath = logger.getLogFilePath();
        if (logFilePath) {
          console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
        }
      }

      try {
        await chatWithAssistant(message, options);
      } catch (error: unknown) {
        const context = createErrorContext(error);
        logger.error('Failed to chat with assistant', context);
        console.error(formatErrorForUser(context));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Chat with CodeMie assistant
 */
async function chatWithAssistant(
  message: string | undefined,
  options: { assistantId?: string }
): Promise<void> {
  // 1. Load configuration
  const config = await ConfigLoader.load();

  // 2. Determine which assistant to use
  const assistantId = options.assistantId;
  let assistantName = 'Assistant';

  if (!assistantId) {
    console.error(chalk.red('\n✗ No assistant ID provided'));
    console.log(chalk.dim('  Use: ') + chalk.cyan('codemie assistants chat --assistant-id <id> "message"\n'));
    console.log(chalk.dim('  Or use registered assistant skills in Claude Code\n'));
    process.exit(1);
  }

  // Try to find assistant name from registered assistants
  if (config.codeMieAssistants) {
    const registered = config.codeMieAssistants.find(a => a.id === assistantId);
    if (registered) {
      assistantName = registered.name;
    }
  }

  // 3. Get message (from arg or prompt)
  let userMessage = message;
  if (!userMessage) {
    const response = await inquirer.prompt([
      {
        type: 'input',
        name: 'message',
        message: 'Message:',
        validate: (input: string) => input.trim().length > 0 || 'Message cannot be empty'
      }
    ]);
    userMessage = response.message;
  }

  // 4. Send message to assistant
  if (!userMessage) {
    console.error(chalk.red('\n✗ No message provided\n'));
    process.exit(1);
  }

  const spinner = ora('Sending message...').start();

  try {
    const client = await getCodemieClient();

    logger.debug('Sending message to assistant', {
      assistantId,
      assistantName,
      messageLength: userMessage.length
    });

    const response = await client.assistants.chat(assistantId, {
      text: userMessage,
      history: [],
      stream: false
    });

    spinner.succeed(chalk.green('Response received'));

    // 5. Display response
    console.log('\n' + chalk.bold.cyan(`${assistantName || 'Assistant'}:`));
    console.log(response.generated || 'No response');
    console.log('');

  } catch (error) {
    spinner.fail(chalk.red('Failed to send message'));
    logger.error('Assistant chat API call failed', { error });

    if (error instanceof Error && (error.message.includes('401') || error.message.includes('403'))) {
      throw new ConfigurationError(
        'Authentication expired. Please run "codemie setup" again.'
      );
    }

    throw error;
  }
}
