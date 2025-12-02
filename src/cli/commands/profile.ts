import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigLoader } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { getAnalytics } from '../../analytics/index.js';

export function createProfileCommand(): Command {
  const command = new Command('profile');

  command
    .description('Manage provider profiles')
    .addCommand(createListCommand())
    .addCommand(createSwitchCommand())
    .addCommand(createDeleteCommand())
    .addCommand(createRenameCommand());

  return command;
}

function createListCommand(): Command {
  const command = new Command('list');

  command
    .description('List all profiles with details')
    .action(async () => {
      try {
        const profiles = await ConfigLoader.listProfiles();

        if (profiles.length === 0) {
          console.log(chalk.yellow('\nNo profiles found. Run "codemie setup" to create one.\n'));
          return;
        }

        console.log(chalk.bold.cyan('\n📋 All Profiles:\n'));

        profiles.forEach(({ name, active, profile }, index) => {
          const activeLabel = active ? chalk.green(' (Active)') : '';
          console.log(chalk.bold.cyan(`Profile: ${name}${activeLabel}`));
          console.log(chalk.cyan('  Provider:     ') + chalk.white(profile.provider || 'N/A'));
          console.log(chalk.cyan('  Base URL:     ') + chalk.white(profile.baseUrl || 'N/A'));
          console.log(chalk.cyan('  Model:        ') + chalk.white(profile.model || 'N/A'));
          console.log(chalk.cyan('  Timeout:      ') + chalk.white(`${profile.timeout || 300}s`));
          console.log(chalk.cyan('  Debug:        ') + chalk.white(profile.debug ? 'Yes' : 'No'));

          if (profile.authMethod) {
            console.log(chalk.cyan('  Auth Method:  ') + chalk.white(profile.authMethod));
          }

          if (profile.codeMieUrl) {
            console.log(chalk.cyan('  CodeMie URL:  ') + chalk.white(profile.codeMieUrl));
          }

          if (profile.apiKey) {
            const maskedKey = profile.apiKey.length > 12
              ? `${profile.apiKey.substring(0, 8)}***${profile.apiKey.substring(profile.apiKey.length - 4)}`
              : '***';
            console.log(chalk.cyan('  API Key:      ') + chalk.white(maskedKey));
          }

          // Add separator between profiles except for the last one
          if (index < profiles.length - 1) {
            console.log('');
          }
        });

        console.log('');
      } catch (error: unknown) {
        logger.error('Failed to list profiles:', error);
        process.exit(1);
      }
    });

  return command;
}

function createSwitchCommand(): Command {
  const command = new Command('switch');

  command
    .description('Switch active profile')
    .argument('<profile>', 'Profile name to switch to')
    .action(async (profileName: string) => {
      try {
        const oldProfile = await ConfigLoader.getActiveProfileName();
        await ConfigLoader.switchProfile(profileName);
        console.log(chalk.green(`\n✓ Switched to profile "${profileName}"\n`));

        // Track profile switch
        try {
          const analytics = getAnalytics();
          const newProfile = await ConfigLoader.getProfile(profileName);
          await analytics.track('profile_switch', {
            fromProfile: oldProfile || 'none',
            toProfile: profileName,
            provider: newProfile?.provider || 'unknown'
          });
        } catch (analyticsError) {
          // Silent fail
          logger.debug('Analytics tracking error:', analyticsError);
        }
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
    .argument('<profile>', 'Profile name to delete')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (profileName: string, options: { yes?: boolean }) => {
      try {
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

        // Show new active profile if switched
        const activeProfile = await ConfigLoader.getActiveProfileName();
        if (activeProfile) {
          console.log(chalk.white(`Active profile is now: ${activeProfile}\n`));
        }

        // Track config change
        try {
          const analytics = getAnalytics();
          await analytics.track('config_change', {
            operation: 'delete_profile',
            profile: profileName
          });
        } catch (analyticsError) {
          // Silent fail
          logger.debug('Analytics tracking error:', analyticsError);
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

        // Track config change
        try {
          const analytics = getAnalytics();
          await analytics.track('config_change', {
            operation: 'rename_profile',
            oldProfile: oldName,
            newProfile: newName
          });
        } catch (analyticsError) {
          // Silent fail
          logger.debug('Analytics tracking error:', analyticsError);
        }
      } catch (error: unknown) {
        logger.error('Failed to rename profile:', error);
        process.exit(1);
      }
    });

  return command;
}
