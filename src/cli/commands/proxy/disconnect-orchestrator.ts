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
import { removeClaudeCodeOtlpConfig } from './connectors/claude-code-otlp.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';

export interface DisconnectTargets {
  claudeCodeOtlp?: boolean;
  codexDesktop?: boolean;
}

export interface DisconnectOptions {
  targets: DisconnectTargets;
  scope?: 'user' | 'project';
}

const DISCONNECT_TARGET_LIST = [
  'Select at least one target to disconnect:',
  '',
  '  --codex-desktop        Codex desktop app (removes the CodeMie block from ~/.codex/config.toml)',
  `  --${CLAUDE_CODE_OTLP_AGENT_NAME}     Claude Code OTLP (removes hook/env entries)`,
  '',
  'Example:',
  '  codemie proxy disconnect --codex-desktop',
].join('\n');

async function disconnectCodexDesktop(): Promise<void> {
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
    console.error(chalk.red(`✗ Codex Desktop — ${message}`));
    process.exitCode = 1;
  }
}

async function disconnectClaudeCodeOtlp(scope?: 'user' | 'project'): Promise<void> {
  try {
    const result = await removeClaudeCodeOtlpConfig({ scope });

    if (!result.removed) {
      console.log(chalk.dim('Claude Code OTLP: nothing to disconnect.'));
      return;
    }

    console.log(chalk.green(`✓ Claude Code OTLP disconnected (${result.path})`));
    if (result.usedBackup) {
      console.log(chalk.yellow(
        "⚠ Restored the pre-connect backup because CodeMie's entries were the file's only content."
      ));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`✗ Claude Code OTLP - ${message}`));
    process.exitCode = 1;
  }
}

export async function disconnectTargets(opts: DisconnectOptions): Promise<void> {
  if (!opts.targets.codexDesktop && !opts.targets.claudeCodeOtlp) {
    console.log(DISCONNECT_TARGET_LIST);
    return;
  }

  if (opts.targets.codexDesktop) {
    await disconnectCodexDesktop();
  }

  if (opts.targets.claudeCodeOtlp) {
    await disconnectClaudeCodeOtlp(opts.scope);
  }
}
