import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigLoader } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { ProfileDisplay } from './display.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { handleAuthValidationFailure } from '../../../providers/core/auth-validation.js';
import { createLoginCommand, createLogoutCommand, createRefreshCommand } from './auth.js';
import { buildSingleChoiceRow, buildTopLine } from '../shared/selection/ui.js';
import { ANSI, KEY } from '../shared/selection/constants.js';
import { COLOR } from '../shared/constants.js';
import type { ProfileInfo } from './display.js';

export interface ProfileSelectionChoiceNameOptions {
  name: string;
  provider?: string;
  source?: 'local' | 'global';
  isActive: boolean;
}

export interface ProfileSelectionUIOptions {
  message: string;
  profiles: ProfileInfo[];
  cursorIndex: number;
}

export function createProfileCommand(): Command {
  const command = new Command('profile');

  command
    .description('Manage provider profiles (lists profiles by default)')
    .action(async () => {
      // Default action: list profiles
      await listProfiles();
    })
    .addCommand(createStatusCommand())
    .addCommand(createLoginCommand())
    .addCommand(createLogoutCommand())
    .addCommand(createRefreshCommand())
    .addCommand(createSwitchCommand())
    .addCommand(createDeleteCommand())
    .addCommand(createRenameCommand());

  return command;
}

/**
 * List all profiles with details
 * Uses ProfileDisplay utility for consistent formatting
 */
async function listProfiles(): Promise<void> {
  try {
    const workingDir = process.cwd();
    const profiles = await ConfigLoader.listProfiles(workingDir);
    const hasLocal = await ConfigLoader.hasLocalConfig(workingDir);

    // Show context indicator
    if (hasLocal) {
      console.log(chalk.dim('\n  📁 Showing profiles from both local (.codemie/) and global (~/.codemie/) configs\n'));
    }

    ProfileDisplay.formatList(profiles);
  } catch (error: unknown) {
    logger.error('Failed to list profiles:', error);
    process.exit(1);
  }
}

/**
 * Create status command
 * Shows active profile + auth status, prompts for re-auth if invalid
 */
function createStatusCommand(): Command {
  const command = new Command('status');

  command
    .description('Show active profile and authentication status')
    .option('--show-sources', 'Show configuration with source attribution')
    .action(async (options: { showSources?: boolean }) => {
      try {
        if (options.showSources) {
          await handleStatusWithSources();
        } else {
          await handleStatus();
        }
      } catch (error: unknown) {
        logger.error('Failed to get profile status:', error);
        process.exit(1);
      }
    });

  return command;
}

/**
 * Handle status command
 * Display profile info + auth status, prompt for re-auth if invalid
 */
async function handleStatus(): Promise<void> {
  const workingDir = process.cwd();
  const config = await ConfigLoader.load(workingDir);
  const profiles = await ConfigLoader.listProfiles(workingDir);
  const activeProfileName = await ConfigLoader.getActiveProfileName(workingDir);
  const hasLocalConfig = await ConfigLoader.hasLocalConfig(workingDir);

  // Find active profile
  const activeProfileInfo = profiles.find(p => p.name === activeProfileName);
  if (!activeProfileInfo) {
    console.log(chalk.yellow('\nNo active profile found. Run "codemie setup" to create one.\n'));
    return;
  }

  // Check if provider supports auth validation
  const provider = ProviderRegistry.getProvider(config.provider || '');
  const setupSteps = provider ? ProviderRegistry.getSetupSteps(config.provider || '') : null;

  // Get auth status if provider implements validation
  let authStatus;
  if (setupSteps?.validateAuth) {
    try {
      const validationResult = await setupSteps.validateAuth(config);

      if (validationResult.valid) {
        authStatus = setupSteps.getAuthStatus
          ? await setupSteps.getAuthStatus(config)
          : undefined;
      } else {
        const reauthed = await handleAuthValidationFailure(validationResult, setupSteps, config);

        if (reauthed) {
          // Re-fetch auth status after successful re-authentication
          authStatus = setupSteps.getAuthStatus
            ? await setupSteps.getAuthStatus(config)
            : undefined;
          console.log(chalk.green('\n✓ Authentication refreshed successfully\n'));
        } else {
          console.log(chalk.yellow('\n⚠️  Authentication required to use this profile\n'));
          return;
        }
      }
    } catch (error) {
      logger.error('Auth status check error:', error);
    }
  }

  // Show source indicator
  const sourceIndicator = hasLocalConfig
    ? chalk.yellow('(source: local .codemie/)')
    : chalk.cyan('(source: global ~/.codemie/)');

  // Display profile + auth status
  ProfileDisplay.formatStatus(activeProfileInfo, authStatus);
  console.log(chalk.dim(`\n  Configuration ${sourceIndicator}`));
  console.log(chalk.dim(`  Use --show-sources to see detailed source attribution\n`));
}

