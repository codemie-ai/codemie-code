import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { AgentInstallationError, getErrorMessage } from '../../utils/errors.js';
import ora from 'ora';
import chalk from 'chalk';

export function createInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install an external AI coding agent or development framework')
    .argument('[name]', 'Agent or framework name to install (run without argument to see available)')
    .action(async (name?: string) => {
      try {
        // If no name provided, show available agents and frameworks
        if (!name) {
          const agents = AgentRegistry.getAllAgents();

          console.log();
          console.log(chalk.bold('📦 Available Agents:\n'));

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

          // Show frameworks
          const { FrameworkRegistry } = await import('../../frameworks/index.js');
          const frameworks = FrameworkRegistry.getAllFrameworks();

          if (frameworks.length > 0) {
            console.log(chalk.bold('🛠️  Available Frameworks:\n'));

            for (const framework of frameworks) {
              const installed = await framework.isInstalled();
              const status = installed ? chalk.green('✓ installed') : chalk.yellow('○ not installed');
              const version = installed ? await framework.getVersion() : null;
              const versionStr = version ? chalk.white(` (${version})`) : '';

              console.log(chalk.bold(`  ${framework.metadata.displayName}`) + versionStr);
              console.log(`    Command: ${chalk.cyan(`codemie install ${framework.metadata.name}`)}`);
              console.log(`    Status: ${status}`);
              console.log(`    ${chalk.white(framework.metadata.description)}`);
              if (framework.metadata.docsUrl) {
                console.log(chalk.gray(`    Docs: ${framework.metadata.docsUrl}`));
              }
              console.log();
            }
          }

          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie install <name>') + ' to install an agent or framework');
          console.log();
          return;
        }

        // Try agent first
        const agent = AgentRegistry.getAgent(name);

        if (agent) {
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
          return;
        }

        // Try framework
        const { FrameworkRegistry } = await import('../../frameworks/index.js');
        const framework = FrameworkRegistry.getFramework(name);

        if (framework) {
          // Check if already installed
          if (await framework.isInstalled()) {
            console.log(chalk.blueBright(`${framework.metadata.displayName} is already installed`));
            return;
          }

          const spinner = ora(`Installing ${framework.metadata.displayName}...`).start();

          try {
            await framework.install();
            spinner.succeed(`${framework.metadata.displayName} installed successfully`);

            // Show how to initialize the framework
            console.log();
            console.log(chalk.cyan('💡 Next steps:'));
            console.log(chalk.white(`   Initialize in project:`), chalk.blueBright(`codemie-<agent> init ${framework.metadata.name}`));
            console.log(chalk.white(`   List frameworks:`), chalk.blueBright(`codemie-<agent> init --list`));
            console.log();
          } catch (error: unknown) {
            spinner.fail(`Failed to install ${framework.metadata.displayName}`);
            throw error;
          }
          return;
        }

        // Neither agent nor framework found
        throw new AgentInstallationError(
          name,
          `Unknown agent or framework. Use 'codemie install' to see available options.`
        );
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
