import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';
import { ConfigurationError, ToolExecutionError } from '../../../utils/errors.js';
import type { ProjectBindingState } from '../../../utils/project-binding.js';
import {
  checkStatus,
  readConnectionRecord,
  readDaemonStatus,
  stopDaemon,
  writeConnectionRecord,
  type DaemonState,
} from './daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, withDaemonLock } from './daemon-lock.js';
import { reportDaemonProfileIdentity } from '../../../agents/core/launch-identity.js';
import { moveClientsToNamedKeys, requestedDaemonPort } from './connect-orchestrator.js';
import { modelFromState } from './otlp-cold-start.js';
import {
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

/**
 * Nothing (alive) to preserve: a stale state file is ignored, as `proxy start` does. The profile is `--profile`,
 * else the recorded one, else the working directory's active one; the port is the one the clients were connected
 * with (`requestedDaemonPort`). Prepared before the daemon lock, spawned under it.
 */
async function prepareStopped(opts: ProxyRestartOptions): Promise<() => Promise<DaemonState>> {
  const port = await requestedDaemonPort();
  const profileName = opts.profile ?? (await readConnectionRecord())?.profile;
  const config = await ConfigLoader.load(process.cwd(), profileName ? { name: profileName } : undefined);
  const profile = config.name ?? 'default';
  const projectBinding = await reportDaemonProfileIdentity(config, 'proxy');
  const prepared = await prepareDaemonLaunch(config, profile);
  const writeRecord = await shouldWriteConnectionRecord(opts.profile);
  return async () => {
    const daemonState = await spawnForProfile(prepared, profile, { port, projectBinding, writeRecord });
    printRestarted(daemonState);
    return daemonState;
  };
}

/** A hook can cold-start a daemon between the stop and the spawn; stop it so the recorded port is free. */
async function stopRacingDaemon(): Promise<void> {
  const { running } = await checkStatus();
  if (running) {
    await stopDaemon();
  }
}

/** Both post-stop failures leave nothing running; a plain restart would then drop what a restart keeps. */
function lostIdentityError(state: DaemonState, reason: string, fix: string): ToolExecutionError {
  return new ToolExecutionError(
    'proxy-daemon',
    `${reason} Nothing is running now, so a plain restart would start a default proxy and drop what this ` +
    `daemon kept (port ${state.port} and its gateway key). ` +
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

/**
 * Replace a running daemon, keeping its port, gateway key, model (`modelFromState`) and project rule
 * (`restartProject`); the start-time conflict check does not apply. The profile is prepared before the
 * daemon lock, so a bad profile or expired SSO leaves the working daemon running; the stop and the spawn
 * run under it.
 */
async function prepareRunning(state: DaemonState, opts: ProxyRestartOptions): Promise<() => Promise<DaemonState>> {
  const config = await ConfigLoader.load(process.cwd(), { name: opts.profile ?? state.profile });
  const profile = config.name ?? opts.profile ?? state.profile;
  const resolvedBinding = await reportDaemonProfileIdentity(config, 'proxy');
  const { project, projectBinding } = restartProject(state, opts, config.codeMieProject, resolvedBinding);
  const prepared = await prepareDaemonLaunch(config, profile);
  // A switched profile's tenant may not serve the old profile's model.
  const model = opts.profile ? undefined : await modelFromState(state);
  return async () => {
    await stopDaemon();
    await stopRacingDaemon();

    let daemonState: DaemonState;
    try {
      daemonState = await spawnForProfile(prepared, profile, {
        port: state.port,
        gatewayKey: state.gatewayKey,
        model,
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
      await writeConnectionRecord(daemonState, profile);
    }
    printRestarted(daemonState);
    return daemonState;
  };
}

/** Whether the daemon found under the lock is not the one the restart was prepared for. */
function daemonChanged(
  before: { running: boolean; state: DaemonState | null },
  now: { running: boolean; state: DaemonState | null }
): boolean {
  if (before.running !== now.running) return true;
  return before.running && (before.state?.pid !== now.state?.pid || before.state?.startedAt !== now.state?.startedAt);
}

/**
 * `codemie proxy restart`: restart the daemon, preserving what it ran with when one is running. The
 * status is read and the profile prepared before the daemon lock; under it the status is read again,
 * and a daemon that changed in between fails the restart, touching nothing. Once the restarted daemon
 * runs, outside the lock, the clients move to their named keys as at `proxy start`.
 */
export async function restartProxy(opts: ProxyRestartOptions): Promise<void> {
  const before = await readDaemonStatus();
  const run = before.running && before.state
    ? await prepareRunning(before.state, opts)
    : await prepareStopped(opts);
  const restarted = await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
    if (daemonChanged(before, await checkStatus())) {
      throw new ConfigurationError('The proxy changed while restarting; run the command again.');
    }
    return run();
  });
  await moveClientsToNamedKeys(restarted, new Map());
}
