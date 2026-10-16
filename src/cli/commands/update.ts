import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { getAgentInstallCommand, getUserFacingAgentName, resolveAgentAlias } from '../../agents/core/agent-aliases.js';
import { AgentAdapter } from '../../agents/core/types.js';
import { AgentNotFoundError, AgentInstallationError, getErrorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import * as npm from '../../utils/processes.js';
import { restoreCliBinLink } from '../../utils/cli-bin.js';
import { CLI_PACKAGE_NAME } from '../../utils/cli-updater.js';
import { compareVersions, isValidSemanticVersion, extractVersion } from '../../utils/version-utils.js';
import { isLiveTrackedAgent, isVersionChecksEnabled, resolveSupportedVersionDetailed } from '../../agents/core/version-resolution.js';
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

// Returned when an installed agent could not be checked because its latest-version lookup
// failed (offline, registry error, timeout) — as opposed to `null`: nothing to check.
const LOOKUP_FAILED = 'lookup-failed' as const;

/**
 * Check a single agent for available updates
 */
async function checkAgentForUpdate(
  agent: AgentAdapter
): Promise<UpdateCheckResult | typeof LOOKUP_FAILED | null> {
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

  // Special handling for built-in agent (codemie-code) — uses CLI package version
  if (agent.metadata.isBuiltIn) {
    const { getCurrentCliVersion } = await import('../../utils/cli-updater.js');
    const cliVersion = await getCurrentCliVersion();
    if (!cliVersion) return null;

    const latestVersion = await npm.getLatestVersion(CLI_PACKAGE_NAME);
    if (!latestVersion) return LOOKUP_FAILED;

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
      npmPackage: CLI_PACKAGE_NAME,
    };
  }

  // Standard npm-based agents
  const npmPackage = agent.metadata.npmPackage;
  if (!npmPackage) {
    return null;
  }

  // Live-tracked agents go through the tracked-version resolver (fetched fresh — the user asked
  // to check now — and written back to the cache); others (opencode, pi) query npm directly.
  // A non-current result is the stale fallback, so skip rather than offer it.
  let latestVersion: string | null | undefined;
  if (isLiveTrackedAgent(agent.name)) {
    // Skipped on purpose while checks are off (the caller explains it) — not a failed lookup.
    if (!(await isVersionChecksEnabled())) {
      return null;
    }
    const resolved = await resolveSupportedVersionDetailed({
      agentName: agent.name,
      npmPackage,
      fallbackSupportedVersion: agent.metadata.supportedVersion,
      minimumSupportedVersion: agent.metadata.minimumSupportedVersion,
      bypassCache: true,
    });
    latestVersion = resolved.isCurrent ? resolved.version : null;
  } else {
    latestVersion = await npm.getLatestVersion(npmPackage);
  }
  if (!latestVersion) {
    return LOOKUP_FAILED;
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
 * Check all installed agents for updates. `unchecked` lists the installed agents whose
 * latest-version lookup failed, so they are reported rather than silently dropped.
 */
async function checkAllAgentsForUpdates(): Promise<{ results: UpdateCheckResult[]; unchecked: string[] }> {
  const agents = AgentRegistry.getManageableAgents();
  const results: UpdateCheckResult[] = [];
  const unchecked: string[] = [];

  // Check all agents in parallel
  const checks = await Promise.all(
    agents.map(async agent => ({ agent, result: await checkAgentForUpdate(agent) }))
  );

  for (const { agent, result } of checks) {
    if (result === LOOKUP_FAILED) {
      unchecked.push(agent.displayName);
    } else if (result) {
      results.push(result);
    }
  }

  return { results, unchecked };
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
  // Special handling for Claude (uses native installer). Install the exact version the check
  // offered rather than re-resolving 'supported', which could read a different cached value.
  if (agent.name === 'claude' && agent.installVersion) {
    await agent.installVersion(latestVersion);
  } else if (agent.metadata.isBuiltIn) {
    // Special handling for built-in agent — update the CLI package
    await npm.installGlobal(CLI_PACKAGE_NAME, { version: latestVersion, force: true });
  } else {
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

  // Acknowledge the freshly installed version so the next launch stays quiet.
  await agent.warnOnceIfUntested();
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

        const versionChecksEnabled = await isVersionChecksEnabled();
        const checkOnly = options?.check ?? false;

        // Case 1: Update specific agent
        if (name) {
          const canonicalName = resolveAgentAlias(name) || name;
          const agent = AgentRegistry.getAgent(canonicalName);

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
            console.log(chalk.cyan(`💡 Install it with: ${getAgentInstallCommand(agent.name)}`));
            return;
          }

          if (!versionChecksEnabled && isLiveTrackedAgent(agent.name)) {
            console.log(
              chalk.dim(
                `Version checks are disabled (versionChecks.enabled=false) — skipping the update check for ${agent.displayName}.`
              )
            );
            console.log(chalk.dim(`To install the newest release anyway: codemie install ${agent.name} latest`));
            return;
          }

          const spinner = ora(`Checking ${agent.displayName} for updates...`).start();

          const result = await checkAgentForUpdate(agent);

          if (!result || result === LOOKUP_FAILED) {
            spinner.warn(`Could not check ${agent.displayName} for updates`);
            return;
          }

          if (!result.hasUpdate) {
            // Live-tracked agents resolve against a cached npm lookup rather than an absolute
            // "latest", so make that distinction explicit instead of a bare "up to date".
            const upToDateMessage = isLiveTrackedAgent(agent.name)
              ? `${agent.displayName} is already up to date — no newer version available (${result.currentVersion})`
              : `${agent.displayName} is already up to date (${result.currentVersion})`;
            spinner.succeed(upToDateMessage);
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
        if (!versionChecksEnabled) {
          console.log(
            chalk.dim('Version checks are disabled (versionChecks.enabled=false) — live-tracked agents are skipped.\n')
          );
        }
        const spinner = ora('Checking for updates...').start();

        const { results, unchecked } = await checkAllAgentsForUpdates();
        const reportUnchecked = (): void => {
          for (const name of unchecked) {
            console.log(chalk.yellow(`⚠ Could not check ${name} for updates`));
          }
        };

        if (results.length === 0 && unchecked.length > 0) {
          spinner.stop();
          reportUnchecked();
          return;
        }

        if (results.length === 0 && !versionChecksEnabled) {
          spinner.info('Nothing to check — live-tracked agents are skipped while version checks are disabled');
          return;
        }

        if (results.length === 0) {
          spinner.info('No updatable agents installed');
          console.log();
          console.log(chalk.cyan('💡 Install an agent with: codemie install <agent>'));
          return;
        }

        spinner.stop();

        // Display status
        displayUpdateStatus(results);
        reportUnchecked();

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
          const allAgents = AgentRegistry.getManageableAgents();
          for (const agent of allAgents) {
            console.log(chalk.white(`   • ${getUserFacingAgentName(agent.name)}`));
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
