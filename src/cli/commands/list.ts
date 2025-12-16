import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

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
          : AgentRegistry.getAllAgents();

        if (agents.length === 0) {
          logger.info(options.installed ? 'No agents installed' : 'No agents available');
        } else {
          console.log(chalk.bold('\n📦 Available Agents:\n'));

          for (const agent of agents) {
            const installed = await agent.isInstalled();
            const status = installed ? chalk.green('✓ installed') : chalk.white('not installed');
            const version = installed ? await agent.getVersion() : null;
            const versionStr = version ? chalk.white(` (${version})`) : '';

            console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
            console.log(`    Command: ${chalk.cyan(agent.name)}`);
            console.log(`    Status: ${status}`);
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
      } catch (error: unknown) {
        logger.error('Failed to list agents and frameworks:', error);
        process.exit(1);
      }
    });

  return command;
}
