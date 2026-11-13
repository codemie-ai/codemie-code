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
import { removeCopilotChatOtlpConfig } from './connectors/copilot-chat-otlp.js';
import { removeCopilotCliOtlpConfig } from './connectors/copilot-cli-otlp.js';
import { removeOmpExtension } from './connectors/omp.js';
import { removeDesktopConfig } from './connectors/desktop.js';
import { removeVsCodeClaudeCodeConfig } from './connectors/vscode-claude-code.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';

export interface DisconnectTargets {
  claudeCodeOtlp?: boolean;
  copilotChatOtlp?: boolean;
  copilotCliOtlp?: boolean;
  claudeDesktop?: boolean;
  vscodeClaudeCode?: boolean;
  codexDesktop?: boolean;
  omp?: boolean;
}

export interface DisconnectOptions {
  targets: DisconnectTargets;
  scope?: 'user' | 'project';
  insiders?: boolean;
}

const DISCONNECT_TARGET_LIST = [
  'Select at least one target to disconnect:',
  '',
  '  --claude-desktop       Claude Desktop app (removes the gateway config and managed MCP servers)',
  '  --vscode-claude-code   VS Code Claude Code extension (removes ANTHROPIC_* env vars from settings.json)',
  '  --codex-desktop        Codex desktop app (removes the CodeMie block from ~/.codex/config.toml)',
  '  --omp                  oh-my-pi (removes the CodeMie model catalog extension)',
  `  --${CLAUDE_CODE_OTLP_AGENT_NAME}     Claude Code OTLP (removes hook/env entries)`,
  `  --${COPILOT_CHAT_OTLP_AGENT_NAME}   Copilot Chat OTLP (removes the CodeMie hook file + settings entry)`,
  `  --${COPILOT_CLI_OTLP_AGENT_NAME}     Copilot CLI OTLP (removes the CodeMie hook file)`,
  '',
  'Example:',
  '  codemie proxy disconnect --claude-desktop --vscode-claude-code',
].join('\n');

