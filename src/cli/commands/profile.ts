import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigLoader } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { renderProfileInfo } from '../../utils/profile.js';

export function createProfileCommand(): Command {
  const command = new Command('profile');

  command
    .description('Manage provider profiles (lists profiles by default)')
    .action(async () => {
      // Default action: list profiles
      await listProfiles();
    })
    .addCommand(createSwitchCommand())
    .addCommand(createDeleteCommand())
    .addCommand(createRenameCommand())
    .addCommand(createStatusCommand())
    .addCommand(createLoginCommand())
    .addCommand(createLogoutCommand())
    .addCommand(createRefreshCommand());

  return command;
}

/**
 * List all profiles with details
 * Extracted as reusable function
 */
async function listProfiles(): Promise<void> {
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

      if (profile.codeMieUrl) {
        console.log(chalk.cyan('  CodeMie URL:  ') + chalk.white(profile.codeMieUrl));
      }

      console.log(chalk.cyan('  Model:        ') + chalk.white(profile.model || 'N/A'));

      if (profile.authMethod) {
        console.log(chalk.cyan('  Auth Method:  ') + chalk.white(profile.authMethod));
      }

      if (profile.codeMieIntegration?.alias) {
        console.log(chalk.cyan('  Integration:  ') + chalk.white(profile.codeMieIntegration.alias));
      }

      console.log(chalk.cyan('  Timeout:      ') + chalk.white(`${profile.timeout || 300}s`));
      console.log(chalk.cyan('  Debug:        ') + chalk.white(profile.debug ? 'Yes' : 'No'));

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
    console.log(chalk.dim('──────────────────────────────────────────────────'));
    console.log(chalk.bold('  Next Steps:'));
    console.log('');
    console.log('  ' + chalk.white('• Switch active profile:') + '  ' + chalk.cyan('codemie profile switch'));
    console.log('  ' + chalk.white('• Check auth status:') + '      ' + chalk.cyan('codemie profile status'));
    console.log('  ' + chalk.white('• Create new profile:') + '     ' + chalk.cyan('codemie setup'));
    console.log('  ' + chalk.white('• Remove a profile:') + '       ' + chalk.cyan('codemie profile delete'));
    console.log('  ' + chalk.white('• Explore more:') + '           ' + chalk.cyan('codemie --help'));
    console.log('');
  } catch (error: unknown) {
    logger.error('Failed to list profiles:', error);
    process.exit(1);
  }
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

function createStatusCommand(): Command {
  const command = new Command('status');

  command
    .description('Show authentication status for active profile')
    .action(async () => {
      try {
        await handleStatus();
      } catch (error: unknown) {
        logger.error('Status check failed:', error);
        process.exit(1);
      }
    });

  return command;
}

function createLoginCommand(): Command {
  const command = new Command('login');

  command
    .description('Authenticate with AI/Run CodeMie SSO for active profile')
    .option('--url <url>', 'AI/Run CodeMie URL to authenticate with')
    .action(async (options: { url?: string }) => {
      try {
        await handleLogin(options.url);
      } catch (error: unknown) {
        logger.error('Login failed:', error);
        process.exit(1);
      }
    });

  return command;
}

function createLogoutCommand(): Command {
  const command = new Command('logout');

  command
    .description('Clear SSO credentials and logout for active profile')
    .action(async () => {
      try {
        await handleLogout();
      } catch (error: unknown) {
        logger.error('Logout failed:', error);
        process.exit(1);
      }
    });

  return command;
}

function createRefreshCommand(): Command {
  const command = new Command('refresh');

  command
    .description('Refresh SSO credentials for active profile')
    .action(async () => {
      try {
        await handleRefresh();
      } catch (error: unknown) {
        logger.error('Refresh failed:', error);
        process.exit(1);
      }
    });

  return command;
}

