/**
 * `codemie-claude models list|select`: which non-Claude catalog models a profile adds to
 * the Claude clients (the Claude Code `/model` picker and Claude Desktop's model list).
 *
 * Claude-family models are always offered. Other families are opt-in per profile, stored
 * as `claudeExtraModels`, because they may not support every Claude-specific feature.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigLoader } from '../../utils/config.js';
import { ConfigurationError } from '../../utils/errors.js';
import { isNonInteractiveEnvironment } from '../../utils/interactive.js';
import { isClaudeFamilyModel, isRouterModel } from '../../utils/model-family.js';
import type { LlmModel } from '../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieCatalogForEnv } from '../../providers/plugins/sso/sso.catalog.js';
import {
  catalogModelId,
  catalogModelIdentifiers,
  listClaudeExtraModelCandidates,
  readClaudeExtraModels,
} from '../../providers/plugins/sso/sso.claude-extra-models.js';

interface ModelsCommandOptions {
  profile?: string;
}

interface ProfileCatalog {
  profileName: string;
  project?: string;
  storedIds: string[];
  catalog: LlmModel[];
}

const APPLIES_TO = 'Applies to Claude Code and Claude Desktop.';
const APPLY_HINT =
  'Claude Code picks this up on its next start; restart Claude Desktop to refresh its model list.';
const COMPATIBILITY_NOTE =
  'Non-Claude models may not support every Claude Code / Claude Desktop feature (thinking, prompt caching, some tools). ' +
  'Claude Desktop lists them under a claude-x-… ID; see docs/COMMANDS.md.';

async function resolveProfileName(requested: string | undefined): Promise<string> {
  const profileName = requested || (await ConfigLoader.getActiveProfileName()) || 'default';
  if (!(await ConfigLoader.getProfile(profileName))) {
    throw new ConfigurationError(`Profile "${profileName}" not found. Run: codemie profile`);
  }
  return profileName;
}

async function loadProfileCatalog(requested: string | undefined): Promise<ProfileCatalog> {
  const profileName = await resolveProfileName(requested);
  const config = await ConfigLoader.load(process.cwd(), { name: profileName });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...ConfigLoader.exportProviderEnvVars(config),
    CODEMIE_PROFILE_CONFIG: JSON.stringify(config),
    // Narrows the catalog to the models the profile's project allows, as an agent launch does.
    // Set even when empty, so a shell's CODEMIE_PROJECT never picks another project's list.
    CODEMIE_PROJECT: config.codeMieProject ?? '',
  };
  const catalog = await fetchCodeMieCatalogForEnv(env, { logPrefix: '[claude-models]' });
  if (!catalog) {
    throw new ConfigurationError(
      `Profile "${profileName}" is not connected to CodeMie, so there is no model catalog to choose from.`
    );
  }
  return {
    profileName,
    project: config.codeMieProject ?? undefined,
    storedIds: readClaudeExtraModels(await ConfigLoader.getProfile(profileName)),
    catalog,
  };
}

function findInCatalog(catalog: readonly LlmModel[], id: string): LlmModel | undefined {
  return catalog.find((model) => catalogModelIdentifiers(model).includes(id));
}

function describeModel(model: LlmModel, id: string): string {
  const name = model.label && model.label !== id ? `${model.label} ${chalk.dim(`(${id})`)}` : id;
  return isRouterModel(model) ? `${name} ${chalk.magenta('router')}` : name;
}

function printHeader({ profileName, project }: ProfileCatalog): void {
  const projectInfo = project ? chalk.dim(` · project ${project}`) : '';
  console.log(chalk.bold(`\nProfile: ${chalk.cyan(profileName)}`) + projectInfo);
}

async function listExtraModels(options: ModelsCommandOptions): Promise<void> {
  const state = await loadProfileCatalog(options.profile);
  printHeader(state);
  console.log(chalk.dim(`Claude models are always offered. ${APPLIES_TO}\n`));

  if (state.storedIds.length === 0) {
    console.log('No extra models selected.');
    console.log(chalk.dim(`Run ${chalk.cyan('codemie-claude models select')} to add non-Claude models.\n`));
    return;
  }

  console.log(chalk.bold('Extra models:'));
  for (const id of state.storedIds) {
    const model = findInCatalog(state.catalog, id);
    console.log(
      model
        ? `  ${chalk.green('●')} ${describeModel(model, id)}`
        : `  ${chalk.yellow('○')} ${id} ${chalk.yellow('— not available in this project; not shown')}`
    );
  }
  console.log('');
}

async function selectExtraModels(options: ModelsCommandOptions): Promise<void> {
  if (isNonInteractiveEnvironment()) {
    throw new ConfigurationError('`codemie-claude models select` needs an interactive terminal.');
  }

  const state = await loadProfileCatalog(options.profile);
  const candidates = listClaudeExtraModelCandidates(state.catalog);
  const stored = new Set(state.storedIds);
  // A stored model the catalog no longer offers stays in the list, checked, so it can be cleared.
  const offered = new Set(candidates.flatMap(catalogModelIdentifiers));
  const unavailable = state.storedIds.filter((id) => !offered.has(id));

  printHeader(state);
  console.log(chalk.dim(`Claude models are always offered. ${APPLIES_TO}`));
  console.log(chalk.yellow(`${COMPATIBILITY_NOTE}\n`));

  if (candidates.length === 0 && unavailable.length === 0) {
    console.log('This project has no non-Claude models to add.\n');
    return;
  }

  const choices = [
    ...candidates.map((model) => {
      const id = catalogModelId(model) as string;
      const checked = catalogModelIdentifiers(model).some((alias) => stored.has(alias));
      return { name: describeModel(model, id), value: id, checked };
    }),
    ...unavailable.map((id) => ({
      name: `${id} ${chalk.yellow('(not available in this project)')}`,
      value: id,
      checked: true,
    })),
  ];

  const { selected } = await inquirer.prompt<{ selected: string[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Select extra models for Claude Code and Claude Desktop:',
      choices,
      pageSize: 15,
      loop: false,
    },
  ]);

  await saveExtraModels(state.profileName, selected);

  console.log(
    selected.length > 0
      ? chalk.green(`\n✓ ${selected.length} extra model(s) saved to profile "${state.profileName}".`)
      : chalk.green(`\n✓ No extra models: profile "${state.profileName}" offers Claude models only.`)
  );
  console.log(chalk.dim(`${APPLY_HINT}\n`));
}

/** Matches a model the user typed by any of its catalog names, ignoring case. */
function findCandidate(candidates: readonly LlmModel[], requested: string): LlmModel | undefined {
  const wanted = requested.trim().toLowerCase();
  return candidates.find((model) =>
    catalogModelIdentifiers(model).some((alias) => alias.toLowerCase() === wanted)
  );
}

