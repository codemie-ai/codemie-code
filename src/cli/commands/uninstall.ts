import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { logger } from '../../utils/logger.js';
import { AgentNotFoundError, getErrorMessage } from '../../utils/errors.js';
import ora from 'ora';
import chalk from 'chalk';

export function createUninstallCommand(): Command {
  const command = new Command('uninstall');

  command
    .description('Uninstall an AI agent or framework')
    .argument('[name]', 'Agent or framework name to uninstall (run without argument to see installed)')
    .action(async (name?: string) => {
      try {
        // If no name provided, show installed agents and frameworks
        if (!name) {
          const installedAgents = await AgentRegistry.getInstalledAgents();

          // Get installed frameworks
          const { FrameworkRegistry } = await import('../../frameworks/index.js');
          const frameworks = FrameworkRegistry.getAllFrameworks();
          const installedFrameworkChecks = await Promise.all(
            frameworks.map(async (fw) => ({
              framework: fw,
              installed: await fw.isInstalled()
            }))
          );
          const installedFrameworks = installedFrameworkChecks
            .filter(({ installed }) => installed)
            .map(({ framework }) => framework);

          if (installedAgents.length === 0 && installedFrameworks.length === 0) {
            console.log();
            console.log(chalk.yellow('No agents or frameworks are currently installed.'));
            console.log();
            console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie list') + ' to see all available items');
            console.log();
            return;
          }

          console.log();

          if (installedAgents.length > 0) {
            console.log(chalk.bold('📦 Installed Agents:\n'));

            for (const agent of installedAgents) {
              const version = await agent.getVersion();
              const versionStr = version ? chalk.white(` (${version})`) : '';

              console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
              console.log(`    Command: ${chalk.cyan(`codemie uninstall ${agent.name}`)}`);
              console.log(`    ${chalk.white(agent.description)}`);
              console.log();
            }
          }

          if (installedFrameworks.length > 0) {
            console.log(chalk.bold('🛠️  Installed Frameworks:\n'));

            for (const framework of installedFrameworks) {
              const version = await framework.getVersion();
              const versionStr = version ? chalk.white(` v${version}`) : '';

              console.log(chalk.bold(`  ${framework.metadata.displayName}`) + versionStr);
              console.log(`    Command: ${chalk.cyan(`codemie uninstall ${framework.metadata.name}`)}`);
              console.log(`    ${chalk.white(framework.metadata.description)}`);
              console.log();
            }
          }

          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie uninstall <name>') + ' to uninstall');
          console.log();
          return;
        }

        // Try agent first
        const agent = AgentRegistry.getAgent(name);

        if (agent) {
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
          return;
        }

        // Try framework
        const { FrameworkRegistry } = await import('../../frameworks/index.js');
        const framework = FrameworkRegistry.getFramework(name);

        if (framework) {
          // Check if installed
          if (!(await framework.isInstalled())) {
            logger.info(`${framework.metadata.displayName} is not installed`);
            return;
          }

          const spinner = ora(`Uninstalling ${framework.metadata.displayName}...`).start();

          try {
            await framework.uninstall();
            spinner.succeed(`${framework.metadata.displayName} uninstalled successfully`);
          } catch (error: unknown) {
            spinner.fail(`Failed to uninstall ${framework.metadata.displayName}`);
            throw error;
          }
          return;
        }

        // Neither agent nor framework found
        throw new AgentNotFoundError(name);
      } catch (error: unknown) {
        // Handle AgentNotFoundError with helpful suggestions
        if (error instanceof AgentNotFoundError) {
          console.error(chalk.red(`✗ ${getErrorMessage(error)}`));
          console.log();
          console.log(chalk.cyan('💡 Available agents and frameworks:'));
          const allAgents = AgentRegistry.getAllAgents();
          for (const agent of allAgents) {
            console.log(chalk.white(`   • ${agent.name}`));
          }

          const { FrameworkRegistry } = await import('../../frameworks/index.js');
          const frameworks = FrameworkRegistry.getAllFrameworks();
          for (const framework of frameworks) {
            console.log(chalk.white(`   • ${framework.metadata.name}`));
          }

          console.log();
          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie uninstall') + ' to see installed items');
          console.log();
          process.exit(1);
        }

        // For other errors, show simple message
        console.error(chalk.red(`✗ Uninstallation failed: ${getErrorMessage(error)}`));
        process.exit(1);
      }
    });

  return command;
}
