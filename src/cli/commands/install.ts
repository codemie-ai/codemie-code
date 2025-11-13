import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry';
import { logger } from '../../utils/logger';
import { asyncTipDisplay } from '../../utils/async-tips';
import { AgentInstallationError } from '../../utils/errors';
import ora from 'ora';
import chalk from 'chalk';

export function createInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install an external AI coding agent (e.g., claude, codex)')
    .argument('[agent]', 'Agent name to install (run without argument to see available agents)')
    .action(async (agentName?: string) => {
      try {
        // If no agent name provided, show available agents
        if (!agentName) {
          const agents = AgentRegistry.getAllAgents();

          console.log();
          console.log(chalk.bold('Available agents to install:\n'));

          for (const agent of agents) {
            const installed = await agent.isInstalled();
            const status = installed ? chalk.green('✓ installed') : chalk.yellow('○ not installed');
            const version = installed ? await agent.getVersion() : null;
            const versionStr = version ? chalk.gray(` (${version})`) : '';

            console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
            console.log(`    Command: ${chalk.cyan(`codemie install ${agent.name}`)}`);
            console.log(`    Status: ${status}`);
            console.log(`    ${chalk.gray(agent.description)}`);
            console.log();
          }

          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie install <agent>') + ' to install an agent');
          console.log();
          return;
        }

        const agent = AgentRegistry.getAgent(agentName);

        if (!agent) {
          throw new AgentInstallationError(
            agentName,
            `Unknown agent. Use 'codemie list' to see available agents.`
          );
        }

        // Check if already installed
        if (await agent.isInstalled()) {
          logger.info(`${agent.displayName} is already installed`);
          return;
        }

        const spinner = ora(`Installing ${agent.displayName}...`).start();

        try {
          // Show tips during installation
          const installPromise = agent.install();
          const stopTips = asyncTipDisplay.showDuring(installPromise);

          await installPromise;
          stopTips();

          spinner.succeed(`${agent.displayName} installed successfully`);

          // Show how to run the newly installed agent
          console.log();
          console.log(chalk.cyan('💡 Next steps:'));
          console.log(chalk.white(`   Run the agent with:`), chalk.blueBright(`codemie run ${agentName}`));
          console.log();
        } catch (error: unknown) {
          spinner.fail(`Failed to install ${agent.displayName}`);
          throw error;
        }
      } catch (error: unknown) {
        logger.error('Installation failed:', error);
        process.exit(1);
      }
    });

  return command;
}
