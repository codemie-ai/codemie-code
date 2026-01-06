import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigLoader } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { ProfileDisplay } from './display.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { handleAuthValidationFailure } from '../../../providers/core/auth-validation.js';
import { createLoginCommand, createLogoutCommand, createRefreshCommand } from './auth.js';

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
    const profiles = await ConfigLoader.listProfiles();
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
    .action(async () => {
      try {
        await handleStatus();
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
  const config = await ConfigLoader.load();
  const profiles = await ConfigLoader.listProfiles();
  const activeProfileName = await ConfigLoader.getActiveProfileName();

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

  // Display profile + auth status
  ProfileDisplay.formatStatus(activeProfileInfo, authStatus);
}

/**
 * Prompt user to select a profile interactively
 * Reusable method for switch, delete, and other commands
 */
async function promptProfileSelection(message: string): Promise<string> {
  const profiles = await ConfigLoader.listProfiles();

  if (profiles.length === 0) {
    throw new Error('No profiles found. Run "codemie setup" to create one.');
  }

  const currentActive = await ConfigLoader.getActiveProfileName();

  // Create choices with visual indicators
  const choices = profiles.map(({ name, profile }) => {
    const isActive = name === currentActive;
    const activeMarker = isActive ? chalk.green('● ') : chalk.white('○ ');
    const providerInfo = chalk.dim(`(${profile.provider})`);
    const displayName = isActive
      ? chalk.green.bold(name)
      : chalk.white(name);

    return {
      name: `${activeMarker}${displayName} ${providerInfo}`,
      value: name,
      short: name
    };
  });

  const { selectedProfile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedProfile',
      message,
      choices,
      pageSize: 10
    }
  ]);

  return selectedProfile;
}

function createSwitchCommand(): Command {
  const command = new Command('switch');

  command
    .description('Switch active profile')
    .argument('[profile]', 'Profile name to switch to (optional - will prompt if not provided)')
    .action(async (profileName?: string) => {
      try {
        // If no profile name provided, prompt interactively
        if (!profileName) {
          const profiles = await ConfigLoader.listProfiles();

          if (profiles.length === 0) {
            console.log(chalk.yellow('\nNo profiles found. Run "codemie setup" to create one.\n'));
            return;
          }

          const currentActive = await ConfigLoader.getActiveProfileName();
          profileName = await promptProfileSelection('Select profile to switch to:');

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

        await ConfigLoader.switchProfile(profileName);
        console.log(chalk.green(`\n✓ Switched to profile "${profileName}"\n`));
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
        // If no profile name provided, prompt interactively
        if (!profileName) {
          const profiles = await ConfigLoader.listProfiles();

          if (profiles.length === 0) {
            console.log(chalk.yellow('\nNo profiles found. Run "codemie setup" to create one.\n'));
            return;
          }

          profileName = await promptProfileSelection('Select profile to delete:');
        }

        // TypeScript guard
        if (!profileName) {
          throw new Error('Profile name is required');
        }

        // Confirmation
        if (!options.yes) {
          const { confirm } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: `Are you sure you want to delete profile "${profileName}"?`,
              default: false
            }
          ]);

          if (!confirm) {
            console.log(chalk.yellow('\nDeletion cancelled.\n'));
            return;
          }
        }

        await ConfigLoader.deleteProfile(profileName);
        console.log(chalk.green(`\n✓ Profile "${profileName}" deleted\n`));

        // Check if any profiles remain
        const remainingProfiles = await ConfigLoader.listProfiles();

        if (remainingProfiles.length === 0) {
          // No profiles left - show setup message
          console.log(chalk.yellow('No profiles remaining.'));
          console.log(chalk.white('Run ') + chalk.cyan('codemie setup') + chalk.white(' to create a new profile.\n'));
        } else {
          // Show new active profile if switched
          const activeProfile = await ConfigLoader.getActiveProfileName();
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
