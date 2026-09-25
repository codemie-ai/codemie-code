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
import { removeDesktopConfig } from './connectors/desktop.js';
import { removeVsCodeLanguageModelsConfig } from './connectors/vscode.js';
import { removeVsCodeClaudeCodeConfig } from './connectors/vscode-claude-code.js';

export interface DisconnectTargets {
  claudeDesktop?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
  codexDesktop?: boolean;
}

export interface DisconnectOptions {
  targets: DisconnectTargets;
}

const DISCONNECT_TARGET_LIST = [
  'Select at least one target to disconnect:',
  '',
  '  --claude-desktop        Claude Desktop app (removes MCP servers and gateway config)',
  "  --vscode                VS Code Copilot Chat models (removes chatLanguageModels.json entry)",
  '  --vscode-claude-code    VS Code Claude Code extension (removes ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN)',
  '  --codex-desktop         Codex desktop app (removes the CodeMie block from ~/.codex/config.toml)',
  '',
  'Example:',
  '  codemie proxy disconnect --claude-desktop --vscode',
].join('\n');

/** One per-target disconnect outcome (spec §3.4's TargetResult/printSummary convention). */
interface TargetResult {
  label: string;
  ok: boolean;
  error?: string;
}

function printSummary(results: TargetResult[]): void {
  console.log(chalk.bold('\nTargets disconnected:'));
  for (const r of results) {
    if (r.ok) {
      console.log(chalk.green(`  ✓ ${r.label}`));
    } else {
      console.log(chalk.red(`  ✗ ${r.label}  — ${r.error ?? 'failed'}`));
    }
  }
}

async function runClaudeDesktop(): Promise<TargetResult> {
  try {
    const result = await removeDesktopConfig();
    if (!result.removed) {
      console.log(chalk.dim('Claude Desktop: nothing to disconnect.'));
      return { label: 'Claude Desktop', ok: true };
    }
    console.log(chalk.green(`✓ Claude Desktop disconnected (${result.configPath})`));
    return { label: 'Claude Desktop', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Claude Desktop disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ Claude Desktop — ${message}`));
    return { label: 'Claude Desktop', ok: false, error: message };
  }
}

async function runVscode(): Promise<TargetResult> {
  try {
    const result = await removeVsCodeLanguageModelsConfig();
    if (!result.removed) {
      console.log(chalk.dim('VS Code (Copilot models): nothing to disconnect.'));
      return { label: 'VS Code (Copilot models)', ok: true };
    }
    console.log(chalk.green('✓ VS Code (Copilot models) disconnected'));
    if (result.error) {
      console.log(chalk.yellow(`  ⚠ One location could not be updated: ${result.error}`));
    }
    return { label: 'VS Code (Copilot models)', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] VS Code Copilot Chat disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ VS Code (Copilot models) — ${message}`));
    return { label: 'VS Code (Copilot models)', ok: false, error: message };
  }
}

async function runVscodeClaudeCode(): Promise<TargetResult> {
  try {
    const result = await removeVsCodeClaudeCodeConfig();
    if (!result.removed) {
      console.log(chalk.dim('VS Code Claude Code: nothing to disconnect.'));
      return { label: 'VS Code Claude Code', ok: true };
    }
    console.log(chalk.green('✓ VS Code Claude Code disconnected'));
    if (result.error) {
      console.log(chalk.yellow(`  ⚠ One location could not be updated: ${result.error}`));
    }
    return { label: 'VS Code Claude Code', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] VS Code Claude Code disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ VS Code Claude Code — ${message}`));
    return { label: 'VS Code Claude Code', ok: false, error: message };
  }
}

async function runCodexDesktop(): Promise<TargetResult> {
  try {
    const result = await removeCodexDesktopConfig();

    if (!result.removed) {
      console.log(chalk.dim('Codex Desktop: nothing to disconnect.'));
      return { label: 'Codex Desktop', ok: true };
    }

    console.log(chalk.green(`✓ Codex Desktop disconnected (${result.configPath})`));
    if (result.usedBackup) {
      console.log(chalk.yellow(
        '⚠ Restored the backup because the managed block could not be removed cleanly.'
      ));
    }
    console.log(chalk.yellow('⚠ Quit and reopen the ChatGPT desktop app to apply the change.'));
    return { label: 'Codex Desktop', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Codex Desktop disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ Codex Desktop — ${message}`));
    return { label: 'Codex Desktop', ok: false, error: message };
  }
}

export async function disconnectTargets(opts: DisconnectOptions): Promise<void> {
  const { targets } = opts;
  const hasAnyTarget = Boolean(
    targets.claudeDesktop || targets.vscode || targets.vscodeClaudeCode || targets.codexDesktop
  );

  if (!hasAnyTarget) {
    console.log(DISCONNECT_TARGET_LIST);
    return;
  }

  const results: TargetResult[] = [];
  if (targets.claudeDesktop) results.push(await runClaudeDesktop());
  if (targets.vscode) results.push(await runVscode());
  if (targets.vscodeClaudeCode) results.push(await runVscodeClaudeCode());
  if (targets.codexDesktop) results.push(await runCodexDesktop());

  printSummary(results);
  if (results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}