async function handleLogin(url?: string): Promise<void> {
  const config = await ConfigLoader.load();

  const codeMieUrl = url || config.codeMieUrl;
  if (!codeMieUrl) {
    console.log(chalk.red('❌ No AI/Run CodeMie URL configured or provided'));
    console.log(chalk.white('Use: codemie profile login --url https://your-airun-codemie-instance.com'));
    return;
  }

  const ora = (await import('ora')).default;
  const spinner = ora('Launching SSO authentication...').start();

  try {
    const { CodeMieSSO } = await import('../../providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const result = await sso.authenticate({ codeMieUrl, timeout: 120000 });

    if (result.success) {
      spinner.succeed(chalk.green('SSO authentication successful'));
      console.log(chalk.cyan(`🔗 Connected to: ${codeMieUrl}`));
      console.log(chalk.cyan(`🔑 Credentials stored securely`));

      console.log('');
      console.log(chalk.bold('  Next Steps:'));
      console.log('');
      console.log('  ' + chalk.white('• Check auth status:') + '    ' + chalk.cyan('codemie profile status'));
      console.log('  ' + chalk.white('• Refresh token:') + '        ' + chalk.cyan('codemie profile refresh'));
      console.log('  ' + chalk.white('• Create profile:') + '       ' + chalk.cyan('codemie setup'));
      console.log('  ' + chalk.white('• Verify system:') + '        ' + chalk.cyan('codemie doctor'));
      console.log('  ' + chalk.white('• Explore more:') + '         ' + chalk.cyan('codemie --help'));
      console.log('');
    } else {
      spinner.fail(chalk.red('SSO authentication failed'));
      console.log(chalk.red(`Error: ${result.error}`));
    }
  } catch (error) {
    spinner.fail(chalk.red('Authentication error'));
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleLogout(): Promise<void> {
  const config = await ConfigLoader.load();
  const baseUrl = config.codeMieUrl || config.baseUrl;

  if (!baseUrl) {
    console.log(chalk.red('❌ No base URL configured'));
    console.log(chalk.white('Run: codemie setup'));
    return;
  }

  const ora = (await import('ora')).default;
  const spinner = ora('Clearing SSO credentials...').start();

  try {
    const { CodeMieSSO } = await import('../../providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    await sso.clearStoredCredentials();

    spinner.succeed(chalk.green('Successfully logged out'));
    console.log(chalk.white(`SSO credentials cleared for ${baseUrl}`));
  } catch (error) {
    spinner.fail(chalk.red('Logout failed'));
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleStatus(): Promise<void> {
  const config = await ConfigLoader.load();
  const profileName = await ConfigLoader.getActiveProfileName();
  const baseUrl = config.codeMieUrl || config.baseUrl;

  console.log(chalk.bold('\n📋 Profile Status:\n'));

  // Use common renderProfileInfo helper
  console.log(await renderProfileInfo({
    profile: profileName || 'default',
    provider: config.provider,
    baseUrl,
    model: config.model,
    timeout: config.timeout,
    debug: config.debug,
    showAuthStatus: true
  }));

  // For SSO profiles, add API health check
  if (config.provider === 'ai-run-sso' && baseUrl) {
    try {
      const { CredentialStore } = await import('../../utils/credential-store.js');
      const store = CredentialStore.getInstance();
      const credentials = await store.retrieveSSOCredentials();

      if (credentials) {
        // Test API access
        const ora = (await import('ora')).default;
        const spinner = ora('Testing API access...').start();
        try {
          const { fetchCodeMieModels } = await import('../../providers/plugins/sso/sso.http-client.js');
          await fetchCodeMieModels(credentials.apiUrl, credentials.cookies);
          spinner.succeed(chalk.green('API access working'));
        } catch (error) {
          spinner.fail(chalk.red('API access failed'));
          console.log(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    } catch (error) {
      console.log(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

async function handleRefresh(): Promise<void> {
  const config = await ConfigLoader.load();

  // Check if current provider uses SSO authentication
  const baseUrl = config.codeMieUrl || config.baseUrl;

  if (config.provider !== 'ai-run-sso' || !baseUrl) {
    console.log(chalk.red('❌ Not configured for SSO authentication'));
    console.log(chalk.white('Run: codemie setup'));
    return;
  }

  // Clear existing credentials and re-authenticate
  const { CodeMieSSO } = await import('../../providers/plugins/sso/sso.auth.js');
  const sso = new CodeMieSSO();
  await sso.clearStoredCredentials();

  await handleLogin(baseUrl);
}
