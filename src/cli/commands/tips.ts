/**
 * Tips command - Browse the feature tips shown at session start and end
 *
 * Also serves as the staleness check for the tip catalog: tips whose command
 * examples no longer validate against the CLI tree (or use a deprecated form)
 * are shown with a "(stale: <reason>)" marker.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { formatTipLine, listTips } from '../../utils/tips.js';
import type { Tip } from '../../utils/tips.js';
import { logger } from '../../utils/logger.js';
import { validateCommandExample } from '../../utils/tips-validator.js';

type ShownTip = Tip & { stale?: string };

function rootOf(command: Command): Command {
  let root = command;
  while (root.parent) root = root.parent;
  return root;
}

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
      const tips = markStaleTips(listTips(), rootOf(command));

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
 * Validate every tip's command examples against the live command tree and the
 * deprecation registry. Stale tips are kept and flagged with a reason so a
 * forgotten tip is visible instead of silently disappearing.
 */
function markStaleTips(tips: readonly Tip[], program: Command): ShownTip[] {
  return tips.map(tip => {
    const examples = [
      ...(tip.command ? [`codemie ${tip.command}`] : []),
      ...(tip.commands ?? []),
    ];
    for (const example of examples) {
      const result = validateCommandExample(program, example);
      if (!result.ok) {
        logger.debug(`[tips] Stale tip '${tip.id}': ${result.reason}`);
        return { ...tip, stale: result.reason };
      }
    }
    return tip;
  });
}

const staleMarker = (tip: ShownTip): string =>
  tip.stale ? ' ' + chalk.yellow(`(stale: ${tip.stale})`) : '';

function showAllTips(tips: ShownTip[]): void {
  if (tips.length === 0) {
    console.log(chalk.yellow('\nNo tips available.\n'));
    return;
  }

  const byCategory = new Map<string, ShownTip[]>();
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
      console.log(`  💡 ${tip.message}${commandRef}${staleMarker(tip)}`);
    }
  }
  console.log();
}

function showRandomTip(tips: ShownTip[]): void {
  if (tips.length === 0) {
    console.log(chalk.yellow('\nNo tips available.\n'));
    return;
  }

  const tip = tips[Math.floor(Math.random() * tips.length)];
  console.log();
  console.log(formatTipLine(tip) + staleMarker(tip));
  if (tip.commands && tip.commands.length > 0) {
    const [first, second] = tip.commands;
    const shown = tip.commands.length === 2 && second ? `${first} · ${second}` : first;
    console.log(chalk.dim(`   Try: ${shown}`));
  }
  console.log();
}
