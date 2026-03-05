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
import { getAuthenticatedClient, promptReauthentication } from '@/utils/auth.js';
import type { CodemieAssistant, ProviderProfile } from '@/env/types.js';
import type { CodeMieClient } from 'codemie-sdk';
import { ROLES, MESSAGES, type HistoryMessage } from '../constants.js';
import { loadConversationHistory } from './historyLoader.js';
import { isExitCommand, enableVerboseMode } from './utils.js';
import type { ChatCommandOptions, SingleMessageOptions } from './types.js';
import { detectFileUploadsFromSession, type DetectedFile } from './fileResolver.js';
import type { FileToUpload } from 'codemie-sdk';

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
    .option('--load-history', 'Load conversation history from previous sessions (default: true)', true)
    .action(async (
      assistantId: string | undefined,
      message: string | undefined,
      options: ChatCommandOptions
    ) => {
      if (options.verbose) {
        enableVerboseMode();
      }

      try {
        await chatWithAssistant(assistantId, message, options);
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
  options: ChatCommandOptions
): Promise<void> {
  const config = await ConfigLoader.load();
  const registeredAssistants = config.codemieAssistants || [];
  const client = await getAuthenticatedClient(config);

  const conversationId = options.conversationId || process.env.CODEMIE_SESSION_ID;

  // Automatically detect file uploads from session JSONL if session ID exists
  let detectedFiles: DetectedFile[] = [];
  if (conversationId) {
    detectedFiles = await detectFileUploadsFromSession(conversationId, { quiet: false });
  }

  if (assistantId && message) { // Single-message mode (for Claude Code)
    const assistant = findAssistant(registeredAssistants, assistantId);
    await sendSingleMessage(
      client,
      assistant,
      message,
      { quiet: true },
      config,
      conversationId,
      options.loadHistory,
      detectedFiles
    );
  } else {
    const assistant = await promptAssistantSelection(registeredAssistants);
    await interactiveChat(client, assistant, config, conversationId, options.loadHistory, detectedFiles);
  }
}

/**
 * Find assistant by ID or exit with error
 */
function findAssistant(assistants: CodemieAssistant[], assistantId: string): CodemieAssistant {
  if (assistants.length === 0) {
    console.log(
      chalk.dim(MESSAGES.SHARED.HINT_REGISTER) +
      chalk.cyan(MESSAGES.SHARED.SETUP_ASSISTANTS_COMMAND) +
      chalk.dim(MESSAGES.SHARED.HINT_REGISTER_SUFFIX)
    );
    process.exit(1);
  }

  const assistant = assistants.find(a => a.id === assistantId);
  if (!assistant) {
    console.error(chalk.red(MESSAGES.SHARED.ERROR_ASSISTANT_NOT_FOUND(assistantId)));
    console.log(
      chalk.dim(MESSAGES.SHARED.HINT_REGISTER) +
      chalk.cyan(MESSAGES.SHARED.SETUP_ASSISTANTS_COMMAND) +
      chalk.dim(MESSAGES.SHARED.HINT_SEE_ASSISTANTS)
    );
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
    console.log(
      chalk.dim(MESSAGES.SHARED.HINT_REGISTER) +
      chalk.cyan(MESSAGES.SHARED.SETUP_ASSISTANTS_COMMAND) +
      chalk.dim(MESSAGES.SHARED.HINT_REGISTER_SUFFIX)
    );
    process.exit(1);
  }

  const choices = assistants.map(assistant => ({
    name: `${assistant.name} ${chalk.dim(`(/${assistant.slug})`)}`,
    value: assistant.id
  }));

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
  conversationId?: string,
  loadHistory: boolean = true,
  detectedFiles: DetectedFile[] = []
): Promise<void> {
  const history: HistoryMessage[] = loadHistory
    ? await loadConversationHistory(conversationId, config)
    : [];

  if (history.length > 0) {
    logger.debug('Loaded conversation history', {
      conversationId,
      messageCount: history.length
    });
    console.log(chalk.dim(`Loaded ${history.length} previous message(s)\n`));
  }

  console.log(chalk.bold.cyan(MESSAGES.CHAT.HEADER(assistant.name)));
  console.log(chalk.dim(MESSAGES.CHAT.INSTRUCTIONS));

  // Chat loop
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
      const response = await sendMessageWithHistory(client, assistant, message, history, conversationId, detectedFiles);
      spinner.stop();

      console.log(
        chalk.rgb(...ASSISTANT_LABEL_COLOR)(`[Assistant @${assistant.slug}]`),
        response || MESSAGES.CHAT.FALLBACK_NO_RESPONSE
      );
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
  options: SingleMessageOptions,
  config: ProviderProfile,
  conversationId?: string,
  loadHistory: boolean = true,
  detectedFiles: DetectedFile[] = []
): Promise<void> {
  try {
    const history = loadHistory ? await loadConversationHistory(conversationId, config) : [];

    if (history.length > 0) {
      logger.debug('Loaded conversation history for single message', {
        conversationId,
        messageCount: history.length
      });
    }

    const response = await sendMessageWithHistory(client, assistant, message, history, conversationId, detectedFiles);

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
 * Upload files to CodeMie platform via SDK
 */
async function uploadFilesToCodeMie(
  client: CodeMieClient,
  files: DetectedFile[]
): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }

  logger.debug('[chat] Uploading files to CodeMie', {
    fileCount: files.length,
    fileNames: files.map(f => f.fileName)
  });

  try {
    // Convert DetectedFile[] to SDK FileToUpload[] format
    const filesToUpload: FileToUpload[] = files.map(f => ({
      name: f.fileName,
      content: Buffer.from(f.data, 'base64'),
      mimeType: f.mediaType
    }));

    // Upload via SDK bulk endpoint
    const response = await client.files.bulkUpload(filesToUpload);

    // Check for failed files
    if (response.failed_files && Object.keys(response.failed_files).length > 0) {
      logger.warn('[chat] Some files failed to upload', {
        failedFiles: response.failed_files
      });

      // Log warnings to console
      Object.entries(response.failed_files).forEach(([name, error]) => {
        console.log(chalk.yellow(`⚠ Failed to upload ${name}: ${error}`));
      });
    }

    // Extract file URLs from successful uploads
    const fileUrls = response.files.map(f => f.file_url);

    logger.info('[chat] Files uploaded successfully', {
      successCount: fileUrls.length,
      failedCount: Object.keys(response.failed_files || {}).length
    });

    console.log(chalk.green(`✓ Uploaded ${fileUrls.length} file(s) to CodeMie`));

    return fileUrls;

  } catch (error) {
    logger.error('[chat] Failed to upload files', { error });
    console.log(chalk.yellow('⚠ File upload failed, continuing without attachments'));
    return [];
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
  conversationId?: string,
  detectedFiles: DetectedFile[] = []
): Promise<string> {
  logger.debug('Sending message to assistant', {
    assistantId: assistant.id,
    assistantName: assistant.name,
    messageLength: message.length,
    historyLength: history.length,
    conversationId,
    fileCount: detectedFiles.length
  });

  let fileUrls: string[] = [];
  if (detectedFiles.length > 0) {
    fileUrls = await uploadFilesToCodeMie(client, detectedFiles);
  }

  const response = await client.assistants.chat(assistant.id, {
    conversation_id: conversationId,
    text: message,
    content_raw: message,
    history,
    stream: false,
    save_history: true,
    file_names: fileUrls.length > 0 ? fileUrls : undefined
  });

  return (response.generated as string) ?? '';
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
