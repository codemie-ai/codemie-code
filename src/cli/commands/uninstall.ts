import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry';
import { logger } from '../../utils/logger';
import { AgentNotFoundError } from '../../utils/errors';
import ora from 'ora';
import chalk from 'chalk';

export function createUninstallCommand(): Command {
  const command = new Command('uninstall');

  command
    .description('Uninstall an external AI coding agent (e.g., claude, codex)')
    .argument('[agent]', 'Agent name to uninstall (run without argument to see installed agents)')
    .action(async (agentName?: string) => {
      try {
        // If no agent name provided, show installed agents
        if (!agentName) {
          const installedAgents = await AgentRegistry.getInstalledAgents();

          if (installedAgents.length === 0) {
            console.log();
            console.log(chalk.yellow('No agents are currently installed.'));
            console.log();
            console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie list') + ' to see all available agents');
            console.log();
            return;
          }

          console.log();
          console.log(chalk.bold('Installed agents:\n'));

          for (const agent of installedAgents) {
            const version = await agent.getVersion();
            const versionStr = version ? chalk.gray(` (${version})`) : '';

            console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
            console.log(`    Command: ${chalk.cyan(`codemie uninstall ${agent.name}`)}`);
            console.log(`    ${chalk.gray(agent.description)}`);
            console.log();
          }

          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie uninstall <agent>') + ' to uninstall an agent');
          console.log();
          return;
        }

        const agent = AgentRegistry.getAgent(agentName);

        if (!agent) {
          throw new AgentNotFoundError(agentName);
        }

        // Check if installed
        if (!(await agent.isInstalled())) {
          logger.info(`${agent.displayName} is not installed`);
          return;
        }

        const spinner = ora(`Uninstalling ${agent.displayName}...`).start();

        try {
          await agent.uninstall();
          spinner.succeed(`${agent.displayName} uninstalled successfully`);
        } catch (error: unknown) {
          spinner.fail(`Failed to uninstall ${agent.displayName}`);
          throw error;
        }
      } catch (error: unknown) {
        logger.error('Uninstallation failed:', error);
        process.exit(1);
      }
    });

  return command;
}
