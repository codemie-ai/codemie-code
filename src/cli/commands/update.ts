import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { AgentAdapter } from '../../agents/core/types.js';
import { AgentNotFoundError, getErrorMessage } from '../../utils/errors.js';
import * as npm from '../../utils/processes.js';
import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';

/**
 * Get npm package name from agent (if available)
 * Built-in agents return null
 */
function getNpmPackage(agent: AgentAdapter): string | null {
  return (agent as { metadata?: { npmPackage?: string | null } }).metadata?.npmPackage ?? null;
}

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
  // Match semver pattern: major.minor.patch (optionally with v prefix and pre-release)
  const match = versionString.match(/v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Compare two semver versions
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  // Extract clean version numbers
  const clean1 = extractVersion(v1);
  const clean2 = extractVersion(v2);

  // If we can't extract versions, treat as equal (no update needed)
  if (!clean1 || !clean2) {
    return 0;
  }

  const parts1 = clean1.split('.').map(Number);
  const parts2 = clean2.split('.').map(Number);

  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }

  return 0;
}

/**
 * Check a single agent for available updates
 */
async function checkAgentForUpdate(agent: AgentAdapter): Promise<UpdateCheckResult | null> {
  // Skip built-in agents (no npmPackage)
  const npmPackage = getNpmPackage(agent);
  if (!npmPackage) {
    return null;
  }

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

  // Get latest version from npm
  const latestVersion = await npm.getLatestVersion(npmPackage);
  if (!latestVersion) {
    return null;
  }

  // Extract clean versions for comparison and display
  const cleanCurrentVersion = extractVersion(currentVersion) || currentVersion;
  const cleanLatestVersion = extractVersion(latestVersion) || latestVersion;

  // Compare versions
  const hasUpdate = compareVersions(currentVersion, latestVersion) < 0;

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
  const npmPackage = getNpmPackage(agent);
  if (!npmPackage) {
    throw new Error(`${agent.displayName} cannot be updated (no npm package)`);
  }

  await npm.installGlobal(npmPackage, { version: latestVersion });
}

export function createUpdateCommand(): Command {
  const command = new Command('update');

  command
    .description('Update installed AI coding agents')
    .argument('[name]', 'Agent name to update (run without argument for interactive selection)')
    .option('-c, --check', 'Check for available updates without installing')
    .action(async (name?: string, options?: { check?: boolean }) => {
      try {
        const checkOnly = options?.check ?? false;

        // Case 1: Update specific agent
        if (name) {
          const agent = AgentRegistry.getAgent(name);

          if (!agent) {
            throw new AgentNotFoundError(name);
          }

          // Check if it's a built-in agent
          const npmPackage = getNpmPackage(agent);
          if (!npmPackage) {
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
            spinner.succeed(`${agent.displayName} is already up to date (${result.currentVersion})`);
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
