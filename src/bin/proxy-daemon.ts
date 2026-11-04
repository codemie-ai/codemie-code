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
import { DesktopRepositoryResolver } from '../telemetry/runtime/DesktopRepositoryResolver.js';
import { getDirname } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { parseProjectBinding } from '../utils/project-binding.js';
import { installSystemProxyDispatcher } from '../utils/system-proxy-dispatcher.js';
import { ProxyWatcher } from '../cli/commands/proxy/watcher.js';
import { daemonStartedAt } from '../cli/commands/proxy/daemon-manager.js';
import { startAwaitingLoginListener, type AwaitingLoginListener } from '../cli/commands/proxy/awaiting-login-listener.js';
import { AuthenticationError } from '../providers/plugins/sso/proxy/proxy-errors.js';
import { getStoredPlatformCredentials } from '../providers/core/codemie-auth-helpers.js';

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
    'model':        { type: 'string' },
    'project':      { type: 'string' },
    'project-binding': { type: 'string' },
    'client-type':  { type: 'string' },
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
const model = values['model'] as string | undefined;
const project = values['project'] as string | undefined;
const projectBinding = parseProjectBinding(values['project-binding'] as string | undefined);
const clientType = values['client-type'] as string | undefined;
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
  model,
  project,
  gatewayKey,
  authMethod,
  clientType: clientType ?? (telemetryMode === 'claude-desktop' ? 'claude-desktop' : 'codemie-daemon'),
  version: readCliVersion(),
  telemetryMode,
  syncApiUrl,
  syncCodeMieUrl,
};

// Resolve proxy/PAC routing lazily per request. This keeps daemon startup
// independent of PAC availability and lets a running daemon recover with VPN.
installSystemProxyDispatcher();

let proxy = new CodeMieProxy(config);
let telemetryRuntime: DesktopTelemetryRuntime | undefined;
let watcher: ProxyWatcher | undefined;
// Set while the real proxy could not start for want of SSO credentials: this listener holds the port.
let awaitingLogin: AwaitingLoginListener | undefined;
let currentState: Record<string, unknown> = {};

async function persistState(patch: Record<string, unknown>): Promise<void> {
  currentState = { ...currentState, ...patch };
  // Per process: two daemons writing at once never rename each other's half-written file.
  const tmp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(currentState, null, 2), 'utf-8');
  await rename(tmp, stateFile!);
}

/**
 * Start the real proxy; with no SSO credentials, keep the port bound with a listener that answers
 * an actionable 401 and let the watcher swap the proxy in once the user has signed in.
 */
async function bringUp(): Promise<{ port: number; url: string }> {
  try {
    const started = await proxy.start();
    awaitingLogin = undefined;
    return started;
  } catch (error) {
    if (!(error instanceof AuthenticationError) || authMethod !== 'sso') {
      throw error;
    }
    logger.warn(`[proxy-daemon] ${error.message} Holding the port until credentials are available.`);
    awaitingLogin = await startAwaitingLoginListener({
      port: config.port,
      host: config.host as string,
      pinnedPort: config.pinnedPort,
      message: error.message,
    });
    return awaitingLogin;
  }
}

function healthPatch(): Record<string, unknown> {
  return awaitingLogin
    ? { health: 'unhealthy', healthReason: awaitingLogin.message }
    : { health: 'ok', healthReason: undefined, lastHealthyAt: new Date().toISOString() };
}

async function credentialsAvailable(): Promise<boolean> {
  const stored = await getStoredPlatformCredentials({
    provider: config.provider,
    baseUrl: config.targetApiUrl,
    codeMieUrl: config.syncCodeMieUrl,
  });
  return Boolean(stored?.credentials);
}

async function cleanup(): Promise<void> {
  watcher?.stop();
  try { await awaitingLogin?.stop(); } catch { /* ignore */ }
  try { await telemetryRuntime?.stop(); } catch { /* ignore */ }
  try { await proxy.stop(); } catch { /* ignore */ }
  try { await unlink(stateFile!); } catch { /* ignore */ }
}

async function restartProxy(): Promise<void> {
  try {
    await awaitingLogin?.stop();
    awaitingLogin = undefined;
    await proxy.stop();
  } catch (error) {
    logger.warn(`[proxy-daemon] proxy.stop() during restart failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Pin to the port we already bound so Claude Desktop's URL stays valid.
  config.pinnedPort = true;
  proxy = new CodeMieProxy(config);
  const { url } = await bringUp();
  await persistState({ url, ...healthPatch(), lastRecoveryAt: new Date().toISOString() });
}

process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('SIGINT',  async () => { await cleanup(); process.exit(0); });

try {
  const { port: actualPort, url } = await bringUp();

  // Pin future restarts to the port we actually bound. The initial bind may
  // have fallen back to a random port if 4001 was busy; recovery must reuse
  // whatever URL was written to the Desktop config.
  config.port = actualPort;
  config.pinnedPort = true;

  if (config.telemetryMode === 'claude-desktop') {
    // One resolver shared by the proxy's header injection and the telemetry poll, so both
    // read and write the same attribution cache.
    const repositoryResolver = new DesktopRepositoryResolver();
    config.desktopRepositoryResolver = repositoryResolver;

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
        inactivityTimeoutMs: config.telemetryInactivityTimeoutMs ?? 300000,
        repositoryResolver,
      }
    );

    config.triggerPoll = () => telemetryRuntime!.triggerPoll();
  }

  await persistState({
    pid: process.pid,
    port: actualPort,
    url,
    profile,
    gatewayKey,
    targetUrl: config.targetApiUrl,
    provider: config.provider,
    project: config.project,
    ...(projectBinding ? { projectBinding } : {}),
    clientType: config.clientType,
    telemetryMode,
    syncApiUrl: config.syncApiUrl,
    syncCodeMieUrl: config.syncCodeMieUrl,
    startedAt: daemonStartedAt(),
    ...healthPatch(),
  });

  // After the state write: `spawnDaemon` reads the daemon as up while the runtime's first poll still runs.
  await telemetryRuntime?.start();

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
        await persistState({ health: 'unhealthy', healthReason: awaitingLogin?.message ?? reason });
      },
      // Signed in again while the port was held: bring the real proxy back on it.
      onUnauthorized: async () => {
        if (awaitingLogin && await credentialsAvailable()) {
          await restartProxy();
        }
      },
    }
  );
  watcher.start();

  logger.debug(`[proxy-daemon] Started on ${url} (profile: ${profile})`);
} catch (error) {
  process.stderr.write(`[proxy-daemon] Failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
