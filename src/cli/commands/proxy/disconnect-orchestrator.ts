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
import { removeVsCodeLanguageModelsConfig } from './connectors/vscode.js';
import {
  ANALYTICS_AGGREGATES,
  aggregateListRows,
  isMemberConfigured,
  isMemberFound,
  MEMBER_LABELS,
  membersOf,
  type AggregateId,
} from './analytics-clients.js';
import { DEFAULT_GATEWAY_KEY, readState } from './daemon-manager.js';
import { formatFlagRows } from './flag-list.js';

export interface DisconnectTargets {
  claudeCodeOtlp?: boolean;
  copilotChatOtlp?: boolean;
  copilotCliOtlp?: boolean;
  claudeDesktop?: boolean;
  vscodeClaudeCode?: boolean;
  vscode?: boolean;
  codexDesktop?: boolean;
  omp?: boolean;
}

export interface DisconnectOptions {
  targets: DisconnectTargets;
  /** Left undefined when `--scope` is omitted; coalesced to `user` after the ignored-flag checks. */
  scope?: 'user' | 'project';
  insiders?: boolean;
  /** The analytics aggregates given; absent is none. */
  aggregates?: readonly AggregateId[];
}

/** The bare `proxy disconnect` target list; every description starts at one column, computed from the longest flag. */
export const DISCONNECT_TARGET_LIST = [
  'Select at least one target to disconnect:',
  '',
  ...formatFlagRows([
    ['--claude-desktop', 'Claude Desktop app (removes the gateway config and managed MCP servers)'],
    ['--vscode', 'VS Code BYOK (removes the CodeMie provider)'],
    ['--vscode-claude-code', 'VS Code Claude Code extension (removes the ANTHROPIC_* settings)'],
    ['--codex-desktop', 'Codex desktop app (removes the CodeMie block from ~/.codex/config.toml)'],
    ['--omp', 'oh-my-pi (removes the CodeMie model catalog extension)'],
    ...aggregateListRows((a) => a.disconnectListLine),
  ]),
  '',
  'Example:',
  '  codemie proxy disconnect --claude-desktop --vscode-claude-code',
  '  codemie proxy disconnect --all      (every connected target)',
  `  codemie proxy disconnect ${ANALYTICS_AGGREGATES[0].flag}`,
].join('\n');

