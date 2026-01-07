/**
 * Conversations command - sync Claude Code conversation history to CodeMie API
 *
 * This command enables manual syncing of specific Claude sessions with incremental
 * message tracking. It's designed for:
 * - Manual testing of conversation sync logic
 * - Debugging sync issues with specific sessions
 * - Integration testing with real session data
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConversationSyncService } from './sync-service.js';
import { ConfigLoader } from '../../../utils/config.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { logger } from '../../../utils/logger.js';

export interface ConversationsSyncOptions {
  assistant?: string;
  folder?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export function createConversationsCommand(): Command {
  const command = new Command('conversations');

  command
    .description('Manage conversation syncing with CodeMie API');

  // Subcommand: sync
  command
    .command('sync <session-id>')
    .description('Sync a specific Claude Code session to CodeMie API')
    .option('--assistant <id>', 'Assistant ID to use for synced conversations', '5a430368-9e91-4564-be20-989803bf4da2')
    .option('--folder <name>', 'Folder name for synced conversations', 'Claude Imports')
    .option('--dry-run', 'Log conversations without sending to API')
    .option('-v, --verbose', 'Show detailed conversation data')
    .action(async (sessionId: string, options: ConversationsSyncOptions) => {
      try {
        await handleSync(sessionId, options);
      } catch (error) {
        logger.error('Conversation sync failed:', error);
        console.error(chalk.red(`\n✗ Sync failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Handle sync command execution
 */
async function handleSync(sessionId: string, options: ConversationsSyncOptions): Promise<void> {
  const spinner = ora('Loading configuration...').start();

  try {
    // 1. Load current profile configuration
    const config = await ConfigLoader.load();

    if (!config) {
      spinner.fail(chalk.red('No configuration found'));
      console.log(chalk.yellow('Please run: codemie setup'));
      return;
    }

    // 2. Verify SSO provider
    if (config.provider !== 'ai-run-sso') {
      spinner.fail(chalk.red('Conversation sync requires ai-run-sso provider'));
      console.log(chalk.yellow(`Current provider: ${config.provider}`));
      console.log(chalk.dim('Switch to SSO provider with: codemie setup'));
      return;
    }

    spinner.text = 'Loading SSO credentials...';

    // 3. Load SSO credentials
    const sso = new CodeMieSSO();
    const codeMieUrl = config.codeMieUrl || config.baseUrl;

    if (!codeMieUrl) {
      spinner.fail(chalk.red('No CodeMie URL configured'));
      console.log(chalk.yellow('Please run: codemie setup'));
      return;
    }

    const credentials = await sso.getStoredCredentials(codeMieUrl);

    if (!credentials) {
      spinner.fail(chalk.red('No SSO credentials found'));
      console.log(chalk.yellow(`Please authenticate with: codemie profile login --url ${codeMieUrl}`));
      return;
    }

    spinner.succeed(chalk.green('Configuration loaded'));

    if (options.dryRun) {
      console.log(chalk.cyan('🔍 Dry-run mode enabled - conversations will be logged but not sent\n'));
    }

    // 4. Initialize sync service
    const syncService = new ConversationSyncService({
      baseUrl: credentials.apiUrl,
      cookies: credentials.cookies,
      dryRun: options.dryRun || false,
      verbose: options.verbose || false
    });

    // 5. Sync the session
    spinner.start(`Syncing session ${chalk.cyan(sessionId)}...`);

    const result = await syncService.syncSession(
      sessionId,
      options.assistant || '5a430368-9e91-4564-be20-989803bf4da2',
      options.folder || 'Claude Imports'
    );

    spinner.succeed(chalk.green('Sync completed successfully'));

    // 6. Display results
    console.log('');
    console.log(chalk.bold('📊 Sync Summary:'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(`  ${chalk.cyan('Session ID:')}      ${result.claudeSessionId}`);
    console.log(`  ${chalk.cyan('Conversations:')}   ${result.conversationsCount}`);
    console.log(`  ${chalk.cyan('Messages synced:')} ${result.totalMessages}`);
    console.log(`  ${chalk.cyan('New messages:')}    ${result.newMessages}`);

    if (result.conversations.length > 0) {
      console.log('');
      console.log(chalk.bold('💬 Conversations:'));
      console.log(chalk.dim('─'.repeat(50)));

      result.conversations.forEach((conv, idx) => {
        const status = conv.created ? chalk.green('NEW') : chalk.blue('UPDATED');
        console.log(`  ${idx + 1}. ${status} ${chalk.dim(conv.conversationId)}`);
        console.log(`     Messages: ${conv.messageCount} (${conv.newMessages} new)`);

        if (options.verbose && conv.firstMessage) {
          const preview = conv.firstMessage.substring(0, 80);
          console.log(`     Preview: ${chalk.dim(preview)}${conv.firstMessage.length > 80 ? '...' : ''}`);
        }
      });
    }

    console.log('');

    if (result.skipped > 0) {
      console.log(chalk.yellow(`⚠️  Skipped ${result.skipped} conversation(s) (already synced)`));
    }

  } catch (error) {
    spinner.fail(chalk.red('Sync failed'));
    throw error;
  }
}
