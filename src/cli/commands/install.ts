import { Command } from 'commander';
import { AgentRegistry } from '@/agents/registry.js';
import { getAgentInstallCommand, getAgentLauncherCommand, getUserFacingAgentName, resolveAgentAlias } from '@/agents/core/agent-aliases.js';
import { AgentInstallationError, getErrorMessage } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { restoreCliBinLink } from '@/utils/cli-bin.js';
import type { AgentInstallationOptions } from '@/agents/core/types.js';
import {
  STATUSLINE_NAME,
  STATUSLINE_DISPLAY_NAME,
  STATUSLINE_DESCRIPTION,
  installStatusline,
  isStatuslineInstalled,
} from '@/agents/plugins/claude/statusline-installer.js';
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
    .option('--sounds', 'Enable sounds (plays audio on hook events)')
    .action(async (name?: string, version?: string, options?: AgentInstallationOptions & { supported?: boolean }) => {
      // Enable debug mode if --verbose flag is set
      if (options?.verbose) {
        process.env.CODEMIE_DEBUG = 'true';
        logger.debug('Verbose mode enabled');
        console.log(chalk.gray('🔍 Verbose mode enabled - showing detailed logs\n'));
      }
      try {
        // If no name provided, show available agents and frameworks
        if (!name) {
          const agents = AgentRegistry.getManageableAgents();

          console.log();
          console.log(chalk.bold('📦 Available Agents:\n'));

          for (const agent of agents) {
            const installed = await agent.isInstalled();
            const status = installed ? chalk.green('✓ installed') : chalk.yellow('○ not installed');
            const version = installed ? await agent.getVersion() : null;
            const versionStr = version ? chalk.white(` (${version})`) : '';

            console.log(chalk.bold(`  ${agent.displayName}`) + versionStr);
            console.log(`    Command: ${chalk.cyan(getAgentInstallCommand(agent.name))}`);
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

          console.log(chalk.bold('✨ Add-ons:\n'));
          const statuslineStatus = isStatuslineInstalled() ? chalk.green('✓ installed') : chalk.yellow('○ not installed');
          console.log(chalk.bold(`  ${STATUSLINE_DISPLAY_NAME}`));
          console.log(`    Command: ${chalk.cyan(`codemie install ${STATUSLINE_NAME}`)}`);
          console.log(`    Status: ${statuslineStatus}`);
          console.log(`    ${chalk.white(STATUSLINE_DESCRIPTION)}`);
          console.log();
          console.log(chalk.bold(`  Halyk FCC (Free Claude Code)`));
          console.log(`    Command: ${chalk.cyan('codemie install fcc')}`);
          console.log(`    ${chalk.white('Halyk Bank internal Claude Code via LiteLLM gateway')}`);
          console.log();

          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie install <name>') + ' to install an agent or framework');
          console.log();
          return;
        }

        // Try agent first
        const canonicalName = resolveAgentAlias(name) || name;
        const agent = AgentRegistry.getAgent(canonicalName);

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
          } else if ((agent.name === 'claude' || agent.name === 'codex') && agent.checkVersionCompatibility) {
            // Default to supported version for agents whose backend compatibility is version-sensitive
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

                // Run additional installation steps (e.g., sounds)
                if (agent.additionalInstallation) {
                  await agent.additionalInstallation(options);
                }

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

              // Run additional installation steps (e.g., sounds)
              if (agent.additionalInstallation) {
                await agent.additionalInstallation(options);
              }

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
            let installedVersion: string | null = null;
            if (versionToInstall && agent.installVersion) {
              installedVersion = await agent.installVersion(versionToInstall);
            } else {
              await agent.install();
            }

            // Restore CLI bin link if overwritten by agent package
            await restoreCliBinLink();

            // Use version returned by installVersion(); fall back to getVersion() when null
            const displayVersion = installedVersion ?? await agent.getVersion();
            const installedVersionStr = displayVersion ? ` v${displayVersion}` : '';

            // Sanity-check: if verification found a version that doesn't match what was requested,
            // the installer ran but PATH still resolves the old binary (common on Windows after install).
            // Report honestly instead of asserting the wrong version as success.
            const requestedVersion = actualVersionToInstall;
            const versionMismatch =
              requestedVersion &&
              /^\d+\.\d+\.\d+/.test(requestedVersion) &&
              displayVersion &&
              displayVersion !== requestedVersion;

            if (versionMismatch) {
              spinner.warn(
                `${agent.displayName} installation completed, but the detected version` +
                ` (v${displayVersion}) does not match the requested version (v${requestedVersion}).` +
                ` A terminal restart may be required.`,
              );
            } else {
              spinner.succeed(`${agent.displayName}${installedVersionStr} installed successfully`);
            }

            // Run additional installation steps (e.g., sounds)
            if (agent.additionalInstallation) {
              await agent.additionalInstallation(options);
            }

            // Show warning if installed version is newer than supported
            if (displayVersion && agent.checkVersionCompatibility) {
              const compat = await agent.checkVersionCompatibility();
              if (compat.isNewer) {
                console.log();
                console.log(chalk.yellow(`⚠️  Note: This version (${displayVersion}) is newer than the supported version (${compat.supportedVersion}).`));
                console.log(chalk.yellow(`   You may encounter compatibility issues with the CodeMie backend.`));
                console.log(chalk.yellow(`   To install the supported version, run:`), chalk.blueBright(`${getAgentInstallCommand(agent.name)} --supported`));
              }
            }

            // Show how to run the newly installed agent
            console.log();

            // Check for custom post-install hints (for ACP adapters, IDE integrations, etc.)
            const metadata = agent.metadata;
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
              const command = getAgentLauncherCommand(agent.name);
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

        if (name === STATUSLINE_NAME) {
          const alreadyInstalled = isStatuslineInstalled();
          const spinnerLabel = alreadyInstalled
            ? `Updating ${STATUSLINE_DISPLAY_NAME}...`
            : `Installing ${STATUSLINE_DISPLAY_NAME}...`;
          const spinner = ora(spinnerLabel).start();

          try {
            const { scriptPath } = await installStatusline();
            const successMsg = alreadyInstalled
              ? `${STATUSLINE_DISPLAY_NAME} updated`
              : `${STATUSLINE_DISPLAY_NAME} installed`;
            spinner.succeed(successMsg);
            console.log();
            console.log(chalk.cyan('💡 The statusline appears at the bottom of every Claude Code session'));
            console.log(chalk.white(`   ${STATUSLINE_DESCRIPTION}`));
            console.log(chalk.gray(`   Script: ${scriptPath}`));
            console.log(chalk.gray('   Budget is auto-detected from your authenticated CodeMie profile — no setup needed'));
            console.log();
          } catch (error: unknown) {
            spinner.fail(`Failed to install ${STATUSLINE_DISPLAY_NAME}`);
            throw error;
          }
          return;
        }

        // FCC (Free Claude Code) - Halyk Bank corporate deployment
        if (name === 'fcc' || name === 'halyk-fcc') {
          await handleFCCInstall(options || {});
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
          const allAgents = AgentRegistry.getManageableAgents();
          for (const agent of allAgents) {
            console.log(chalk.white(`   • ${getUserFacingAgentName(agent.name)}`));
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

/**
 * Install FCC (Free Claude Code) for Halyk Bank corporate users
 *
 * FCC is Halyk Bank's internal Claude Code deployment that routes requests
 * through the corporate LiteLLM gateway with SSO authentication.
 *
 * This function:
 * 1. Checks for GitLab access (spm-api group)
 * 2. Installs uv (Python package manager) if needed
 * 3. Checks/installs Node.js 18+ if needed
 * 4. Installs Claude Code CLI via npm
 * 5. Installs FCC via uv tool install
 * 6. Prompts for FCC LiteLLM API key
 * 7. Creates ~/.fcc/.env configuration
 */
async function handleFCCInstall(options: { verbose?: boolean; supported?: boolean }): Promise<void> {
  const { exec } = await import('../../utils/processes.js');
  const { logger } = await import('../../utils/logger.js');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { promises: fs } = await import('node:fs');
  const inquirer = (await import('inquirer')).default;

  console.log();
  console.log(chalk.bold.cyan('🏦 Halyk FCC (Free Claude Code) Installation\n'));
  console.log(chalk.dim('  FCC is Halyk Bank\'s internal Claude Code deployment via LiteLLM gateway.\n'));

  // Step 1: Check GitLab access
  console.log(chalk.white('Step 1/6: Checking GitLab access...'));
  const { confirmGitLab } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmGitLab',
      message: 'Do you have access to the spm-api group on GitLab (gitlab.halykbank.nb)?',
      default: true,
    },
  ]);

  if (!confirmGitLab) {
    console.log(chalk.yellow('\n⚠️  GitLab access is required to install FCC.'));
    console.log(chalk.white('   Request access from:'));
    console.log(chalk.cyan('   • Дамир Бахтияров'));
    console.log(chalk.cyan('   • Алышер Сағидолдаев\n'));
    process.exit(1);
  }
  console.log(chalk.green('✓ GitLab access confirmed\n'));

  // Step 2: Check/install uv
  console.log(chalk.white('Step 2/6: Checking uv (Python package manager)...'));
  let uvInstalled = false;
  try {
    await exec('uv --version');
    console.log(chalk.green('✓ uv is already installed\n'));
    uvInstalled = true;
  } catch {
    console.log(chalk.yellow('○ uv not found\n'));
  }

  if (!uvInstalled) {
    const { installUv } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'installUv',
        message: 'Install uv via winget?',
        default: true,
      },
    ]);

    if (installUv) {
      const spinner = ora('Installing uv...').start();
      try {
        await exec('winget install --id astral-sh.uv --silent --accept-package-agreements --accept-source-agreements');
        spinner.succeed('uv installed successfully');
        console.log(chalk.dim('  Note: You may need to restart your terminal for uv to be available.\n'));
      } catch (error: unknown) {
        spinner.fail('Failed to install uv');
        console.log(chalk.yellow('  Install manually from: https://github.com/astral-sh/uv\n'));
        logger.debug('uv installation failed', { error });
      }
    }
  }

  // Step 3: Check/install Node.js
  console.log(chalk.white('Step 3/6: Checking Node.js (requires v18+)...'));
  let nodeInstalled = false;
  try {
    const nodeResult = await exec('node -v');
    const nodeVersion = nodeResult.stdout.trim().replace('v', '');
    const major = parseInt(nodeVersion.split('.')[0], 10);
    if (major >= 18) {
      console.log(chalk.green(`✓ Node.js ${nodeVersion} is installed\n`));
      nodeInstalled = true;
    } else {
      console.log(chalk.yellow(`○ Node.js ${nodeVersion} is too old (requires 18+)\n`));
    }
  } catch {
    console.log(chalk.yellow('○ Node.js not found\n'));
  }

  if (!nodeInstalled) {
    const { installNode } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'installNode',
        message: 'Install Node.js LTS via winget?',
        default: true,
      },
    ]);

    if (installNode) {
      const spinner = ora('Installing Node.js LTS...').start();
      try {
        await exec('winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements');
        spinner.succeed('Node.js installed successfully');
        console.log(chalk.dim('  Note: You may need to restart your terminal for node to be available.\n'));
      } catch (error: unknown) {
        spinner.fail('Failed to install Node.js');
        console.log(chalk.yellow('  Install manually from: https://nodejs.org/\n'));
        logger.debug('Node.js installation failed', { error });
      }
    }
  }

  // Step 4: Install Claude Code CLI
  console.log(chalk.white('Step 4/6: Installing Claude Code CLI...'));
  let claudeCliInstalled = false;
  try {
    await exec('claude --version');
    console.log(chalk.green('✓ Claude Code CLI is already installed\n'));
    claudeCliInstalled = true;
  } catch {
    console.log(chalk.yellow('○ Claude Code CLI not found\n'));
  }

  if (!claudeCliInstalled) {
    const { installClaudeCli } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'installClaudeCli',
        message: 'Install Claude Code CLI via npm?',
        default: true,
      },
    ]);

    if (installClaudeCli) {
      const spinner = ora('Installing Claude Code CLI...').start();
      try {
        // Configure npm proxy if needed
        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        if (proxyUrl) {
          logger.debug('Configuring npm proxy', { proxyUrl });
          await exec(`npm config set proxy ${proxyUrl}`);
          await exec(`npm config set https-proxy ${proxyUrl}`);
        }
        await exec('npm install -g @anthropic-ai/claude-code');
        spinner.succeed('Claude Code CLI installed successfully\n');
      } catch (error: unknown) {
        spinner.fail('Failed to install Claude Code CLI');
        console.log(chalk.yellow('  Check proxy settings and npm configuration.\n'));
        logger.debug('Claude Code CLI installation failed', { error });
      }
    }
  }

  // Step 5: Install FCC - SKIPPED
  // FCC installation from GitLab requires corporate network access.
  // Users should install FCC manually when connected to corporate network.
  console.log(chalk.white('Step 5/7: Installing FCC from GitLab...'));
  console.log(chalk.yellow('⊘ Skipped: Requires corporate network access\n'));
  console.log(chalk.dim('  To install FCC manually when in the office:\n'));
  console.log(chalk.blueBright('  uv tool install git+https://gitlab.halykbank.nb/spm-api/genai/localclaude.git\n'));

  // Step 6: Get FCC LiteLLM API key
  console.log(chalk.white('Step 6/6: Configuring FCC API key...'));
  const { fccLiteLLMKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'fccLiteLLMKey',
      message: 'Enter your FCC LiteLLM API key:',
      validate: (input: string) => {
        if (!input.trim()) return 'API key is required';
        return true;
      },
    },
  ]);

  // Step 6: Create configuration
  console.log(chalk.white('Step 6/6: Creating FCC configuration...'));
  const fccDir = join(homedir(), '.fcc');
  const envPath = join(fccDir, '.env');

  try {
    await fs.mkdir(fccDir, { recursive: true });

    const serverUrl = process.env.FCC_SERVER_URL || 'https://fcc-server-spmng.apps.spm3-dev-rz.halykbank.nb';
    const authToken = 'freecc';

    const envContent = `# Free Claude Code Configuration
# Generated: ${new Date().toISOString()}

FCC_SERVER_URL=${serverUrl}
ANTHROPIC_AUTH_TOKEN=${authToken}
FCC_LITELLM_KEY=${fccLiteLLMKey}
`;

    await fs.writeFile(envPath, envContent, 'utf-8');
    console.log(chalk.green(`✓ FCC configuration created at ${envPath}\n`));
  } catch (error: unknown) {
    console.log(chalk.yellow(`⚠️  Failed to create configuration file: ${error instanceof Error ? error.message : String(error)}\n`));
  }

  // Installation complete
  console.log();
  console.log(chalk.bold.green('✅ FCC setup completed!\n'));
  console.log(chalk.cyan('💡 Next steps:\n'));
  console.log(chalk.white('   1. When connected to corporate network, install FCC:'));
  console.log(chalk.blueBright('      uv tool install git+https://gitlab.halykbank.nb/spm-api/genai/localclaude.git'));
  console.log();
  console.log(chalk.white('   2. Run FCC Claude (after FCC installation):'));
  console.log(chalk.blueBright('      fcc-claude'));
  console.log();
  console.log(chalk.white('   3. Or use with CodeMie CLI:'));
  console.log(chalk.blueBright('      codemie setup --provider fcc'));
  console.log();
  console.log(chalk.dim('   For detailed usage instructions, see: docs/FCC-SETUP.md\n'));
  console.log();
}
