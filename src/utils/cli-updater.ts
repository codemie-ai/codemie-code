/**
 * CLI Auto-Update Utilities
 *
 * Handles version checking and updating for the CodeMie CLI itself
 * (@codemieai/code package)
 *
 * Environment Variables:
 * - CODEMIE_AUTO_UPDATE=true (default): Silently update without prompting
 * - CODEMIE_AUTO_UPDATE=false: Prompt user before updating
 * - CODEMIE_UPDATE_CHECK_INTERVAL: Time between update checks in ms (default: 86400000 = 24h)
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { getLatestVersion, installGlobal } from './processes.js';
import { compareVersions, isValidSemanticVersion } from './version-utils.js';
import { getCodemiePath } from './paths.js';

const CLI_PACKAGE_NAME = '@codemieai/code';

// Rate limiting: Check for updates at most once per interval (default: 24 hours)
const UPDATE_CHECK_INTERVAL = parseInt(
  process.env.CODEMIE_UPDATE_CHECK_INTERVAL || '86400000',
  10
);
const LAST_CHECK_FILE = path.join(getCodemiePath(), '.last-update-check');
const UPDATE_LOCK_FILE = path.join(getCodemiePath(), '.update-lock');

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
 * Check if we should perform an update check (rate limiting)
 * Only checks once per UPDATE_CHECK_INTERVAL (default: 24 hours)
 */
async function shouldCheckForUpdate(): Promise<boolean> {
  try {
    const lastCheckStr = await fs.readFile(LAST_CHECK_FILE, 'utf-8');
    const lastCheck = parseInt(lastCheckStr, 10);
    const now = Date.now();

    const shouldCheck = (now - lastCheck) > UPDATE_CHECK_INTERVAL;
    if (!shouldCheck) {
      logger.debug(`Skipping update check (last checked ${Math.floor((now - lastCheck) / 1000 / 60)} minutes ago)`);
    }
    return shouldCheck;
  } catch {
    // File doesn't exist or invalid - should check
    return true;
  }
}

/**
 * Record the time of the last update check
 */
async function recordUpdateCheck(): Promise<void> {
  try {
    await fs.writeFile(LAST_CHECK_FILE, Date.now().toString(), 'utf-8');
    logger.debug('Recorded update check timestamp');
  } catch (error) {
    logger.debug('Failed to record update check time:', error);
  }
}

/**
 * Acquire lock file to prevent concurrent updates
 * @returns true if lock acquired, false if another process is updating
 */
async function acquireUpdateLock(): Promise<boolean> {
  try {
    // Try to create lock file with exclusive flag (fails if exists)
    const fd = await fs.open(UPDATE_LOCK_FILE, 'wx');
    await fd.close();
    logger.debug('Acquired update lock');
    return true;
  } catch {
    // Lock file exists - another process is updating
    logger.debug('Update lock already held by another process');
    return false;
  }
}

/**
 * Release update lock file
 */
async function releaseUpdateLock(): Promise<void> {
  try {
    await fs.unlink(UPDATE_LOCK_FILE);
    logger.debug('Released update lock');
  } catch {
    // Lock file already deleted or never created
    logger.debug('Lock file not found (already released)');
  }
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

    // Validate current version format
    if (!isValidSemanticVersion(currentVersion)) {
      logger.error('Invalid current CLI version format', { version: currentVersion });
      return null;
    }

    // Fast check with 5-second timeout
    const latestVersion = await getLatestVersion(CLI_PACKAGE_NAME, { timeout: 5000 });
    if (!latestVersion) {
      logger.debug('Could not fetch latest CLI version from npm');
      return null;
    }

    // SECURITY: Validate version string from npm registry before using
    if (!isValidSemanticVersion(latestVersion)) {
      logger.error('Invalid version format received from npm registry (potential security issue)', {
        version: latestVersion,
        source: 'npm'
      });
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
    // Log error for debugging
    logger.error('CLI update failed', {
      targetVersion: latestVersion,
      error: error instanceof Error ? error.message : String(error),
      silent
    });

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
 * Performance optimizations:
 * - Rate limited: Only checks once per UPDATE_CHECK_INTERVAL (default: 24h)
 * - File-based locking: Prevents concurrent updates from multiple CLI processes
 *
 * Non-blocking: Failures are logged but don't block CLI startup
 */
export async function checkAndPromptForUpdate(): Promise<void> {
  try {
    // PERFORMANCE FIX: Rate limiting - only check once per interval (default: 24h)
    if (!(await shouldCheckForUpdate())) {
      return;
    }

    const result = await checkForCliUpdate();

    // Record check timestamp even if no update (prevents repeated checks)
    await recordUpdateCheck();

    // No update available or check failed
    if (!result || !result.hasUpdate) {
      return;
    }

    const autoUpdate = isAutoUpdateEnabled();

    if (autoUpdate) {
      // CONCURRENCY FIX: Try to acquire lock before updating
      const hasLock = await acquireUpdateLock();
      if (!hasLock) {
        logger.debug('Another process is updating CLI, skipping');
        return;
      }

      try {
        // Silent auto-update (default behavior)
        logger.debug(`Auto-updating CLI: ${result.currentVersion} → ${result.latestVersion}`);
        await updateCli(result.latestVersion, true);
        // Don't exit - let CLI continue with updated version on next run
      } finally {
        await releaseUpdateLock();
      }
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

    // CONCURRENCY FIX: Try to acquire lock before updating
    const hasLock = await acquireUpdateLock();
    if (!hasLock) {
      console.log();
      console.log(chalk.yellow('⚠ Another process is updating CLI. Please wait and try again.'));
      console.log();
      return;
    }

    try {
      // Perform update (verbose)
      await updateCli(result.latestVersion, false);

      // Exit after update so user can run the new version
      process.exit(0);
    } finally {
      await releaseUpdateLock();
    }
  } catch (error) {
    // Clean up lock on error
    await releaseUpdateLock();

    // Log error with context for troubleshooting
    logger.error('CLI update check/installation failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      autoUpdate: isAutoUpdateEnabled()
    });

    // Don't block CLI startup if update check/install fails
    logger.debug('CLI update check failed (non-blocking):', error);
  }
}
