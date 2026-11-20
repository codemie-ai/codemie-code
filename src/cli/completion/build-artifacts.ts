/** Generate distributable shell completion files from the installed command tree. */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logger } from '@/utils/logger.js';
import { generateCompletion } from './index.js';
import { introspectTree } from './introspect.js';
import type { RootTree } from './types.js';

async function build(): Promise<void> {
  // These imports register runtime plugins, so silence the logger before evaluating them.
  logger.disableOutput();
  const [{ AgentCLI }, { getAgentLauncherCommand }, { AgentRegistry }, { createProgram }, { buildCandidateMap }] = await Promise.all([
    import('@/agents/core/AgentCLI.js'),
    import('@/agents/core/agent-aliases.js'),
    import('@/agents/registry.js'),
    import('@/cli/program.js'),
    import('./candidates.js'),
  ]);
  const program = createProgram();
  const roots: RootTree[] = [{ command: program.name(), node: introspectTree(program) }];
  for (const adapter of AgentRegistry.getManageableAgents()) {
    if (adapter.name.endsWith('-acp')) continue;
    const command = getAgentLauncherCommand(adapter.name);
    roots.push({ command, node: introspectTree(new AgentCLI(adapter).getProgram()) });
  }
  roots.sort((a, b) => a.command < b.command ? -1 : a.command > b.command ? 1 : 0);
  const commands = roots.map(root => root.command);
  if (new Set(commands).size !== commands.length) throw new Error('Duplicate completion command');
  const candidates = buildCandidateMap();
  const destination = fileURLToPath(new URL('../../completions/', import.meta.url));
  await rm(destination, { recursive: true, force: true });
  await Promise.all(['bash', 'fish', 'zsh'].map(shell => mkdir(`${destination}/${shell}`, { recursive: true })));
  // One Zsh file per command makes compinit notice newly added launchers in its dump.
  const files = { bash: [] as string[], zsh: [] as string[], fish: [] as string[] };
  for (const root of roots) {
    const bash = `bash/${root.command}.bash`;
    const fish = `fish/${root.command}.fish`;
    const zsh = `zsh/_${root.command}`;
    files.bash.push(bash);
    files.fish.push(fish);
    files.zsh.push(zsh);
    await writeFile(`${destination}/${bash}`, generateCompletion('bash', [root], candidates));
    await writeFile(`${destination}/${fish}`, generateCompletion('fish', [root], candidates));
    await writeFile(`${destination}/${zsh}`, generateCompletion('zsh', [root], candidates));
  }
  await writeFile(`${destination}/manifest.json`, `${JSON.stringify({ commands, files }, null, 2)}\n`);
}

await build();
