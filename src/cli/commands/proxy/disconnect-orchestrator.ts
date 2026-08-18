/**
 * `codemie proxy disconnect` — reverse what `connect` wrote for a target.
 *
 * The daemon is deliberately left running: it may still be serving other
 * connected targets, and stopping it is `codemie proxy stop`'s job.
 */
import chalk from 'chalk';

import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

import { removeCodexDesktopConfig } from './connectors/codex-desktop.js';

export interface DisconnectTargets {
  codexDesktop?: boolean;
}

export interface DisconnectOptions {
  targets: DisconnectTargets;
}

const DISCONNECT_TARGET_LIST = [
  'Select at least one target to disconnect:',
  '',
  '  --codex-desktop        Codex desktop app (removes the CodeMie block from ~/.codex/config.toml)',
  '',
  'Example:',
  '  codemie proxy disconnect --codex-desktop',
].join('\n');

export async function disconnectTargets(opts: DisconnectOptions): Promise<void> {
  if (!opts.targets.codexDesktop) {
    console.log(DISCONNECT_TARGET_LIST);
    return;
  }

  try {
    const result = await removeCodexDesktopConfig();

    if (!result.removed) {
      console.log(chalk.dim('Codex Desktop: nothing to disconnect.'));
      return;
    }

    console.log(chalk.green(`✓ Codex Desktop disconnected (${result.configPath})`));
    if (result.usedBackup) {
      console.log(chalk.yellow(
        '⚠ Restored the backup because the managed block could not be removed cleanly.'
      ));
    }
    console.log(chalk.yellow('⚠ Quit and reopen the ChatGPT desktop app to apply the change.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Codex Desktop disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.red(`✗ Codex Desktop  — ${message}`));
    process.exitCode = 1;
  }
}
