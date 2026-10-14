import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigLoader, resolveProfileModels } from '../../utils/config.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { logger } from '../../utils/logger.js';
import type { ModelInfo } from '../../providers/core/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { autoSelectModelTiers } from './setup.js';
import { promptModelSwitchSelection } from './models-switch-prompt.js';

/** Providers whose setup auto-picks the single model they support (no multi-model UX). */
const SUBSCRIPTION_SINGLE_MODEL_PROVIDERS = new Set(['anthropic-subscription', 'moonshot-subscription']);

const UNSUPPORTED_PROVIDERS = new Set(['openai', 'openai-compatible']);

export function formatTable(
  models: ModelInfo[],
  profileModelIds: string[] = [],
  activeModelId?: string
): void {
  // Router aliases (Switchyard virtual routers, LiteLLM auto-router declarations) are
  // free-form custom names and routinely run longer than any concrete deployment id
  // (e.g. a custom Switchyard variant name) — wide enough not to silently truncate those.
  const ID_WIDTH = 55;
  const NAME_WIDTH = 35;
  const ORIGIN_WIDTH = 10;
  const TYPE_WIDTH = 9;
  const DESC_WIDTH = 60;

  // Only providers that tag model origin (e.g. ollama local/cloud) get the column
  const showOrigin = models.some(m => typeof m.metadata?.origin === 'string');
  // Only shown when the catalog actually has router entries — see fetchModelsFromAPI's
  // metadata.isRouter (Switchyard virtual routers and LiteLLM auto-router declarations alike).
  const showType = models.some(m => m.metadata?.isRouter === true);

  const header =
    chalk.bold(padEnd('ID', ID_WIDTH)) +
    chalk.bold(padEnd('NAME', NAME_WIDTH)) +
    (showOrigin ? chalk.bold(padEnd('ORIGIN', ORIGIN_WIDTH)) : '') +
    (showType ? chalk.bold(padEnd('TYPE', TYPE_WIDTH)) : '') +
    chalk.bold('DESCRIPTION');

  console.log(header);
  console.log(chalk.dim('─'.repeat(
    ID_WIDTH + NAME_WIDTH + (showOrigin ? ORIGIN_WIDTH : 0) + (showType ? TYPE_WIDTH : 0) + DESC_WIDTH
  )));

  for (const model of models) {
    const id = padEnd(model.id, ID_WIDTH);
    const name = padEnd(model.name || model.id, NAME_WIDTH);
    const desc = truncate(model.description ?? '', DESC_WIDTH);
    const origin = showOrigin ? formatOrigin(model.metadata?.origin, ORIGIN_WIDTH) : '';
    const type = showType ? formatType(model.metadata?.isRouter, TYPE_WIDTH) : '';
    // Mark rows belonging to the active profile's own model list (resolveProfileModels),
    // and the one matching the active model distinctly — so the profile's own models
    // are visible at a glance without opening the full catalog.
    const tag =
      model.id === activeModelId
        ? chalk.green(' (active)')
        : profileModelIds.includes(model.id)
          ? chalk.cyan(' (profile)')
          : '';
    console.log(chalk.cyan(id) + chalk.white(name) + origin + type + chalk.dim(desc) + tag);
  }
}

function formatOrigin(origin: unknown, width: number): string {
  const value = typeof origin === 'string' ? origin : '';
  const padded = padEnd(value, width);
  return value === 'cloud' ? chalk.yellow(padded) : chalk.green(padded);
}

function formatType(isRouter: unknown, width: number): string {
  const padded = padEnd(isRouter === true ? 'router' : 'model', width);
  return isRouter === true ? chalk.magenta(padded) : chalk.dim(padded);
}

function padEnd(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width - 1) + ' ' : str.padEnd(width);
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

/**
 * `codemie models switch [model-id]` — change the active profile's active
 * model in place.
 *
 * Only ever touches the active profile's own model list (resolveProfileModels),
 * never the full provider catalog: an unknown `model-id` fails loudly rather
 * than being silently written, and a single-model profile is a documented
 * no-op rather than an error.
 */
