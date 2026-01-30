import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import {
  checkForCliUpdate,
  updateCli,
  isAutoUpdateEnabled
} from '../../utils/cli-updater.js';
import { getErrorMessage } from '../../utils/errors.js';

export function createSelfUpdateCommand(): Command {
  const command = new Command('self-update');

  command
    .description('Update CodeMie CLI to the latest version')
    .option('-c, --check', 'Check for updates without installing')
    .action(async (options?: { check?: boolean }) => {
      try {
        const checkOnly = options?.check ?? false;

        const spinner = ora('Checking for CodeMie CLI updates...').start();

        const result = await checkForCliUpdate();

        if (!result) {
          spinner.fail('Could not check for updates');
          console.log();
          console.log(chalk.yellow('  Please check your internet connection and try again.'));
          console.log();
          process.exit(1);
        }

        if (!result.hasUpdate) {
          spinner.succeed(`CodeMie CLI is up to date (${result.currentVersion})`);
          console.log();
          return;
        }

        spinner.succeed(`Update available: ${result.currentVersion} → ${chalk.green(result.latestVersion)}`);
        console.log();

        // Check-only mode
        if (checkOnly) {
          console.log(chalk.cyan(`💡 Run 'codemie self-update' to install the update`));
          console.log();
          return;
        }

        // Perform update
        await updateCli(result.latestVersion, false);

        // Show auto-update status
        const autoUpdate = isAutoUpdateEnabled();
        if (autoUpdate) {
          console.log(chalk.dim('  ℹ️  Auto-update is enabled (CODEMIE_AUTO_UPDATE=true)'));
        } else {
          console.log(chalk.dim('  ℹ️  Auto-update is disabled (CODEMIE_AUTO_UPDATE=false)'));
        }
        console.log();

      } catch (error: unknown) {
        console.error(chalk.red(`✗ Self-update failed: ${getErrorMessage(error)}`));
        process.exit(1);
      }
    });

  return command;
}
