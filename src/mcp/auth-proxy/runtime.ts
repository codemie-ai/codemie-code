/**
 * MCP Auth Proxy — shared daemon runtime.
 *
 * Single implementation behind both the detached bin entry and CLI --foreground:
 * load + validate config, start the server, persist the state file, clean up on
 * SIGTERM/SIGINT. No self-healing watcher by design (spec § Non-Goals): the proxy
 * holds no session state, so a crash only needs a manual restart.
 */
import { logger } from '../../utils/logger.js';
import { getDefaultStatePath, loadAuthProxyConfig } from './config.js';
import { McpAuthProxy } from './server.js';
import { clearAuthProxyState, writeAuthProxyState } from './state.js';

export interface RunDaemonOptions {
  configPath?: string;
  port?: number;
  stateFile?: string;
}

export interface RunningDaemon {
  proxy: McpAuthProxy;
  port: number;
  url: string;
  routes: string[];
  stop: () => Promise<void>;
}

export async function runAuthProxyDaemon(options: RunDaemonOptions = {}): Promise<RunningDaemon> {
  const config = await loadAuthProxyConfig(options.configPath);
  if (options.port !== undefined) {
    config.port = options.port;
  }
  const stateFile = options.stateFile ?? getDefaultStatePath();

  const proxy = new McpAuthProxy(config);
  const { port, url } = await proxy.start();
  const routes = Object.keys(config.servers);

  await writeAuthProxyState(
    { pid: process.pid, port, routes, startedAt: new Date().toISOString() },
    stateFile
  );

  const stop = async (): Promise<void> => {
    try {
      await proxy.stop();
    } catch {
      // Best-effort shutdown
    }
    try {
      await clearAuthProxyState(stateFile);
    } catch {
      // Best-effort cleanup
    }
  };
  const onSignal = (): void => {
    void stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  logger.debug(`[mcp-auth-proxy] Daemon running at ${url} (routes: ${routes.join(', ')})`);
  return { proxy, port, url, routes, stop };
}
