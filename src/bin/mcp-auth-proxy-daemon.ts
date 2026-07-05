/**
 * MCP Auth Proxy Daemon Entry Point
 *
 * Spawned as a detached process by `codemie mcp-auth-proxy start`.
 * Loads the config, starts McpAuthProxy, writes the state file, handles SIGTERM.
 */
import { parseArgs } from 'node:util';
import { runAuthProxyDaemon } from '../mcp/auth-proxy/runtime.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    port: { type: 'string' },
    'state-file': { type: 'string' },
    tls: { type: 'boolean' },
  },
  strict: false,
});

const portArg = values.port as string | undefined;
const port = portArg ? Number.parseInt(portArg, 10) : undefined;
if (port !== undefined && (!Number.isFinite(port) || port <= 0)) {
  process.stderr.write(`[mcp-auth-proxy-daemon] Invalid --port value: ${portArg}\n`);
  process.exit(1);
}

try {
  await runAuthProxyDaemon({
    configPath: values.config as string | undefined,
    port,
    stateFile: values['state-file'] as string | undefined,
    tls: values.tls === true,
  });
} catch (error) {
  process.stderr.write(`[mcp-auth-proxy-daemon] Failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
