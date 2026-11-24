import { Command, Option } from 'commander';
import { markHidden } from '@/cli/hidden.js';

/**
 * Synthetic commander tree shared by the shell-completion emitter tests.
 *
 *   tool [--task <task>] [-V]
 *     list|ls  [-v] [--format <json|text|"two words">] [--out <path>] [--cfg [file]] [--secret hidden]
 *     internal (hidden)
 *     a
 *       b
 *         c [--deep]
 *       zz (hidden)
 */
export function buildFixtureRoot(): Command {
  const root = new Command('tool').version('1.2.3').option('--task <task>', 'Run a task');
  const list = root.command('list').alias('ls').description("List things (it's fine)");
  list.option('-v, --verbose', 'Verbose');
  list.addOption(
    new Option('--format <fmt>', 'Output format').choices(['json', 'text', 'two words'])
  );
  list.addOption(new Option('--secret', 'Secret').hideHelp());
  list.option('--out <path>', 'Output file');
  list.option('--cfg [file]', 'Config file');
  list.option('--name <name>', 'Free-form value');
  markHidden(root.command('internal'));
  const a = root.command('a').description('Group a');
  markHidden(a.command('zz'));
  a.command('b').command('c').option('--deep', 'Deep');
  return root;
}