async function saveExtraModels(profileName: string, ids: readonly string[]): Promise<void> {
  await ConfigLoader.updateProfile(profileName, {
    claudeExtraModels: ids.length > 0 ? [...ids] : undefined,
  });
}

async function addExtraModels(requested: string[], options: ModelsCommandOptions): Promise<void> {
  const state = await loadProfileCatalog(options.profile);
  const candidates = listClaudeExtraModelCandidates(state.catalog);
  const next = [...state.storedIds];
  const unknown: string[] = [];

  for (const name of requested) {
    const model = findCandidate(candidates, name);
    if (!model) {
      const inCatalog = findInCatalog(state.catalog, name);
      if (inCatalog && isClaudeFamilyModel(inCatalog)) {
        console.log(chalk.dim(`  ${name}: Claude models are always offered, nothing to add.`));
      } else {
        unknown.push(name);
      }
      continue;
    }
    const id = catalogModelId(model) as string;
    if (catalogModelIdentifiers(model).some((alias) => next.includes(alias))) {
      console.log(chalk.dim(`  ${describeModel(model, id)}: already selected.`));
      continue;
    }
    next.push(id);
    console.log(`  ${chalk.green('+')} ${describeModel(model, id)}`);
  }

  if (unknown.length > 0) {
    throw new ConfigurationError(
      `Not available as an extra model in this project: ${unknown.join(', ')}. ` +
        'Run `codemie-claude models select` to see the models you can add.'
    );
  }
  if (next.length === state.storedIds.length) return;

  await saveExtraModels(state.profileName, next);
  console.log(chalk.green(`\n✓ Profile "${state.profileName}" now offers ${next.length} extra model(s).`));
  console.log(chalk.yellow(COMPATIBILITY_NOTE));
  console.log(chalk.dim(`${APPLY_HINT}\n`));
}

