import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { AgentInstallationError, getErrorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import ora from 'ora';
import chalk from 'chalk';

export function createInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install an external AI coding agent or development framework')
    .argument('[name]', 'Agent or framework name to install (run without argument to see available)')
    .argument('[version]', 'Optional: specific version to install (e.g., 2.0.30)')
    .option('--supported', 'Install the latest supported version tested with CodeMie')
    .option('--verbose', 'Show detailed installation logs for troubleshooting')
    .action(async (name?: string, version?: string, options?: { supported?: boolean; verbose?: boolean }) => {
      // Enable debug mode if --verbose flag is set
      if (options?.verbose) {
        process.env.CODEMIE_DEBUG = 'true';
        logger.debug('Verbose mode enabled');
        console.log(chalk.gray('🔍 Verbose mode enabled - showing detailed logs\n'));
      }
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
          // Determine which version to install
          let versionToInstall: string | undefined;
          let actualVersionToInstall: string | undefined; // Resolved version for display

          // Priority: --supported flag > version argument > 'supported' (default for Claude) > undefined (latest)
          if (options?.supported) {
            versionToInstall = 'supported';
            // Resolve 'supported' to actual version for display and comparison
            if (agent.checkVersionCompatibility) {
              const compat = await agent.checkVersionCompatibility();
              actualVersionToInstall = compat.supportedVersion;
            }
          } else if (version) {
            versionToInstall = version;
            actualVersionToInstall = version;
          } else if (agent.name === 'claude' && agent.checkVersionCompatibility) {
            // Default to supported version for Claude (native installer)
            versionToInstall = 'supported';
            const compat = await agent.checkVersionCompatibility();
            actualVersionToInstall = compat.supportedVersion;
          }

          // Check if already installed with matching version
          if (await agent.isInstalled()) {
            const installedVersion = await agent.getVersion();

            // If requesting specific version, check if it matches
            if (actualVersionToInstall && installedVersion) {
              if (installedVersion === actualVersionToInstall) {
                console.log(chalk.blueBright(`${agent.displayName} v${installedVersion} is already installed`));
                return;
              } else {
                // Different version installed, ask to reinstall
                const versionDisplay = options?.supported ? `${actualVersionToInstall} (supported)` : actualVersionToInstall;
                console.log(chalk.yellow(`${agent.displayName} v${installedVersion} is already installed (requested: ${versionDisplay})`));
                const inquirer = (await import('inquirer')).default;
                const { confirm } = await inquirer.prompt([
                  {
                    type: 'confirm',
                    name: 'confirm',
                    message: `Reinstall with version ${versionDisplay}?`,
                    default: false,
                  },
                ]);

                if (!confirm) {
                  console.log(chalk.gray('Installation cancelled'));
                  return;
                }
              }
            } else if (!actualVersionToInstall) {
              // No specific version requested, already installed
              console.log(chalk.blueBright(`${agent.displayName} is already installed`));
              return;
            }
          }

          // Build installation message
          const isUsingSupported = versionToInstall === 'supported';
          const versionMessage = isUsingSupported && actualVersionToInstall
            ? ` v${actualVersionToInstall} (supported version)`
            : actualVersionToInstall
            ? ` v${actualVersionToInstall}`
            : '';

          const spinner = ora(`Installing ${agent.displayName}${versionMessage}...`).start();

          try {
            // Use installVersion if available and version specified
            if (versionToInstall && agent.installVersion) {
              await agent.installVersion(versionToInstall);
            } else {
              await agent.install();
            }

            // Get installed version for success message
            const installedVersion = await agent.getVersion();
            const installedVersionStr = installedVersion ? ` v${installedVersion}` : '';

            spinner.succeed(`${agent.displayName}${installedVersionStr} installed successfully`);

            // Show warning if installed version is newer than supported
            if (installedVersion && agent.checkVersionCompatibility) {
              const compat = await agent.checkVersionCompatibility();
              if (compat.isNewer) {
                console.log();
                console.log(chalk.yellow(`⚠️  Note: This version (${installedVersion}) is newer than the supported version (${compat.supportedVersion}).`));
                console.log(chalk.yellow(`   You may encounter compatibility issues with the CodeMie backend.`));
                console.log(chalk.yellow(`   To install the supported version, run:`), chalk.blueBright(`codemie install ${agent.name} --supported`));
              }
            }

            // Show how to run the newly installed agent
            console.log();

            // Check for custom post-install hints (for ACP adapters, IDE integrations, etc.)
            const metadata = (agent as any).metadata;
            if (metadata?.postInstallHints && metadata.postInstallHints.length > 0) {
              console.log(chalk.cyan('💡 Next steps:'));
              for (const line of metadata.postInstallHints) {
                console.log(chalk.white(`   ${line}`));
              }
              console.log();
            } else {
              // Default hints for regular agents
              console.log(chalk.cyan('💡 Next steps:'));
              // Handle special case where agent name already includes 'codemie-' prefix
              const command = agent.name.startsWith('codemie-') ? agent.name : `codemie-${agent.name}`;
              console.log(chalk.white(`   Interactive mode:`), chalk.blueBright(command));
              console.log(chalk.white(`   Single task:`), chalk.blueBright(`${command} --task "your task"`));
              console.log();
            }
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