/**
 * Handle status command with source attribution
 * Shows where each configuration value comes from
 */
async function handleStatusWithSources(): Promise<void> {
  await ConfigLoader.showWithSources();
}

export function buildProfileSelectionChoiceName({
  name,
  provider,
  source,
  isActive,
}: ProfileSelectionChoiceNameOptions): string {
  const providerInfo = chalk.dim(`(${provider || 'N/A'})`);
  const sourceIndicator = source === 'local'
    ? chalk.yellow(' [Local]')
    : chalk.cyan(' [Global]');
  const displayName = isActive
    ? chalk.green.bold(name)
    : chalk.white(name);

  return buildSingleChoiceRow({
    label: `${displayName} ${providerInfo}${sourceIndicator}`,
    isCursor: false,
    isSelected: isActive,
    formatLabel: value => value,
    formatSelectedMarker: marker => chalk.green(marker),
    formatUnselectedMarker: marker => chalk.white(marker),
  });
}

function buildProfileSelectionRow(
  profileInfo: ProfileInfo,
  currentActive: string | undefined,
  isCursor: boolean
): string {
  const isActive = profileInfo.name === currentActive || profileInfo.active;
  const providerInfo = chalk.dim(`(${profileInfo.profile.provider || 'N/A'})`);
  const sourceIndicator = profileInfo.source === 'local'
    ? chalk.yellow(' [Local]')
    : chalk.cyan(' [Global]');
  const displayName = isActive
    ? chalk.green.bold(profileInfo.name)
    : chalk.white(profileInfo.name);

  return buildSingleChoiceRow({
    label: `${displayName} ${providerInfo}${sourceIndicator}`,
    isCursor,
    isSelected: isActive,
    formatLabel: value => value,
    formatSelectedMarker: marker => chalk.green(marker),
    formatUnselectedMarker: marker => chalk.white(marker),
  });
}

export function renderProfileSelectionUI({
  message,
  profiles,
  cursorIndex,
}: ProfileSelectionUIOptions): string {
  const activeProfile = profiles.find(profile => profile.active)?.name;
  let output = ANSI.CURSOR_HOME_CLEAR;

  output += buildTopLine();
  output += chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold('Profiles') + '\n\n';
  output += chalk.dim(message) + '\n\n';

  profiles.forEach((profile, index) => {
    output += buildProfileSelectionRow(profile, activeProfile, index === cursorIndex) + '\n';
  });

  output += '\n';
  output += chalk.dim('↑↓ to Navigate • Enter to Confirm • Esc to Cancel\n');

  return output;
}

async function promptProfileSelectionCustom(message: string, profiles: ProfileInfo[]): Promise<string> {
  let cursorIndex = Math.max(0, profiles.findIndex(profile => profile.active));
  if (cursorIndex < 0) {
    cursorIndex = 0;
  }

  function render(): void {
    process.stdout.write(renderProfileSelectionUI({ message, profiles, cursorIndex }));
  }

  return new Promise((resolve, reject) => {
    let keepAliveTimer: NodeJS.Timeout | null = null;

    function cleanup(): void {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      process.stdin.removeAllListeners('data');
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write(ANSI.CURSOR_HOME_CLEAR);
    }

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      switch (key) {
        case KEY.ARROW_UP:
          cursorIndex = Math.max(0, cursorIndex - 1);
          render();
          break;
        case KEY.ARROW_DOWN:
          cursorIndex = Math.min(profiles.length - 1, cursorIndex + 1);
          render();
          break;
        case KEY.ENTER:
        case KEY.NEWLINE:
          cleanup();
          resolve(profiles[cursorIndex].name);
          break;
        case KEY.ESC:
        case KEY.CTRL_C:
          cleanup();
          reject(new Error('Profile selection cancelled.'));
          break;
        default:
          break;
      }
    });

    keepAliveTimer = setInterval(() => {}, 1000);
    render();
  });
}

/**
 * Prompt user to select a profile interactively
 * Reusable method for switch, delete, and other commands
 */
