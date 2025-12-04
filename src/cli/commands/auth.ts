import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { CodeMieSSO } from '../../providers/plugins/sso/sso.auth.js';
import { ConfigLoader } from '../../utils/config-loader.js';
import { fetchCodeMieModels } from '../../providers/plugins/sso/sso.http-client.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { logger } from '../../utils/logger.js';

export function createAuthCommand(): Command {
  const command = new Command('auth');
  command.description('Manage SSO authentication');

  // Login command
  const loginCmd = new Command('login');
  loginCmd
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

  // Logout command
  const logoutCmd = new Command('logout');
  logoutCmd
    .description('Clear SSO credentials and logout')
    .action(async () => {
      try {
        await handleLogout();
      } catch (error: unknown) {
        logger.error('Logout failed:', error);
        process.exit(1);
      }
    });

  // Status command
  const statusCmd = new Command('status');
  statusCmd
    .description('Show authentication status')
    .action(async () => {
      try {
        await handleStatus();
      } catch (error: unknown) {
        logger.error('Status check failed:', error);
        process.exit(1);
      }
    });

  // Refresh command
  const refreshCmd = new Command('refresh');
  refreshCmd
    .description('Refresh SSO credentials')
    .action(async () => {
      try {
        await handleRefresh();
      } catch (error: unknown) {
        logger.error('Refresh failed:', error);
        process.exit(1);
      }
    });

  command.addCommand(loginCmd);
  command.addCommand(logoutCmd);
  command.addCommand(statusCmd);
  command.addCommand(refreshCmd);

  return command;
}

async function handleLogin(url?: string): Promise<void> {
  const config = await ConfigLoader.load();

  const codeMieUrl = url || config.codeMieUrl;
  if (!codeMieUrl) {
    console.log(chalk.red('❌ No AI/Run CodeMie URL configured or provided'));
    console.log(chalk.white('Use: codemie auth login --url https://your-airun-codemie-instance.com'));
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
    const sso = new CodeMieSSO();
    await sso.clearStoredCredentials();

    spinner.succeed(chalk.green('Successfully logged out'));
    console.log(chalk.white('SSO credentials have been cleared'));
  } catch (error) {
    spinner.fail(chalk.red('Logout failed'));
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleStatus(): Promise<void> {
  const config = await ConfigLoader.load();

  console.log(chalk.bold('\n🔐 Authentication Status:\n'));

  // Check if current provider uses SSO authentication
  const provider = ProviderRegistry.getProvider(config.provider || '');
  if (!provider || provider.authType !== 'sso') {
    console.log(chalk.yellow('  Provider: Not using SSO authentication'));
    console.log(chalk.white(`  Current provider: ${config.provider || 'unknown'}`));
    return;
  }

  console.log(chalk.green(`  Provider: CodeMie SSO`));
  console.log(chalk.green(`  CodeMie URL: ${config.codeMieUrl || 'not configured'}`));

  try {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials();

    if (credentials) {
      console.log(chalk.green(`  Status: Authenticated`));
      console.log(chalk.green(`  API URL: ${credentials.apiUrl}`));

      if (credentials.expiresAt) {
        const expiresIn = Math.max(0, credentials.expiresAt - Date.now());
        const hours = Math.floor(expiresIn / (1000 * 60 * 60));
        const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60));

        if (expiresIn > 0) {
          console.log(chalk.green(`  Expires in: ${hours}h ${minutes}m`));
        } else {
          console.log(chalk.red(`  Status: Expired`));
        }
      }

      // Test API access
      const spinner = ora('Testing API access...').start();
      try {
        await fetchCodeMieModels(credentials.apiUrl, credentials.cookies);
        spinner.succeed(chalk.green('API access working'));
      } catch (error) {
        spinner.fail(chalk.red('API access failed'));
        console.log(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
      }

    } else {
      console.log(chalk.red(`  Status: Not authenticated`));
      console.log(chalk.white(`  Run: codemie auth login`));
    }
  } catch (error) {
    console.log(chalk.red(`  Status: Error checking credentials`));
    console.log(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleRefresh(): Promise<void> {
  const config = await ConfigLoader.load();

  // Check if current provider uses SSO authentication
  const provider = ProviderRegistry.getProvider(config.provider || '');
  if (!provider || provider.authType !== 'sso' || !config.codeMieUrl) {
    console.log(chalk.red('❌ Not configured for SSO authentication'));
    console.log(chalk.white('Run: codemie setup'));
    return;
  }

  // Clear existing credentials and re-authenticate
  const sso = new CodeMieSSO();
  await sso.clearStoredCredentials();

  await handleLogin(config.codeMieUrl);
}