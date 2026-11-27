/**
 * The parts of a proxy daemon that differ by the kind of daemon it is: its arguments, plugin set, proxy config,
 * how it brings the proxy up and back, what it adds to the state, what its watcher checks and its Desktop runtime.
 * The entry (`proxy-daemon.ts`) owns the generic lifecycle and calls these members.
 */
import type { CodeMieProxy, ProxyConfig } from '../providers/plugins/sso/index.js';
import type { PluginRegistry } from '../providers/plugins/sso/proxy/plugins/registry.js';
import { ClaudeDesktopTelemetryAdapter } from '../telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js';
import { DesktopTelemetryRuntime } from '../telemetry/runtime/DesktopTelemetryRuntime.js';
import { DesktopRepositoryResolver } from '../telemetry/runtime/DesktopRepositoryResolver.js';
import { getCurrentCliVersion } from '../utils/cli-updater.js';
import { ConfigurationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { parseProjectBinding, type ProjectBindingState } from '../utils/project-binding.js';
import type { WatcherCallbacks } from '../cli/commands/proxy/watcher.js';
import { checkProxyHealth } from '../cli/commands/proxy/health-check.js';
import { DEFAULT_GATEWAY_KEY, readConnectionRecord } from '../cli/commands/proxy/daemon-manager.js';
import { startAwaitingLoginListener, type AwaitingLoginListener } from '../cli/commands/proxy/awaiting-login-listener.js';
import { AuthenticationError } from '../providers/plugins/sso/proxy/proxy-errors.js';
import { getStoredPlatformCredentials } from '../providers/core/codemie-auth-helpers.js';
import { startDetachedSsoLogin, type DetachedLoginOutcome } from '../providers/plugins/sso/sso.detached-login.js';
import { sessionExpiredMessage } from '../providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.js';
import { markAnalyticsAuthInvalid } from '../utils/analytics-auth-status.js';
import { CLAUDE_DESKTOP, defaultClientOf } from '../providers/plugins/sso/proxy/proxy-clients.js';
import { GatewayKeyPlugin } from '../providers/plugins/sso/proxy/plugins/gateway-key.plugin.js';
import { LocalAnalyticsPlugin } from '../providers/plugins/sso/proxy/plugins/local-analytics.plugin.js';
import { NoUpstreamPlugin } from '../providers/plugins/sso/proxy/plugins/no-upstream.plugin.js';

type PersistState = (patch: Record<string, unknown>) => Promise<void>;

/** What every daemon's entry needs from its arguments. */
export interface DaemonArgs {
  stateFile: string;
  port?: number;
  gatewayKey: string;
  profile: string;
}

/** The entry's hold on the proxy, for a restart. */
export interface RestartHost {
  /** Stops the current proxy. */
  stopProxy(): Promise<void>;
  /** Builds the next proxy on the pinned port and makes it the current one. */
  nextProxy(): CodeMieProxy;
  persistState: PersistState;
}

export interface DaemonRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  triggerPoll(): Promise<void>;
}

export interface DaemonComponents {
  /** Reads the daemon's arguments; throws `ConfigurationError` naming a missing or invalid one. */
  parse(values: Record<string, string | boolean | undefined>): DaemonArgs;
  /** Chooses the plugin set the proxy initializes. */
  plugins(registry: PluginRegistry): Promise<void>;
  proxyConfig(): Promise<ProxyConfig>;
  /** Starts `proxy` and answers where it listens. */
  bringUp(proxy: CodeMieProxy): Promise<{ port: number; url: string }>;
  /** Replaces the proxy in-process on the same port; the watcher's recovery. */
  restart(host: RestartHost): Promise<void>;
  /** The health fields of the state after a bring-up. */
  healthPatch(): Record<string, unknown>;
  /** Stops what the daemon's own parts hold, before the runtime and the proxy stop. */
  cleanup(): Promise<void>;
  /** The watcher's check and callbacks. */
  watcher(host: { restart: () => Promise<void>; persistState: PersistState }): WatcherCallbacks;
  desktopRuntime(config: ProxyConfig, opts: { persistState: PersistState }): DaemonRuntime;
  /** The daemon's own fields of its first full state write. */
  stateFields(): Record<string, unknown>;
}

