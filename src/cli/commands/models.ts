import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigLoader, resolveAgentModelSet, resolveProfileModels } from '../../utils/config.js';
import type { ProviderProfile } from '../../env/types.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { logger } from '../../utils/logger.js';
import type { ModelInfo } from '../../providers/core/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { autoSelectModelTiers } from './setup.js';
import { promptModelSwitchSelection, promptAgentSwitchSelection, ModelSwitchCancelledError } from './models-switch-prompt.js';
import { agentsUsingModel, classifyModelForAgent, getAgentDisplayName, isActiveModelOnly } from '../../agents/core/model-compat.js';

/** Providers whose setup auto-picks the single model they support (no multi-model UX). */
const SUBSCRIPTION_SINGLE_MODEL_PROVIDERS = new Set(['anthropic-subscription', 'moonshot-subscription']);

const UNSUPPORTED_PROVIDERS = new Set(['openai', 'openai-compatible']);

export function formatTable(
  models: ModelInfo[],
  profileModelIds: string[] = [],
  activeModelId?: string,
  agentModels?: ProviderProfile['agentModels']
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
  // A profile set up per agent gets an AGENTS column instead of the trailing tag.
  const agents = agentModels ? buildAgentsColumn(agentModels) : undefined;

  const header =
    chalk.bold(padEnd('ID', ID_WIDTH)) +
    chalk.bold(padEnd('NAME', NAME_WIDTH)) +
    (showOrigin ? chalk.bold(padEnd('ORIGIN', ORIGIN_WIDTH)) : '') +
    (showType ? chalk.bold(padEnd('TYPE', TYPE_WIDTH)) : '') +
    (agents ? chalk.bold(agents.header) : '') +
    chalk.bold('DESCRIPTION');

  console.log(header);
  console.log(chalk.dim('─'.repeat(
    ID_WIDTH + NAME_WIDTH + (showOrigin ? ORIGIN_WIDTH : 0) + (showType ? TYPE_WIDTH : 0) +
    (agents?.width ?? 0) + DESC_WIDTH
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
    const tag = agents
      ? ''
      : model.id === activeModelId
        ? chalk.green(' (active)')
        : profileModelIds.includes(model.id)
          ? chalk.cyan(' (profile)')
          : '';
    const [agentCell = '', ...moreAgentLines] = agents ? agents.row(model.id) : [];
    console.log(chalk.cyan(id) + chalk.white(name) + origin + type + agentCell + chalk.dim(desc) + tag);
    // A long agent list continues under its own column, so the row grows instead of being cut.
    const leadWidth = ID_WIDTH + NAME_WIDTH + (showOrigin ? ORIGIN_WIDTH : 0) + (showType ? TYPE_WIDTH : 0);
    for (const line of moreAgentLines) {
      console.log(' '.repeat(leadWidth) + line.trimEnd());
    }
  }

  if (agents) {
    console.log(chalk.dim(`\n${agents.legend}`));
  }
}

interface AgentsColumn {
  header: string;
  width: number;
  /** One cell per line; a list longer than the column wraps onto further lines. */
  row: (modelId: string) => string[];
  legend: string;
}

/**
 * A single AGENTS column listing the agents each model is available to, with `*` marking the
 * agents that start with it.
 */
function buildAgentsColumn(agentModels: NonNullable<ProviderProfile['agentModels']>): AgentsColumn {
  const entries = Object.entries(agentModels);
  const switchHint = 'switch with `codemie models switch --agent <name>`';

  const width = 30;
  return {
    header: padEnd('AGENTS', width),
    width,
    // Color each agent on its own: active (`*`) green, available cyan. Padding is measured on the
    // plain text so the colors never shift the DESCRIPTION column.
    row: modelId => {
      const names = entries
        .filter(([, set]) => set.models.includes(modelId))
        .map(([agent, set]) => ({ text: set.model === modelId ? `${agent}*` : agent, active: set.model === modelId }));
      const lines: string[] = [];
      let plain = '';
      let styled = '';
      for (const [index, name] of names.entries()) {
        const separator = index === 0 ? '' : ', ';
        // Leave at least one space before DESCRIPTION; wrap onto the next line when the name does not fit.
        if (plain && plain.length + separator.length + name.text.length > width - 1) {
          lines.push(styled + chalk.dim(',') + ' '.repeat(Math.max(1, width - plain.length - 1)));
          plain = '';
          styled = '';
        }
        const lead = plain ? separator : '';
        plain += lead + name.text;
        styled += chalk.dim(lead) + (name.active ? chalk.green(name.text) : chalk.cyan(name.text));
      }
      lines.push(styled + ' '.repeat(Math.max(1, width - plain.length)));
      return lines;
    },
    legend: `AGENTS = agents the model is available to; * = the agent starts with this model (${switchHint})`,
  };
}

/** Models any agent of the profile uses come first; catalog order is kept within each group. */
export function sortUsedModelsFirst(models: ModelInfo[], usedIds: string[]): ModelInfo[] {
  const used = new Set(usedIds);
  return [...models.filter(m => used.has(m.id)), ...models.filter(m => !used.has(m.id))];
}

/** "Agents:" block listing each agent's models, active first, for a per-agent profile. */
export function formatAgentModelsBlock(profile: Pick<ProviderProfile, 'agentModels'>): string[] {
  const entries = Object.entries(profile.agentModels ?? {}).map(([agent, set]) => ({
    name: getAgentDisplayName(agent),
    set,
  }));
  const width = Math.max(0, ...entries.map(entry => entry.name.length)) + 2;
  return [
    chalk.bold('Agents:'),
    ...entries.map(({ name, set }) =>
      '  ' + chalk.white(name.padEnd(width)) +
      [chalk.green(`${set.model} (active)`), ...set.models.filter(id => id !== set.model)].join(chalk.dim(', '))
    ),
  ];
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
 * `codemie models switch [model-id] [--agent <name>]` — change the active
 * profile's active model in place.
 *
 * Only ever touches the active profile's own model list (resolveProfileModels),
 * never the full provider catalog: an unknown `model-id` fails loudly rather
 * than being silently written, and a single-model profile is a documented
 * no-op rather than an error. On a profile set up per agent it switches one
 * agent's active model, chosen by `--agent`, by the model id, or interactively.
 */
export async function runModelsSwitch(
  modelIdArg: string | undefined,
  workingDir: string = process.cwd(),
  agentArg?: string
): Promise<void> {
  const activeProfileName = await ConfigLoader.getActiveProfileName(workingDir);
  if (!activeProfileName) {
    console.error(chalk.red('No active profile found. Run ' + chalk.cyan('codemie setup') + ' to get started.'));
    process.exit(1);
    return;
  }

  const profile = await ConfigLoader.getProfileForModelSwitch(activeProfileName, workingDir);
  if (!profile) {
    console.error(chalk.red(`Active profile "${activeProfileName}" not found. Run `) + chalk.cyan('codemie setup') + chalk.red('.'));
    process.exit(1);
    return;
  }

  if (profile.agentModels) {
    await switchAgentModel(profile, activeProfileName, modelIdArg, workingDir, agentArg);
    return;
  }

  if (agentArg) {
    console.error(chalk.red(`Profile '${activeProfileName}' does not set models per agent, so --agent does not apply.`));
    console.error(chalk.white('Run ') + chalk.cyan('codemie setup') + chalk.white(' → Update an existing profile to choose models per agent.'));
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
  const tierOverrides = await refreshClaudeTiers(profile, targetModel, workingDir);

  const { profileName } = await ConfigLoader.switchActiveProfileModel(targetModel, workingDir, tierOverrides);
  console.log(chalk.green(`✓ Switched ${profileName} to ${targetModel}`));
}

/** Per-agent branch of `runModelsSwitch`: resolve the agent, then switch its active model. */
async function switchAgentModel(
  profile: ProviderProfile,
  profileName: string,
  modelIdArg: string | undefined,
  workingDir: string,
  agentArg: string | undefined
): Promise<void> {
  const agentModels = profile.agentModels ?? {};
  const agentNames = Object.keys(agentModels);

  let agent: string | undefined;
  if (agentArg) {
    agent = agentArg.replace(/-acp$/, '');
    if (!agentModels[agent]) {
      console.error(chalk.red(`Agent '${agentArg}' has no models on profile '${profileName}'.`));
      console.error(chalk.white('Agents on this profile: ') + agentNames.join(', '));
      process.exit(1);
      return;
    }
  } else {
    // A model id narrows the choice to the agents that have it.
    const candidates = modelIdArg
      ? agentNames.filter(name => agentModels[name].models.includes(modelIdArg))
      : agentNames;
    if (candidates.length === 0) {
      console.error(chalk.red(`Model '${modelIdArg}' is not available to any agent on profile '${profileName}'.`));
      const activeOnly = agentNames.filter(name => isActiveModelOnly(name));
      if (activeOnly.length > 0) {
        console.error(chalk.white('To make it the model of ') + activeOnly.join(', ') + chalk.white(', run ') +
          chalk.cyan(`codemie models switch --agent <agent> ${modelIdArg}`) + chalk.white('.'));
      }
      console.error(chalk.white('Run ') + chalk.cyan('codemie setup') + chalk.white(' to add it.'));
      process.exit(1);
      return;
    }
    agent = candidates.length === 1
      ? candidates[0]
      : await promptAgentSwitchSelection(candidates.map(name => ({
        name,
        displayName: getAgentDisplayName(name),
        model: agentModels[name].model,
      })));
  }

  const set = agentModels[agent];
  const displayName = getAgentDisplayName(agent);

  if (isActiveModelOnly(agent)) {
    await switchActiveOnlyAgentModel(profile, profileName, agent, set.model, modelIdArg, workingDir);
    return;
  }

  if (set.models.length <= 1 && !modelIdArg) {
    console.log(
      chalk.yellow(`${displayName} has a single model (${set.model}) on profile '${profileName}'. `) +
        chalk.white('Run ') +
        chalk.cyan('codemie setup') +
        chalk.white(' → Update an existing profile to add more.')
    );
    return;
  }

  if (modelIdArg && !set.models.includes(modelIdArg)) {
    console.error(chalk.red(`Model '${modelIdArg}' is not available to ${displayName} on profile '${profileName}'.`));
    console.error(chalk.white(`${displayName} models: `) + set.models.join(', '));
    console.error(chalk.white('Run ') + chalk.cyan('codemie setup') + chalk.white(' to add it.'));
    process.exit(1);
    return;
  }

  const agentLabels = Object.fromEntries(set.models.map(id => [id, agentsUsingModel(profile, id)]));
  const targetModel = modelIdArg ?? (await promptModelSwitchSelection(
    set.models,
    set.model,
    agentLabels,
    `Select ${displayName}'s active model:`
  ));
  // Claude's haiku/sonnet/opus tiers follow Claude's own active model only.
  const tierOverrides = agent === 'claude'
    ? await refreshClaudeTiers(profile, targetModel, workingDir)
    : undefined;

  await ConfigLoader.switchActiveProfileModel(targetModel, workingDir, tierOverrides, agent);
  console.log(chalk.green(`✓ Switched ${displayName} on ${profileName} to ${targetModel}`));
}

/**
 * Switch an agent that always runs on its active model (`activeModelOnly`). It keeps no saved list,
 * so the choice comes from the live catalog, narrowed to the models the agent can use. A model id
 * outside the catalog (e.g. a LiteLLM wildcard route) is accepted unless the agent's rules reject it.
 */
async function switchActiveOnlyAgentModel(
  profile: ProviderProfile,
  profileName: string,
  agent: string,
  currentModel: string,
  modelIdArg: string | undefined,
  workingDir: string
): Promise<void> {
  const displayName = getAgentDisplayName(agent);
  const catalog = await fetchAgentCatalog(profile, agent, workingDir);

  let targetModel: string;
  if (modelIdArg) {
    const known = modelIdArg === currentModel || catalog?.includes(modelIdArg);
    if (!known && classifyModelForAgent(agent, modelIdArg, { provider: profile.provider }) === 'incompatible') {
      console.error(chalk.red(`Model '${modelIdArg}' is not compatible with ${displayName}.`));
      if (catalog?.length) {
        console.error(chalk.white(`${displayName} models on ${profile.provider}: `) + catalog.join(', '));
      }
      process.exit(1);
      return;
    }
    targetModel = modelIdArg;
  } else {
    if (!catalog) {
      console.log(
        chalk.yellow(`Could not list ${displayName} models from ${profile.provider ?? 'the provider'}. `) +
          chalk.white('Pass the model id: ') +
          chalk.cyan(`codemie models switch --agent ${agent} <model-id>`)
      );
      return;
    }
    const ids = catalog.includes(currentModel) ? catalog : [currentModel, ...catalog];
    if (ids.length <= 1) {
      console.log(chalk.yellow(`${currentModel} is the only ${displayName} model on ${profile.provider}.`));
      return;
    }
    targetModel = await promptModelSwitchSelection(ids, currentModel, undefined, `Select ${displayName}'s active model:`);
  }

  await ConfigLoader.switchActiveProfileModel(targetModel, workingDir, undefined, agent);
  console.log(chalk.green(`✓ Switched ${displayName} on ${profileName} to ${targetModel}`));
}

/**
 * Catalog ids the agent can use on the profile's provider, or undefined when the provider lists no
 * models or the fetch fails (the switch then needs an explicit model id).
 */
async function fetchAgentCatalog(
  profile: ProviderProfile,
  agent: string,
  workingDir: string
): Promise<string[] | undefined> {
  const proxy = profile.provider ? ProviderRegistry.getModelProxy(profile.provider) : undefined;
  if (!proxy) return undefined;
  try {
    const config = await ConfigLoader.load(workingDir);
    const catalog = await proxy.fetchModels(config);
    const routers = new Set(catalog.filter(m => m.metadata?.isRouter === true).map(m => m.id));
    const ids = catalog
      .map(m => m.id)
      .filter(id => classifyModelForAgent(agent, id, { provider: profile.provider, isRouter: routers.has(id) }) !== 'incompatible');
    return ids.length > 0 ? ids : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to fetch models for ${agent} during switch: ${message}`);
    return undefined;
  }
}

/**
 * Refresh Claude's haiku/sonnet/opus tiers from the live catalog, only when this
 * provider backs the Claude agent (same condition setup.ts uses).
 * CR-006: this network call must never deny a switch that is otherwise a
 * pure local config write - a transient failure here just skips the tier
 * refresh rather than aborting switchActiveProfileModel.
 */
async function refreshClaudeTiers(
  profile: ProviderProfile,
  targetModel: string,
  workingDir: string
): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string } | undefined> {
  const claudeAgent = AgentRegistry.getAgent('claude');
  const supportsClaude = Boolean(profile.provider && claudeAgent?.metadata.supportedProviders.includes(profile.provider));
  if (!supportsClaude || !profile.provider) return undefined;

  try {
    const proxy = ProviderRegistry.getModelProxy(profile.provider);
    if (!proxy) return undefined;
    const config = await ConfigLoader.load(workingDir);
    const catalog = await proxy.fetchModels(config);
    return await autoSelectModelTiers(catalog.map(m => m.id), targetModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to refresh Claude model tiers during switch; continuing without them: ${message}`);
    return undefined;
  }
}

/**
 * `codemie models list [--agent <name>]` — the provider catalog, with the active
 * profile's own models tagged. A profile set up per agent gets an "Agents:"
 * block and per-agent tags; `--agent` tags only that agent's models.
 */
export async function runModelsList(agentArg?: string, workingDir: string = process.cwd()): Promise<void> {
  const config = await ConfigLoader.load(workingDir);
  const provider = config.provider;

  if (!provider) {
    console.error(chalk.red('No provider configured. Run ' + chalk.cyan('codemie setup') + ' to get started.'));
    process.exit(1);
    return;
  }

  if (UNSUPPORTED_PROVIDERS.has(provider)) {
    console.error(chalk.red(`Model listing is not supported for provider '${provider}'.`));
    process.exit(1);
    return;
  }

  // Validate --agent before the network call.
  const agentSet = agentArg ? resolveAgentModelSet(config, agentArg) : undefined;
  if (agentArg && !agentSet) {
    if (config.agentModels) {
      console.error(chalk.red(`Agent '${agentArg}' has no models on the active profile.`));
      console.error(chalk.white('Agents on this profile: ') + Object.keys(config.agentModels).join(', '));
    } else {
      console.error(chalk.red('The active profile does not set models per agent, so --agent does not apply.'));
    }
    process.exit(1);
    return;
  }

  const proxy = ProviderRegistry.getModelProxy(provider);

  if (!proxy) {
    console.error(chalk.red(`Model listing is not supported for provider '${provider}'.`));
    process.exit(1);
    return;
  }

  logger.debug(`Fetching models for provider: ${provider}`);

  const models = await proxy.fetchModels(config);

  if (models.length === 0) {
    console.log(chalk.yellow(`No models found for provider '${provider}'.`));
    return;
  }

  console.log(chalk.bold(`\nProvider: ${chalk.cyan(provider)}`));
  if (agentArg && agentSet) {
    console.log(chalk.bold(`Agent: ${chalk.cyan(getAgentDisplayName(agentArg))}\n`));
    formatTable(sortUsedModelsFirst(models, agentSet.models), agentSet.models, agentSet.model);
  } else if (config.agentModels) {
    console.log(formatAgentModelsBlock(config).join('\n') + '\n');
    formatTable(sortUsedModelsFirst(models, resolveProfileModels(config)), [], undefined, config.agentModels);
  } else {
    console.log();
    // config already carries the active profile's own model field
    // (ProviderProfile & WorkspaceConfig) — no extra profile lookup needed.
    formatTable(models, resolveProfileModels(config), config.model);
  }
  console.log(chalk.dim(`\n${models.length} model(s) available.\n`));
}

export function createModelsCommand(): Command {
  const command = new Command('models');
  command.description('Manage and list AI models, including the active profile\'s own list');
  command.addHelpText('after', `
"codemie setup" chooses models per agent: for each selected agent, the models
it may use (the "agentModels" map) and its active model. Each agent launches
with its own active model.

"codemie models switch" changes an agent's active model, without touching
credentials or any other profile field. Pass --agent <name> or a model id, or
pick interactively. "codemie setup" -> "Update an existing profile" is how you
add models in the first place.

"codemie models list" tags each model with the agents using it;
--agent <name> tags only that agent's models.

Each agent's in-session model picker (Claude's /model, Codex's model
catalog, OpenCode/codemie-code's dynamic model config, Pi's models.json) is
limited to just that agent's models, even a single one - never the full
provider catalog. A legacy single-model profile, or an agent the profile does
not set up, sees the full catalog everywhere, exactly as before.
`);

  const listCommand = new Command('list');
  listCommand
    .description('List all models available for the current provider configuration')
    .option('--agent <name>', 'Tag only this agent\'s models (profiles set up per agent)')
    .action(async (options: { agent?: string }) => {
      try {
        await runModelsList(options.agent, process.cwd());
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
    .option('--agent <name>', 'Agent whose active model to switch (profiles set up per agent)')
    .action(async (modelIdArg: string | undefined, options: { agent?: string }) => {
      try {
        await runModelsSwitch(modelIdArg, process.cwd(), options.agent);
      } catch (error: unknown) {
        if (error instanceof ModelSwitchCancelledError) {
          console.log(chalk.yellow('Model switch cancelled - nothing changed.'));
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Failed to switch model: ${message}`));
        process.exit(1);
      }
    });

  command.addCommand(listCommand);
  command.addCommand(switchCommand);
  return command;
}
