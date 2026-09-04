#!/usr/bin/env node

/**
 * GitHub Copilot CLI Agent Entry Point
 * Direct entry point for codemie-copilot command
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';
import { resolveCopilotModel } from '../dist/agents/plugins/copilot-cli/index.js';
import { ConfigLoader } from '../dist/utils/config.js';
import { getCodemiePath } from '../dist/utils/paths.js';
import { installProcessGuards } from '../dist/utils/process-guards.js';

installProcessGuards();

const SAVED_MODEL_PATH = getCodemiePath('agents', 'copilot-cli', 'model.json');

const OPTION_ALIASES = new Map([
  ['-m', 'model'],
  ['--model', 'model'],
  ['--model-list', 'modelList'],
  ['--profile', 'profile'],
  ['--provider', 'provider'],
  ['--api-key', 'apiKey'],
  ['--base-url', 'baseUrl'],
  ['--timeout', 'timeout'],
  ['--jwt-token', 'jwtToken'],
]);

function parseOptionValue(argv, index) {
  const arg = argv[index];
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex !== -1) {
    return { value: arg.slice(equalsIndex + 1), consumed: 0 };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith('-')) {
    return { value: true, consumed: 0 };
  }

  return { value: next, consumed: 1 };
}

function parseCopilotOptions(argv) {
  const options = {};

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const optionName = OPTION_ALIASES.get(arg.split('=')[0]);
    if (!optionName) continue;

    if (optionName === 'modelList') {
      options.modelList = true;
      continue;
    }

    const { value, consumed } = parseOptionValue(argv, i);
    options[optionName] = value;
    i += consumed;
  }

  return options;
}

function hasEnvModelOverride() {
  return Boolean(process.env.CODEMIE_MODEL);
}

async function loadSavedModel() {
  try {
    const raw = await readFile(SAVED_MODEL_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function saveSelectedModel(model) {
  await mkdir(dirname(SAVED_MODEL_PATH), { recursive: true });
  await writeFile(
    SAVED_MODEL_PATH,
    `${JSON.stringify({ model, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf-8'
  );
}

function applySavedModelIfNeeded(options, savedModel) {
  if (typeof options.model === 'string' || options.model === true || hasEnvModelOverride() || !savedModel) {
    return;
  }

  process.env.CODEMIE_MODEL = savedModel;
}

function resolveInitialModelSource(options) {
  if (typeof options.model === 'string') return 'cli';
  if (hasEnvModelOverride()) return 'env';
  return 'default';
}

function buildConfigOverrides(options) {
  return {
    name: typeof options.profile === 'string' ? options.profile : undefined,
    provider: typeof options.provider === 'string' ? options.provider : undefined,
    model: typeof options.model === 'string' ? options.model : undefined,
    apiKey: typeof options.apiKey === 'string' ? options.apiKey : undefined,
    baseUrl: typeof options.baseUrl === 'string' ? options.baseUrl : undefined,
    timeout: typeof options.timeout === 'string' ? Number.parseInt(options.timeout, 10) : undefined,
  };
}

async function getCopilotModels(options) {
  const config = await ConfigLoader.load(process.cwd(), buildConfigOverrides(options));
  if (typeof options.jwtToken === 'string') {
    process.env.CODEMIE_JWT_TOKEN = options.jwtToken;
    config.authMethod = 'jwt';
  }

  const env = ConfigLoader.exportProviderEnvVars(config);
  env.CODEMIE_MODEL_SOURCE = resolveInitialModelSource(options);
  if (typeof options.jwtToken === 'string') {
    env.CODEMIE_AUTH_METHOD = 'jwt';
    env.CODEMIE_JWT_TOKEN = options.jwtToken;
  }

  return resolveCopilotModel(env);
}

async function printModelList(options) {
  const { selectedModel, availableModels } = await getCopilotModels(options);
  const currentModel = typeof options.model === 'string' ? options.model : process.env.CODEMIE_MODEL;

  console.log(chalk.bold('\nAvailable models for codemie-copilot:\n'));
  for (const model of availableModels) {
    const badges = [];
    if (model === availableModels[0]) badges.push('recommended');
    if (currentModel === model) badges.push('current');
    const suffix = badges.length ? chalk.gray(`  (${badges.join(', ')})`) : '';
    console.log(`  ${chalk.cyan(model)}${suffix}`);
  }
  console.log('');
}

async function promptForModel(options) {
  const { selectedModel, availableModels } = await getCopilotModels(options);
  if (availableModels.length === 0) {
    throw new Error('No CodeMie model compatible with codemie-copilot is available.');
  }

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Select model for codemie-copilot:',
      choices: availableModels.map((model) => {
        const badges = [];
        if (model === availableModels[0]) badges.push('recommended');
        if (process.env.CODEMIE_MODEL === model) badges.push('current');
        return {
          name: badges.length ? `${model} (${badges.join(', ')})` : model,
          value: model,
        };
      }),
      default: selectedModel,
    },
  ]);

  return answer.model;
}

function replaceValuelessModelArg(argv, model) {
  const rewritten = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--model' || arg === '-m') && (!argv[i + 1] || argv[i + 1].startsWith('-'))) {
      rewritten.push(arg, model);
      continue;
    }
    rewritten.push(arg);
  }
  return rewritten;
}

async function handleCopilotOnlyModelUx() {
  const options = parseCopilotOptions(process.argv);
  const savedModel = await loadSavedModel();
  applySavedModelIfNeeded(options, savedModel);
  process.env.CODEMIE_MODEL_SOURCE = resolveInitialModelSource(options);

  if (options.modelList) {
    await printModelList(options);
    process.exit(0);
  }

  if (options.model === true) {
    const model = await promptForModel(options);
    await saveSelectedModel(model);
    process.argv = replaceValuelessModelArg(process.argv, model);
    process.env.CODEMIE_MODEL_SOURCE = 'cli';
  }
}

try {
  await handleCopilotOnlyModelUx();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red('\n✗ Failed to resolve codemie-copilot models\n'));
  console.error(chalk.white(message));
  console.error('');
  process.exit(1);
}

const agent = AgentRegistry.getAgent('copilot-cli');
if (!agent) {
  console.error('✗ GitHub Copilot CLI agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
