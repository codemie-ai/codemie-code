import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigLoader } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';

export function createProfileCommand(): Command {
  const command = new Command('profile');

  command
    .description('Manage provider profiles')
    .addCommand(createListCommand())
    .addCommand(createSwitchCommand())
    .addCommand(createShowCommand())
    .addCommand(createDeleteCommand())
    .addCommand(createRenameCommand());

  return command;
}

function createListCommand(): Command {
  const command = new Command('list');

  command
    .description('List all provider profiles')
    .action(async () => {
      try {
        const profiles = await ConfigLoader.listProfiles();

        if (profiles.length === 0) {
          console.log(chalk.yellow('\nNo profiles found. Run "codemie setup" to create one.\n'));
          return;
        }

        console.log(chalk.bold.cyan('\n📋 Provider Profiles:\n'));

        profiles.forEach(({ name, active, profile }) => {
          const activeMarker = active ? chalk.green('● ') : chalk.dim('○ ');
          const providerLabel = chalk.dim(`(${profile.provider})`);
          const modelLabel = profile.model ? chalk.dim(`- ${profile.model}`) : '';

          console.log(`${activeMarker}${chalk.white(name)} ${providerLabel} ${modelLabel}`);

          if (active) {
            console.log(chalk.dim(`  └─ Active profile`));
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
        await ConfigLoader.switchProfile(profileName);
        console.log(chalk.green(`\n✓ Switched to profile "${profileName}"\n`));
      } catch (error: unknown) {
        logger.error('Failed to switch profile:', error);
        process.exit(1);
      }
    });

  return command;
}

function createShowCommand(): Command {
  const command = new Command('show');

  command
    .description('Show profile details')
    .argument('[profile]', 'Profile name (defaults to active profile)')
    .action(async (profileName?: string) => {
      try {
        // If no profile specified, show active profile
        if (!profileName) {
          profileName = await ConfigLoader.getActiveProfileName() || undefined;
          if (!profileName) {
            console.log(chalk.yellow('\nNo active profile found.\n'));
            return;
          }
        }

        const profile = await ConfigLoader.getProfile(profileName);

        if (!profile) {
          console.log(chalk.red(`\nProfile "${profileName}" not found.\n`));
          process.exit(1);
        }

        console.log(chalk.bold.cyan(`\n📄 Profile: ${profileName}\n`));
        console.log(chalk.cyan('Provider:     ') + chalk.white(profile.provider || 'N/A'));
        console.log(chalk.cyan('Base URL:     ') + chalk.white(profile.baseUrl || 'N/A'));
        console.log(chalk.cyan('Model:        ') + chalk.white(profile.model || 'N/A'));
        console.log(chalk.cyan('Timeout:      ') + chalk.white(`${profile.timeout || 300}s`));
        console.log(chalk.cyan('Debug:        ') + chalk.white(profile.debug ? 'Yes' : 'No'));

        if (profile.authMethod) {
          console.log(chalk.cyan('Auth Method:  ') + chalk.white(profile.authMethod));
        }

        if (profile.codeMieUrl) {
          console.log(chalk.cyan('CodeMie URL:  ') + chalk.white(profile.codeMieUrl));
        }

        if (profile.apiKey) {
          const maskedKey = profile.apiKey.length > 12
            ? `${profile.apiKey.substring(0, 8)}***${profile.apiKey.substring(profile.apiKey.length - 4)}`
            : '***';
          console.log(chalk.cyan('API Key:      ') + chalk.dim(maskedKey));
        }

        console.log('');
      } catch (error: unknown) {
        logger.error('Failed to show profile:', error);
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
          console.log(chalk.dim(`Active profile is now: ${activeProfile}\n`));
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
