#!/usr/bin/env node

/**
 * CodeMie MCP Auth Proxy Daemon entry point
 * Imports compiled daemon from dist/
 */
import('../dist/bin/mcp-auth-proxy-daemon.js').catch((error) => {
  process.stderr.write(`[mcp-auth-proxy-daemon] Fatal: ${error.message}\n`);
  process.exit(1);
});
