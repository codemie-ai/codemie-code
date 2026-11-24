/**
 * Completion command - print a shell completion script for bash, zsh or fish.
 * The script is generated from the live command tree; stdout carries the script only.
 */

import { Argument, Command } from 'commander';
import { COMPLETION_SHELLS, generate } from '../completion/index.js';
import type { CompletionShell } from '../completion/index.js';

function rootOf(command: Command): Command {
  let root = command;
  while (root.parent) root = root.parent;
  return root;
}

export function createCompletionCommand(): Command {
  const command = new Command('completion');

  command
    .description('Print a shell completion script (bash, zsh or fish)')
    .addArgument(new Argument('<shell>', 'Target shell').choices(COMPLETION_SHELLS))
    .showHelpAfterError(`(allowed shells: ${COMPLETION_SHELLS.join(', ')})`)
    .addHelpText('after', `
Examples:
  eval "$(codemie completion bash)"
  codemie completion zsh > "\${fpath[1]}/_codemie"
  codemie completion fish > ~/.config/fish/completions/codemie.fish
`)
    .action((shell: CompletionShell) => {
      process.stdout.write(generate(shell, rootOf(command)));
    });

  return command;
}
