import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import {
  PluginRegistry,
  PluginInstaller,
  MarketplaceClient,
  MarketplaceRegistry,
} from '../../plugins/index.js';
import type { LoadedPlugin } from '../../plugins/index.js';

/**
 * Format plugin source with color
 */
function formatSource(plugin: LoadedPlugin): string {
  if (plugin.isDevelopment) {
    return chalk.yellow('dev');
  }
  if (plugin.installedMeta?.source === 'marketplace') {
    return chalk.green('marketplace');
  }
  return chalk.blue('local');
}

/**
 * Create plugin list command
 */
function createListCommand(): Command {
  return new Command('list')
    .description('List all installed plugins')
    .option('--verbose', 'Show detailed information')
    .action(async (options) => {
      try {
        const registry = PluginRegistry.getInstance();
        const plugins = await registry.getAllPlugins();

        if (plugins.length === 0) {
          console.log(chalk.yellow('\nNo plugins installed\n'));
          console.log(chalk.white('Install plugins using:'));
          console.log(`  ${chalk.cyan('codemie plugin install <name>')}`);
          console.log('');
          console.log(chalk.white('Search for plugins:'));
          console.log(`  ${chalk.cyan('codemie plugin search <query>')}`);
          console.log('');
          return;
        }

        // Create table
        const table = new Table({
          head: [
            chalk.bold('Name'),
            chalk.bold('Version'),
            chalk.bold('Source'),
            chalk.bold('Skills'),
            chalk.bold('Description'),
          ],
          colWidths: [20, 12, 15, 8, 45],
          wordWrap: true,
        });

        // Add rows
        for (const plugin of plugins) {
          table.push([
            chalk.bold(plugin.name),
            plugin.manifest.version,
            formatSource(plugin),
            plugin.skillCount.toString(),
            plugin.manifest.description,
          ]);
        }

        console.log('');
        console.log(chalk.bold(`Plugins (${plugins.length} installed)`));
        console.log(table.toString());

        // Show verbose details
        if (options.verbose) {
          console.log('');
          for (const plugin of plugins) {
            console.log(chalk.bold(`\n${plugin.name}:`));
            console.log(`  Path: ${chalk.dim(plugin.path)}`);
            if (plugin.skillNames.length > 0) {
              console.log(`  Skills: ${plugin.skillNames.join(', ')}`);
            }
            if (plugin.loadErrors.length > 0) {
              console.log(chalk.red(`  Errors: ${plugin.loadErrors.join(', ')}`));
            }
            if (plugin.installedMeta) {
              console.log(`  Installed: ${plugin.installedMeta.installedAt}`);
              if (plugin.installedMeta.repositoryUrl) {
                console.log(`  Repository: ${plugin.installedMeta.repositoryUrl}`);
              }
            }
          }
        }

        console.log('');
      } catch (error) {
        logger.error('Failed to list plugins:', error);
        process.exit(1);
      }
    });
}

/**
 * Create plugin install command
 */
function createInstallCommand(): Command {
  return new Command('install')
    .description('Install a plugin from the marketplace')
    .argument('<name>', 'Plugin name to install')
    .option('--dir <path>', 'Install from a local directory')
    .option('--source <id>', 'Marketplace source ID')
    .option('--force', 'Force reinstall if already installed')
    .action(async (name, options) => {
      try {
        const installer = new PluginInstaller();

        // Install from local directory
        if (options.dir) {
          console.log(chalk.white(`\nInstalling plugin from ${options.dir}...\n`));
          const result = await installer.installFromLocal(options.dir);

          if (result.success) {
            console.log(chalk.green(`${result.message}`));
            console.log(chalk.dim(`  Path: ${result.installedPath}`));
          } else {
            console.log(chalk.red(`${result.message}`));
            process.exit(1);
          }
          console.log('');
          return;
        }

        // Install from marketplace
        console.log(chalk.white(`\nInstalling plugin '${name}' from marketplace...\n`));

        const result = await installer.install(name, {
          force: options.force,
          sourceId: options.source,
        });

        if (result.success) {
          console.log(chalk.green(`${result.message}`));
          console.log(chalk.dim(`  Path: ${result.installedPath}`));

          // Reload registry
          await PluginRegistry.getInstance().reload();
        } else {
          console.log(chalk.red(`${result.message}`));
          process.exit(1);
        }

        console.log('');
      } catch (error) {
        logger.error('Failed to install plugin:', error);
        process.exit(1);
      }
    });
}

/**
 * Create plugin uninstall command
 */
function createUninstallCommand(): Command {
  return new Command('uninstall')
    .description('Uninstall a plugin')
    .argument('<name>', 'Plugin name to uninstall')
    .action(async (name) => {
      try {
        console.log(chalk.white(`\nUninstalling plugin '${name}'...\n`));

        const installer = new PluginInstaller();
        const result = await installer.uninstall(name);

        if (result.success) {
          console.log(chalk.green(`${result.message}`));

          // Reload registry
          await PluginRegistry.getInstance().reload();
        } else {
          console.log(chalk.red(`${result.message}`));
          process.exit(1);
        }

        console.log('');
      } catch (error) {
        logger.error('Failed to uninstall plugin:', error);
        process.exit(1);
      }
    });
}

