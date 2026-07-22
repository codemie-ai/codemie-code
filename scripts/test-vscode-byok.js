#!/usr/bin/env node

/**
 * Smoke-test the running VS Code BYOK profile-model proxy daemon.
 * Reads the local daemon state, sends a logical model ID, and never prints the
 * local gateway key.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOGICAL_MODEL = 'codemie-profile-default';
const STATE_FILE = process.env.CODEMIE_HOME
  ? join(process.env.CODEMIE_HOME, 'proxy-daemon.json')
  : join(homedir(), '.codemie', 'proxy-daemon.json');

function printUsage() {
  console.log(`Usage: node scripts/test-vscode-byok.js [options]

Options:
  --api-type <type>   responses | chat-completions (default: responses)
  --stream            Request a streaming response
  --message <text>    Prompt text (default: "Reply with OK")
  --tool-test         Ask the model to call the harmless get_test_value function
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
    apiType: 'responses',
    stream: false,
    message: 'Reply with OK',
    toolTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--stream') options.stream = true;
    else if (arg === '--tool-test') options.toolTest = true;
    else if (arg === '--api-type') options.apiType = readOptionValue(argv, index++, arg);
    else if (arg === '--message') options.message = readOptionValue(argv, index++, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!['responses', 'chat-completions'].includes(options.apiType)) {
    throw new Error('--api-type must be responses or chat-completions');
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
  if (state.enforceProfileModel !== true) {
    throw new Error('The running proxy is not in profile-model mode. Restart it with --use-profile-model.');
  }
  if (!state.url || !state.gatewayKey || !state.model) {
    throw new Error('Daemon state is missing URL, gateway key, or pinned model. Restart the proxy.');
  }
  return state;
}

function createTool(apiType) {
  const parameters = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  };
  if (apiType === 'responses') {
    return {
      type: 'function',
      name: 'get_test_value',
      description: 'Return a harmless synthetic test value.',
      parameters,
      strict: true,
    };
  }
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

function createRequestBody(options) {
  const message = options.toolTest
    ? 'Call get_test_value with name "vscode-byok-smoke". Do not answer directly.'
    : options.message;
  const common = {
    model: LOGICAL_MODEL,
    stream: options.stream,
  };

  if (options.apiType === 'responses') {
    return {
      ...common,
      input: message,
      ...(options.toolTest ? { tools: [createTool(options.apiType)], tool_choice: 'required' } : {}),
    };
  }
  return {
    ...common,
    messages: [{ role: 'user', content: message }],
    ...(options.toolTest ? { tools: [createTool(options.apiType)], tool_choice: 'required' } : {}),
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
  const endpoint = options.apiType === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  const targetUrl = new URL(endpoint, state.url);
  const body = createRequestBody(options);

  console.log(`Endpoint:     ${targetUrl.href}`);
  console.log(`Profile:      ${state.profile ?? 'unknown'}`);
  console.log(`Pinned model: ${state.model}`);
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