async function removeExtraModels(requested: string[], options: ModelsCommandOptions): Promise<void> {
  // Works from the profile alone, so a model the catalog dropped (or an offline machine) can still be cleared.
  const profileName = await resolveProfileName(options.profile);
  const stored = readClaudeExtraModels(await ConfigLoader.getProfile(profileName));
  const wanted = new Set(requested.map((name) => name.trim().toLowerCase()));
  const kept = stored.filter((id) => !wanted.has(id.toLowerCase()));
  const removed = stored.filter((id) => wanted.has(id.toLowerCase()));
  const missing = requested.filter((name) => !stored.some((id) => id.toLowerCase() === name.trim().toLowerCase()));

  for (const id of removed) console.log(`  ${chalk.red('-')} ${id}`);
  for (const name of missing) console.log(chalk.dim(`  ${name}: not selected.`));
  if (removed.length === 0) {
    if (stored.length > 0) console.log(chalk.dim(`Selected: ${stored.join(', ')}\n`));
    return;
  }

  await saveExtraModels(profileName, kept);
  console.log(
    kept.length > 0
      ? chalk.green(`\n✓ Profile "${profileName}" now offers ${kept.length} extra model(s).`)
      : chalk.green(`\n✓ No extra models: profile "${profileName}" offers Claude models only.`)
  );
  console.log(chalk.dim(`${APPLY_HINT}\n`));
}

/**
 * Commander calls an action with its arguments, then the options, then the command. The
 * `codemie-claude` program declares its own `--profile`, and Commander hands a flag both
 * levels declare to the parent, so the options are read merged with the parent's.
 */
function runAction<A extends unknown[]>(action: (...args: [...A, ModelsCommandOptions]) => Promise<void>) {
  return async (...received: unknown[]): Promise<void> => {
    const command = received[received.length - 1] as Command;
    const args = received.slice(0, -2) as A;
    try {
      await action(...args, command.optsWithGlobals<ModelsCommandOptions>());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`\n✗ ${message}\n`));
      process.exit(1);
    }
  };
}

export function createClaudeModelsCommand(): Command {
  const command = new Command('models').description(
    `Choose non-Claude models to offer alongside Claude models. ${APPLIES_TO}`
  );

  command
    .command('list')
    .description('Show the extra models selected for a profile')
    .option('--profile <name>', 'Profile to show (default: active profile)')
    .action(runAction(listExtraModels));

  command
    .command('select')
    .description('Pick extra models from the project catalog')
    .option('--profile <name>', 'Profile to update (default: active profile)')
    .action(runAction(selectExtraModels));

  command
    .command('add')
    .description('Add extra models by ID or name (e.g. gemini-3.1-pro)')
    .argument('<models...>', 'Model IDs or names from the project catalog')
    .option('--profile <name>', 'Profile to update (default: active profile)')
    .action(runAction<[string[]]>(addExtraModels));

  command
    .command('remove')
    .description('Remove extra models by ID')
    .argument('<models...>', 'Model IDs as shown by `models list`')
    .option('--profile <name>', 'Profile to update (default: active profile)')
    .action(runAction<[string[]]>(removeExtraModels));

  return command;
}