/**
 * Create plugin update command
 */
function createUpdateCommand(): Command {
  return new Command('update')
    .description('Update a plugin to the latest version')
    .argument('[name]', 'Plugin name to update (updates all if not specified)')
    .action(async (name) => {
      try {
        const installer = new PluginInstaller();

        if (name) {
          // Update specific plugin
          console.log(chalk.white(`\nUpdating plugin '${name}'...\n`));
          const result = await installer.update(name);

          if (result.success) {
            console.log(chalk.green(`${result.message}`));
          } else {
            console.log(chalk.red(`${result.message}`));
            process.exit(1);
          }
        } else {
          // Check for updates for all plugins
          console.log(chalk.white('\nChecking for updates...\n'));
          const updates = await installer.checkForUpdates();

          const hasUpdates = updates.filter((u) => u.hasUpdate);

          if (hasUpdates.length === 0) {
            console.log(chalk.green('All plugins are up to date'));
          } else {
            console.log(chalk.yellow(`Updates available for ${hasUpdates.length} plugin(s):\n`));

            for (const update of hasUpdates) {
              console.log(
                `  ${chalk.bold(update.pluginName)}: ${update.currentVersion} -> ${chalk.green(update.latestVersion)}`
              );
            }

            console.log('');
            console.log(chalk.dim('Run `codemie plugin update <name>` to update a specific plugin'));
          }
        }

        // Reload registry
        await PluginRegistry.getInstance().reload();

        console.log('');
      } catch (error) {
        logger.error('Failed to update plugin:', error);
        process.exit(1);
      }
    });
}

/**
 * Create plugin search command
 */
function createSearchCommand(): Command {
  return new Command('search')
    .description('Search for plugins in the marketplace')
    .argument('<query>', 'Search query')
    .action(async (query) => {
      try {
        console.log(chalk.white(`\nSearching for '${query}'...\n`));

        const client = new MarketplaceClient();
        const registryClient = MarketplaceRegistry.getInstance();
        const sources = await registryClient.getEnabledSources();

        const results = await client.search(query, sources);

        if (results.length === 0) {
          console.log(chalk.yellow('No plugins found matching your query'));
          console.log('');
          return;
        }

        // Create table
        const table = new Table({
          head: [
            chalk.bold('Name'),
            chalk.bold('Version'),
            chalk.bold('Source'),
            chalk.bold('Description'),
          ],
          colWidths: [25, 12, 25, 40],
          wordWrap: true,
        });

        // Add rows (limit to top 10)
        const topResults = results.slice(0, 10);
        for (const result of topResults) {
          table.push([
            chalk.bold(result.plugin.name),
            result.plugin.version,
            chalk.dim(result.sourceName),
            result.plugin.description,
          ]);
        }

        console.log(table.toString());

        if (results.length > 10) {
          console.log(chalk.dim(`\n  ... and ${results.length - 10} more results`));
        }

        console.log('');
        console.log(chalk.dim('Install with: codemie plugin install <name>'));
        console.log('');
      } catch (error) {
        logger.error('Failed to search plugins:', error);
        process.exit(1);
      }
    });
}

/**
 * Create plugin info command
 */
