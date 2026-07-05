/**
 * `codemie mcp-auth-proxy` — manage the MCP OAuth rewriting proxy daemon.
 *
 * Distinct from `codemie mcp-proxy` (the stdio↔HTTP bridge): this command manages a
 * background loopback HTTP proxy that rewrites OAuth client_name/scope/resource for
 * remote MCP servers — see docs/SPEC-mcp-auth-proxy.md.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ConfigurationError,
  ToolExecutionError,
  createErrorContext,
  formatErrorForUser,
} from '../../utils/errors.js';
import { getDirname } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import { exec, spawnDetached } from '../../utils/processes.js';
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
import { fetchHealth, requestShutdown } from '../../mcp/auth-proxy/client.js';
import type { DaemonEndpoint } from '../../mcp/auth-proxy/client.js';
import { ensureAuthProxyCerts, getAuthProxyTlsPaths } from '../../mcp/auth-proxy/certs.js';
import { applyTrust } from '../../mcp/auth-proxy/trust.js';
import type { AuthProxyDaemonState } from '../../mcp/auth-proxy/types.js';

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

function printAddCommands(port: number, routes: string[], tls: boolean): void {
  const protocol = tls ? 'https' : 'http';
  console.log(chalk.bold('\nAdd to Claude Code:'));
  for (const id of routes) {
    console.log(
      `  claude mcp add --scope local --transport http ${id} ${protocol}://127.0.0.1:${port}/${id}`
    );
  }
}

function printTlsHints(): void {
  console.log(
    chalk.yellow(
      '\n⚠ TLS is enabled: routes previously registered with http:// URLs must be re-registered with the https:// URLs above.'
    )
  );
  console.log(
    chalk.gray(
      'If the browser or Claude Desktop rejects the certificate, run: codemie mcp-auth-proxy trust\n' +
        'Node-based clients (e.g. Claude Code CLI) do not read the OS trust store — set NODE_EXTRA_CA_CERTS=' +
        getAuthProxyTlsPaths().caCert
    )
  );
}

/** Builds the control-plane endpoint from daemon state, loading the CA for TLS daemons. */
async function daemonEndpoint(state: AuthProxyDaemonState): Promise<DaemonEndpoint> {
  if (state.tls !== true) {
    return { port: state.port, tls: false };
  }
  try {
    return {
      port: state.port,
      tls: true,
      caPem: await readFile(getAuthProxyTlsPaths().caCert, 'utf-8'),
    };
  } catch {
    // CA file missing — request will fail TLS verification and callers fall back.
    return { port: state.port, tls: true };
  }
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
    .option('--tls', 'Serve HTTPS with the locally-generated CodeMie CA (see the trust subcommand)')
    .action(async (opts: { config?: string; port?: string; foreground?: boolean; tls?: boolean }) => {
      try {
        const existing = await readAuthProxyState();
        if (existing && isProcessAlive(existing.pid)) {
          console.log(
            chalk.green(
              `✓ mcp-auth-proxy already running on http://127.0.0.1:${existing.port} (pid ${existing.pid})`
            )
          );
          printAddCommands(existing.port, existing.routes, existing.tls === true);
          return;
        }
        await clearAuthProxyState();

        const configPath = opts.config ? resolve(opts.config) : getDefaultConfigPath();
        const config = await loadAuthProxyConfig(configPath); // fail fast with the offending key path
        const port = parsePortOption(opts.port) ?? config.port;
        const routes = Object.keys(config.servers);
        const tls = opts.tls === true || config.tls;
        if (tls) {
          await ensureAuthProxyCerts(); // fail fast on cert problems before spawning
        }

        if (opts.foreground) {
          await runAuthProxyDaemon({ configPath, port, tls: opts.tls === true });
          console.log(
            chalk.green(
              `✓ mcp-auth-proxy running (foreground) on ${tls ? 'https' : 'http'}://127.0.0.1:${port}`
            )
          );
          printAddCommands(port, routes, tls);
          if (tls) {
            printTlsHints();
          }
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
          ...(opts.tls === true ? ['--tls'] : []),
        ]);

        for (let i = 0; i < 50; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          const state = await readAuthProxyState();
          if (state && isProcessAlive(state.pid)) {
            console.log(
              chalk.green(
                `✓ mcp-auth-proxy started on ${state.tls === true ? 'https' : 'http'}://127.0.0.1:${state.port} (pid ${state.pid})`
              )
            );
            printAddCommands(state.port, state.routes, state.tls === true);
            if (state.tls === true) {
              printTlsHints();
            }
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
      const protocol = state.tls === true ? 'https' : 'http';
      console.log(
        chalk.green(
          `✓ mcp-auth-proxy running on ${protocol}://127.0.0.1:${state.port} (pid ${state.pid}, started ${state.startedAt})`
        )
      );
      try {
        const health = await fetchHealth(await daemonEndpoint(state));
        for (const route of health.routes) {
          const marker =
            route.status === 'degraded' ? chalk.red('✗ degraded') : chalk.green(`✓ ${route.status}`);
          console.log(`  ${route.id}: ${marker} → ${route.upstreamUrl}`);
          console.log(
            `    claude mcp add --scope local --transport http ${route.id} ${protocol}://127.0.0.1:${state.port}/${route.id}`
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
      // Graceful first (works on Windows and POSIX): ask the daemon to run its
      // own proxy.stop() + exit via the loopback control endpoint. Only wait for
      // a self-exit when it acked — a wedged/unreachable daemon returns false
      // immediately, so skip straight to the signal fallback instead of polling.
      const acked = await requestShutdown(await daemonEndpoint(state));
      if (acked) {
        for (let i = 0; i < 50; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          if (!isProcessAlive(state.pid)) {
            break;
          }
        }
      }

      // Fallback only if it did not exit: SIGTERM (POSIX graceful / Windows hard
      // kill), then SIGKILL. Skipped entirely when the daemon already shut down.
      if (isProcessAlive(state.pid)) {
        logger.warn('[mcp-auth-proxy] Graceful shutdown timed out; sending SIGTERM');
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {
          // Already gone between the check and the signal — fine.
        }
        for (let i = 0; i < 50; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          if (!isProcessAlive(state.pid)) {
            break;
          }
        }
      }
      if (isProcessAlive(state.pid)) {
        logger.warn('[mcp-auth-proxy] Daemon ignored SIGTERM; escalating to SIGKILL');
        try {
          process.kill(state.pid, 'SIGKILL');
        } catch {
          // Already gone — fine.
        }
      }
      await clearAuthProxyState();
      console.log(chalk.green('✓ mcp-auth-proxy stopped'));
    });

  command
    .command('trust')
    .description('Install (or remove) the locally-generated CA in the OS user trust store')
    .option('--uninstall', 'Remove the CodeMie CA from the trust store instead of installing it')
    .action(async (opts: { uninstall?: boolean }) => {
      try {
        const material = await ensureAuthProxyCerts();
        const action = opts.uninstall === true ? 'uninstall' : 'install';
        const result = await applyTrust(action, {
          platform: platform(),
          exec: (cmd, args) => exec(cmd, args),
          caPath: material.paths.caCert,
          caCommonName: material.caCommonName,
        });

        const { X509Certificate } = await import('node:crypto');
        const ca = new X509Certificate(material.caCertPem);
        console.log(`CA certificate : ${material.paths.caCert}`);
        console.log(`Subject CN     : ${material.caCommonName}`);
        console.log(`SHA-256        : ${ca.fingerprint256}`);
        console.log(`Valid until    : ${ca.validTo}`);

        if (result.ok) {
          console.log(
            chalk.green(
              action === 'install'
                ? '✓ CA installed in the user trust store'
                : '✓ CA removed from the user trust store'
            )
          );
        } else {
          console.log(chalk.yellow(`Automated ${action} was not possible on this system.`));
          if (result.manual !== undefined) {
            console.log(result.manual);
          }
          process.exitCode = 1;
        }
      } catch (error) {
        printError(error, '[mcp-auth-proxy] trust failed');
      }
    });

  return command;
}