/** The arguments every daemon reads the same way: `--state-file` (required), `--port`, `--gateway-key`. */
function parseSharedArgs(values: Record<string, string | boolean | undefined>): Omit<DaemonArgs, 'profile'> {
  const stateFile = values['state-file'] as string | undefined;
  if (!stateFile) {
    throw new ConfigurationError('--state-file is required');
  }
  const portArg = values['port'] as string | undefined;
  const port = portArg ? Number.parseInt(portArg, 10) : undefined;
  if (port !== undefined && (!Number.isFinite(port) || port <= 0)) {
    throw new ConfigurationError(`Invalid --port value: ${portArg}`);
  }
  return { stateFile, port, gatewayKey: (values['gateway-key'] as string | undefined) ?? DEFAULT_GATEWAY_KEY };
}

/** The arguments of a daemon that serves a CodeMie backend. */
interface BackendArgs extends DaemonArgs {
  targetUrl: string;
  provider: string;
  model?: string;
  project?: string;
  projectBinding?: ProjectBindingState;
  authMethod: 'sso' | 'jwt';
  syncApiUrl?: string;
  syncCodeMieUrl?: string;
}

let args: BackendArgs;
let config: ProxyConfig;
// Set while the real proxy could not start for want of SSO credentials: this listener holds the port.
let awaitingLogin: AwaitingLoginListener | undefined;

/**
 * Called by the awaiting-login listener for a request that carried the gateway key: records the
 * rejected login for analytics, starts the (locked, throttled) browser sign-in and returns the 401 text.
 * The full proxy does the same when the gateway answers an expired-session redirect.
 */
