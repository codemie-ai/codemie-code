import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { checkProviderHealth } from '../../utils/health-checker.js';
import { fetchCodeMieModelsFromConfig } from '../../utils/codemie-model-fetcher.js';
import { getAnalytics } from '../../analytics/index.js';

export function createConfigCommand(): Command {
  const command = new Command('config');

  command.description('Configuration utilities and diagnostics');

  // config show - Display configuration with sources
  command
    .command('show')
    .description('Show current configuration with sources (env, global, project)')
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
        { name: 'provider', desc: 'LLM provider (ai-run-sso, openai, azure, bedrock, litellm)' },
        { name: 'baseUrl', desc: 'API endpoint URL' },
        { name: 'apiKey', desc: 'Authentication API key' },
        { name: 'model', desc: 'Model identifier (e.g., claude-4-5-sonnet, gpt-4.1)' },
        { name: 'timeout', desc: 'Request timeout in seconds' },
        { name: 'debug', desc: 'Enable debug logging (true/false)' },
        { name: 'allowedDirs', desc: 'Allowed directories (comma-separated)' },
        { name: 'ignorePatterns', desc: 'Ignore patterns (comma-separated)' }
      ];

      for (const param of params) {
        console.log(`  ${chalk.cyan(param.name.padEnd(20))} ${chalk.white(param.desc)}`);
      }

      console.log(chalk.white('\n📝 To modify profiles:'));
      console.log(chalk.white('  - Add/update:     codemie setup'));
      console.log(chalk.white('  - Switch active:  codemie profile switch <name>'));
      console.log(chalk.white('  - View profiles:  codemie profile list'));
      console.log(chalk.white('\n🔧 Configuration sources (priority order):'));
      console.log(chalk.white('  1. CLI flags:     --profile <name>, --model <model>, etc.'));
      console.log(chalk.white('  2. Environment:   CODEMIE_<PARAM>'));
      console.log(chalk.white('  3. Project:       .codemie/config.json (use: codemie config init)'));
      console.log(chalk.white('  4. Global:        ~/.codemie/config.json (profiles)'));
      console.log(chalk.white('  5. Defaults:      Built-in fallback values\n'));
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

        // Special handling for SSO provider
        if (config.provider === 'ai-run-sso') {
          spinner.start('Testing SSO connection...');

          try {
            const startTime = Date.now();
            const models = await fetchCodeMieModelsFromConfig();
            const duration = Date.now() - startTime;

            spinner.succeed(chalk.green(`Connection successful (${duration}ms)`));
            console.log(chalk.white(`  Provider: ${config.provider}`));
            console.log(chalk.white(`  Model: ${config.model}`));
            console.log(chalk.white(`  Available models: ${models.length}`));
            console.log(chalk.white(`  Status: SSO authentication working\n`));
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            spinner.fail(chalk.red('SSO connection failed'));

            if (errorMessage.includes('expired')) {
              console.log(chalk.yellow('  Your SSO session may have expired.'));
              console.log(chalk.white('  Run: codemie auth refresh\n'));
            }

            throw error;
          }
        } else {
          // Standard provider health check
          spinner.start('Testing connection...');

          const startTime = Date.now();
          const result = await checkProviderHealth(config.baseUrl!, config.apiKey!);
          const duration = Date.now() - startTime;

          if (!result.success) {
            throw new Error(result.message);
          }

          spinner.succeed(chalk.green(`Connection successful (${duration}ms)`));
          console.log(chalk.white(`  Provider: ${config.provider}`));
          console.log(chalk.white(`  Model: ${config.model}`));
          console.log(chalk.white(`  Status: ${result.message}\n`));
        }
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
        console.log(chalk.white('Override global settings for this project.\n'));

        const { overrideModel, overrideTimeout } = await inquirer.prompt([
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

        await ConfigLoader.saveProjectConfig(options.dir, projectConfig);
        logger.success(`Created .codemie/config.json`);

        console.log(chalk.white('\nProject config created. Environment variables and CLI flags will still override these settings.'));

        // Track config change
        try {
          const analytics = getAnalytics();
          await analytics.track('config_change', {
            operation: 'init_project_config',
            directory: options.dir,
            overrides: Object.keys(projectConfig)
          });
        } catch (analyticsError) {
          // Silent fail
          logger.debug('Analytics tracking error:', analyticsError);
        }
      } catch (error: unknown) {
        logger.error('Failed to initialize project config:', error);
        process.exit(1);
      }
    });

  return command;
}
