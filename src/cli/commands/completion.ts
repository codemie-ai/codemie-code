/**
 * `codemie completion <shell>`
 *
 * Prints a self-contained shell completion script to stdout. The script is
 * generated from a snapshot of the live command tree, so commands, options and
 * enumerable values (agents, profiles, workflows, ...) are always in sync with
 * the installed CLI at generation time.
 *
 * Enable with:
 *   source <(codemie completion zsh)     # bash / zsh
 *   codemie completion fish | source     # fish
 */

import type { Command } from 'commander';
import { Command as Commander } from 'commander';
import { buildCandidateMap } from '../completion/candidates.js';
import { generateCompletion } from '../completion/index.js';
import { introspectTree } from '../completion/introspect.js';
import { SUPPORTED_SHELLS, isShell } from '../completion/types.js';
import type { RootTree, Shell } from '../completion/types.js';

function detectShell(): Shell | undefined {
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';
  return undefined;
}

function usageHint(shell: Shell): string {
  if (shell === 'fish') {
    return [
      '',
      'To enable completions:',
      '  codemie completion fish | source',
      'To persist across sessions:',
      '  codemie completion fish > ~/.config/fish/completions/codemie.fish',
      '',
    ].join('\n');
  }
  return [
    '',
    'To enable completions:',
    `  source <(codemie completion ${shell})`,
    'Add that line to your shell rc file to persist it.',
    '',
  ].join('\n');
}

/**
 * Collect the root `codemie` tree plus every interactive `codemie-<agent>`
 * launcher tree. Launcher introspection loads the agent CLI lazily so normal
 * CLI startup is unaffected.
 */
async function collectRootTrees(program: Command): Promise<RootTree[]> {
  const roots: RootTree[] = [{ command: program.name(), node: introspectTree(program) }];

  try {
    const [{ AgentCLI }, { AgentRegistry }, { getAgentLauncherCommand }] = await Promise.all([
      import('@/agents/core/AgentCLI.js'),
      import('@/agents/registry.js'),
      import('@/agents/core/agent-aliases.js'),
    ]);

    for (const adapter of AgentRegistry.getManageableAgents()) {
      // ACP adapters are driven by editors over JSON-RPC, not typed in a shell.
      if (adapter.name.endsWith('-acp')) continue;
      const command = getAgentLauncherCommand(adapter.name);
      const cli = new AgentCLI(adapter);
      roots.push({ command, node: introspectTree(cli.getProgram()) });
    }
  } catch {
    // Launcher completions are additive; never fail the main script.
  }

  return roots;
}

export function createCompletionCommand(program: Command): Commander {
  return new Commander('completion')
    .description('Print a shell completion script (bash, zsh, fish)')
    .argument('[shell]', `Shell to generate completions for: ${SUPPORTED_SHELLS.join(', ')}`)
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  source <(codemie completion zsh)     # bash / zsh (this session)',
        '  codemie completion fish | source     # fish (this session)',
        '  codemie completion bash > ~/.local/share/bash-completion/completions/codemie',
        '',
      ].join('\n')
    )
    .action(async (shellArg?: string) => {
      const shell = (shellArg ? shellArg.toLowerCase() : detectShell()) as string | undefined;

      if (!shell || !isShell(shell)) {
        process.stderr.write(
          `Unsupported shell: ${shell ?? 'could not detect'}\n` +
            `Supported shells: ${SUPPORTED_SHELLS.join(', ')}\n`
        );
        process.exitCode = 1;
        return;
      }

      const candidates = await buildCandidateMap();
      const roots = await collectRootTrees(program);

      process.stdout.write(generateCompletion(shell, roots, candidates));
      process.stderr.write(usageHint(shell));
    });
}
