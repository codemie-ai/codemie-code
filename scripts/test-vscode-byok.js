#!/usr/bin/env node

/**
 * Smoke-test the running transparent VS Code BYOK proxy daemon.
 * Reads the model ID written to VS Code configuration and never prints the
 * local gateway key.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MANAGED_MODEL_NAME = 'CodeMie Profile Model';
const STATE_FILE = process.env.CODEMIE_HOME
  ? join(process.env.CODEMIE_HOME, 'proxy-daemon.json')
  : join(homedir(), '.codemie', 'proxy-daemon.json');

function printUsage() {
  console.log(`Usage: node scripts/test-vscode-byok.js [options]

Options:
  --stream            Request a streaming response
  --message <text>    Prompt text (default: "Reply with OK")
  --tool-test         Ask the model to call the harmless get_test_value function
  --insiders          Read VS Code Insiders configuration
  -h, --help          Show this help`);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    stream: false,
    message: 'Reply with OK',
    toolTest: false,
    insiders: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--stream') options.stream = true;
    else if (arg === '--tool-test') options.toolTest = true;
    else if (arg === '--insiders') options.insiders = true;
    else if (arg === '--message') options.message = readOptionValue(argv, index++, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function loadDaemonState() {
  let raw;
  try {
    raw = await readFile(STATE_FILE, 'utf-8');
  } catch {
    throw new Error(`Proxy daemon state not found at ${STATE_FILE}. Start the proxy first.`);
  }

  const state = JSON.parse(raw);
  if (!state.url || !state.gatewayKey || state.clientType !== 'vscode-byok') {
    throw new Error('Daemon state is not a VS Code proxy. Run: codemie proxy connect vscode');
  }
  return state;
}

function getVsCodeLanguageModelsPath(insiders) {
  const productName = insiders ? 'Code - Insiders' : 'Code';
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', productName, 'User', 'chatLanguageModels.json');
  }
  if (process.platform === 'win32') {
    const roamingDir = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(roamingDir, productName, 'User', 'chatLanguageModels.json');
  }
  if (process.platform === 'linux') {
    const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    return join(configDir, productName, 'User', 'chatLanguageModels.json');
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function loadConfiguredModel(insiders) {
  const configPath = getVsCodeLanguageModelsPath(insiders);
  let providers;
  try {
    providers = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Could not read VS Code language model configuration at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(providers)) {
    throw new Error(`VS Code language model configuration is not an array: ${configPath}`);
  }
  const provider = providers.find(candidate =>
    candidate?.name === 'CodeMie' && candidate?.vendor === 'customendpoint'
  );
  const model = Array.isArray(provider?.models)
    ? provider.models.find(candidate => candidate?.name === MANAGED_MODEL_NAME)
    : undefined;
  if (typeof model?.id !== 'string' || !model.id.trim()) {
    throw new Error(`CodeMie profile model was not found in ${configPath}. Re-run the connect command.`);
  }
  return { configPath, modelId: model.id.trim() };
}

function createTool() {
  const parameters = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  };
  return {
    type: 'function',
    function: {
      name: 'get_test_value',
      description: 'Return a harmless synthetic test value.',
      parameters,
      strict: true,
    },
  };
}

function createRequestBody(options, modelId) {
  const message = options.toolTest
    ? 'Call get_test_value with name "vscode-byok-smoke". Do not answer directly.'
    : options.message;
  return {
    model: modelId,
    stream: options.stream,
    messages: [{ role: 'user', content: message }],
    ...(options.toolTest ? { tools: [createTool()], tool_choice: 'required' } : {}),
  };
}

async function readResponse(response, stream) {
  if (!stream) {
    const text = await response.text();
    console.log(text);
    return text;
  }
  if (!response.body) throw new Error('Streaming response did not include a body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let combined = '';
  let chunkNumber = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunkNumber += 1;
    const text = decoder.decode(value, { stream: true });
    combined += text;
    process.stdout.write(`[chunk ${chunkNumber}] ${text}`);
  }
  combined += decoder.decode();
  if (!combined.endsWith('\n')) process.stdout.write('\n');
  return combined;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const state = await loadDaemonState();
  const configuredModel = await loadConfiguredModel(options.insiders);
  const targetUrl = new URL('/v1/chat/completions', state.url);
  const body = createRequestBody(options, configuredModel.modelId);

  console.log(`Endpoint:     ${targetUrl.href}`);
  console.log(`Profile:      ${state.profile ?? 'unknown'}`);
  console.log(`Model:        ${configuredModel.modelId}`);
  console.log(`VS Code config: ${configuredModel.configPath}`);
  console.log('Gateway key:  [redacted]');

  const startedAt = performance.now();
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${state.gatewayKey}`,
      'content-type': 'application/json',
      accept: options.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(body),
  });
  const timeToFirstByteMs = Math.round(performance.now() - startedAt);

  console.log(`HTTP status:  ${response.status} ${response.statusText}`);
  console.log(`TTFB:         ${timeToFirstByteMs}ms`);
  const responseText = await readResponse(response, options.stream);

  if (!response.ok) throw new Error(`Smoke test failed with HTTP ${response.status}`);
  if (options.toolTest && !responseText.includes('get_test_value')) {
    throw new Error('Tool test response did not contain a get_test_value tool call');
  }
  if (options.toolTest) console.log('Tool call:    verified get_test_value');
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
