import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { logger } from '../../../utils/logger.js';
import {
  getPlatformUrl,
  getStoredPlatformCredentials
} from '../../../providers/core/codemie-auth-helpers.js';

interface HeadlessFlags {
  /** commander sets browser=false for --no-browser */
  browser?: boolean;
  headless?: boolean;
}

function isHeadless(options: HeadlessFlags): boolean {
  return options.browser === false || options.headless === true;
}

// Export individual commands for profile (not nested under 'auth')
export function createLoginCommand(): Command {
  const command = new Command('login');
  command
    .description('Authenticate with AI/Run CodeMie SSO')
    .option('--url <url>', 'AI/Run CodeMie URL to authenticate with')
    .option('--no-browser', 'Do not open a browser: print the login URL and paste the result back')
    .option('--headless', 'Alias for --no-browser')
    .action(async (options: { url?: string } & HeadlessFlags) => {
      try {
        await handleLogin(options.url, isHeadless(options));
      } catch (error: unknown) {
        logger.error('Login failed:', error);
        process.exit(1);
      }
    });

  return command;
}

export function createLogoutCommand(): Command {
  const command = new Command('logout');

  command
    .description('Clear SSO credentials and logout')
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

export function createRefreshCommand(): Command {
  const command = new Command('refresh');

  command
    .description('Refresh SSO credentials')
    .option('--no-browser', 'Do not open a browser: print the login URL and paste the result back')
    .option('--headless', 'Alias for --no-browser')
    .action(async (options: HeadlessFlags) => {
      try {
        await handleRefresh(isHeadless(options));
      } catch (error: unknown) {
        logger.error('Refresh failed:', error);
        process.exit(1);
      }
    });

  return command;
}

async function handleLogin(url?: string, headless = false): Promise<void> {
  const config = await ConfigLoader.load();

  const codeMieUrl = url || getPlatformUrl(config);
  if (!codeMieUrl) {
    console.log(chalk.red('❌ No AI/Run CodeMie URL configured or provided'));
    console.log(chalk.white('Use: codemie profile login --url https://your-airun-codemie-instance.com'));
    return;
  }

  // Headless login prompts for input, so a spinner would fight with the terminal
  const spinner = headless ? undefined : ora('Launching SSO authentication...').start();

  try {
    const sso = new CodeMieSSO();
    const result = await sso.authenticate({ codeMieUrl, timeout: 120000, ...(headless ? { headless: true } : {}) });

    if (result.success) {
      if (spinner) spinner.succeed(chalk.green('SSO authentication successful'));
      else console.log(chalk.green('SSO authentication successful'));
      console.log(chalk.cyan(`🔗 Connected to: ${codeMieUrl}`));
      console.log(chalk.cyan(`🔑 Credentials stored securely`));

      console.log('');
      console.log(chalk.bold('  Next Steps:'));
      console.log('');
      console.log('  ' + chalk.white('• Check profile status:') + '  ' + chalk.cyan('codemie profile status'));
      console.log('  ' + chalk.white('• Refresh token:') + '        ' + chalk.cyan('codemie profile refresh'));
      console.log('  ' + chalk.white('• Create profile:') + '       ' + chalk.cyan('codemie setup'));
      console.log('  ' + chalk.white('• Verify system:') + '        ' + chalk.cyan('codemie doctor'));
      console.log('  ' + chalk.white('• Explore more:') + '         ' + chalk.cyan('codemie --help'));
      console.log('');
    } else {
      if (spinner) spinner.fail(chalk.red('SSO authentication failed'));
      else console.log(chalk.red('SSO authentication failed'));
      console.log(chalk.red(`Error: ${result.error}`));
      process.exitCode = 1;
    }
  } catch (error) {
    if (spinner) spinner.fail(chalk.red('Authentication error'));
    else console.log(chalk.red('Authentication error'));
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  }
}

async function handleLogout(): Promise<void> {
  const spinner = ora('Clearing SSO credentials...').start();

  try {
    const config = await ConfigLoader.load();
    // Clear only the URL that holds this profile's credentials, so logging out of
    // one environment never wipes the login of another. With no URL, clear the
    // default slot.
    const sso = new CodeMieSSO();
    const found = await getStoredPlatformCredentials(config);
    await sso.clearStoredCredentials(found?.url ?? getPlatformUrl(config));

    spinner.succeed(chalk.green('Successfully logged out'));
    console.log(chalk.white('SSO credentials have been cleared'));
  } catch (error) {
    spinner.fail(chalk.red('Logout failed'));
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleRefresh(headless = false): Promise<void> {
  const config = await ConfigLoader.load();

  // Check if current provider uses SSO authentication
  const provider = ProviderRegistry.getProvider(config.provider || '');
  if (!provider || provider.authType !== 'sso') {
    console.log(chalk.red('❌ Not configured for SSO authentication'));
    console.log(chalk.white('Run: codemie setup'));
    return;
  }

  // Refresh the URL that actually holds the credentials, else the first candidate
  const url = (await getStoredPlatformCredentials(config))?.url ?? getPlatformUrl(config);
  if (!url) {
    console.log(chalk.red('❌ No AI/Run CodeMie URL configured'));
    console.log(chalk.white('Run: codemie setup'));
    return;
  }

  // Re-authenticate against the same URL. Headless login can fail on a bad paste, so it must not
  // clear first: a successful login overwrites the stored credentials for this URL anyway.
  if (!headless) {
    const sso = new CodeMieSSO();
    await sso.clearStoredCredentials(url);
  }

  await handleLogin(url, headless);
}