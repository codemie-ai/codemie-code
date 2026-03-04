/**
 * Plugin CLI Command
 *
 * Manages the native plugin system:
 * - codemie plugin list     — List installed/enabled plugins
 * - codemie plugin install  — Install from local path or git URL
 * - codemie plugin uninstall — Remove a plugin
 * - codemie plugin enable   — Enable a disabled plugin
 * - codemie plugin disable  — Disable without removing
 */

import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../../utils/logger.js';
import {
  resolvePlugins,
  installPluginToCache,
  removePluginFromCache,
  enablePlugin,
  disablePlugin,
  readPluginSettings,
  parseManifest,
} from '../../plugins/core/index.js';

/**
 * Create the plugin list subcommand
 */
function createPluginListCommand(): Command {
  return new Command('list')
    .description('List all discovered plugins and their status')
    .option('--cwd <path>', 'Working directory for project plugins', process.cwd())
    .action(async (options) => {
      try {
        const settings = await readPluginSettings();
        const plugins = await resolvePlugins({
          cwd: options.cwd,
          settings,
        });

        if (plugins.length === 0) {
          console.log(chalk.yellow('\nNo plugins found.\n'));
          console.log(chalk.white('Install plugins with:'));
          console.log(`  ${chalk.cyan('codemie plugin install <path>')}`);
          console.log('');
          console.log(chalk.white('Or place plugins in:'));
          console.log(`  ${chalk.cyan('.codemie/plugins/')} (project-specific)`);
          console.log(`  ${chalk.cyan('~/.codemie/plugins/cache/')} (user-level)`);
          console.log('');
          return;
        }

        const table = new Table({
          head: [
            chalk.bold('Name'),
            chalk.bold('Version'),
            chalk.bold('Description'),
            chalk.bold('Source'),
            chalk.bold('Status'),
            chalk.bold('Components'),
          ],
          colWidths: [22, 10, 30, 10, 10, 25],
          wordWrap: true,
        });

        for (const plugin of plugins) {
          const components: string[] = [];
          if (plugin.skills.length > 0) components.push(`${plugin.skills.length} skills`);
          if (plugin.commands.length > 0) components.push(`${plugin.commands.length} cmds`);
          if (plugin.agents.length > 0) components.push(`${plugin.agents.length} agents`);
          if (plugin.hooks) components.push('hooks');
          if (plugin.mcpServers) components.push('mcp');

          table.push([
            chalk.bold(plugin.manifest.name),
            plugin.manifest.version || chalk.dim('n/a'),
            plugin.manifest.description || chalk.dim('No description'),
            formatSource(plugin.source),
            plugin.enabled ? chalk.green('enabled') : chalk.red('disabled'),
            components.join(', ') || chalk.dim('none'),
          ]);
        }

        console.log('');
        console.log(chalk.bold(`Plugins (${plugins.length} found)`));
        console.log(table.toString());
        console.log('');
      } catch (error) {
        logger.error('Failed to list plugins:', error);
        console.error(chalk.red(`Failed to list plugins: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });
}

/**
 * Create the plugin install subcommand
 */
function createPluginInstallCommand(): Command {
  return new Command('install')
    .description('Install a plugin from a local path')
    .argument('<path>', 'Local path to plugin directory')
    .action(async (pluginPath: string) => {
      try {
        const resolvedPath = resolve(pluginPath);

        if (!existsSync(resolvedPath)) {
          console.error(chalk.red(`\nPlugin path does not exist: ${resolvedPath}\n`));
          process.exit(1);
        }

        // Validate it's a valid plugin
        const manifest = await parseManifest(resolvedPath);
        console.log(chalk.white(`\nInstalling plugin "${chalk.bold(manifest.name)}"...`));

        // Copy to cache
        const cacheDir = await installPluginToCache(resolvedPath);

        console.log(chalk.green(`\nPlugin "${manifest.name}" installed successfully.`));
        console.log(chalk.dim(`  Location: ${cacheDir}`));
        if (manifest.version) {
          console.log(chalk.dim(`  Version: ${manifest.version}`));
        }
        console.log('');
      } catch (error) {
        logger.error('Failed to install plugin:', error);
        console.error(chalk.red(`\nFailed to install plugin: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });
}

/**
 * Create the plugin uninstall subcommand
 */
function createPluginUninstallCommand(): Command {
  return new Command('uninstall')
    .description('Remove a plugin from the cache')
    .argument('<name>', 'Plugin name to uninstall')
    .action(async (pluginName: string) => {
      try {
        const removed = await removePluginFromCache(pluginName);

        if (!removed) {
          console.log(chalk.yellow(`\nPlugin "${pluginName}" is not installed.\n`));
          process.exit(1);
        }

        console.log(chalk.green(`\nPlugin "${pluginName}" uninstalled successfully.\n`));
      } catch (error) {
        logger.error('Failed to uninstall plugin:', error);
        console.error(chalk.red(`\nFailed to uninstall: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });
}

/**
 * Create the plugin enable subcommand
 */
function createPluginEnableCommand(): Command {
  return new Command('enable')
    .description('Enable a disabled plugin')
    .argument('<name>', 'Plugin name to enable')
    .action(async (pluginName: string) => {
      try {
        await enablePlugin(pluginName);
        console.log(chalk.green(`\nPlugin "${pluginName}" enabled.\n`));
      } catch (error) {
        logger.error('Failed to enable plugin:', error);
        console.error(chalk.red(`\nFailed to enable: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });
}

/**
 * Create the plugin disable subcommand
 */
function createPluginDisableCommand(): Command {
  return new Command('disable')
    .description('Disable a plugin without removing it')
    .argument('<name>', 'Plugin name to disable')
    .action(async (pluginName: string) => {
      try {
        await disablePlugin(pluginName);
        console.log(chalk.green(`\nPlugin "${pluginName}" disabled.\n`));
      } catch (error) {
        logger.error('Failed to disable plugin:', error);
        console.error(chalk.red(`\nFailed to disable: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exit(1);
      }
    });
}

/**
 * Format plugin source with color
 */
function formatSource(source: string): string {
  switch (source) {
    case 'project':
      return chalk.green('project');
    case 'user':
      return chalk.blue('user');
    case 'local':
      return chalk.yellow('local');
    default:
      return source;
  }
}

/**
 * Create the main plugin command with subcommands
 */
export function createPluginCommand(): Command {
  const plugin = new Command('plugin')
    .description('Manage native plugins (Anthropic format)');

  plugin.addCommand(createPluginListCommand());
  plugin.addCommand(createPluginInstallCommand());
  plugin.addCommand(createPluginUninstallCommand());
  plugin.addCommand(createPluginEnableCommand());
  plugin.addCommand(createPluginDisableCommand());

  return plugin;
}
