import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';
import { ConfigurationError } from '../../../utils/errors.js';
import {
  checkStatus,
  isOlderDaemon,
  readDaemonStatus,
  seedConnectionRecord,
  writeConnectionPort,
  writeConnectionRecord,
  type DaemonState,
} from './daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, withDaemonLock } from './daemon-lock.js';
import { reportDaemonProfileIdentity } from '../../../agents/core/launch-identity.js';
import { prepareDaemonLaunch, shouldWriteConnectionRecord, spawnForProfile } from './launch-daemon.js';
import { formatDaemonConflict } from './daemon-conflict.js';
import {
  DEFAULT_DAEMON_PORT,
  daemonMatchesRequest,
  moveClientsToNamedKeys,
  requestedDaemonPort,
  type RequestedDaemonConfig,
} from './connect-orchestrator.js';
import { isRestartableState, startFromState } from './otlp-cold-start.js';

export interface ProxyStartOptions {
  port?: string;
  profile?: string;
}

function parsePortOption(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`Invalid port value: ${value}`);
  }

  return parsed;
}

export async function startProxy(opts: ProxyStartOptions): Promise<void> {
  // Read before any status check, which can delete the state file the port is read from.
  const requestedPort = opts.port ? parsePortOption(opts.port, DEFAULT_DAEMON_PORT) : await requestedDaemonPort();
  const config = await ConfigLoader.load(
    process.cwd(),
    opts.profile ? { name: opts.profile } : undefined
  );
  const profile = config.name ?? 'default';
  const projectBinding = await reportDaemonProfileIdentity(config, 'proxy');

  const requestedDaemon: RequestedDaemonConfig = {
    profile,
    port: requestedPort,
    project: config.codeMieProject,
    provider: config.provider ?? 'ai-run-sso',
    targetUrl: config.baseUrl,
  };
  /** `--port <N>` is recorded as the clients' port once the daemon runs on it. */
  const recordExplicitPort = async (daemonState: DaemonState): Promise<void> => {
    if (opts.port && daemonState.port === requestedPort) await writeConnectionPort(requestedPort);
  };
  /** `--profile` records the running daemon with its profile; without it an absent record is seeded. */
  const recordConnection = async (state: DaemonState): Promise<void> => {
    if (opts.profile) {
      await writeConnectionRecord(state, state.profile);
    } else {
      await seedConnectionRecord(state);
    }
    await recordExplicitPort(state);
  };
  const alreadyRunning = async (state: DaemonState): Promise<void> => {
    await recordConnection(state);
    console.log(chalk.green(`✓ Proxy already running at ${state.url}  (profile: ${state.profile})`));
  };

  const first = await readDaemonStatus();
  if (first.running && first.state && daemonMatchesRequest(first.state, requestedDaemon) &&
    !(await isOlderDaemon(first.state))) {
    await alreadyRunning(first.state);
    await moveClientsToNamedKeys(first.state, new Map());
    return;
  }

  const prepared = await prepareDaemonLaunch(config, profile);
  const runningState = await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async (): Promise<DaemonState> => {
    const { running, state } = await checkStatus();
    if (running && state) {
      if (!daemonMatchesRequest(state, requestedDaemon)) {
        throw new ConfigurationError(formatDaemonConflict(state));
      }
      if (!(await isOlderDaemon(state))) {
        await alreadyRunning(state);
        return state;
      }
      if (!isRestartableState(state)) {
        throw new ConfigurationError(formatDaemonConflict(state));
      }
      // Started by an older CLI: replaced from its own state on its port, as a hook replaces it.
      const replaced = await startFromState(state, state.port);
      await recordConnection(replaced);
      console.log(chalk.green(`✓ Proxy running at ${replaced.url}  (profile: ${replaced.profile})`));
      return replaced;
    }

    const daemonState = await spawnForProfile(prepared, profile, {
      port: requestedPort,
      projectBinding,
      writeRecord: await shouldWriteConnectionRecord(opts.profile),
    });
    await recordExplicitPort(daemonState);
    console.log(chalk.green(`✓ Proxy running at ${daemonState.url}  (profile: ${daemonState.profile})`));
    return daemonState;
  });
  await moveClientsToNamedKeys(runningState, new Map());
}
