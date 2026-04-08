import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigLoader } from '../../utils/config.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { logger } from '../../utils/logger.js';
import type { ModelInfo } from '../../providers/core/types.js';

const UNSUPPORTED_PROVIDERS = new Set(['openai', 'bearer-auth', 'openai-compatible']);

function formatTable(models: ModelInfo[]): void {
  const ID_WIDTH = 40;
  const NAME_WIDTH = 35;
  const DESC_WIDTH = 60;

  const header =
    chalk.bold(padEnd('ID', ID_WIDTH)) +
    chalk.bold(padEnd('NAME', NAME_WIDTH)) +
    chalk.bold('DESCRIPTION');

  console.log(header);
  console.log(chalk.dim('─'.repeat(ID_WIDTH + NAME_WIDTH + DESC_WIDTH)));

  for (const model of models) {
    const id = padEnd(model.id, ID_WIDTH);
    const name = padEnd(model.name || model.id, NAME_WIDTH);
    const desc = truncate(model.description ?? '', DESC_WIDTH);
    console.log(chalk.cyan(id) + chalk.white(name) + chalk.dim(desc));
  }
}

function padEnd(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width - 1) + ' ' : str.padEnd(width);
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

export function createModelsCommand(): Command {
  const command = new Command('models');
  command.description('Manage and list AI models');

  const listCommand = new Command('list');
  listCommand
    .description('List all models available for the current provider configuration')
    .action(async () => {
      try {
        const config = await ConfigLoader.load(process.cwd());
        const provider = config.provider;

        if (!provider) {
          console.error(chalk.red('No provider configured. Run ' + chalk.cyan('codemie setup') + ' to get started.'));
          process.exit(1);
        }

        if (UNSUPPORTED_PROVIDERS.has(provider)) {
          console.error(chalk.red(`Model listing is not supported for provider '${provider}'.`));
          process.exit(1);
        }

        const proxy = ProviderRegistry.getModelProxy(provider);

        if (!proxy) {
          console.error(chalk.red(`Model listing is not supported for provider '${provider}'.`));
          process.exit(1);
        }

        logger.debug(`Fetching models for provider: ${provider}`);

        const models = await proxy.fetchModels(config);

        if (models.length === 0) {
          console.log(chalk.yellow(`No models found for provider '${provider}'.`));
          return;
        }

        console.log(chalk.bold(`\nProvider: ${chalk.cyan(provider)}\n`));
        formatTable(models);
        console.log(chalk.dim(`\n${models.length} model(s) available.\n`));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Failed to fetch models: ${message}`));
        process.exit(1);
      }
    });

  command.addCommand(listCommand);
  return command;
}
