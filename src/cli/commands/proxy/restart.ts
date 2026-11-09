import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';
import { ToolExecutionError } from '../../../utils/errors.js';
import type { ProjectBindingState } from '../../../utils/project-binding.js';
import { checkStatus, stopDaemon, writeConnectionRecord, type DaemonState } from './daemon-manager.js';
import { reportDaemonProfileIdentity } from '../../../agents/core/launch-identity.js';
import { DEFAULT_DAEMON_PORT } from './connect-orchestrator.js';
import {
  launchDaemon,
  prepareDaemonLaunch,
  shouldWriteConnectionRecord,
  spawnForProfile,
} from './launch-daemon.js';

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
  const projectBinding = await reportDaemonProfileIdentity(config, 'proxy');
  printRestarted(await launchDaemon(config, profile, {
    port: DEFAULT_DAEMON_PORT,
    clientType: 'codemie-daemon',
    projectBinding,
    writeRecord: await shouldWriteConnectionRecord(opts.profile),
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

/**
 * Project for a restarted daemon (EPMCDME-15411; PR #758 review, finding 6). The project can
 * depend on the directory the daemon was started from, so a restart from elsewhere must not move it:
 * - `--profile`: the newly resolved project.
 * - Started from a repo config (`local`): the recorded project; that config is not visible here.
 * - The profile now owns its identity (`own` / `none`): the resolved value, so a profile that gained
 *   its own project bills it.
 * - Otherwise (unowned, not-applicable, or a state file without a binding): the recorded project.
 */
export function restartProject(
  state: Pick<DaemonState, 'project' | 'projectBinding'>,
  opts: Pick<ProxyRestartOptions, 'profile'>,
  resolvedProject: string | undefined,
  resolvedBinding: ProjectBindingState | undefined
): { project?: string; projectBinding?: ProjectBindingState } {
  if (opts.profile) return { project: resolvedProject, projectBinding: resolvedBinding };
  if (state.projectBinding !== 'local' && (resolvedBinding === 'own' || resolvedBinding === 'none')) {
    return { project: resolvedProject, projectBinding: resolvedBinding };
  }
  return {
    project: state.project ?? resolvedProject,
    projectBinding: state.project ? state.projectBinding : resolvedBinding,
  };
}

/** Replace a running daemon, keeping its port and identity (the start-time conflict check does not apply). */
async function restartRunning(state: DaemonState, opts: ProxyRestartOptions): Promise<void> {
  const config = await ConfigLoader.load(process.cwd(), { name: opts.profile ?? state.profile });
  const profile = config.name ?? opts.profile ?? state.profile;
  const resolvedBinding = await reportDaemonProfileIdentity(config, 'proxy');
  const { project, projectBinding } = restartProject(state, opts, config.codeMieProject, resolvedBinding);
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
      project,
      projectBinding,
      // Written below, only once the port check has passed: a rolled-back restart leaves no record.
      writeRecord: false,
    });
  } catch (error) {
    throw spawnFailedError(state, error);
  }

  if (daemonState.port !== state.port) {
    // Clients are configured for the recorded port; do not leave a daemon elsewhere.
    await stopDaemon();
    throw portMismatchError(state, daemonState.port);
  }
  // `profile` is the one the daemon was just spawned for (equal to daemonState.profile).
  if (await shouldWriteConnectionRecord(opts.profile)) {
    await writeConnectionRecord(daemonState, profile, state.clientType);
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