function createInfoCommand(): Command {
  return new Command('info')
    .description('Show detailed information about a plugin')
    .argument('<name>', 'Plugin name')
    .action(async (name) => {
      try {
        // First check if installed
        const registry = PluginRegistry.getInstance();
        const installedPlugin = await registry.getPlugin(name);

        if (installedPlugin) {
          console.log('');
          console.log(chalk.bold(`${installedPlugin.name} (installed)`));
          console.log('');
          console.log(`  ${chalk.bold('Version:')} ${installedPlugin.manifest.version}`);
          console.log(`  ${chalk.bold('Description:')} ${installedPlugin.manifest.description}`);

          if (installedPlugin.manifest.author) {
            console.log(`  ${chalk.bold('Author:')} ${installedPlugin.manifest.author}`);
          }
          if (installedPlugin.manifest.license) {
            console.log(`  ${chalk.bold('License:')} ${installedPlugin.manifest.license}`);
          }
          if (installedPlugin.manifest.homepage) {
            console.log(`  ${chalk.bold('Homepage:')} ${installedPlugin.manifest.homepage}`);
          }

          console.log('');
          console.log(`  ${chalk.bold('Path:')} ${installedPlugin.path}`);
          console.log(`  ${chalk.bold('Skills:')} ${installedPlugin.skillCount}`);

          if (installedPlugin.skillNames.length > 0) {
            console.log(`  ${chalk.bold('Skill names:')} ${installedPlugin.skillNames.join(', ')}`);
          }

          if (installedPlugin.installedMeta) {
            console.log('');
            console.log(`  ${chalk.bold('Installed:')} ${installedPlugin.installedMeta.installedAt}`);
            console.log(`  ${chalk.bold('Source:')} ${installedPlugin.installedMeta.source}`);
            if (installedPlugin.installedMeta.repositoryUrl) {
              console.log(`  ${chalk.bold('Repository:')} ${installedPlugin.installedMeta.repositoryUrl}`);
            }
          }

          console.log('');
          return;
        }

        // Search in marketplace
        const client = new MarketplaceClient();
        const registryClient = MarketplaceRegistry.getInstance();
        const sources = await registryClient.getEnabledSources();

        for (const source of sources) {
          const plugin = await client.getPlugin(source, name);
          if (plugin) {
            console.log('');
            console.log(chalk.bold(`${plugin.name} (available)`));
            console.log('');
            console.log(`  ${chalk.bold('Version:')} ${plugin.version}`);
            console.log(`  ${chalk.bold('Description:')} ${plugin.description}`);

            if (plugin.author) {
              console.log(`  ${chalk.bold('Author:')} ${plugin.author}`);
            }
            if (plugin.category) {
              console.log(`  ${chalk.bold('Category:')} ${plugin.category}`);
            }
            if (plugin.keywords && plugin.keywords.length > 0) {
              console.log(`  ${chalk.bold('Keywords:')} ${plugin.keywords.join(', ')}`);
            }

            console.log('');
            console.log(chalk.dim(`Install with: codemie plugin install ${plugin.name}`));
            console.log('');
            return;
          }
        }

        console.log(chalk.yellow(`\nPlugin '${name}' not found\n`));
        process.exit(1);
      } catch (error) {
        logger.error('Failed to get plugin info:', error);
        process.exit(1);
      }
    });
}

/**
 * Create marketplace subcommand group
 */
function createMarketplaceCommand(): Command {
  const marketplace = new Command('marketplace')
    .description('Manage marketplace sources');

  // marketplace list
  marketplace.addCommand(
    new Command('list')
      .description('List configured marketplace sources')
      .action(async () => {
        try {
          const registry = MarketplaceRegistry.getInstance();
          const sources = await registry.getSources();

          if (sources.length === 0) {
            console.log(chalk.yellow('\nNo marketplace sources configured\n'));
            return;
          }

          // Create table
          const table = new Table({
            head: [
              chalk.bold('ID'),
              chalk.bold('Name'),
              chalk.bold('Repository'),
              chalk.bold('Status'),
            ],
            colWidths: [25, 25, 35, 12],
          });

          for (const source of sources) {
            table.push([
              source.isDefault ? chalk.bold(source.id) : source.id,
              source.name,
              source.repository,
              source.enabled
                ? chalk.green('enabled')
                : chalk.dim('disabled'),
            ]);
          }

          console.log('');
          console.log(chalk.bold('Marketplace Sources'));
          console.log(table.toString());
          console.log('');
        } catch (error) {
          logger.error('Failed to list marketplace sources:', error);
          process.exit(1);
        }
      })
  );

  // marketplace add
  marketplace.addCommand(
    new Command('add')
      .description('Add a new marketplace source')
      .argument('<repository>', 'GitHub repository (owner/repo)')
      .option('--id <id>', 'Custom source ID')
      .option('--name <name>', 'Custom display name')
      .option('--branch <branch>', 'Branch to use (default: main)')
      .action(async (repository, options) => {
        try {
          const registry = MarketplaceRegistry.getInstance();

          // Generate ID from repository if not provided
          const id = options.id || repository.replace('/', '-');
          const name = options.name || repository;

          await registry.addSource({
            id,
            name,
            type: 'github',
            repository,
            branch: options.branch,
            enabled: true,
          });

          console.log(chalk.green(`\nAdded marketplace source '${id}'\n`));
        } catch (error) {
          logger.error('Failed to add marketplace source:', error);
          process.exit(1);
        }
      })
  );

  // marketplace remove
  marketplace.addCommand(
    new Command('remove')
      .description('Remove a marketplace source')
      .argument('<id>', 'Source ID to remove')
      .action(async (id) => {
        try {
          const registry = MarketplaceRegistry.getInstance();
          await registry.removeSource(id);

          console.log(chalk.green(`\nRemoved marketplace source '${id}'\n`));
        } catch (error) {
          logger.error('Failed to remove marketplace source:', error);
          process.exit(1);
        }
      })
  );

  return marketplace;
}

/**
 * Create main plugin command with subcommands
 */
export function createPluginCommand(): Command {
  const plugin = new Command('plugin')
    .description('Manage CodeMie plugins');

  // Add subcommands
  plugin.addCommand(createListCommand());
  plugin.addCommand(createInstallCommand());
  plugin.addCommand(createUninstallCommand());
  plugin.addCommand(createUpdateCommand());
  plugin.addCommand(createSearchCommand());
  plugin.addCommand(createInfoCommand());
  plugin.addCommand(createMarketplaceCommand());

  return plugin;
}
