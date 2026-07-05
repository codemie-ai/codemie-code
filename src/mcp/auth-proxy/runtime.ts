/**
 * MCP Auth Proxy — shared daemon runtime.
 *
 * Single implementation behind both the detached bin entry and CLI --foreground:
 * load + validate config, start the server, persist the state file, clean up on
 * SIGTERM/SIGINT. No self-healing watcher by design (spec § Non-Goals): the proxy
 * holds no session state, so a crash only needs a manual restart.
 */
import { logger } from '../../utils/logger.js';
import { ensureAuthProxyCerts } from './certs.js';
import { getDefaultStatePath, loadAuthProxyConfig } from './config.js';
import { McpAuthProxy } from './server.js';
import type { ServerTlsMaterial } from './server.js';
import { clearAuthProxyState, writeAuthProxyState } from './state.js';

export interface RunDaemonOptions {
  configPath?: string;
  port?: number;
  stateFile?: string;
  /** Force TLS on regardless of the config file (CLI --tls / daemon --tls). */
  tls?: boolean;
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

  const tlsEnabled = options.tls === true || config.tls;
  let tlsMaterial: ServerTlsMaterial | undefined;
  if (tlsEnabled) {
    const material = await ensureAuthProxyCerts();
    tlsMaterial = { keyPem: material.keyPem, certPem: material.certPem };
  }

  const routes = Object.keys(config.servers);

  // One idempotent graceful path shared by the /shutdown endpoint and POSIX
  // signals: stop the server (drains SSE), clear state, exit. On Windows the
  // endpoint is the only path that runs this — a signal there is a hard kill,
  // so this must be reachable over HTTP, not just via SIGTERM/SIGINT.
  let shuttingDown = false;
  function gracefulShutdown(): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void stop().then(() => process.exit(0));
  }

  const proxy = new McpAuthProxy(config, gracefulShutdown, tlsMaterial);
  const { port, url } = await proxy.start();

  await writeAuthProxyState(
    { pid: process.pid, port, routes, startedAt: new Date().toISOString(), tls: tlsEnabled },
    stateFile
  );

  async function stop(): Promise<void> {
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
  }

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  logger.debug(`[mcp-auth-proxy] Daemon running at ${url} (routes: ${routes.join(', ')})`);
  return { proxy, port, url, routes, stop };
}
