import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';
import { ToolExecutionError } from '../../../utils/errors.js';
import { checkStatus, stopDaemon, type DaemonState } from './daemon-manager.js';
import { DEFAULT_DAEMON_PORT } from './connect-orchestrator.js';
import { launchDaemon, prepareDaemonLaunch, spawnForProfile } from './launch-daemon.js';

export interface ProxyRestartOptions {
  profile?: string;
}

function printRestarted(daemonState: DaemonState): void {
  console.log(chalk.green(`✓ Proxy restarted at ${daemonState.url}  (profile: ${daemonState.profile})`));
}

/** Nothing (alive) to preserve: a stale state file is ignored, as `proxy start` does. */
async function restartStopped(opts: ProxyRestartOptions): Promise<void> {
  const config = await ConfigLoader.load(process.cwd(), opts.profile ? { name: opts.profile } : undefined);
  const profile = config.name ?? 'default';
  printRestarted(await launchDaemon(config, profile, {
    port: DEFAULT_DAEMON_PORT,
    clientType: 'codemie-daemon',
  }));
}

/** A hook can cold-start a daemon between the stop and the spawn; stop it so the recorded port is free. */
async function stopRacingDaemon(): Promise<void> {
  const { running } = await checkStatus();
  if (running) {
    await stopDaemon();
  }
}

/** Both post-stop failures leave nothing running; a plain restart would then drop the identity. */
function lostIdentityError(state: DaemonState, reason: string, fix: string): ToolExecutionError {
  return new ToolExecutionError(
    'proxy-daemon',
    `${reason} Nothing is running now, so a plain restart would start a default proxy and drop this ` +
    `daemon's identity (client: ${state.clientType ?? 'codemie-daemon'}, gateway key and telemetry mode). ` +
    `${fix}, then run: codemie proxy start --port ${state.port} --profile ${state.profile} ` +
    `and reconnect the client (codemie proxy connect).`
  );
}

function portMismatchError(state: DaemonState, actualPort: number): ToolExecutionError {
  return lostIdentityError(
    state,
    `Proxy could not rebind port ${state.port}; it came up on ${actualPort} and was stopped.`,
    `Free port ${state.port}`
  );
}

function spawnFailedError(state: DaemonState, error: unknown): ToolExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  return lostIdentityError(
    state,
    `Proxy was stopped but the replacement failed to start: ${message}.`,
    'Fix that'
  );
}

/** Replace a running daemon, keeping its port and identity (the start-time conflict check does not apply). */
async function restartRunning(state: DaemonState, opts: ProxyRestartOptions): Promise<void> {
  const config = await ConfigLoader.load(process.cwd(), { name: opts.profile ?? state.profile });
  const profile = config.name ?? opts.profile ?? state.profile;
  // Fail on a bad profile or expired SSO before the working daemon is touched.
  const prepared = await prepareDaemonLaunch(config, profile);

  await stopDaemon();
  await stopRacingDaemon();

  let daemonState: DaemonState;
  try {
    daemonState = await spawnForProfile(prepared, profile, {
      port: state.port,
      clientType: state.clientType,
      telemetryMode: state.telemetryMode,
      gatewayKey: state.gatewayKey,
      // A switched profile's tenant may not serve the old profile's model.
      model: opts.profile ? undefined : state.model,
      project: opts.profile ? config.codeMieProject : (state.project ?? config.codeMieProject),
    });
  } catch (error) {
    throw spawnFailedError(state, error);
  }

  if (daemonState.port !== state.port) {
    // Clients are configured for the recorded port; do not leave a daemon elsewhere.
    await stopDaemon();
    throw portMismatchError(state, daemonState.port);
  }
  printRestarted(daemonState);
}

/** `codemie proxy restart`: restart the daemon, preserving its identity when one is running. */
export async function restartProxy(opts: ProxyRestartOptions): Promise<void> {
  const { running, state } = await checkStatus();
  if (!running || !state) {
    await restartStopped(opts);
    return;
  }
  await restartRunning(state, opts);
}
