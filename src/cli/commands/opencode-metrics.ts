/**
 * OpenCode Metrics CLI Command
 *
 * Trigger OpenCode session processing to extract metrics and write JSONL deltas.
 * Per tech spec Review 13 G1: Provides CLI entry point for Phase 1 metrics extraction.
 *
 * Usage:
 *   codemie opencode-metrics --session <id>  # Process specific session
 *   codemie opencode-metrics --discover      # Discover and process all unprocessed sessions
 */

import { Command } from 'commander';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

export function createOpencodeMetricsCommand(): Command {
  const command = new Command('opencode-metrics');

  command
    .description('Process OpenCode sessions and extract metrics to JSONL')
    .option('-s, --session <id>', 'Process specific OpenCode session by ID')
    .option('-d, --discover', 'Discover and process all unprocessed sessions')
    .option('-v, --verbose', 'Show detailed processing output')
    .action(async (options) => {
      try {
        const { getOpenCodeStoragePath } = await import('../../agents/plugins/opencode/opencode.paths.js');
        const storagePath = getOpenCodeStoragePath();

        if (!storagePath) {
          console.error(chalk.red('OpenCode storage not found.'));
          console.log(chalk.dim('Expected location: ~/.local/share/opencode/storage/ (Linux)'));
          console.log(chalk.dim('                  ~/Library/Application Support/opencode/storage/ (macOS)'));
          process.exit(1);
        }

        if (options.verbose) {
          console.log(chalk.dim(`Storage path: ${storagePath}`));
        }

        if (options.session) {
          // Process specific session
          await processSpecificSession(storagePath, options.session, options.verbose);
        } else if (options.discover) {
          // Discover and process all
          await discoverAndProcessSessions(storagePath, options.verbose);
        } else {
          console.log(chalk.yellow('Use --session <id> or --discover to process OpenCode sessions'));
          console.log('');
          console.log(chalk.bold('Examples:'));
          console.log(chalk.dim('  codemie opencode-metrics --session ses_abc123...'));
          console.log(chalk.dim('  codemie opencode-metrics --discover'));
        }

      } catch (error: unknown) {
        logger.error('Failed to process OpenCode metrics:', error);
        console.error(chalk.red('Failed to process OpenCode metrics'));
        if (error instanceof Error) {
          console.error(chalk.dim(error.message));
        }
        process.exit(1);
      }
    });

  return command;
}

/**
 * Process a specific OpenCode session by ID
 */
async function processSpecificSession(
  storagePath: string,
  sessionId: string,
  verbose: boolean
): Promise<void> {
  const sessionDir = join(storagePath, 'session');

  if (!existsSync(sessionDir)) {
    console.error(chalk.red(`Session directory not found: ${sessionDir}`));
    process.exit(1);
  }

  // Locate session file across all projectIDs
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(sessionDir);
  } catch {
    console.error(chalk.red(`Failed to read session directory: ${sessionDir}`));
    process.exit(1);
  }

  for (const projectId of projectDirs) {
    const projectPath = join(sessionDir, projectId);

    // Skip non-directories
    try {
      const { statSync } = await import('fs');
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const sessionPath = join(projectPath, `${sessionId}.json`);
    if (existsSync(sessionPath)) {
      console.log(chalk.blue(`Found session: ${sessionId}`));
      if (verbose) {
        console.log(chalk.dim(`  Path: ${sessionPath}`));
        console.log(chalk.dim(`  Project: ${projectId}`));
      }

      // Process the session
      await processSession(storagePath, sessionPath, sessionId, verbose);
      return;
    }
  }

  console.error(chalk.red(`Session ${sessionId} not found in OpenCode storage`));
  console.log(chalk.dim('Searched in: ' + sessionDir));
  process.exit(1);
}

/**
 * Discover and process all OpenCode sessions
 */
async function discoverAndProcessSessions(
  storagePath: string,
  verbose: boolean
): Promise<void> {
  const { OpenCodeSessionAdapter } = await import('../../agents/plugins/opencode/opencode.session.js');
  const { OpenCodePluginMetadata } = await import('../../agents/plugins/opencode/opencode.plugin.js');

  const adapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata);

  console.log(chalk.blue('Discovering OpenCode sessions...'));

  // Discover sessions (last 30 days by default)
  const sessions = await adapter.discoverSessions({ maxAgeDays: 30 });

  if (sessions.length === 0) {
    console.log(chalk.yellow('No OpenCode sessions found in the last 30 days'));
    return;
  }

  console.log(chalk.green(`Found ${sessions.length} session(s)`));
  console.log('');

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const sessionDesc of sessions) {
    if (verbose) {
      console.log(chalk.dim(`Processing: ${sessionDesc.sessionId}`));
    }

    try {
      const result = await processSession(
        storagePath,
        sessionDesc.filePath,
        sessionDesc.sessionId,
        verbose
      );

      if (result.skipped) {
        skippedCount++;
      } else {
        processedCount++;
      }
    } catch (error) {
      errorCount++;
      if (verbose) {
        console.error(chalk.red(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    }
  }

  console.log('');
  console.log(chalk.bold('Summary:'));
  console.log(`  ${chalk.green('✓')} Processed: ${processedCount}`);
  console.log(`  ${chalk.yellow('○')} Skipped (recently processed): ${skippedCount}`);
  if (errorCount > 0) {
    console.log(`  ${chalk.red('✗')} Errors: ${errorCount}`);
  }
}

/**
 * Process a single session and write metrics
 */
async function processSession(
  _storagePath: string,
  sessionPath: string,
  sessionId: string,
  verbose: boolean
): Promise<{ skipped: boolean }> {
  const { OpenCodeSessionAdapter } = await import('../../agents/plugins/opencode/opencode.session.js');
  const { OpenCodePluginMetadata } = await import('../../agents/plugins/opencode/opencode.plugin.js');

  const adapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata);

  // Parse and process the session
  const parsedSession = await adapter.parseSessionFile(sessionPath, sessionId);

  // Run the metrics processor directly
  const { OpenCodeMetricsProcessor } = await import('../../agents/plugins/opencode/session/processors/opencode.metrics-processor.js');
  const processor = new OpenCodeMetricsProcessor();

  // Create minimal ProcessingContext for CLI usage
  // The processor only needs sessionId from context
  const context = {
    sessionId,
    apiBaseUrl: '',
    cookies: '',
    clientType: 'codemie-opencode',
    version: '1.0.0',
    dryRun: false
  };

  const result = await processor.process(parsedSession, context);

  if (verbose) {
    console.log(chalk.dim(`  Result: ${result.message}`));
    if (result.metadata) {
      console.log(chalk.dim(`  Deltas written: ${result.metadata.deltasWritten || 0}`));
      if (result.metadata.deltasSkipped) {
        console.log(chalk.dim(`  Deltas skipped (dedup): ${result.metadata.deltasSkipped}`));
      }
    }
  }

  // Check if skipped due to recent processing
  const skipped = result.metadata?.skippedReason === 'RECENTLY_PROCESSED';

  if (!verbose) {
    const status = skipped
      ? chalk.yellow('○')
      : (result.success ? chalk.green('✓') : chalk.red('✗'));
    const deltasInfo = result.metadata?.deltasWritten
      ? chalk.dim(` (${result.metadata.deltasWritten} deltas)`)
      : '';
    console.log(`${status} ${sessionId}${deltasInfo}`);
  }

  return { skipped };
}
