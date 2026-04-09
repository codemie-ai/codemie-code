#!/usr/bin/env node

/**
 * MCP Proxy Entry Point
 *
 * Lightweight entry point for the stdio-to-HTTP MCP proxy.
 * Skips migrations, update checks, and plugin loading to avoid
 * any stdout output that would corrupt the JSON-RPC stdio channel.
 *
 * Usage:
 *   node bin/mcp-proxy.js <url>
 *   claude mcp add my-server -- node /path/to/bin/mcp-proxy.js "https://mcp-server/path"
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Boot-level file logger (before any imports that might touch stdout)
const logDir = join(homedir(), '.codemie', 'logs');
const logFile = join(logDir, 'mcp-proxy.log');
try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }

function bootLog(msg) {
  const line = `[${new Date().toISOString()}] [boot] ${msg}\n`;
  try { appendFileSync(logFile, line); } catch { /* ignore */ }
}

bootLog(`mcp-proxy started, argv: ${JSON.stringify(process.argv)}`);
bootLog(`env: CODEMIE_DEBUG=${process.env.CODEMIE_DEBUG}, MCP_PROXY_DEBUG=${process.env.MCP_PROXY_DEBUG}`);

const url = process.argv[2];

if (!url) {
  console.error('Usage: mcp-proxy <url>');
  console.error('  url: MCP server URL to connect to');
  process.exit(1);
}

try {
  new URL(url);
} catch {
  bootLog(`Invalid URL: ${url}`);
  console.error(`[mcp-proxy] Invalid MCP server URL: ${url}`);
  process.exit(1);
}

bootLog(`URL validated: ${url}`);

let StdioHttpBridge;
try {
  const mod = await import('../dist/mcp/stdio-http-bridge.js');
  StdioHttpBridge = mod.StdioHttpBridge;
  bootLog('Bridge module imported successfully');
} catch (error) {
  bootLog(`Failed to import bridge: ${error.message}\n${error.stack}`);
  console.error(`[mcp-proxy] Failed to load: ${error.message}`);
  process.exit(1);
}

const bridge = new StdioHttpBridge({ serverUrl: url });

const shutdown = async () => {
  bootLog('Shutdown signal received');
  try {
    await bridge.shutdown();
  } catch (err) {
    bootLog(`Shutdown error: ${err.message}`);
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  bootLog(`Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  bootLog(`Unhandled rejection: ${reason}`);
});

try {
  bootLog('Starting bridge...');
  await bridge.start();
  bootLog('Bridge started, listening on stdio');
} catch (error) {
  bootLog(`Fatal error: ${error.message}\n${error.stack}`);
  console.error(`[mcp-proxy] Fatal error: ${error.message}`);
  process.exit(1);
}