export async function disconnectClaudeDesktop(): Promise<void> {
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

export async function disconnectVsCodeClaudeCode(insiders: boolean): Promise<void> {
  const label = insiders ? 'VS Code Insiders Claude Code' : 'VS Code Claude Code';
  try {
    const gatewayKey = (await readState())?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
    const result = await removeVsCodeClaudeCodeConfig(gatewayKey, insiders);

    if (!result.removed) {
      const reason = result.reason ? ` (${result.reason})` : '';
      console.log(chalk.dim(`${label}: nothing to disconnect${reason}.`));
      return;
    }

    console.log(chalk.green(`✓ ${label} disconnected (${result.path})`));
    console.log(chalk.yellow(`⚠ Fully quit and reopen ${insiders ? 'VS Code Insiders' : 'VS Code'} to apply the change.`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] VS Code Claude Code disconnect failed', ...sanitizeLogArgs({ error: message, insiders }));
    console.error(chalk.red(`✗ ${label} — ${message}`));
    process.exitCode = 1;
  }
}

export async function disconnectVsCodeByok(insiders: boolean): Promise<void> {
  const label = insiders ? 'VS Code Insiders BYOK' : 'VS Code BYOK';
  try {
    const result = await removeVsCodeLanguageModelsConfig({ insiders });

    if (!result.removed) {
      console.log(chalk.dim(`${label}: nothing to disconnect.`));
      return;
    }

    console.log(chalk.green(`✓ ${label} disconnected`));
    console.log(chalk.yellow('⚠ Reload VS Code to apply the change.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] VS Code BYOK disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.error(chalk.red(`✗ ${label} — ${message}`));
    process.exitCode = 1;
  }
}

export async function disconnectCodexDesktop(): Promise<void> {
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

export async function disconnectClaudeCodeOtlp(scope?: 'user' | 'project'): Promise<void> {
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

export async function disconnectCopilotChatOtlp(scope?: 'user' | 'project'): Promise<void> {
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

export async function disconnectCopilotCliOtlp(scope?: 'user' | 'project'): Promise<void> {
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

export async function disconnectOmp(): Promise<void> {
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

interface AggregateDisconnect {
  targets: DisconnectTargets;
  /** The VS Code editions (`insiders`) whose extension route a vendor flag disconnects; empty when it does not. */
  extensionEditions: boolean[];
}

/**
 * A copy of `targets` without the members an aggregate set that stay as they are: with scope `project` the
 * machine-wide Claude Desktop and extension, left connected; and any member neither found nor configured, which has
 * nothing to remove and prints `<client>: nothing to disconnect.` (not a failure). The extension set by a vendor flag
 * is handed over as editions: both stable and Insiders, or Insiders alone with `--insiders`.
 */
async function dropAggregateMembers(opts: DisconnectOptions): Promise<AggregateDisconnect> {
  if (!opts.aggregates?.length) return { targets: { ...opts.targets }, extensionEditions: [] };
  const run = { insiders: Boolean(opts.insiders) };
  const members = [...membersOf(opts.aggregates)].filter((member) => opts.targets[member]);
  const kept = await Promise.all(members.map(async (member): Promise<'run' | 'kept' | 'nothing' | 'editions'> => {
    if (opts.scope === 'project' && (member === 'claudeDesktop' || member === 'vscodeClaudeCode')) return 'kept';
    if (member === 'vscodeClaudeCode') return 'editions';
    const [found, configured] = await Promise.all([isMemberFound(member, run), isMemberConfigured(member, run)]);
    return found || configured ? 'run' : 'nothing';
  }));
  const targets: DisconnectTargets = { ...opts.targets };
  let extensionEditions: boolean[] = [];
  members.forEach((member, i) => {
    if (kept[i] === 'run') return;
    targets[member] = false;
    if (kept[i] === 'editions') extensionEditions = opts.insiders ? [true] : [false, true];
    if (kept[i] === 'nothing') console.log(chalk.dim(`${MEMBER_LABELS[member]}: nothing to disconnect.`));
  });
  return { targets, extensionEditions };
}

/**
 * Removes the extension's CodeMie route from each edition that has one, through the edition's client target
 * (`vscode-claude-code`, `vscode-claude-code-insiders`). An installed edition with no route prints
 * `<target>: nothing to disconnect.`; an edition neither installed nor routed prints nothing.
 */
async function disconnectExtensionEditions(editions: readonly boolean[]): Promise<void> {
  // Loaded here: `client-targets.ts` imports this module.
  const { CLIENT_TARGETS } = await import('./client-targets.js');
  for (const insiders of editions) {
    const target = CLIENT_TARGETS.find((entry) => entry.id === (insiders ? 'vscode-claude-code-insiders' : 'vscode-claude-code'));
    if (!target) continue;
    let routed: boolean;
    try {
      routed = await target.isConnected();
    } catch (error) {
      logger.debug(`[proxy] ${target.id} connected check failed; disconnecting it`, ...sanitizeLogArgs(error));
      routed = true;
    }
    if (routed) {
      await target.disconnect?.();
    } else if (await isMemberFound('vscodeClaudeCode', { insiders })) {
      console.log(chalk.dim(`${target.label}: nothing to disconnect.`));
    }
  }
}

/**
 * Disconnects every selected target. Resolves false, after printing the target list and setting exit code 1, when
 * no target was selected (a usage error); true once the selected targets ran, whatever each one reported. A run an
 * aggregate left with nothing to remove prints one line and resolves true.
 */
export async function disconnectTargets(opts: DisconnectOptions): Promise<boolean> {
  const given = opts.targets;
  if (
    !given.codexDesktop && !given.claudeCodeOtlp && !given.copilotChatOtlp && !given.copilotCliOtlp &&
    !given.omp && !given.claudeDesktop && !given.vscodeClaudeCode && !given.vscode
  ) {
    console.log(DISCONNECT_TARGET_LIST);
    process.exitCode = 1;
    return false;
  }

  if (opts.insiders && !given.vscode && !given.vscodeClaudeCode) {
    console.log(
      chalk.yellow('Note: --insiders has no effect without a VS Code target (--vscode / --vscode-claude-code).')
    );
  }
  if (opts.scope && !given.claudeCodeOtlp && !given.copilotChatOtlp && !given.copilotCliOtlp) {
    console.log(chalk.yellow(
      'Note: --scope has no effect without an analytics connector target ' +
      `(${ANALYTICS_AGGREGATES.map((a) => a.flag).join(' / ')}).`
    ));
  }
  const scope = opts.scope ?? 'user';

  const { targets, extensionEditions } = await dropAggregateMembers(opts);

  if (targets.claudeDesktop) {
    await disconnectClaudeDesktop();
  }

  if (targets.vscodeClaudeCode) {
    await disconnectVsCodeClaudeCode(Boolean(opts.insiders));
  }
  await disconnectExtensionEditions(extensionEditions);

  if (targets.vscode) {
    await disconnectVsCodeByok(Boolean(opts.insiders));
  }

  if (targets.codexDesktop) {
    await disconnectCodexDesktop();
  }

  if (targets.claudeCodeOtlp) {
    await disconnectClaudeCodeOtlp(scope);
  }

  if (targets.copilotChatOtlp) {
    await disconnectCopilotChatOtlp(scope);
  }

  if (targets.copilotCliOtlp) {
    await disconnectCopilotCliOtlp(scope);
  }

  if (targets.omp) {
    await disconnectOmp();
  }
  return true;
}
