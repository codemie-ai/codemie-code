import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { AgentInstallationError, getErrorMessage } from '../../utils/errors.js';
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
            const versionStr = version ? chalk.white(` (${version})`) : '';

            console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
            console.log(`    Command: ${chalk.cyan(`codemie install ${agent.name}`)}`);
            console.log(`    Status: ${status}`);
            console.log(`    ${chalk.white(agent.description)}`);
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
          console.log(chalk.blueBright(`${agent.displayName} is already installed`));
          return;
        }

        const spinner = ora(`Installing ${agent.displayName}...`).start();

        try {
          await agent.install();
          spinner.succeed(`${agent.displayName} installed successfully`);

          // Show how to run the newly installed agent
          console.log();
          console.log(chalk.cyan('💡 Next steps:'));
          // Handle special case where agent name already includes 'codemie-' prefix
          const command = agent.name.startsWith('codemie-') ? agent.name : `codemie-${agent.name}`;
          console.log(chalk.white(`   Interactive mode:`), chalk.blueBright(command));
          console.log(chalk.white(`   Single task:`), chalk.blueBright(`${command} --task "your task"`));
          console.log();
        } catch (error: unknown) {
          spinner.fail(`Failed to install ${agent.displayName}`);
          throw error;
        }
      } catch (error: unknown) {
        // Handle AgentInstallationError with helpful suggestions
        if (error instanceof AgentInstallationError) {
          console.error(chalk.red(`✗ ${getErrorMessage(error)}`));
          console.log();
          console.log(chalk.cyan('💡 Available agents:'));
          const allAgents = AgentRegistry.getAllAgents();
          for (const agent of allAgents) {
            console.log(chalk.white(`   • ${agent.name}`));
          }
          console.log();
          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie install') + ' to see all agents');
          console.log();
          process.exit(1);
        }

        // For other errors, show simple message
        console.error(chalk.red(`✗ Installation failed: ${getErrorMessage(error)}`));
        process.exit(1);
      }
    });

  return command;
}