async function promptSignIn(): Promise<string> {
  let outcome: DetachedLoginOutcome | undefined;
  try {
    await markAnalyticsAuthInvalid('proxy daemon holds the port without SSO credentials', config.targetApiUrl);
    outcome = await startDetachedSsoLogin(config.targetApiUrl);
  } catch (error) {
    logger.warn(`[proxy-daemon] Starting the browser sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return sessionExpiredMessage(outcome);
}

async function credentialsAvailable(): Promise<boolean> {
  const stored = await getStoredPlatformCredentials({
    provider: config.provider,
    baseUrl: config.targetApiUrl,
    codeMieUrl: config.syncCodeMieUrl,
  });
  return Boolean(stored?.credentials);
}

function healthPatch(): Record<string, unknown> {
  return awaitingLogin
    ? { health: 'unhealthy', healthReason: awaitingLogin.message }
    : { health: 'ok', healthReason: undefined, lastHealthyAt: new Date().toISOString() };
}

/**
 * Start the real proxy; with no SSO credentials, keep the port bound with a listener that answers
 * an actionable 401 and let the watcher swap the proxy in once the user has signed in.
 */
async function bringUp(proxy: CodeMieProxy): Promise<{ port: number; url: string }> {
  try {
    const started = await proxy.start();
    awaitingLogin = undefined;
    return started;
  } catch (error) {
    if (!(error instanceof AuthenticationError) || args.authMethod !== 'sso') {
      throw error;
    }
    logger.warn(`[proxy-daemon] ${error.message} Holding the port until credentials are available.`);
    awaitingLogin = await startAwaitingLoginListener({
      port: config.port,
      host: config.host as string,
      pinnedPort: config.pinnedPort,
      message: error.message,
      gatewayKey: args.gatewayKey,
      onSignInRequest: promptSignIn,
    });
    return awaitingLogin;
  }
}

/** The daemon of a machine with a CodeMie backend: the proxy forwards to `--target-url`. */
export const backendDaemon: DaemonComponents = {
  parse(values) {
    const targetUrl = values['target-url'] as string | undefined;
    if (!targetUrl || !values['state-file']) {
      throw new ConfigurationError('--target-url and --state-file are required');
    }
    args = {
      ...parseSharedArgs(values),
      profile: (values['profile'] as string | undefined) ?? 'default',
      targetUrl,
      provider: (values['provider'] as string | undefined) ?? 'ai-run-sso',
      model: values['model'] as string | undefined,
      project: values['project'] as string | undefined,
      projectBinding: parseProjectBinding(values['project-binding'] as string | undefined),
      authMethod: ((values['auth-method'] as string | undefined) ?? 'sso') as 'sso' | 'jwt',
      syncApiUrl: values['sync-api-url'] as string | undefined,
      syncCodeMieUrl: values['sync-codemie-url'] as string | undefined,
    };
    return args;
  },

  // Every plugin stays as registered.
  plugins: async () => undefined,

  async proxyConfig() {
    config = {
      targetApiUrl: args.targetUrl,
      port: args.port,
      // Bind to 127.0.0.1 explicitly — Claude Desktop's gateway URL validator
      // accepts only HTTPS or http on the literal 127.0.0.1 loopback IP, and the
      // default 'localhost' bind on macOS lands on IPv6 ::1 only.
      host: '127.0.0.1',
      provider: args.provider,
      profile: args.profile,
      model: args.model,
      project: args.project,
      gatewayKey: args.gatewayKey,
      authMethod: args.authMethod,
      // The client a request with the shared key is served as; a named key names its own.
      clientType: defaultClientOf(await readConnectionRecord()),
      version: (await getCurrentCliVersion()) ?? '0.0.0',
      syncApiUrl: args.syncApiUrl,
      syncCodeMieUrl: args.syncCodeMieUrl,
    };
    // One resolver shared by the proxy's client attribution and the telemetry poll, so both
    // read and write the same attribution cache; on the config before the first proxy creates its plugins.
    config.desktopRepositoryResolver = new DesktopRepositoryResolver();
    return config;
  },

  bringUp,

  async restart(host) {
    const heldListener = awaitingLogin;
    try {
      await awaitingLogin?.stop();
      awaitingLogin = undefined;
      await host.stopProxy();
    } catch (error) {
      logger.warn(`[proxy-daemon] proxy.stop() during restart failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const proxy = host.nextProxy();
    let started: { port: number; url: string };
    try {
      started = await bringUp(proxy);
    } catch (error) {
      if (heldListener) {
        // A failed replacement must not discard the sign-in listener when the port is free.
        await proxy.stop().catch(stopError => {
          logger.warn(`[proxy-daemon] Cleanup after failed recovery: ${String(stopError)}`);
        });
        awaitingLogin = await startAwaitingLoginListener({
          port: config.port,
          host: config.host as string,
          pinnedPort: true,
          message: 'Proxy recovery failed after sign-in. Automatic recovery will retry on this port.',
          gatewayKey: args.gatewayKey, // no sign-in prompt here: the user has just signed in
        });
        await host.persistState({ url: awaitingLogin.url, ...healthPatch() });
      }
      throw error;
    }
    await host.persistState({ url: started.url, ...healthPatch(), lastRecoveryAt: new Date().toISOString() });
  },

  healthPatch,

  async cleanup() {
    try { await awaitingLogin?.stop(); } catch { /* ignore */ }
  },

  watcher: ({ restart, persistState }) => ({
    check: () => checkProxyHealth({ port: config.port as number, gatewayKey: args.gatewayKey, deep: true }),
    restart,
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
    onUnauthorized: args.authMethod === 'sso' ? async () => {
      if (awaitingLogin && await credentialsAvailable()) {
        await restart();
      }
    } : undefined,
    // While the listener holds the port a deep check would start a browser sign-in on every tick.
    isAwaitingLogin: () => awaitingLogin !== undefined,
  }),

  // Takes Desktop's sessions only while Desktop's applied config points at this daemon's port and key; one being
  // collected is finished either way.
  desktopRuntime: (proxyConfig, { persistState }) => new DesktopTelemetryRuntime(
    new ClaudeDesktopTelemetryAdapter(),
    {
      clientType: CLAUDE_DESKTOP,
      targetApiUrl: proxyConfig.targetApiUrl,
      provider: proxyConfig.provider ?? 'ai-run-sso',
      version: proxyConfig.version ?? '0.0.0',
      profile: proxyConfig.profile,
      syncApiUrl: proxyConfig.syncApiUrl,
      syncCodeMieUrl: proxyConfig.syncCodeMieUrl,
      pollIntervalMs: proxyConfig.telemetryPollIntervalMs ?? 10000,
      inactivityTimeoutMs: proxyConfig.telemetryInactivityTimeoutMs ?? 300000,
      repositoryResolver: proxyConfig.desktopRepositoryResolver as DesktopRepositoryResolver,
      port: proxyConfig.port as number,
      gatewayKey: args.gatewayKey,
      onDesktopConnectedChange: (desktopConnectedSince) => persistState({ desktopConnectedSince }),
    }
  ),

  stateFields: () => ({
    targetUrl: config.targetApiUrl,
    provider: config.provider,
    project: config.project,
    ...(args.projectBinding ? { projectBinding: args.projectBinding } : {}),
    model: args.model,
    version: config.version,
    // The default client, for an older CLI that reads the state; nothing in this one reads it.
    clientType: config.clientType,
    syncApiUrl: config.syncApiUrl,
    syncCodeMieUrl: config.syncCodeMieUrl,
  }),
};

let localArgs: DaemonArgs;
let localConfig: ProxyConfig;

function localHealthPatch(): Record<string, unknown> {
  return { health: 'ok', healthReason: undefined, lastHealthyAt: new Date().toISOString() };
}

/**
 * The daemon of the local mode: no upstream, no credentials; it takes the analytics endpoints into the local spool
 * and answers 404 to everything else.
 */
export const localDaemon: DaemonComponents = {
  parse(values) {
    localArgs = { ...parseSharedArgs(values), profile: '' };
    return localArgs;
  },

  // The gateway key, the local intake and the 404 for the rest; every other plugin off.
  async plugins(registry) {
    for (const plugin of registry.getAll()) {
      const keep =
        plugin instanceof GatewayKeyPlugin || plugin instanceof LocalAnalyticsPlugin || plugin instanceof NoUpstreamPlugin;
      await registry.setEnabled(plugin.id, keep);
    }
  },

  async proxyConfig() {
    // No provider and no sync URL: the proxy loads no credentials at its start.
    localConfig = {
      targetApiUrl: '',
      port: localArgs.port,
      host: '127.0.0.1',
      gatewayKey: localArgs.gatewayKey,
      version: (await getCurrentCliVersion()) ?? '0.0.0',
    };
    return localConfig;
  },

  bringUp: (proxy) => proxy.start(),

  async restart(host) {
    try {
      await host.stopProxy();
    } catch (error) {
      logger.warn(`[proxy-daemon] proxy.stop() during restart failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const started = await host.nextProxy().start();
    await host.persistState({ url: started.url, ...localHealthPatch(), lastRecoveryAt: new Date().toISOString() });
  },

  healthPatch: localHealthPatch,

  cleanup: async () => undefined,

  watcher: ({ restart, persistState }) => ({
    check: () => checkProxyHealth({ port: localConfig.port as number, gatewayKey: localArgs.gatewayKey, deep: false }),
    restart,
    onHealthy: async () => {
      await persistState(localHealthPatch());
    },
    onGiveUp: async (reason) => {
      await persistState({ health: 'unhealthy', healthReason: reason });
    },
  }),

  desktopRuntime: () => ({
    start: async () => undefined,
    stop: async () => undefined,
    triggerPoll: async () => undefined,
  }),

  stateFields: () => ({ mode: 'local', profile: '', version: localConfig.version }),
};
