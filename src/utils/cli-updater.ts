/**
 * CLI Auto-Update Utilities
 *
 * Handles version checking and updating for the CodeMie CLI itself
 * (@codemieai/code package)
 *
 * Environment Variables:
 * - CODEMIE_AUTO_UPDATE=true (default): Silently update without prompting
 * - CODEMIE_AUTO_UPDATE=false: Prompt user before updating
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { getLatestVersion, installGlobal } from './processes.js';

const CLI_PACKAGE_NAME = '@codemieai/code';

/**
 * Get the current CLI version from package.json
 */
export async function getCurrentCliVersion(): Promise<string | null> {
  try {
    // Navigate from src/utils/ to package.json (2 levels up)
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = path.resolve(dirname, '../../package.json');

    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content);

    return packageJson.version || null;
  } catch (error) {
    logger.debug('Failed to read current CLI version:', error);
    return null;
  }
}

/**
 * Compare two semver versions
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

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
 * Check if auto-update is enabled (default: true)
 * Reads CODEMIE_AUTO_UPDATE environment variable
 *
 * @returns true if auto-update should happen silently, false if prompt required
 */
export function isAutoUpdateEnabled(): boolean {
  const envValue = process.env.CODEMIE_AUTO_UPDATE;

  // If not set, default to true (silent auto-update)
  if (envValue === undefined || envValue === null || envValue === '') {
    return true;
  }

  // Parse as boolean
  const normalized = envValue.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Result of checking for CLI updates
 */
export interface CliUpdateCheckResult {
  /** Current CLI version */
  currentVersion: string;
  /** Latest available version from npm */
  latestVersion: string;
  /** True if update available */
  hasUpdate: boolean;
}

/**
 * Check if a CLI update is available
 * Fast check with 5-second timeout
 *
 * @returns Update check result, or null if check fails
 */
export async function checkForCliUpdate(): Promise<CliUpdateCheckResult | null> {
  try {
    const currentVersion = await getCurrentCliVersion();
    if (!currentVersion) {
      logger.debug('Could not determine current CLI version');
      return null;
    }

    // Fast check with 5-second timeout
    const latestVersion = await getLatestVersion(CLI_PACKAGE_NAME, { timeout: 5000 });
    if (!latestVersion) {
      logger.debug('Could not fetch latest CLI version from npm');
      return null;
    }

    const hasUpdate = compareVersions(currentVersion, latestVersion) < 0;

    return {
      currentVersion,
      latestVersion,
      hasUpdate
    };
  } catch (error) {
    logger.debug('CLI update check failed:', error);
    return null;
  }
}

/**
 * Prompt user to update CLI
 *
 * @param result - Update check result
 * @returns True if user confirms update, false otherwise
 */
export async function promptForCliUpdate(result: CliUpdateCheckResult): Promise<boolean> {
  // Box: 47 total width (45 dashes + 2 corners)
  // Content area: 47 - 4 (two borders + two leading spaces) = 43 chars
  const contentWidth = 43;

  // Title: "📦 CodeMie CLI Update Available" (30 string chars, 31 visual width due to emoji)
  const titleVisualWidth = 31; // Emoji takes 2 visual columns
  const titlePadding = ' '.repeat(Math.max(0, contentWidth - titleVisualWidth));

  // Build content lines with proper padding
  const currentLine = `Current: ${result.currentVersion}`;
  const currentPadding = ' '.repeat(Math.max(0, contentWidth - currentLine.length));

  const latestLine = `Latest:  ${result.latestVersion}`;
  const latestPadding = ' '.repeat(Math.max(0, contentWidth - latestLine.length));

  console.log();
  console.log(chalk.yellow('┌─────────────────────────────────────────────┐'));
  console.log(chalk.yellow('│  ') + chalk.bold('📦 CodeMie CLI Update Available') + titlePadding + chalk.yellow('│'));
  console.log(chalk.yellow('│─────────────────────────────────────────────│'));
  console.log(chalk.yellow('│  ') + currentLine + currentPadding + chalk.yellow('│'));
  console.log(chalk.yellow('│  ') + chalk.green(latestLine) + latestPadding + chalk.yellow('│'));
  console.log(chalk.yellow('└─────────────────────────────────────────────┘'));
  console.log();

  const { shouldUpdate } = await inquirer.prompt<{ shouldUpdate: boolean }>([
    {
      type: 'confirm',
      name: 'shouldUpdate',
      message: 'Would you like to update now?',
      default: true
    }
  ]);

  return shouldUpdate;
}

/**
 * Update the CLI to the latest version
 *
 * @param latestVersion - Version to install
 * @param silent - If true, minimize output (for auto-update)
 */
export async function updateCli(latestVersion: string, silent = false): Promise<void> {
  if (!silent) {
    console.log();
    console.log(chalk.cyan(`📦 Updating CodeMie CLI to ${latestVersion}...`));
  }

  try {
    // Use force: true to handle directory conflicts during global update
    await installGlobal(CLI_PACKAGE_NAME, {
      version: latestVersion,
      force: true,
      timeout: 60000 // 1 minute timeout for update
    });

    if (silent) {
      // Silent mode: just log to debug
      logger.debug(`CodeMie CLI auto-updated to ${latestVersion}`);
    } else {
      console.log();
      console.log(chalk.green('✓ CodeMie CLI updated successfully!'));
      console.log(chalk.cyan(`  Current version: ${latestVersion}`));
      console.log();
      console.log(chalk.dim('  💡 The update will take effect on the next command.'));
      console.log();
    }
  } catch (error) {
    // On error, show message even in silent mode
    console.log();
    console.error(chalk.red('✗ Failed to update CodeMie CLI'));
    console.log();
    console.log(chalk.yellow('  You can manually update with:'));
    console.log(chalk.white(`    npm install -g ${CLI_PACKAGE_NAME}@${latestVersion}`));
    console.log();
    console.log(chalk.dim('  💡 To disable auto-update: export CODEMIE_AUTO_UPDATE=false'));
    console.log();
    throw error;
  }
}

/**
 * Check for CLI updates and handle update (silent or prompted)
 * This is the main entry point called from bin/codemie.js
 *
 * Behavior:
 * - CODEMIE_AUTO_UPDATE=true (default): Silent update
 * - CODEMIE_AUTO_UPDATE=false: Prompt user
 *
 * Non-blocking: Failures are logged but don't block CLI startup
 */
export async function checkAndPromptForUpdate(): Promise<void> {
  try {
    const result = await checkForCliUpdate();

    // No update available or check failed
    if (!result || !result.hasUpdate) {
      return;
    }

    const autoUpdate = isAutoUpdateEnabled();

    if (autoUpdate) {
      // Silent auto-update (default behavior)
      logger.debug(`Auto-updating CLI: ${result.currentVersion} → ${result.latestVersion}`);
      await updateCli(result.latestVersion, true);
      // Don't exit - let CLI continue with updated version on next run
      return;
    }

    // Prompt mode (CODEMIE_AUTO_UPDATE=false)
    const shouldUpdate = await promptForCliUpdate(result);

    if (!shouldUpdate) {
      console.log(chalk.dim('  Skipping update. You can update later with:'));
      console.log(chalk.white(`    codemie self-update`));
      console.log();
      console.log(chalk.dim('  💡 To enable auto-update: export CODEMIE_AUTO_UPDATE=true'));
      console.log();
      return;
    }

    // Perform update (verbose)
    await updateCli(result.latestVersion, false);

    // Exit after update so user can run the new version
    process.exit(0);
  } catch (error) {
    // Don't block CLI startup if update check/install fails
    logger.debug('CLI update check failed:', error);
  }
}
