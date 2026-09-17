/**
 * Tips command - Browse the feature tips shown at session start and end
 *
 * Also serves as the staleness check for the tip catalog: tips whose
 * `command` reference no longer matches a registered CLI command are dropped
 * from the output and flagged via logger.debug.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { formatTipLine, listTips } from '../../utils/tips.js';
import type { Tip } from '../../utils/tips.js';
import { logger } from '../../utils/logger.js';

interface TipsCommandOptions {
  random?: boolean;
  category?: string;
}

export function createTipsCommand(): Command {
  const command = new Command('tips');

  command
    .description('Browse the feature tips shown at session start and end')
    .option('--random', 'Show a single random tip')
    .option('--category <name>', 'Show only tips from one category (case-insensitive)')
    .action((options: TipsCommandOptions) => {
      const knownCommands = collectKnownCommandNames(command);
      const tips = dropStaleTips(listTips(), knownCommands);

      const categoryFilter = options.category?.toLowerCase();
      const filtered = categoryFilter
        ? tips.filter(tip => tip.category.toLowerCase() === categoryFilter)
        : tips;

      if (categoryFilter && filtered.length === 0) {
        console.log(chalk.yellow(`\nNo tips in category "${options.category}". Available categories:`));
        for (const category of new Set(tips.map(tip => tip.category))) {
          console.log(`  - ${category}`);
        }
        console.log();
        return;
      }

      if (options.random) {
        showRandomTip(filtered);
        return;
      }

      showAllTips(filtered);
    });

  return command;
}

/**
 * Collect every registered command path from the root program down,
 * e.g. 'proxy' and 'proxy connect'. Top-level names are what tip.command
 * references; nested paths are collected for completeness.
 */
function collectKnownCommandNames(command: Command): Set<string> {
  let root = command;
  while (root.parent) {
    root = root.parent;
  }

  const names = new Set<string>();
  const visit = (node: Command, prefix: string): void => {
    for (const sub of node.commands) {
      const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
      names.add(path);
      visit(sub, path);
    }
  };
  visit(root, '');
  return names;
}

/**
 * Drop tips whose command reference is not a registered top-level command —
 * the self-healing signal when a command is retired but its tip was forgotten.
 * A tip is stale when its `command` OR any of its `commands` variations fails.
 */
function dropStaleTips(tips: readonly Tip[], knownCommands: Set<string>): Tip[] {
  return tips.filter(tip => {
    if (tip.command && !knownCommands.has(tip.command)) {
      logger.debug(`[tips] Dropping stale tip '${tip.id}': 'codemie ${tip.command}' is not a registered command`);
      return false;
    }
    const staleVariation = tip.commands?.find(variation => !isKnownVariation(variation, knownCommands));
    if (staleVariation) {
      logger.debug(`[tips] Dropping stale tip '${tip.id}': variation '${staleVariation}' does not match a registered command`);
      return false;
    }
    return true;
  });
}

/**
 * Validate one variation: locate the bare `codemie` token and check the token
 * after it against the known command tree. Variations without a checkable
 * command token — binary form (`codemie-<agent> ...`) or flag-led
 * (`codemie --task ...`) — are skipped.
 */
function isKnownVariation(variation: string, knownCommands: Set<string>): boolean {
  const tokens = variation.split(/\s+/);
  const codemieIndex = tokens.indexOf('codemie');
  if (codemieIndex === -1) {
    return true;
  }
  const topLevel = tokens[codemieIndex + 1];
  if (!topLevel || topLevel.startsWith('-')) {
    return true;
  }
  return knownCommands.has(topLevel);
}

function showAllTips(tips: Tip[]): void {
  if (tips.length === 0) {
    console.log(chalk.yellow('\nNo tips available.\n'));
    return;
  }

  const byCategory = new Map<string, Tip[]>();
  for (const tip of tips) {
    const group = byCategory.get(tip.category) ?? [];
    group.push(tip);
    byCategory.set(tip.category, group);
  }

  console.log();
  console.log(chalk.bold('💡 CodeMie Feature Tips'));
  console.log(chalk.dim('   Shown at session start and end. Disable with CODEMIE_TIPS=0.'));

  for (const [category, categoryTips] of byCategory) {
    console.log();
    console.log(chalk.bold.cyan(category));
    for (const tip of categoryTips) {
      // Tips with concrete variations show those; others fall back to the
      // top-level command reference.
      const commandRef = tip.commands?.length
        ? chalk.dim(' → ') + tip.commands.map(cmd => chalk.cyan(cmd)).join(chalk.dim(' · '))
        : (tip.command ? chalk.dim(' → ') + chalk.cyan(`codemie ${tip.command}`) : '');
      console.log(`  💡 ${tip.message}${commandRef}`);
    }
  }
  console.log();
}

function showRandomTip(tips: Tip[]): void {
  if (tips.length === 0) {
    console.log(chalk.yellow('\nNo tips available.\n'));
    return;
  }

  const tip = tips[Math.floor(Math.random() * tips.length)];
  console.log();
  console.log(formatTipLine(tip));
  if (tip.commands && tip.commands.length > 0) {
    const [first, second] = tip.commands;
    const shown = tip.commands.length === 2 && second ? `${first} · ${second}` : first;
    console.log(chalk.dim(`   Try: ${shown}`));
  }
  console.log();
}
