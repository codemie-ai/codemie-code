import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { logger } from '../../utils/logger.js';
import { tipDisplay } from '../../utils/tips.js';
import chalk from 'chalk';

export function createListCommand(): Command {
  const command = new Command('list');

  command
    .description('List all available agents')
    .option('-i, --installed', 'Show only installed agents')
    .action(async (options) => {
      try {
        const agents = options.installed
          ? await AgentRegistry.getInstalledAgents()
          : AgentRegistry.getAllAgents();

        if (agents.length === 0) {
          logger.info(options.installed ? 'No agents installed' : 'No agents available');
          return;
        }

        console.log(chalk.bold('\nAvailable Agents:\n'));

        for (const agent of agents) {
          const installed = await agent.isInstalled();
          const status = installed ? chalk.green('✓ installed') : chalk.gray('not installed');
          const version = installed ? await agent.getVersion() : null;
          const versionStr = version ? chalk.gray(` (${version})`) : '';

          console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
          console.log(`    Command: ${chalk.cyan(agent.name)}`);
          console.log(`    Status: ${status}`);
          console.log(`    ${chalk.gray(agent.description)}`);
          console.log();
        }

        // Show a helpful tip after listing agents (unless in assistant context)
        if (!options.installed && !process.env.CODEMIE_IN_ASSISTANT) {
          tipDisplay.showRandomTip();
        }
      } catch (error: unknown) {
        logger.error('Failed to list agents:', error);
        process.exit(1);
      }
    });

  return command;
}
