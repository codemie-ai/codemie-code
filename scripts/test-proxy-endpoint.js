#!/usr/bin/env node
/**
 * Send a sample /v1/messages request to the local CodeMie proxy daemon.
 *
 * - Auto-discovers URL and gateway key from ~/.codemie/proxy-daemon.json
 *   (override with --url and --gateway-key)
 * - Sends Anthropic-style headers and a tiny payload
 * - Supports both buffered and streaming (SSE) responses
 *
 * Usage:
 *   node scripts/test-proxy-endpoint.js                       # auto-discover, non-streaming
 *   node scripts/test-proxy-endpoint.js --stream              # SSE streaming
 *   node scripts/test-proxy-endpoint.js --url http://localhost:4001 --gateway-key codemie-proxy
 *   node scripts/test-proxy-endpoint.js --model claude-sonnet-4-5 --message "Hello"
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_FILE = process.env.CODEMIE_HOME
  ? join(process.env.CODEMIE_HOME, 'proxy-daemon.json')
  : join(homedir(), '.codemie', 'proxy-daemon.json');

function printUsage() {
  console.log(`Usage: node scripts/test-proxy-endpoint.js [options]

Options:
  --url <base-url>          Proxy base URL (default: read from state file)
  --gateway-key <key>       Static bearer key (default: read from state file)
  --endpoint <path>         Endpoint path (default: /v1/messages)
  --model <id>              Model ID (default: claude-sonnet-4-5)
  --message <text>          Prompt text (default: "Test proxy endpoint")
  --max-tokens <n>          Max tokens (default: 32)
  --stream                  Use SSE streaming
  --no-anthropic-version    Don't send anthropic-version header
  -h, --help                Show this help`);
}

function parseArgs(argv) {
  const opts = {
    endpoint: '/v1/messages',
    message: 'Test proxy endpoint',
    model: 'claude-sonnet-4-5',
    maxTokens: 32,
    stream: false,
    sendAnthropicVersion: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; return opts; }
    if (arg === '--url')          { opts.url = argv[++i]; continue; }
    if (arg === '--gateway-key')  { opts.gatewayKey = argv[++i]; continue; }
    if (arg === '--endpoint')     { opts.endpoint = argv[++i] || opts.endpoint; continue; }
    if (arg === '--message')      { opts.message = argv[++i] || opts.message; continue; }
    if (arg === '--model')        { opts.model = argv[++i] || opts.model; continue; }
    if (arg === '--max-tokens')   {
      const v = Number.parseInt(argv[++i] || '', 10);
      if (Number.isFinite(v) && v > 0) opts.maxTokens = v;
      continue;
    }
    if (arg === '--stream')                  { opts.stream = true; continue; }
    if (arg === '--no-anthropic-version')    { opts.sendAnthropicVersion = false; continue; }
  }
  return opts;
}

async function loadDaemonState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  if (!args.url || !args.gatewayKey) {
    const state = await loadDaemonState();
    if (state) {
      args.url ??= state.url;
      args.gatewayKey ??= state.gatewayKey;
      console.log(`[test] Using daemon at ${args.url} (profile: ${state.profile})`);
    }
  }

  if (!args.url) {
    console.error(`No proxy URL. Provide --url or start the daemon: codemie proxy start`);
    process.exit(1);
  }
  if (!args.gatewayKey) {
    console.error(`No gateway key. Provide --gateway-key or start the daemon: codemie proxy start`);
    process.exit(1);
  }

  let baseUrl;
  try { baseUrl = new URL(args.url); }
  catch { console.error(`Invalid URL: ${args.url}`); process.exit(1); }

  const endpoint = args.endpoint.startsWith('/') ? args.endpoint : `/${args.endpoint}`;
  const targetUrl = new URL(endpoint, baseUrl);

  const body = {
    model: args.model,
    messages: [{ role: 'user', content: args.message }],
    max_tokens: args.maxTokens,
    stream: args.stream,
  };

  const headers = {
    'Content-Type': 'application/json',
    Accept: args.stream ? 'text/event-stream' : 'application/json',
    Authorization: `Bearer ${args.gatewayKey}`,
  };
  if (args.sendAnthropicVersion) headers['anthropic-version'] = '2023-06-01';

  console.log(`[test] POST ${targetUrl.href}`);
  console.log(`[test] Headers: ${JSON.stringify({ ...headers, Authorization: 'Bearer ***' })}`);
  console.log(`[test] Body:    ${JSON.stringify(body)}`);

  const startMs = Date.now();
  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error(`[test] Request failed: ${error.message}`);
    process.exit(1);
  }

  const ttfbMs = Date.now() - startMs;
  console.log(`\n[test] Status:  ${response.status} ${response.statusText}  (TTFB ${ttfbMs}ms)`);
  console.log(`[test] Response headers:`);
  for (const [k, v] of response.headers.entries()) {
    console.log(`         ${k}: ${v}`);
  }

  if (args.stream) {
    if (!response.body) {
      console.error('[test] No response body for streaming');
      process.exit(1);
    }
    console.log('\n[test] --- SSE stream ---');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let totalBytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunkCount += 1;
      totalBytes += value.length;
      process.stdout.write(decoder.decode(value, { stream: true }));
    }
    const totalMs = Date.now() - startMs;
    console.log(`\n[test] --- end (${chunkCount} chunks, ${totalBytes} bytes, ${totalMs}ms total) ---`);
  } else {
    const text = await response.text();
    const totalMs = Date.now() - startMs;
    console.log(`\n[test] Body (${text.length} bytes, ${totalMs}ms total):`);
    console.log(text);
  }

  if (!response.ok) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
