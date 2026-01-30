/**
 * Assistants Chat Command
 *
 * Send messages to registered CodeMie assistants
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { createErrorContext, formatErrorForUser } from '@/utils/errors.js';
import type { CodemieAssistant, ProviderProfile } from '@/env/types.js';
import type { CodeMieClient } from 'codemie-sdk';
import { EXIT_PROMPTS, ROLES, MESSAGES, type HistoryMessage } from './constants.js';
import { getAuthenticatedClient, promptReauthentication } from '@/utils/auth.js';

/** Assistant label color */
const ASSISTANT_LABEL_COLOR = [177, 185, 249] as const;

/**
 * Create assistants chat command
 */
export function createAssistantsChatCommand(): Command {
  const command = new Command('chat');

  command
    .description(MESSAGES.CHAT.COMMAND_DESCRIPTION)
    .argument('[assistant-id]', MESSAGES.CHAT.ARGUMENT_ASSISTANT_ID)
    .argument('[message]', MESSAGES.CHAT.ARGUMENT_MESSAGE)
    .option('-v, --verbose', MESSAGES.SHARED.OPTION_VERBOSE)
    .option('--conversation-id <id>', 'Conversation ID for maintaining context across calls')
    .action(async (assistantId: string | undefined, message: string | undefined, options: {
      verbose?: boolean;
      conversationId?: string;
    }) => {
      if (options.verbose) {
        process.env.CODEMIE_DEBUG = 'true';
        const logFilePath = logger.getLogFilePath();
        if (logFilePath) {
          console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
        }
      }

      try {
        await chatWithAssistant(assistantId, message, options.conversationId);
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
  assistantId: string | undefined,
  message: string | undefined,
  conversationId?: string
): Promise<void> {
  const config = await ConfigLoader.load();
  const registeredAssistants = config.codemieAssistants || [];

  const client = await getAuthenticatedClient(config);

  // Resolve conversation ID: CLI option > environment variable > undefined
  const resolvedConversationId = conversationId || process.env.CODEMIE_SESSION_ID;

  if (assistantId && message) { // Single-message mode (example: for Claude Code skill)
    const assistant = findAssistant(registeredAssistants, assistantId);
    await sendSingleMessage(client, assistant, message, { quiet: true }, config, resolvedConversationId);
  } else { // Interactive mode
    const assistant = await promptAssistantSelection(registeredAssistants);
    await interactiveChat(client, assistant, config, resolvedConversationId);
  }
}

/**
 * Find assistant by ID or exit with error
 */
function findAssistant(assistants: CodemieAssistant[], assistantId: string): CodemieAssistant {
  if (assistants.length === 0) {
    console.error(chalk.red(MESSAGES.SHARED.ERROR_NO_ASSISTANTS));
    console.log(chalk.dim(MESSAGES.SHARED.HINT_REGISTER) + chalk.cyan(MESSAGES.SHARED.COMMAND_LIST) + chalk.dim(MESSAGES.SHARED.HINT_REGISTER_SUFFIX));
    process.exit(1);
  }

  const assistant = assistants.find(a => a.id === assistantId);
  if (!assistant) {
    console.error(chalk.red(MESSAGES.SHARED.ERROR_ASSISTANT_NOT_FOUND(assistantId)));
    console.log(chalk.dim(MESSAGES.SHARED.HINT_REGISTER) + chalk.cyan(MESSAGES.SHARED.COMMAND_LIST) + chalk.dim(MESSAGES.SHARED.HINT_SEE_ASSISTANTS));
    process.exit(1);
  }
  return assistant;
}

/**
 * Prompt user to select an assistant
 */
async function promptAssistantSelection(assistants: CodemieAssistant[]): Promise<CodemieAssistant> {
  if (assistants.length === 0) {
    console.error(chalk.red(MESSAGES.SHARED.ERROR_NO_ASSISTANTS));
    console.log(chalk.dim(MESSAGES.SHARED.HINT_REGISTER) + chalk.cyan(MESSAGES.SHARED.COMMAND_LIST) + chalk.dim(MESSAGES.SHARED.HINT_REGISTER_SUFFIX));
    process.exit(1);
  }

  const choices = assistants.map(assistant => {
    const slugText = chalk.dim(`(/${assistant.slug})`);
    return {
      name: `${assistant.name} ${slugText}`,
      value: assistant.id
    };
  });

  const { selectedId } = await inquirer.prompt<{ selectedId: string }>([
    {
      type: 'list',
      name: 'selectedId',
      message: MESSAGES.SHARED.PROMPT_SELECT_ASSISTANT,
      choices
    }
  ]);

  return findAssistant(assistants, selectedId);
}

/**
 * Interactive chat session with conversation history
 */
async function interactiveChat(
  client: CodeMieClient,
  assistant: CodemieAssistant,
  config: ProviderProfile,
  conversationId?: string
): Promise<void> {
  const history: HistoryMessage[] = [];

  console.log(chalk.bold.cyan(MESSAGES.CHAT.HEADER(assistant.name)));
  console.log(chalk.dim(MESSAGES.CHAT.INSTRUCTIONS));

  while (true) {
    const { message } = await inquirer.prompt<{ message: string }>([
      {
        type: 'input',
        name: 'message',
        message: MESSAGES.CHAT.PROMPT_YOUR_MESSAGE,
        prefix: '',
        validate: (input: string) => input.trim().length > 0 || MESSAGES.CHAT.VALIDATION_MESSAGE_EMPTY
      }
    ]);

    if (isExitCommand(message)) {
      console.log(chalk.dim(MESSAGES.CHAT.GOODBYE));
      break;
    }

    const spinner = ora(MESSAGES.CHAT.SPINNER_THINKING).start();

    try {
      const response = await sendMessageWithHistory(client, assistant, message, history, conversationId);
      spinner.stop();

      console.log(chalk.rgb(...ASSISTANT_LABEL_COLOR)(`[Assistant @${assistant.slug}]`), response || MESSAGES.CHAT.FALLBACK_NO_RESPONSE);
      console.log('');

      history.push(
        { role: ROLES.USER, message },
        { role: ROLES.ASSISTANT, message: response }
      );
    } catch (error) {
      spinner.fail(chalk.red(MESSAGES.CHAT.ERROR_SEND_FAILED));
      await handleChatError(error, config);

      console.log(chalk.yellow(MESSAGES.CHAT.RETRY_PROMPT));
    }
  }
}

/**
 * Send a single message (for Claude Code skills in quiet mode)
 */
async function sendSingleMessage(
  client: CodeMieClient,
  assistant: CodemieAssistant,
  message: string,
  options: { quiet?: boolean },
  config: ProviderProfile,
  conversationId?: string
): Promise<void> {
  try {
    const response = await sendMessageWithHistory(client, assistant, message, [], conversationId);

    if (options.quiet) {
      console.log(response || MESSAGES.CHAT.FALLBACK_NO_RESPONSE);
    } else {
      console.log('\n' + chalk.bold.cyan(`${assistant.name}:`));
      console.log(response || MESSAGES.CHAT.FALLBACK_NO_RESPONSE);
      console.log('');
    }
  } catch (error) {
    await handleChatError(error, config);
    throw error;
  }
}

/**
 * Send message to assistant with conversation history
 */
async function sendMessageWithHistory(
  client: CodeMieClient,
  assistant: CodemieAssistant,
  message: string,
  history: HistoryMessage[],
  conversationId?: string
): Promise<string> {
  logger.debug('Sending message to assistant', {
    assistantId: assistant.id,
    assistantName: assistant.name,
    messageLength: message.length,
    historyLength: history.length,
    conversationId: conversationId
  });

  const response = await client.assistants.chat(assistant.id, {
    conversation_id: conversationId,
    text: message,
    history: history,
    stream: false
  });

  return (response.generated as string) ?? ''
}

/**
 * Check if message is an exit prompt
 */
function isExitCommand(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  return EXIT_PROMPTS.includes(normalized as any);
}

/**
 * Handle chat errors with proper context
 */
async function handleChatError(error: unknown, config: ProviderProfile): Promise<void> {
  const context = createErrorContext(error);
  logger.error('Assistant chat API call failed', context);

  if (error instanceof Error && (error.message.includes('401') || error.message.includes('403'))) {
    await promptReauthentication(config);
  }
}
