import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { ChatOpenAI } from '@langchain/openai';

export function createConfigCommand(): Command {
  const command = new Command('config');

  command.description('Manage CodeMie Code configuration');

  // config show - Display configuration with sources
  command
    .command('show')
    .description('Show current configuration with sources')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .action(async (options: { dir: string }) => {
      try {
        await ConfigLoader.showWithSources(options.dir);
      } catch (error: unknown) {
        logger.error('Failed to show configuration:', error);
        process.exit(1);
      }
    });

  // config list - List all available parameters
  command
    .command('list')
    .description('List all available configuration parameters')
    .action(() => {
      console.log(chalk.bold('\nAvailable Configuration Parameters:\n'));

      const params = [
        { name: 'provider', desc: 'LLM provider (anthropic, openai, azure, litellm)' },
        { name: 'baseUrl', desc: 'API endpoint URL' },
        { name: 'apiKey', desc: 'Authentication API key' },
        { name: 'model', desc: 'Model identifier (e.g., claude-sonnet-4, gpt-4)' },
        { name: 'timeout', desc: 'Request timeout in seconds' },
        { name: 'debug', desc: 'Enable debug logging (true/false)' },
        { name: 'mcpServers', desc: 'MCP server names (comma-separated)' },
        { name: 'allowedDirs', desc: 'Allowed directories (comma-separated)' },
        { name: 'ignorePatterns', desc: 'Ignore patterns (comma-separated)' }
      ];

      for (const param of params) {
        console.log(`  ${chalk.cyan(param.name.padEnd(20))} ${chalk.dim(param.desc)}`);
      }

      console.log(chalk.dim('\nSet via:'));
      console.log(chalk.dim('  - Global config:  ~/.codemie/config.json'));
      console.log(chalk.dim('  - Project config: .codemie/config.json'));
      console.log(chalk.dim('  - Environment:    CODEMIE_<PARAM>'));
      console.log(chalk.dim('  - CLI flags:      --<param>\n'));
    });

  // config set - Set a configuration value
  command
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key')
    .argument('<value>', 'Configuration value')
    .option('-g, --global', 'Set in global config (default)', true)
    .option('-p, --project', 'Set in project config')
    .option('-d, --dir <path>', 'Working directory for project config', process.cwd())
    .action(async (key: string, value: string, options: { global?: boolean; project?: boolean; dir: string }) => {
      try {
        const isGlobal = !options.project;

        // Parse value
        const parsedValue = parseConfigValue(value);

        // Load current config
        const currentConfig = isGlobal
          ? await ConfigLoader['loadJsonConfig'](ConfigLoader['GLOBAL_CONFIG'])
          : await ConfigLoader['loadJsonConfig'](`${options.dir}/.codemie/config.json`);

        // Update config
        const updatedConfig = { ...currentConfig, [key]: parsedValue };

        // Save config
        if (isGlobal) {
          await ConfigLoader.saveGlobalConfig(updatedConfig);
          logger.success(`Set ${key} in global config`);
        } else {
          await ConfigLoader.saveProjectConfig(options.dir, updatedConfig);
          logger.success(`Set ${key} in project config`);
        }
      } catch (error: unknown) {
        logger.error('Failed to set configuration:', error);
        process.exit(1);
      }
    });

  // config get - Get a configuration value
  command
    .command('get')
    .description('Get a configuration value')
    .argument('<key>', 'Configuration key')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .action(async (key: string, options: { dir: string }) => {
      try {
        const config = await ConfigLoader.load(options.dir);
        const value = (config as any)[key];

        if (value === undefined) {
          console.log(chalk.yellow(`Configuration key '${key}' not set`));
        } else {
          // Check if sensitive
          const keyLower = key.toLowerCase();
          if (keyLower.includes('key') || keyLower.includes('token')) {
            const masked = ConfigLoader['maskSensitive'](key, value);
            console.log(masked);
          } else {
            console.log(value);
          }
        }
      } catch (error: unknown) {
        logger.error('Failed to get configuration:', error);
        process.exit(1);
      }
    });

  // config edit - Edit configuration interactively
  command
    .command('edit')
    .description('Edit a configuration value interactively')
    .argument('<key>', 'Configuration key')
    .option('-g, --global', 'Edit global config (default)', true)
    .option('-p, --project', 'Edit project config')
    .option('-d, --dir <path>', 'Working directory for project config', process.cwd())
    .action(async (key: string, options: { global?: boolean; project?: boolean; dir: string }) => {
      try {
        const isGlobal = !options.project;

        // Load current value
        const config = await ConfigLoader.load(options.dir);
        const currentValue = (config as any)[key];

        // Prompt for new value
        const isSensitive = key.toLowerCase().includes('key') || key.toLowerCase().includes('token');
        const { newValue } = await inquirer.prompt([
          {
            type: isSensitive ? 'password' : 'input',
            name: 'newValue',
            message: `Enter new value for ${key}:`,
            default: isSensitive ? undefined : currentValue,
            mask: isSensitive ? '*' : undefined
          }
        ]);

        // Parse value
        const parsedValue = parseConfigValue(newValue);

        // Load current config
        const currentConfig = isGlobal
          ? await ConfigLoader['loadJsonConfig'](ConfigLoader['GLOBAL_CONFIG'])
          : await ConfigLoader['loadJsonConfig'](`${options.dir}/.codemie/config.json`);

        // Update config
        const updatedConfig = { ...currentConfig, [key]: parsedValue };

        // Save config
        if (isGlobal) {
          await ConfigLoader.saveGlobalConfig(updatedConfig);
          logger.success(`Updated ${key} in global config`);
        } else {
          await ConfigLoader.saveProjectConfig(options.dir, updatedConfig);
          logger.success(`Updated ${key} in project config`);
        }
      } catch (error: unknown) {
        logger.error('Failed to edit configuration:', error);
        process.exit(1);
      }
    });

  // config reset - Reset configuration
  command
    .command('reset')
    .description('Reset configuration (delete config file)')
    .option('-g, --global', 'Reset global config', true)
    .option('-p, --project', 'Reset project config')
    .option('-d, --dir <path>', 'Working directory for project config', process.cwd())
    .action(async (options: { global?: boolean; project?: boolean; dir: string }) => {
      try {
        const isGlobal = !options.project;

        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Are you sure you want to reset ${isGlobal ? 'global' : 'project'} configuration?`,
            default: false
          }
        ]);

        if (!confirm) {
          console.log(chalk.yellow('Reset cancelled.'));
          return;
        }

        if (isGlobal) {
          await ConfigLoader.saveGlobalConfig({});
          logger.success('Global configuration reset');
          console.log(chalk.dim('\nRun: codemie setup'));
        } else {
          await ConfigLoader.saveProjectConfig(options.dir, {});
          logger.success('Project configuration reset');
        }
      } catch (error: unknown) {
        logger.error('Failed to reset configuration:', error);
        process.exit(1);
      }
    });

  // config test - Test configuration
  command
    .command('test')
    .description('Test connection with current configuration')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .action(async (options: { dir: string }) => {
      try {
        const spinner = ora('Loading configuration...').start();

        const config = await ConfigLoader.loadAndValidate(options.dir);
        spinner.succeed('Configuration loaded');

        spinner.start('Testing connection...');

        const llm = new ChatOpenAI({
          modelName: config.model,
          configuration: {
            baseURL: config.baseUrl,
            apiKey: config.apiKey
          },
          timeout: (config.timeout || 300) * 1000,
          maxRetries: 1
        });

        const startTime = Date.now();
        const response = await llm.invoke('Say "test successful"');
        const duration = Date.now() - startTime;

        if (!response || !response.content) {
          throw new Error('Empty response from model');
        }

        spinner.succeed(chalk.green(`Connection successful (${duration}ms)`));
        console.log(chalk.dim(`  Provider: ${config.provider}`));
        console.log(chalk.dim(`  Model: ${config.model}`));
        console.log(chalk.dim(`  Response: ${response.content}\n`));
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Connection test failed:', errorMessage);
        process.exit(1);
      }
    });

  // config init - Initialize project config
  command
    .command('init')
    .description('Initialize project-specific configuration')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .action(async (options: { dir: string }) => {
      try {
        // Check if project config already exists
        if (await ConfigLoader.hasProjectConfig(options.dir)) {
          const { overwrite } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'overwrite',
              message: 'Project config already exists. Overwrite?',
              default: false
            }
          ]);

          if (!overwrite) {
            console.log(chalk.yellow('Init cancelled.'));
            return;
          }
        }

        // Load global config as template
        const globalConfig = await ConfigLoader['loadJsonConfig'](ConfigLoader['GLOBAL_CONFIG']);

        console.log(chalk.bold('\n📁 Initialize Project Configuration\n'));
        console.log(chalk.dim('Override global settings for this project.\n'));

        const { overrideModel, overrideTimeout, addMcpServers } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overrideModel',
            message: 'Override model for this project?',
            default: false
          },
          {
            type: 'confirm',
            name: 'overrideTimeout',
            message: 'Override timeout for this project?',
            default: false
          },
          {
            type: 'confirm',
            name: 'addMcpServers',
            message: 'Configure project-specific MCP servers?',
            default: false
          }
        ]);

        const projectConfig: Partial<CodeMieConfigOptions> = {};

        if (overrideModel) {
          const { model } = await inquirer.prompt([
            {
              type: 'input',
              name: 'model',
              message: 'Model:',
              default: globalConfig.model
            }
          ]);
          projectConfig.model = model;
        }

        if (overrideTimeout) {
          const { timeout } = await inquirer.prompt([
            {
              type: 'number',
              name: 'timeout',
              message: 'Timeout (seconds):',
              default: globalConfig.timeout || 300
            }
          ]);
          projectConfig.timeout = timeout;
        }

        if (addMcpServers) {
          const { mcpServers } = await inquirer.prompt([
            {
              type: 'input',
              name: 'mcpServers',
              message: 'MCP servers (comma-separated):',
              default: Array.isArray(globalConfig.mcpServers) ? globalConfig.mcpServers.join(',') : ''
            }
          ]);
          projectConfig.mcpServers = mcpServers.split(',').map((s: string) => s.trim());
        }

        await ConfigLoader.saveProjectConfig(options.dir, projectConfig);
        logger.success(`Created .codemie/config.json`);

        console.log(chalk.dim('\nProject config created. Environment variables and CLI flags will still override these settings.'));
      } catch (error: unknown) {
        logger.error('Failed to initialize project config:', error);
        process.exit(1);
      }
    });

  return command;
}

/**
 * Parse configuration value from string
 */
function parseConfigValue(value: string): any {
  // Try to parse as JSON for complex types
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);

  // Check if it's a comma-separated list
  if (value.includes(',')) {
    return value.split(',').map(s => s.trim());
  }

  return value;
}
