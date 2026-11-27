/**
 * The start of a proxy daemon process: the daemon's entry, the detached spawn and the wait for the state it writes,
 * and `spawnDaemon`, the start of a daemon that serves a backend, which records its profile and port.
 */
import { join } from 'node:path';
import type { ProjectBindingState } from '@/utils/project-binding.js';
import { getDirname } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { ToolExecutionError } from '@/utils/errors.js';
import { spawnDetached } from '@/utils/processes.js';
import {
  DAEMON_READY_TIMEOUT_MS,
  DEFAULT_GATEWAY_KEY,
  DEFAULT_STATE_FILE,
  isDaemonAlive,
  readConnectionRecord,
  readState,
  writeConnectionPort,
  writeConnectionRecord,
  type DaemonState,
} from './daemon-manager.js';

/** Poll interval `spawnDaemon` uses while waiting for the daemon to become ready. */
const DAEMON_READY_POLL_INTERVAL_MS = 100;

/**
 * The daemon's entry, relative to this compiled file:
 * dist/cli/commands/proxy/daemon-spawn.js → ../../../../bin/proxy-daemon.js
 */
export function daemonEntry(): string {
  return join(getDirname(import.meta.url), '../../../../bin/proxy-daemon.js');
}

/** The port a start records: the one it asked for, once the daemon runs on it, when the record has none. */
async function startPortToRecord(asked: number | undefined, state: DaemonState): Promise<number | undefined> {
  if (asked === undefined || state.port !== asked) return undefined;
  return (await readConnectionRecord())?.port === undefined ? asked : undefined;
}

export interface SpawnOptions {
  targetUrl: string;
  provider: string;
  profile: string;
  port?: number;
  gatewayKey?: string;
  model?: string;
  project?: string;
  projectBinding?: ProjectBindingState;
  syncApiUrl?: string;
  syncCodeMieUrl?: string;
  /** Record this start's profile in proxy-connection.json (default true). Not passed to the daemon. */
  writeRecord?: boolean;
  /**
   * With `writeRecord: false`: still record `port` as the record's port once the daemon runs on it, when the
   * record has none (default true). Not passed to the daemon.
   */
  recordPort?: boolean;
}

/**
 * Starts the proxy daemon for `opts` and answers the state it wrote once it runs, recording the start in
 * proxy-connection.json as `writeRecord` / `recordPort` say. Throws a `ToolExecutionError` when the daemon is not
 * ready within the start timeout.
 */
export async function spawnDaemon(opts: SpawnOptions): Promise<DaemonState> {
  const gatewayKey = opts.gatewayKey ?? DEFAULT_GATEWAY_KEY;

  const daemonBin = daemonEntry();
  const args = [
    daemonBin,
    '--target-url', opts.targetUrl,
    '--provider', opts.provider,
    '--profile', opts.profile,
    '--gateway-key', gatewayKey,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.project ? ['--project', opts.project] : []),
    ...(opts.projectBinding ? ['--project-binding', opts.projectBinding] : []),
    '--state-file', DEFAULT_STATE_FILE,
    ...(opts.port ? ['--port', String(opts.port)] : []),
    ...(opts.syncApiUrl ? ['--sync-api-url', opts.syncApiUrl] : []),
    ...(opts.syncCodeMieUrl ? ['--sync-codemie-url', opts.syncCodeMieUrl] : []),
  ];

  // The gateway key is deliberately absent: sanitizeLogArgs redacts by key name and `gatewayKey` matches none of its patterns.
  logger.debug(
    '[daemon-manager] Spawning daemon',
    ...sanitizeLogArgs({
      daemonBin,
      targetUrl: opts.targetUrl,
      provider: opts.provider,
      profile: opts.profile,
      port: opts.port,
      model: opts.model,
      project: opts.project,
      syncApiUrl: opts.syncApiUrl,
      syncCodeMieUrl: opts.syncCodeMieUrl
    })
  );

  const state = await spawnDaemonProcess(args);
  const port = await startPortToRecord(opts.port, state);
  if (opts.writeRecord !== false) {
    await writeConnectionRecord(state, opts.profile, { port });
  } else if (opts.recordPort !== false && port !== undefined) {
    await writeConnectionPort(port);
  }
  return state;
}

/**
 * Spawns the daemon detached with `args` (the daemon entry first) and waits for the state it writes, naming its pid,
 * up to DAEMON_READY_TIMEOUT_MS. A child slower than that is left running: it comes up and the next start adopts it.
 */
export async function spawnDaemonProcess(args: string[]): Promise<DaemonState> {
  const stateFile = DEFAULT_STATE_FILE;
  // The child's pid is the one its daemon writes into the state: a state naming another pid is another daemon.
  // A failed spawn returns -1, which no state names, so it ends in the timeout below.
  const pid = spawnDetached(process.execPath, args);

  const attempts = DAEMON_READY_TIMEOUT_MS / DAEMON_READY_POLL_INTERVAL_MS;
  for (let i = 0; i < attempts; i++) {
    await new Promise<void>(r => setTimeout(r, DAEMON_READY_POLL_INTERVAL_MS));
    const state = await readState(stateFile);
    if (state && state.pid === pid && (await isDaemonAlive(state))) {
      return state;
    }
  }

  throw new ToolExecutionError(
    'proxy-daemon',
    `Daemon failed to start within ${DAEMON_READY_TIMEOUT_MS / 1000} seconds. Check logs: ~/.codemie/logs/`
  );
}