export async function runModelsSwitch(
  modelIdArg: string | undefined,
  workingDir: string = process.cwd()
): Promise<void> {
  const activeProfileName = await ConfigLoader.getActiveProfileName(workingDir);
  if (!activeProfileName) {
    console.error(chalk.red('No active profile found. Run ' + chalk.cyan('codemie setup') + ' to get started.'));
    process.exit(1);
    return;
  }

  const profile = await ConfigLoader.getProfile(activeProfileName, workingDir);
  if (!profile) {
    console.error(chalk.red(`Active profile "${activeProfileName}" not found. Run `) + chalk.cyan('codemie setup') + chalk.red('.'));
    process.exit(1);
    return;
  }

  const ids = resolveProfileModels(profile);

  if (ids.length <= 1) {
    if (profile.provider && SUBSCRIPTION_SINGLE_MODEL_PROVIDERS.has(profile.provider)) {
      console.log(chalk.yellow(`The ${profile.provider} provider doesn't support multiple models.`));
    } else {
      console.log(
        chalk.yellow(`Profile '${activeProfileName}' has a single model (${profile.model}). `) +
          chalk.white('Run ') +
          chalk.cyan('codemie setup') +
          chalk.white(' → Update an existing profile to add more.')
      );
    }
    return;
  }

  if (modelIdArg && !ids.includes(modelIdArg)) {
    console.error(chalk.red(`Model '${modelIdArg}' is not available on profile '${activeProfileName}'.`));
    console.error(chalk.white('Available models: ') + ids.join(', '));
    console.error(chalk.white('Run ') + chalk.cyan('codemie setup') + chalk.white(' to add it.'));
    process.exit(1);
    return;
  }

  const targetModel = modelIdArg ?? (await promptModelSwitchSelection(ids, profile.model ?? ids[0]));

  // Refresh Claude's haiku/sonnet/opus tiers from the live catalog only when
  // this provider backs the Claude agent (same condition setup.ts uses).
  let tierOverrides: { haikuModel?: string; sonnetModel?: string; opusModel?: string } | undefined;
  const claudeAgent = AgentRegistry.getAgent('claude');
  const claudeMetadata = (claudeAgent as any)?.metadata;
  const supportsClaude = claudeMetadata?.supportedProviders?.includes(profile.provider);
  if (supportsClaude && profile.provider) {
    const proxy = ProviderRegistry.getModelProxy(profile.provider);
    if (proxy) {
      const config = await ConfigLoader.load(workingDir);
      const catalog = await proxy.fetchModels(config);
      const catalogIds = catalog.map(m => m.id);
      tierOverrides = await autoSelectModelTiers(catalogIds, targetModel);
    }
  }

  const { profileName } = await ConfigLoader.switchActiveProfileModel(targetModel, workingDir, tierOverrides);
  console.log(chalk.green(`✓ Switched ${profileName} to ${targetModel}`));
}

export function createModelsCommand(): Command {
  const command = new Command('models');
  command.description('Manage and list AI models, including the active profile\'s own list');
  command.addHelpText('after', `
A profile may optionally hold several models (the "models" array) alongside
its single active "model". "codemie models switch" changes which one is
active, without touching credentials or any other profile field; "codemie
setup" -> "Update an existing profile" is how you add models to the list in
the first place.

When the active profile has 2+ models, Claude's /model picker, Codex's model
catalog, OpenCode/codemie-code's dynamic model config, and Pi's models.json
are all limited to just those models for the running session - never the
full provider catalog. A single-model (or legacy) profile sees the full
catalog everywhere, exactly as before.
`);

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
        // config already carries the active profile's own model/models fields
        // (ProviderProfile & WorkspaceConfig) — no extra profile lookup needed.
        formatTable(models, resolveProfileModels(config), config.model);
        console.log(chalk.dim(`\n${models.length} model(s) available.\n`));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Failed to fetch models: ${message}`));
        process.exit(1);
      }
    });

  const switchCommand = new Command('switch');
  switchCommand
    .description('Switch the active profile\'s active model (pass a model id, or pick interactively)')
    .argument('[model-id]', 'Model id to switch to; omit to pick interactively')
    .action(async (modelIdArg: string | undefined) => {
      try {
        await runModelsSwitch(modelIdArg, process.cwd());
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Failed to switch model: ${message}`));
        process.exit(1);
      }
    });

  command.addCommand(listCommand);
  command.addCommand(switchCommand);
  return command;
}
