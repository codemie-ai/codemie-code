/**
 * CodeMie Proxy Daemon Entry Point
 *
 * Spawned as a detached process by `codemie proxy start`.
 * Starts CodeMieProxy on the requested port, writes state file, handles SIGTERM.
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { writeFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { CodeMieProxy } from '../providers/plugins/sso/index.js';
import type { ProxyConfig } from '../providers/plugins/sso/index.js';
import '../providers/plugins/sso/proxy/plugins/index.js'; // Auto-register core plugins
import { ClaudeDesktopTelemetryAdapter } from '../telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js';
import { DesktopTelemetryRuntime } from '../telemetry/runtime/DesktopTelemetryRuntime.js';
import { getDirname } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { ProxyWatcher } from '../cli/commands/proxy/watcher.js';

function readCliVersion(): string {
  try {
    const pkgPath = join(getDirname(import.meta.url), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const { values } = parseArgs({
  options: {
    'target-url':   { type: 'string' },
    'provider':     { type: 'string' },
    'profile':      { type: 'string' },
    'project':      { type: 'string' },
    'port':         { type: 'string' },
    'gateway-key':  { type: 'string' },
    'state-file':   { type: 'string' },
    'auth-method':  { type: 'string' },
    'telemetry-mode': { type: 'string' },
    'sync-api-url': { type: 'string' },
    'sync-codemie-url': { type: 'string' },
  },
  strict: false,
});

const targetUrl = values['target-url'] as string | undefined;
const stateFile = values['state-file'] as string | undefined;

if (!targetUrl || !stateFile) {
  process.stderr.write('[proxy-daemon] --target-url and --state-file are required\n');
  process.exit(1);
}

const portArg = values['port'] as string | undefined;
const parsedPort = portArg ? Number.parseInt(portArg, 10) : undefined;
if (parsedPort !== undefined && (!Number.isFinite(parsedPort) || parsedPort <= 0)) {
  process.stderr.write(`[proxy-daemon] Invalid --port value: ${portArg}\n`);
  process.exit(1);
}
const port = parsedPort;
const gatewayKey = (values['gateway-key'] as string | undefined) ?? 'codemie-proxy';
const profile    = (values['profile'] as string | undefined) ?? 'default';
const provider   = (values['provider'] as string | undefined) ?? 'ai-run-sso';
const project = values['project'] as string | undefined;
const authMethod = ((values['auth-method'] as string | undefined) ?? 'sso') as 'sso' | 'jwt';
const telemetryMode = ((values['telemetry-mode'] as string | undefined) ?? 'none') as 'none' | 'claude-desktop';
const syncApiUrl = values['sync-api-url'] as string | undefined;
const syncCodeMieUrl = values['sync-codemie-url'] as string | undefined;

const config: ProxyConfig = {
  targetApiUrl: targetUrl,
  port,
  // Bind to 127.0.0.1 explicitly — Claude Desktop's gateway URL validator
  // accepts only HTTPS or http on the literal 127.0.0.1 loopback IP, and the
  // default 'localhost' bind on macOS lands on IPv6 ::1 only.
  host: '127.0.0.1',
  provider,
  profile,
  project,
  gatewayKey,
  authMethod,
  clientType: telemetryMode === 'claude-desktop' ? 'claude-desktop' : 'codemie-daemon',
  version: readCliVersion(),
  telemetryMode,
  syncApiUrl,
  syncCodeMieUrl,
};

let proxy = new CodeMieProxy(config);
let telemetryRuntime: DesktopTelemetryRuntime | undefined;
let watcher: ProxyWatcher | undefined;
let currentState: Record<string, unknown> = {};

async function persistState(patch: Record<string, unknown>): Promise<void> {
  currentState = { ...currentState, ...patch };
  const tmp = stateFile + '.tmp';
  await writeFile(tmp, JSON.stringify(currentState, null, 2), 'utf-8');
  await rename(tmp, stateFile!);
}

async function cleanup(): Promise<void> {
  watcher?.stop();
  try { await telemetryRuntime?.stop(); } catch { /* ignore */ }
  try { await proxy.stop(); } catch { /* ignore */ }
  try { await unlink(stateFile!); } catch { /* ignore */ }
}

async function restartProxy(): Promise<void> {
  try {
    await proxy.stop();
  } catch (error) {
    logger.warn(`[proxy-daemon] proxy.stop() during restart failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Pin to the port we already bound so Claude Desktop's URL stays valid.
  config.pinnedPort = true;
  proxy = new CodeMieProxy(config);
  const { url } = await proxy.start();
  await persistState({
    url,
    health: 'ok',
    healthReason: undefined,
    lastHealthyAt: new Date().toISOString(),
    lastRecoveryAt: new Date().toISOString(),
  });
}

process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('SIGINT',  async () => { await cleanup(); process.exit(0); });

try {
  const { port: actualPort, url } = await proxy.start();

  // Pin future restarts to the port we actually bound. The initial bind may
  // have fallen back to a random port if 4001 was busy; recovery must reuse
  // whatever URL was written to the Desktop config.
  config.port = actualPort;
  config.pinnedPort = true;

  if (config.telemetryMode === 'claude-desktop') {
    telemetryRuntime = new DesktopTelemetryRuntime(
      new ClaudeDesktopTelemetryAdapter(),
      {
        clientType: 'claude-desktop',
        targetApiUrl: config.targetApiUrl,
        provider: config.provider ?? 'ai-run-sso',
        version: config.version ?? '0.0.0',
        profile: config.profile,
        syncApiUrl: config.syncApiUrl,
        syncCodeMieUrl: config.syncCodeMieUrl,
        pollIntervalMs: config.telemetryPollIntervalMs ?? 10000,
        inactivityTimeoutMs: config.telemetryInactivityTimeoutMs ?? 300000
      }
    );
    await telemetryRuntime.start();
  }

  const nowIso = new Date().toISOString();
  await persistState({
    pid: process.pid,
    port: actualPort,
    url,
    profile,
    gatewayKey,
    targetUrl: config.targetApiUrl,
    provider: config.provider,
    project: config.project,
    clientType: config.clientType,
    telemetryMode,
    syncApiUrl: config.syncApiUrl,
    syncCodeMieUrl: config.syncCodeMieUrl,
    startedAt: nowIso,
    health: 'ok',
    lastHealthyAt: nowIso,
  });

  // Background self-healing watcher: deep-checks every 30s, restarts in-process
  // on the same pinned port, gives up (records unhealthy) after 3 failures or
  // on an unrecoverable expired session.
  watcher = new ProxyWatcher(
    { port: actualPort, gatewayKey, intervalMs: 30000, maxRestartAttempts: 3 },
    {
      restart: restartProxy,
      onHealthy: async () => {
        await persistState({
          health: 'ok',
          healthReason: undefined,
          lastHealthyAt: new Date().toISOString(),
        });
      },
      onGiveUp: async (reason) => {
        await persistState({ health: 'unhealthy', healthReason: reason });
      },
    }
  );
  watcher.start();

  logger.debug(`[proxy-daemon] Started on ${url} (profile: ${profile})`);
} catch (error) {
  process.stderr.write(`[proxy-daemon] Failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
