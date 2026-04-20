/**
 * CLI command: codemie mcp-proxy <url>
 *
 * Stdio-to-HTTP MCP bridge with built-in OAuth authorization.
 * Claude Code spawns this as a stdio MCP server. It connects to the real
 * MCP server over streamable HTTP, handling OAuth when required.
 *
 * Usage:
 *   claude mcp add --scope project my-server -- codemie mcp-proxy "https://mcp-server.example.com/path"
 */

import { Command } from 'commander';
import { StdioHttpBridge } from '../../mcp/stdio-http-bridge.js';
import { logger } from '../../utils/logger.js';

export function createMcpProxyCommand(): Command {
  const command = new Command('mcp-proxy');

  command
    .description('Run a stdio-to-HTTP MCP proxy with OAuth support')
    .argument('<url>', 'MCP server URL to connect to')
    .action(async (url: string) => {
      // Validate URL
      try {
        new URL(url);
      } catch {
        console.error(`[mcp-proxy] Invalid MCP server URL: ${url}`);
        process.exit(1);
      }

      const bridge = new StdioHttpBridge({ serverUrl: url });

      // Graceful shutdown on signals
      const shutdown = async () => {
        try {
          logger.debug('[mcp-proxy] Received shutdown signal');
          await bridge.shutdown();
        } catch (err) {
          logger.debug(`[mcp-proxy] Error during shutdown: ${(err as Error).message}`);
        }
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      try {
        await bridge.start();
      } catch (error) {
        console.error(`[mcp-proxy] Fatal error: ${(error as Error).message}`);
        logger.debug(`[mcp-proxy] Fatal error: ${(error as Error).stack}`);
        process.exit(1);
      }
    });

  return command;
}
