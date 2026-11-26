import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { getUserFacingAgentName } from '../../agents/core/agent-aliases.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import { formatNotOnPathShort, type ShadowVerdict } from '../../utils/path-shadow.js';

const SHADOW_DEADLINE_MS = 5000;
const UNKNOWN_VERDICT: ShadowVerdict = { status: 'unknown' };

/** Start all verdict lookups at once under one shared deadline; unfinished ones are `unknown`. */
async function collectShadowVerdicts(
  agents: Array<{ name: string; checkPathShadow?: (opts?: { resolvePrefix?: boolean }) => Promise<ShadowVerdict> }>
): Promise<Map<string, ShadowVerdict>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ShadowVerdict>((resolve) => {
    timer = setTimeout(() => resolve(UNKNOWN_VERDICT), SHADOW_DEADLINE_MS);
  });
  try {
    const entries = await Promise.all(
      agents.map(async (agent): Promise<[string, ShadowVerdict]> => {
        if (!agent.checkPathShadow) return [agent.name, UNKNOWN_VERDICT];
        try {
          return [agent.name, await Promise.race([agent.checkPathShadow(), deadline])];
        } catch (error: unknown) {
          logger.debug('PATH shadow check failed', error);
          return [agent.name, UNKNOWN_VERDICT];
        }
      })
    );
    return new Map(entries);
  } finally {
    clearTimeout(timer);
  }
}

export function createListCommand(): Command {
  const command = new Command('list');

  command
    .description('List all available agents and frameworks')
    .option('-i, --installed', 'Show only installed agents and frameworks')
    .action(async (options) => {
      try {
        // List agents
        const agents = options.installed
          ? await AgentRegistry.getInstalledAgents()
          : AgentRegistry.getManageableAgents();

        if (agents.length === 0) {
          logger.info(options.installed ? 'No agents installed' : 'No agents available');
        } else {
          console.log(chalk.bold('\n📦 Available Agents:\n'));

          const verdicts = await collectShadowVerdicts(agents);

          for (const agent of agents) {
            const userFacingName = getUserFacingAgentName(agent.name);
            const installed = await agent.isInstalled();
            const verdict = verdicts.get(agent.name) ?? UNKNOWN_VERDICT;
            const extraLines: string[] = [];
            let status: string;
            if (verdict.status === 'shadowed') {
              status = chalk.yellow('shadowed');
              extraLines.push(
                chalk.yellow(`      Active:   ${verdict.active}`),
                chalk.yellow(`      Expected: ${verdict.managedDir}`)
              );
            } else if (!installed && verdict.status === 'missing-on-path') {
              status = chalk.yellow(formatNotOnPathShort(verdict));
            } else {
              status = installed ? chalk.green('✓ installed') : chalk.white('not installed');
            }
            const version = installed ? await agent.getVersion() : null;
            const versionStr = version ? chalk.white(` (${version})`) : '';

            console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
            console.log(`    Command: ${chalk.cyan(userFacingName)}`);
            console.log(`    Status: ${status}`);
            for (const line of extraLines) console.log(line);
            console.log(`    ${chalk.white(agent.description)}`);
            console.log();
          }
        }

        // List frameworks
        const { FrameworkRegistry } = await import('../../frameworks/index.js');
        const frameworks = FrameworkRegistry.getAllFrameworks();

        if (frameworks.length > 0) {
          // Filter by installed if requested
          let displayFrameworks = frameworks;
          if (options.installed) {
            const installedCheck = await Promise.all(
              frameworks.map(async (fw) => ({
                framework: fw,
                installed: await fw.isInstalled()
              }))
            );
            displayFrameworks = installedCheck
              .filter(({ installed }) => installed)
              .map(({ framework }) => framework);
          }

          if (displayFrameworks.length > 0) {
            console.log(chalk.bold('🛠️  Available Frameworks:\n'));

            for (const framework of displayFrameworks) {
              const installed = await framework.isInstalled();
              const initialized = await framework.isInitialized();

              const status = installed ? chalk.green('✓ installed') : chalk.white('not installed');
              const initStatus = initialized ? chalk.green(' (initialized)') : '';
              const version = installed ? await framework.getVersion() : null;
              const versionStr = version ? chalk.white(` v${version}`) : '';

              console.log(chalk.bold(`  ${framework.metadata.displayName}`) + versionStr + initStatus);
              console.log(`    Command: ${chalk.cyan(framework.metadata.name)}`);
              console.log(`    Status: ${status}`);
              console.log(`    ${chalk.white(framework.metadata.description)}`);

              if (framework.metadata.docsUrl) {
                console.log(`    Docs: ${chalk.cyan(framework.metadata.docsUrl)}`);
              }

              console.log();
            }
          } else if (options.installed) {
            logger.info('No frameworks installed');
          }
        }

        console.log('');
        console.log(chalk.dim('──────────────────────────────────────────────────'));
        console.log(chalk.bold('  Next Steps:'));
        console.log('');
        console.log('  ' + chalk.white('• Install an agent:') + '      ' + chalk.cyan('codemie install <agent>'));
        console.log('  ' + chalk.white('• Run an agent:') + '          ' + chalk.cyan('codemie-<agent>'));
        console.log('  ' + chalk.white('• Run a quick task:') + '      ' + chalk.cyan('codemie --task "your task"'));
        console.log('  ' + chalk.white('• Install framework:') + '     ' + chalk.cyan('codemie install <framework>'));
        console.log('  ' + chalk.white('• Initialize framework:') + '    ' + chalk.cyan('codemie-<agent> init'));
        console.log('  ' + chalk.white('• Explore more:') + '          ' + chalk.cyan('codemie --help'));
        console.log('');

      } catch (error: unknown) {
        logger.error('Failed to list agents and frameworks:', error);
        process.exit(1);
      }
    });

  return command;
}
