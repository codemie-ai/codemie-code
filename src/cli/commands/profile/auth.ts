import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { logger } from '../../../utils/logger.js';
import {
  getPlatformUrl,
  getPlatformUrlCandidates,
  getStoredPlatformCredentials
} from '../../../providers/core/codemie-auth-helpers.js';

// Export individual commands for profile (not nested under 'auth')
export function createLoginCommand(): Command {
  const command = new Command('login');
  command
    .description('Authenticate with AI/Run CodeMie SSO')
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

  const codeMieUrl = url || getPlatformUrl(config);
  if (!codeMieUrl) {
    console.log(chalk.red('❌ No AI/Run CodeMie URL configured or provided'));
    console.log(chalk.white('Use: codemie profile login --url https://your-airun-codemie-instance.com'));
    return;
  }

  const spinner = ora('Launching SSO authentication...').start();

  try {
    const sso = new CodeMieSSO();
    const result = await sso.authenticate({ codeMieUrl, timeout: 120000 });

    if (result.success) {
      spinner.succeed(chalk.green('SSO authentication successful'));
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
      spinner.fail(chalk.red('SSO authentication failed'));
      console.log(chalk.red(`Error: ${result.error}`));
    }
  } catch (error) {
    spinner.fail(chalk.red('Authentication error'));
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleLogout(): Promise<void> {
  const spinner = ora('Clearing SSO credentials...').start();

  try {
    const config = await ConfigLoader.load();
    const candidates = getPlatformUrlCandidates(config);

    // Clear every candidate so logout works regardless of which URL holds the
    // credentials (clearing is idempotent). With no URL, clear the default slot.
    const sso = new CodeMieSSO();
    if (candidates.length === 0) {
      await sso.clearStoredCredentials(undefined);
    }
    for (const candidate of candidates) {
      await sso.clearStoredCredentials(candidate);
    }

    spinner.succeed(chalk.green('Successfully logged out'));
    console.log(chalk.white('SSO credentials have been cleared'));
  } catch (error) {
    spinner.fail(chalk.red('Logout failed'));
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleRefresh(): Promise<void> {
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

  // Clear existing credentials and re-authenticate against the same URL
  const sso = new CodeMieSSO();
  await sso.clearStoredCredentials(url);

  await handleLogin(url);
}