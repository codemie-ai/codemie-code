import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { AgentAdapter } from '../../agents/core/types.js';
import { AgentNotFoundError, AgentInstallationError, getErrorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import * as npm from '../../utils/processes.js';
import { restoreCliBinLink } from '../../utils/cli-bin.js';
import { compareVersions, isValidSemanticVersion } from '../../utils/version-utils.js';
import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';

/**
 * Result of checking a single agent for updates
 */
interface UpdateCheckResult {
  /** Agent internal name (e.g., 'claude') */
  name: string;
  /** Display name (e.g., 'Claude Code') */
  displayName: string;
  /** Currently installed version */
  currentVersion: string;
  /** Latest available version from npm */
  latestVersion: string;
  /** True if latest > current */
  hasUpdate: boolean;
  /** npm package name for installation */
  npmPackage: string;
}

/**
 * Extract semver version from a string that may contain extra text
 * e.g., "2.0.76 (Claude Code)" -> "2.0.76"
 *       "v1.2.3-beta" -> "1.2.3"
 */
function extractVersion(versionString: string): string | null {
  const match = versionString.match(/v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Check a single agent for available updates
 */
async function checkAgentForUpdate(agent: AgentAdapter): Promise<UpdateCheckResult | null> {
  // Check if installed
  const installed = await agent.isInstalled();
  if (!installed) {
    return null;
  }

  // Get current version
  const currentVersion = await agent.getVersion();
  if (!currentVersion) {
    return null;
  }

  // Special handling for Claude (uses native installer, not npm)
  if (agent.name === 'claude' && agent.checkVersionCompatibility) {
    const compat = await agent.checkVersionCompatibility();
    const supportedVersion = compat.supportedVersion;
    const cleanCurrentVersion = extractVersion(currentVersion) || currentVersion;

    // Validate versions before comparing
    const cleanSupported = extractVersion(supportedVersion);
    if (!cleanSupported) return null;

    // Check if update available (current < supported)
    const hasUpdate = compareVersions(cleanCurrentVersion, cleanSupported) < 0;

    return {
      name: agent.name,
      displayName: agent.displayName,
      currentVersion: cleanCurrentVersion,
      latestVersion: cleanSupported,
      hasUpdate,
      npmPackage: '@anthropic-ai/claude-code' // Keep for compatibility, won't be used
    };
  }

  // Special handling for built-in agent (codemie-code) — uses CLI package version
  if (agent.metadata.isBuiltIn) {
    const { getCurrentCliVersion } = await import('../../utils/cli-updater.js');
    const cliVersion = await getCurrentCliVersion();
    if (!cliVersion) return null;

    const latestVersion = await npm.getLatestVersion('@codemieai/code');
    if (!latestVersion) return null;

    // Validate both versions before comparing
    if (!isValidSemanticVersion(cliVersion) || !isValidSemanticVersion(latestVersion)) {
      logger.debug('Invalid version format for built-in agent', { cliVersion, latestVersion });
      return null;
    }

    const hasUpdate = compareVersions(cliVersion, latestVersion) < 0;

    return {
      name: agent.name,
      displayName: agent.displayName,
      currentVersion: cliVersion,
      latestVersion,
      hasUpdate,
      npmPackage: '@codemieai/code',
    };
  }

  // Standard npm-based agents
  const npmPackage = agent.metadata.npmPackage;
  if (!npmPackage) {
    return null;
  }

  // Get latest version from npm
  const latestVersion = await npm.getLatestVersion(npmPackage);
  if (!latestVersion) {
    return null;
  }

  // Extract clean versions for comparison and display
  const cleanCurrentVersion = extractVersion(currentVersion) || currentVersion;
  const cleanLatestVersion = extractVersion(latestVersion) || latestVersion;

  // Validate versions before comparing (canonical compareVersions throws on invalid input)
  if (!isValidSemanticVersion(cleanCurrentVersion) || !isValidSemanticVersion(cleanLatestVersion)) {
    logger.debug('Invalid version format, skipping update check', { cleanCurrentVersion, cleanLatestVersion });
    return null;
  }

  // Compare versions
  const hasUpdate = compareVersions(cleanCurrentVersion, cleanLatestVersion) < 0;

  return {
    name: agent.name,
    displayName: agent.displayName,
    currentVersion: cleanCurrentVersion,
    latestVersion: cleanLatestVersion,
    hasUpdate,
    npmPackage
  };
}

/**
 * Check all installed agents for updates
 */
async function checkAllAgentsForUpdates(): Promise<UpdateCheckResult[]> {
  const agents = AgentRegistry.getAllAgents();
  const results: UpdateCheckResult[] = [];

  // Check all agents in parallel
  const checks = await Promise.all(
    agents.map(agent => checkAgentForUpdate(agent))
  );

  for (const result of checks) {
    if (result) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Display update check results
 */
function displayUpdateStatus(results: UpdateCheckResult[]): void {
  console.log();
  console.log(chalk.bold('📦 Agent Update Status:\n'));

  for (const result of results) {
    console.log(chalk.bold(`  ${result.displayName}`));
    console.log(`    Current: ${result.currentVersion}`);

    if (result.hasUpdate) {
      console.log(`    Latest:  ${chalk.green(result.latestVersion)} ${chalk.yellow('(update available)')}`);
    } else {
      console.log(`    Latest:  ${result.latestVersion} ${chalk.green('(up to date)')}`);
    }
    console.log();
  }
}

/**
 * Interactive selection of agents to update
 */
async function promptAgentSelection(outdated: UpdateCheckResult[]): Promise<string[]> {
  const choices = outdated.map(result => ({
    name: `${result.displayName} (${result.currentVersion} → ${chalk.green(result.latestVersion)})`,
    value: result.name,
    checked: true // Pre-select all by default
  }));

  const { selectedAgents } = await inquirer.prompt<{ selectedAgents: string[] }>([
    {
      type: 'checkbox',
      name: 'selectedAgents',
      message: 'Select agents to update:',
      choices,
      pageSize: 10
    }
  ]);

  return selectedAgents;
}

/**
 * Update a single agent
 */
async function updateAgent(agent: AgentAdapter, latestVersion: string): Promise<void> {
  // Special handling for Claude (uses native installer)
  if (agent.name === 'claude' && agent.installVersion) {
    await agent.installVersion('supported');
    return;
  }

  // Special handling for built-in agent — update the CLI package
  if (agent.metadata.isBuiltIn) {
    await npm.installGlobal('@codemieai/code', { version: latestVersion, force: true });
    return;
  }

  // Standard npm-based agents
  const npmPackage = agent.metadata.npmPackage;
  if (!npmPackage) {
    throw new AgentInstallationError(
      agent.name,
      `${agent.displayName} cannot be updated (no npm package configured)`
    );
  }

  // Use force: true to avoid ENOTEMPTY errors when updating global packages
  await npm.installGlobal(npmPackage, { version: latestVersion, force: true });
}

export function createUpdateCommand(): Command {
  const command = new Command('update');

  command
    .description('Update installed AI coding agents')
    .argument('[name]', 'Agent name to update (run without argument for interactive selection)')
    .option('-c, --check', 'Check for available updates without installing')
    .option('--verbose', 'Show detailed update logs for troubleshooting')
    .action(async (name?: string, options?: { check?: boolean; verbose?: boolean }) => {
      try {
        // Enable debug mode if --verbose flag is set
        if (options?.verbose) {
          process.env.CODEMIE_DEBUG = 'true';
          logger.debug('Verbose mode enabled');
          console.log(chalk.gray('🔍 Verbose mode enabled - showing detailed logs\n'));
        }

        const checkOnly = options?.check ?? false;

        // Case 1: Update specific agent
        if (name) {
          const agent = AgentRegistry.getAgent(name);

          if (!agent) {
            throw new AgentNotFoundError(name);
          }

          // Built-in agents are updated via 'codemie self-update' (CLI package update)
          if (agent.metadata.isBuiltIn) {
            console.log(chalk.blueBright(`${agent.displayName} is a built-in agent and cannot be updated externally`));
            return;
          }

          // Check if installed
          const installed = await agent.isInstalled();
          if (!installed) {
            console.log(chalk.yellow(`${agent.displayName} is not installed`));
            console.log(chalk.cyan(`💡 Install it with: codemie install ${agent.name}`));
            return;
          }

          const spinner = ora(`Checking ${agent.displayName} for updates...`).start();

          const result = await checkAgentForUpdate(agent);

          if (!result) {
            spinner.warn(`Could not check ${agent.displayName} for updates`);
            return;
          }

          if (!result.hasUpdate) {
            // For Claude, clarify it's the latest supported version (not absolute latest)
            if (agent.name === 'claude') {
              spinner.succeed(`${agent.displayName} is already up to date with latest verified version by CodeMie (${result.currentVersion})`);
            } else {
              spinner.succeed(`${agent.displayName} is already up to date (${result.currentVersion})`);
            }
            return;
          }

          spinner.succeed(`Update available: ${result.currentVersion} → ${chalk.green(result.latestVersion)}`);

          // Check-only mode: don't install
          if (checkOnly) {
            console.log();
            console.log(chalk.cyan(`💡 Run 'codemie update ${name}' to install the update`));
            return;
          }

          // Perform update
          const updateSpinner = ora(`Updating ${agent.displayName}...`).start();

          try {
            await updateAgent(agent, result.latestVersion);
            await restoreCliBinLink();
            updateSpinner.succeed(`${agent.displayName} updated to ${result.latestVersion}`);
          } catch (error: unknown) {
            updateSpinner.fail(`Failed to update ${agent.displayName}`);
            throw error;
          }

          return;
        }

        // Case 2: Check/update all agents
        const spinner = ora('Checking for updates...').start();

        const results = await checkAllAgentsForUpdates();

        if (results.length === 0) {
          spinner.info('No updatable agents installed');
          console.log();
          console.log(chalk.cyan('💡 Install an agent with: codemie install <agent>'));
          return;
        }

        spinner.stop();

        // Display status
        displayUpdateStatus(results);

        // Filter to agents with updates
        const outdated = results.filter(r => r.hasUpdate);

        if (outdated.length === 0) {
          console.log(chalk.green('✓ All agents are up to date!'));
          return;
        }

        console.log(chalk.yellow(`${outdated.length} update${outdated.length > 1 ? 's' : ''} available`));
        console.log();

        // Check-only mode: don't install
        if (checkOnly) {
          console.log(chalk.cyan(`💡 Run 'codemie update' to install updates`));
          return;
        }

        // Interactive selection
        const selectedNames = await promptAgentSelection(outdated);

        if (selectedNames.length === 0) {
          console.log(chalk.yellow('No agents selected for update'));
          return;
        }

        console.log();

        // Update selected agents
        let successCount = 0;
        let failCount = 0;

        for (const agentName of selectedNames) {
          const result = outdated.find(r => r.name === agentName);
          const agent = AgentRegistry.getAgent(agentName);

          if (!result || !agent) {
            continue;
          }

          const updateSpinner = ora(`Updating ${result.displayName}...`).start();

          try {
            await updateAgent(agent, result.latestVersion);
            updateSpinner.succeed(`${result.displayName} updated to ${result.latestVersion}`);
            successCount++;
          } catch (error: unknown) {
            updateSpinner.fail(`Failed to update ${result.displayName}: ${getErrorMessage(error)}`);
            failCount++;
          }
        }

        // Restore CLI bin link once after all updates (agent packages may overwrite it)
        if (successCount > 0) {
          await restoreCliBinLink();
        }

        console.log();

        if (failCount === 0) {
          console.log(chalk.green(`✓ ${successCount} agent${successCount > 1 ? 's' : ''} updated successfully!`));
        } else {
          console.log(chalk.yellow(`${successCount} updated, ${failCount} failed`));
        }

      } catch (error: unknown) {
        // Handle AgentNotFoundError with helpful suggestions
        if (error instanceof AgentNotFoundError) {
          console.error(chalk.red(`✗ ${getErrorMessage(error)}`));
          console.log();
          console.log(chalk.cyan('💡 Available agents:'));
          const allAgents = AgentRegistry.getAllAgents();
          for (const agent of allAgents) {
            console.log(chalk.white(`   • ${agent.name}`));
          }
          console.log();
          console.log(chalk.cyan('💡 Tip:') + ' Run ' + chalk.blueBright('codemie update --check') + ' to see installed agents');
          console.log();
          process.exit(1);
        }

        // For other errors, show simple message
        console.error(chalk.red(`✗ Update failed: ${getErrorMessage(error)}`));
        process.exit(1);
      }
    });

  return command;
}