async function promptProfileSelection(message: string, workingDir: string = process.cwd()): Promise<string> {
  const profiles = await ConfigLoader.listProfiles(workingDir);

  if (profiles.length === 0) {
    throw new Error('No profiles found. Run "codemie setup" to create one.');
  }

  const currentActive = await ConfigLoader.getActiveProfileName(workingDir);
  return promptProfileSelectionCustom(
    message,
    profiles.map(profile => ({
      ...profile,
      active: profile.name === currentActive,
    }))
  );
}

function createSwitchCommand(): Command {
  const command = new Command('switch');

  command
    .description('Switch active profile')
    .argument('[profile]', 'Profile name to switch to (optional - will prompt if not provided)')
    .action(async (profileName?: string) => {
      try {
        const workingDir = process.cwd();
        const hasLocal = await ConfigLoader.hasLocalConfig(workingDir);

        // If no profile name provided, prompt interactively
        if (!profileName) {
          const profiles = await ConfigLoader.listProfiles(workingDir);

          if (profiles.length === 0) {
            console.log(chalk.yellow('\nNo profiles found. Run "codemie setup" to create one.\n'));
            return;
          }

          const currentActive = await ConfigLoader.getActiveProfileName(workingDir);
          profileName = await promptProfileSelection('Select profile to switch to:', workingDir);

          // If already active, no need to switch
          if (profileName === currentActive) {
            console.log(chalk.yellow(`\nProfile "${profileName}" is already active.\n`));
            return;
          }
        }

        // TypeScript guard - profileName is guaranteed to be defined here
        if (!profileName) {
          throw new Error('Profile name is required');
        }

        await ConfigLoader.switchProfile(profileName, workingDir);

        const location = hasLocal ? 'local config' : 'global config';
        console.log(chalk.green(`\n✓ Switched to profile "${profileName}" in ${location}\n`));
      } catch (error: unknown) {
        logger.error('Failed to switch profile:', error);
        process.exit(1);
      }
    });

  return command;
}

function createDeleteCommand(): Command {
  const command = new Command('delete');

  command
    .description('Delete a profile')
    .argument('[profile]', 'Profile name to delete (optional - will prompt if not provided)')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (profileName?: string, options: { yes?: boolean } = {}) => {
      try {
        const workingDir = process.cwd();
        const hasLocal = await ConfigLoader.hasLocalConfig(workingDir);

        // If no profile name provided, prompt interactively
        if (!profileName) {
          const profiles = await ConfigLoader.listProfiles(workingDir);

          if (profiles.length === 0) {
            console.log(chalk.yellow('\nNo profiles found. Run "codemie setup" to create one.\n'));
            return;
          }

          profileName = await promptProfileSelection('Select profile to delete:', workingDir);
        }

        // TypeScript guard
        if (!profileName) {
          throw new Error('Profile name is required');
        }

        // Confirmation
        if (!options.yes) {
          const location = hasLocal ? 'local config' : 'global config';
          const { confirm } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: `Are you sure you want to delete profile "${profileName}" from ${location}?`,
              default: false
            }
          ]);

          if (!confirm) {
            console.log(chalk.yellow('\nDeletion cancelled.\n'));
            return;
          }
        }

        await ConfigLoader.deleteProfile(profileName, workingDir);
        console.log(chalk.green(`\n✓ Profile "${profileName}" deleted\n`));

        // Check if any profiles remain
        const remainingProfiles = await ConfigLoader.listProfiles(workingDir);

        if (remainingProfiles.length === 0) {
          // No profiles left - show setup message
          console.log(chalk.yellow('No profiles remaining.'));
          console.log(chalk.white('Run ') + chalk.cyan('codemie setup') + chalk.white(' to create a new profile.\n'));
        } else {
          // Show new active profile if switched
          const activeProfile = await ConfigLoader.getActiveProfileName(workingDir);
          if (activeProfile) {
            console.log(chalk.white(`Active profile is now: ${activeProfile}\n`));
          }
        }
      } catch (error: unknown) {
        logger.error('Failed to delete profile:', error);
        process.exit(1);
      }
    });

  return command;
}

function createRenameCommand(): Command {
  const command = new Command('rename');

  command
    .description('Rename a profile')
    .argument('<old-name>', 'Current profile name')
    .argument('<new-name>', 'New profile name')
    .action(async (oldName: string, newName: string) => {
      try {
        await ConfigLoader.renameProfile(oldName, newName);
        console.log(chalk.green(`\n✓ Profile renamed from "${oldName}" to "${newName}"\n`));
      } catch (error: unknown) {
        logger.error('Failed to rename profile:', error);
        process.exit(1);
      }
    });

  return command;
}
