/**
 * `codemie mcp-auth-proxy` — manage the MCP OAuth rewriting proxy daemon.
 *
 * Distinct from `codemie mcp-proxy` (the stdio↔HTTP bridge): this command manages a
 * background loopback HTTP proxy that rewrites OAuth client_name/scope/resource for
 * remote MCP servers — see docs/SPEC-mcp-auth-proxy.md.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import http from 'node:http';
import { join, resolve } from 'node:path';
import {
  ConfigurationError,
  ToolExecutionError,
  createErrorContext,
  formatErrorForUser,
} from '../../utils/errors.js';
import { getDirname } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import { spawnDetached } from '../../utils/processes.js';
import {
  getDefaultConfigPath,
  getDefaultStatePath,
  loadAuthProxyConfig,
} from '../../mcp/auth-proxy/config.js';
import { runAuthProxyDaemon } from '../../mcp/auth-proxy/runtime.js';
import {
  clearAuthProxyState,
  isProcessAlive,
  readAuthProxyState,
} from '../../mcp/auth-proxy/state.js';
import type { RouteStatus } from '../../mcp/auth-proxy/types.js';

function parsePortOption(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new ConfigurationError(`Invalid port value: ${value}`);
  }
  return parsed;
}

function printError(error: unknown, label: string): never {
  logger.error(label, error);
  if (error instanceof ConfigurationError || error instanceof ToolExecutionError) {
    console.error(chalk.red(`✗ ${error.message}`));
  } else {
    console.error(formatErrorForUser(createErrorContext(error), { showSystem: false }));
  }
  process.exit(1);
}

function printAddCommands(port: number, routes: string[]): void {
  console.log(chalk.bold('\nAdd to Claude Code:'));
  for (const id of routes) {
    console.log(`  claude mcp add --scope local --transport http ${id} http://127.0.0.1:${port}/${id}`);
  }
}

interface HealthzRoute {
  id: string;
  upstreamUrl: string;
  status: RouteStatus;
}

function fetchHealth(port: number): Promise<{ status: string; routes: HealthzRoute[] }> {
  return new Promise((resolveHealth, rejectHealth) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/healthz', timeout: 2000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolveHealth(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (error) {
            rejectHealth(error as Error);
          }
        });
      }
    );
    request.on('error', rejectHealth);
    request.on('timeout', () => request.destroy(new Error('healthz timed out')));
  });
}

export function createMcpAuthProxyCommand(): Command {
  const command = new Command('mcp-auth-proxy');
  command.description(
    'Manage the MCP OAuth rewriting proxy (client_name/scope/resource rewrites for remote MCP servers; not the stdio mcp-proxy bridge)'
  );

  command
    .command('start')
    .description('Start the proxy daemon (detached by default)')
    .option('--config <path>', 'Config file path (default: <codemie-home>/mcp-auth-proxy.json)')
    .option('--port <port>', 'Override the configured listen port')
    .option('--foreground', 'Run in the foreground (debugging; CODEMIE_DEBUG=true for verbose logs)')
    .action(async (opts: { config?: string; port?: string; foreground?: boolean }) => {
      try {
        const existing = await readAuthProxyState();
        if (existing && isProcessAlive(existing.pid)) {
          console.log(
            chalk.green(
              `✓ mcp-auth-proxy already running on http://127.0.0.1:${existing.port} (pid ${existing.pid})`
            )
          );
          printAddCommands(existing.port, existing.routes);
          return;
        }
        await clearAuthProxyState();

        const configPath = opts.config ? resolve(opts.config) : getDefaultConfigPath();
        const config = await loadAuthProxyConfig(configPath); // fail fast with the offending key path
        const port = parsePortOption(opts.port) ?? config.port;
        const routes = Object.keys(config.servers);

        if (opts.foreground) {
          await runAuthProxyDaemon({ configPath, port });
          console.log(chalk.green(`✓ mcp-auth-proxy running (foreground) on http://127.0.0.1:${port}`));
          printAddCommands(port, routes);
          console.log(chalk.gray('Press Ctrl+C to stop.'));
          return;
        }

        // dist/cli/commands/mcp-auth-proxy.js → ../../../bin/mcp-auth-proxy-daemon.js
        const daemonBin = join(getDirname(import.meta.url), '../../../bin/mcp-auth-proxy-daemon.js');
        spawnDetached(process.execPath, [
          daemonBin,
          '--config', configPath,
          '--port', String(port),
          '--state-file', getDefaultStatePath(),
        ]);

        for (let i = 0; i < 50; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          const state = await readAuthProxyState();
          if (state && isProcessAlive(state.pid)) {
            console.log(
              chalk.green(`✓ mcp-auth-proxy started on http://127.0.0.1:${state.port} (pid ${state.pid})`)
            );
            printAddCommands(state.port, state.routes);
            return;
          }
        }
        throw new ToolExecutionError(
          'mcp-auth-proxy-daemon',
          'Daemon failed to start within 5 seconds. Try --foreground with CODEMIE_DEBUG=true.'
        );
      } catch (error) {
        printError(error, '[mcp-auth-proxy] start failed');
      }
    });

  command
    .command('status')
    .description('Show daemon status and per-route health')
    .action(async () => {
      const state = await readAuthProxyState();
      if (!state || !isProcessAlive(state.pid)) {
        if (state) {
          await clearAuthProxyState();
        }
        console.log(chalk.yellow('mcp-auth-proxy is not running'));
        return;
      }
      console.log(
        chalk.green(
          `✓ mcp-auth-proxy running on http://127.0.0.1:${state.port} (pid ${state.pid}, started ${state.startedAt})`
        )
      );
      try {
        const health = await fetchHealth(state.port);
        for (const route of health.routes) {
          const marker =
            route.status === 'degraded' ? chalk.red('✗ degraded') : chalk.green(`✓ ${route.status}`);
          console.log(`  ${route.id}: ${marker} → ${route.upstreamUrl}`);
          console.log(
            `    claude mcp add --scope local --transport http ${route.id} http://127.0.0.1:${state.port}/${route.id}`
          );
        }
      } catch {
        console.log(chalk.red('  ✗ Daemon process is alive but /healthz did not answer'));
      }
    });

  command
    .command('stop')
    .description('Stop the proxy daemon and remove its state file')
    .action(async () => {
      const state = await readAuthProxyState();
      if (!state || !isProcessAlive(state.pid)) {
        await clearAuthProxyState();
        console.log(chalk.yellow('mcp-auth-proxy is not running'));
        return;
      }
      process.kill(state.pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
        if (!isProcessAlive(state.pid)) {
          break;
        }
      }
      if (isProcessAlive(state.pid)) {
        logger.warn('[mcp-auth-proxy] Daemon ignored SIGTERM; escalating to SIGKILL');
        try {
          process.kill(state.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the signal — fine.
        }
      }
      await clearAuthProxyState();
      console.log(chalk.green('✓ mcp-auth-proxy stopped'));
    });

  return command;
}
