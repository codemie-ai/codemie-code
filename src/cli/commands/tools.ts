/**
 * Tools management CLI commands
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import {
  checkAllTools,
  getToolStatus,
  installTool,
  uninstallTool,
  updateTool,
  authenticateTool,
  getAllTools,
  type VCSTool,
} from '../../tools/index.js';

export function createToolsCommand(): Command {
  const tools = new Command('tools')
    .description('Manage VCS CLI tools (GitHub CLI, GitLab CLI)');

  // Check command
  tools
    .command('check')
    .description('Check status of all VCS tools')
    .action(async () => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║        VCS Tools Status              ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      const spinner = ora('Checking installed tools...').start();

      const status = checkAllTools();
      spinner.succeed(chalk.green('Tools checked'));

      console.log('');

      // Git status
      if (status.git.installed) {
        console.log(`${chalk.green('✓')} Git ${chalk.dim(`(v${status.git.version})`)}`);
      } else {
        console.log(`${chalk.red('✗')} Git ${chalk.dim('(not installed)')}`);
      }

      console.log('');

      // GitHub CLI status
      if (status.gh.installed) {
        const authStatus = status.gh.authenticated
          ? chalk.green(`authenticated as ${status.gh.authUser}`)
          : chalk.yellow('not authenticated');
        console.log(
          `${chalk.green('✓')} GitHub CLI (gh) ${chalk.dim(`v${status.gh.version}`)} - ${authStatus}`
        );
      } else {
        console.log(`${chalk.red('✗')} GitHub CLI (gh) ${chalk.dim('not installed')}`);
        console.log(chalk.dim('   Install with: codemie tools install gh'));
      }

      console.log('');

      // GitLab CLI status
      if (status.glab.installed) {
        const authStatus = status.glab.authenticated
          ? chalk.green(`authenticated as ${status.glab.authUser}`)
          : chalk.yellow('not authenticated');
        console.log(
          `${chalk.green('✓')} GitLab CLI (glab) ${chalk.dim(`v${status.glab.version}`)} - ${authStatus}`
        );
      } else {
        console.log(`${chalk.red('✗')} GitLab CLI (glab) ${chalk.dim('not installed')}`);
        console.log(chalk.dim('   Install with: codemie tools install glab'));
      }

      console.log('');
    });

  // Install command
  tools
    .command('install <tools...>')
    .description('Install VCS CLI tools via npm')
    .option('-f, --force', 'Force reinstall if already installed')
    .action(async (toolNames: string[], options: { force?: boolean }) => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║        Install VCS Tools             ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      for (const toolName of toolNames) {
        if (toolName !== 'gh' && toolName !== 'glab') {
          console.log(chalk.red(`✗ Unknown tool: ${toolName}`));
          console.log(chalk.dim('  Available tools: gh, glab\n'));
          continue;
        }

        const tool = toolName as VCSTool;

        try {
          const spinner = ora(`Installing ${toolName}...`).start();

          await installTool(tool, { force: options.force });

          spinner.succeed(chalk.green(`${toolName} installed successfully`));

          // Check authentication
          const status = getToolStatus(tool);
          if (!status.authenticated) {
            console.log(
              chalk.yellow(`⚠ ${toolName} is not authenticated. Run: codemie tools auth ${toolName}`)
            );
          }
        } catch (error) {
          console.log(chalk.red(`✗ Failed to install ${toolName}`));
          console.log(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}`));
        }
      }

      console.log('');
    });

  // Uninstall command
  tools
    .command('uninstall <tool>')
    .description('Uninstall a VCS CLI tool')
    .action(async (toolName: string) => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan(`║       Uninstall ${toolName.padEnd(20)} ║`));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      if (toolName !== 'gh' && toolName !== 'glab') {
        console.log(chalk.red(`✗ Unknown tool: ${toolName}`));
        console.log(chalk.dim('  Available tools: gh, glab\n'));
        return;
      }

      const tool = toolName as VCSTool;

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to uninstall ${toolName}?`,
          default: false
        }
      ]);

      if (!confirm) {
        console.log(chalk.yellow('\nUninstall cancelled\n'));
        return;
      }

      try {
        const spinner = ora(`Uninstalling ${toolName}...`).start();

        await uninstallTool(tool);

        spinner.succeed(chalk.green(`${toolName} uninstalled successfully`));
        console.log('');
      } catch (error) {
        console.log(chalk.red(`✗ Failed to uninstall ${toolName}`));
        console.log(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
    });

  // Update command
  tools
    .command('update <tool>')
    .description('Update a VCS CLI tool')
    .action(async (toolName: string) => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan(`║         Update ${toolName.padEnd(20)} ║`));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      if (toolName !== 'gh' && toolName !== 'glab') {
        console.log(chalk.red(`✗ Unknown tool: ${toolName}`));
        console.log(chalk.dim('  Available tools: gh, glab\n'));
        return;
      }

      const tool = toolName as VCSTool;

      try {
        const spinner = ora(`Updating ${toolName}...`).start();

        await updateTool(tool);

        spinner.succeed(chalk.green(`${toolName} updated successfully`));
        console.log('');
      } catch (error) {
        console.log(chalk.red(`✗ Failed to update ${toolName}`));
        console.log(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
    });

  // Auth command
  tools
    .command('auth <tool>')
    .description('Authenticate a VCS CLI tool')
    .option('-t, --token <token>', 'Authentication token')
    .action(async (toolName: string, options: { token?: string }) => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan(`║      Authenticate ${toolName.padEnd(16)} ║`));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      if (toolName !== 'gh' && toolName !== 'glab') {
        console.log(chalk.red(`✗ Unknown tool: ${toolName}`));
        console.log(chalk.dim('  Available tools: gh, glab\n'));
        return;
      }

      const tool = toolName as VCSTool;

      try {
        console.log(chalk.dim('This will open your browser for authentication...\n'));

        await authenticateTool(tool, options.token);

        console.log('');
        console.log(chalk.green(`✓ ${toolName} authenticated successfully\n`));
      } catch (error) {
        console.log('');
        console.log(chalk.red(`✗ Failed to authenticate ${toolName}`));
        console.log(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
    });

  // Auth status command
  tools
    .command('auth-status')
    .description('Check authentication status for all tools')
    .action(async () => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║      Authentication Status           ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      const status = checkAllTools();

      // GitHub CLI
      if (status.gh.installed) {
        if (status.gh.authenticated) {
          console.log(
            `${chalk.green('✓')} GitHub CLI: ${chalk.green(`authenticated as ${status.gh.authUser}`)}`
          );
        } else {
          console.log(`${chalk.yellow('⚠')} GitHub CLI: ${chalk.yellow('not authenticated')}`);
          console.log(chalk.dim('   Run: codemie tools auth gh'));
        }
      } else {
        console.log(`${chalk.red('✗')} GitHub CLI: ${chalk.dim('not installed')}`);
      }

      console.log('');

      // GitLab CLI
      if (status.glab.installed) {
        if (status.glab.authenticated) {
          console.log(
            `${chalk.green('✓')} GitLab CLI: ${chalk.green(`authenticated as ${status.glab.authUser}`)}`
          );
        } else {
          console.log(`${chalk.yellow('⚠')} GitLab CLI: ${chalk.yellow('not authenticated')}`);
          console.log(chalk.dim('   Run: codemie tools auth glab'));
        }
      } else {
        console.log(`${chalk.red('✗')} GitLab CLI: ${chalk.dim('not installed')}`);
      }

      console.log('');
    });

  // List command
  tools
    .command('list')
    .description('List all available VCS tools')
    .action(async () => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║       Available VCS Tools            ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      const allTools = getAllTools();
      const status = checkAllTools();

      for (const toolInfo of allTools) {
        const toolStatus = status[toolInfo.name];
        const installed = toolStatus.installed ? chalk.green('installed') : chalk.dim('not installed');

        console.log(chalk.bold(toolInfo.displayName) + ` (${toolInfo.name})`);
        console.log(chalk.dim(`  ${toolInfo.description}`));
        console.log(`  Status: ${installed}`);
        if (toolStatus.installed) {
          console.log(chalk.dim(`  Version: ${toolStatus.version}`));
          console.log(
            `  Auth: ${toolStatus.authenticated ? chalk.green('✓') : chalk.yellow('✗')}`
          );
        }
        console.log(chalk.dim(`  npm: ${toolInfo.npmPackage}`));
        console.log(chalk.dim(`  Docs: ${toolInfo.docsUrl}`));
        console.log('');
      }
    });

  return tools;
}
