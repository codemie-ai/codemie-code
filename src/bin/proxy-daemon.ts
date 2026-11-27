/**
 * CodeMie Proxy Daemon Entry Point
 *
 * Spawned as a detached process by `codemie proxy start`.
 * Starts CodeMieProxy on the requested port, writes state file, handles SIGTERM. What differs by the kind of daemon
 * (`--mode`) comes from its `DaemonComponents`.
 */
import { parseArgs } from 'node:util';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { CodeMieProxy } from '../providers/plugins/sso/index.js';
import '../providers/plugins/sso/proxy/plugins/index.js'; // Auto-register core plugins
import { getPluginRegistry } from '../providers/plugins/sso/proxy/plugins/registry.js';
import { logger } from '../utils/logger.js';
import { installSystemProxyDispatcher } from '../utils/system-proxy-dispatcher.js';
import { ProxyWatcher } from '../cli/commands/proxy/watcher.js';
import { daemonStartedAt } from '../cli/commands/proxy/daemon-manager.js';
import { backendDaemon, localDaemon, type DaemonArgs, type DaemonComponents, type DaemonRuntime } from './daemon-components.js';

const { values } = parseArgs({
  options: {
    'mode':         { type: 'string' },
    'target-url':   { type: 'string' },
    'provider':     { type: 'string' },
    'profile':      { type: 'string' },
    'model':        { type: 'string' },
    'project':      { type: 'string' },
    'project-binding': { type: 'string' },
    'port':         { type: 'string' },
    'gateway-key':  { type: 'string' },
    'state-file':   { type: 'string' },
    'auth-method':  { type: 'string' },
    'sync-api-url': { type: 'string' },
    'sync-codemie-url': { type: 'string' },
  },
  strict: false,
});

const mode = values['mode'];
if (mode !== undefined && mode !== 'local') {
  process.stderr.write(`[proxy-daemon] Unknown --mode: ${String(mode)}\n`);
  process.exit(1);
}
const daemon: DaemonComponents = mode === 'local' ? localDaemon : backendDaemon;

let args: DaemonArgs;
try {
  args = daemon.parse(values);
} catch (error) {
  process.stderr.write(`[proxy-daemon] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const { stateFile, gatewayKey, profile } = args;

await daemon.plugins(getPluginRegistry());
const config = await daemon.proxyConfig();

// Resolve proxy/PAC routing lazily per request. This keeps daemon startup
// independent of PAC availability and lets a running daemon recover with VPN.
installSystemProxyDispatcher();

let proxy = new CodeMieProxy(config);
let telemetryRuntime: DaemonRuntime | undefined;
let watcher: ProxyWatcher | undefined;
let currentState: Record<string, unknown> = {};
/** The state writes in order: two at once would share the one tmp file. */
let stateWrites: Promise<void> = Promise.resolve();
/** Set once cleanup began: the state is never written again. */
let closing = false;

/** Merges `patch` (an undefined value removes its field) into the state file, after every earlier write. */
function persistState(patch: Record<string, unknown>): Promise<void> {
  const write = stateWrites.then(async () => {
    if (closing) return;
    currentState = { ...currentState, ...patch };
    // Per process: two daemons writing at once never rename each other's half-written file.
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(currentState, null, 2), 'utf-8');
    await rename(tmp, stateFile);
  });
  stateWrites = write.catch(() => undefined);
  return write;
}

/** Removes the state file only while it names this process: a successor's state, or one unreadable, is left. */
async function unlinkOwnState(): Promise<void> {
  let state: unknown;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf-8'));
  } catch {
    return;
  }
  if ((state as { pid?: unknown } | null)?.pid === process.pid) await unlink(stateFile);
}

async function cleanup(): Promise<void> {
  closing = true;
  watcher?.stop();
  await daemon.cleanup();
  try { await telemetryRuntime?.stop(); } catch { /* ignore */ }
  try { await proxy.stop(); } catch { /* ignore */ }
  await stateWrites;
  try { await unlinkOwnState(); } catch { /* ignore */ }
}

async function restartProxy(): Promise<void> {
  await daemon.restart({
    stopProxy: () => proxy.stop(),
    nextProxy: () => {
      // Pin to the port we already bound so Claude Desktop's URL stays valid.
      config.pinnedPort = true;
      proxy = new CodeMieProxy(config);
      return proxy;
    },
    persistState,
  });
}

process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('SIGINT',  async () => { await cleanup(); process.exit(0); });

try {
  const { port: actualPort, url } = await daemon.bringUp(proxy);

  // Pin future restarts to the port we actually bound. The initial bind may
  // have fallen back to a random port if 4001 was busy; recovery must reuse
  // whatever URL was written to the Desktop config.
  config.port = actualPort;
  config.pinnedPort = true;

  const runtime = daemon.desktopRuntime(config, { persistState });
  telemetryRuntime = runtime;
  config.triggerPoll = () => runtime.triggerPoll();

  await persistState({
    pid: process.pid,
    port: actualPort,
    url,
    profile,
    gatewayKey,
    ...daemon.stateFields(),
    startedAt: daemonStartedAt(),
    ...daemon.healthPatch(),
  });

  // After the state write: `spawnDaemon` reads the daemon as up while the runtime's first poll still runs.
  await runtime.start();

  // Background self-healing watcher: checks every 30s, restarts in-process
  // on the same pinned port, gives up (records unhealthy) after 3 failures or
  // on an unrecoverable expired session.
  watcher = new ProxyWatcher(
    { port: actualPort, intervalMs: 30000, maxRestartAttempts: 3 },
    daemon.watcher({ restart: restartProxy, persistState })
  );
  watcher.start();

  logger.debug(`[proxy-daemon] Started on ${url} (profile: ${profile})`);
} catch (error) {
  process.stderr.write(`[proxy-daemon] Failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