async function disconnectClaudeDesktop(): Promise<void> {
  try {
    const result = await removeDesktopConfig();

    if (!result.removed) {
      const reason = result.reason ? ` (${result.reason})` : '';
      console.log(chalk.dim(`Claude Desktop: nothing to disconnect${reason}.`));
      return;
    }

    console.log(chalk.green(`✓ Claude Desktop disconnected (${result.configPath})`));
    if (!result.deletedConfigFile) {
      console.log(chalk.dim('  Kept settings in the config that CodeMie did not write.'));
    }
    console.log(chalk.yellow('⚠ Quit and reopen Claude Desktop to apply the change.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Claude Desktop disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ Claude Desktop — ${message}`));
    process.exitCode = 1;
  }
}

async function disconnectVsCodeClaudeCode(insiders: boolean): Promise<void> {
  try {
    const result = await removeVsCodeClaudeCodeConfig(insiders);

    if (!result.removed) {
      const reason = result.reason ? ` (${result.reason})` : '';
      console.log(chalk.dim(`VS Code Claude Code: nothing to disconnect${reason}.`));
      return;
    }

    console.log(chalk.green(`✓ VS Code Claude Code disconnected (${result.path})`));
    console.log(chalk.yellow('⚠ Fully quit and reopen VS Code to apply the change.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] VS Code Claude Code disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ VS Code Claude Code — ${message}`));
    process.exitCode = 1;
  }
}

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
      const reason = result.reason ? ` (${result.reason})` : '';
      console.log(chalk.dim(`Claude Code OTLP: nothing to disconnect${reason}.`));
      return;
    }

    if (result.mode === 'entry-removed') {
      console.log(chalk.green(`✓ Project removed from Claude Code OTLP tracking (${result.path})`));
      console.log(chalk.dim('  Still tracked:'));
      for (const projectPath of result.allowlist ?? []) {
        console.log(chalk.dim(`    - ${projectPath}`));
      }
      return;
    }

    console.log(chalk.green(`✓ Claude Code OTLP disconnected (${result.path})`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`✗ Claude Code OTLP - ${message}`));
    process.exitCode = 1;
  }
}

async function disconnectCopilotChatOtlp(scope?: 'user' | 'project'): Promise<void> {
  try {
    const result = await removeCopilotChatOtlpConfig({ scope });

    if (!result.removed) {
      const reason = result.reason ? ` (${result.reason})` : '';
      console.log(chalk.dim(`Copilot Chat OTLP: nothing to disconnect${reason}.`));
      return;
    }

    if (result.mode === 'entry-removed') {
      console.log(chalk.green(`✓ Project removed from Copilot Chat OTLP tracking (${result.settingsPath})`));
      console.log(chalk.dim('  Still tracked:'));
      for (const projectPath of result.allowlist ?? []) {
        console.log(chalk.dim(`    - ${projectPath}`));
      }
      return;
    }

    console.log(chalk.green(`✓ Copilot Chat OTLP disconnected (${result.settingsPath})`));
    console.log(chalk.yellow('  Restart VS Code to apply changes.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Copilot Chat OTLP disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ Copilot Chat OTLP — ${message}`));
    process.exitCode = 1;
  }
}

async function disconnectCopilotCliOtlp(scope?: 'user' | 'project'): Promise<void> {
  try {
    const result = await removeCopilotCliOtlpConfig({ scope });

    if (!result.removed) {
      const reason = result.reason ? ` (${result.reason})` : '';
      console.log(chalk.dim(`Copilot CLI OTLP: nothing to disconnect${reason}.`));
      return;
    }

    if (result.mode === 'entry-removed') {
      console.log(chalk.green(`✓ Project removed from Copilot CLI OTLP tracking (${result.hookFilePath})`));
      console.log(chalk.dim('  Still tracked:'));
      for (const projectPath of result.allowlist ?? []) {
        console.log(chalk.dim(`    - ${projectPath}`));
      }
      return;
    }

    console.log(chalk.green(`✓ Copilot CLI OTLP disconnected (${result.hookFilePath})`));
    console.log(chalk.yellow('  Restart the Copilot CLI to apply changes.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Copilot CLI OTLP disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ Copilot CLI OTLP — ${message}`));
    process.exitCode = 1;
  }
}

async function disconnectOmp(): Promise<void> {
  try {
    const result = await removeOmpExtension();
    if (!result.removed) {
      console.log(chalk.dim('oh-my-pi: nothing to disconnect.'));
      return;
    }
    console.log(chalk.green(`✓ oh-my-pi disconnected (${result.path})`));
    console.log(chalk.yellow('⚠ Restart omp to drop the codemie and codemie-claude providers.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`✗ oh-my-pi — ${message}`));
    process.exitCode = 1;
  }
}

export async function disconnectTargets(opts: DisconnectOptions): Promise<void> {
  const { targets } = opts;
  if (
    !targets.codexDesktop && !targets.claudeCodeOtlp && !targets.copilotChatOtlp && !targets.copilotCliOtlp &&
    !targets.omp && !targets.claudeDesktop && !targets.vscodeClaudeCode
  ) {
    console.log(DISCONNECT_TARGET_LIST);
    return;
  }

  if (targets.claudeDesktop) {
    await disconnectClaudeDesktop();
  }

  if (targets.vscodeClaudeCode) {
    await disconnectVsCodeClaudeCode(Boolean(opts.insiders));
  }

  if (targets.codexDesktop) {
    await disconnectCodexDesktop();
  }

  if (targets.claudeCodeOtlp) {
    await disconnectClaudeCodeOtlp(opts.scope);
  }

  if (targets.copilotChatOtlp) {
    await disconnectCopilotChatOtlp(opts.scope);
  }

  if (targets.copilotCliOtlp) {
    await disconnectCopilotCliOtlp(opts.scope);
  }

  if (targets.omp) {
    await disconnectOmp();
  }
}
