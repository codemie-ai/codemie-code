import { writeFile, readFile, unlink, rename } from 'node:fs/promises';
import type { ProjectBindingState } from '../../../utils/project-binding.js';
import { join } from 'node:path';
import { getCodemieHome, getDirname } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { ToolExecutionError } from '../../../utils/errors.js';
import { isOwnerAlive, processStartedAt, spawnDetached } from '../../../utils/processes.js';
import { fetchProxyHealth } from './health-check.js';

export interface DaemonState {
  pid: number;
  port: number;
  url: string;
  profile: string;
  gatewayKey: string;
  telemetryMode?: 'none' | 'claude-desktop';
  targetUrl?: string;
  provider?: string;
  project?: string;
  /** Binding state `project` was resolved with at start (absent in state files from older CLIs). */
  projectBinding?: ProjectBindingState;
  model?: string;
  clientType?: string;
  syncApiUrl?: string;
  syncCodeMieUrl?: string;
  startedAt: string;
  // Health tracking (written by the daemon's watcher; all optional and
  // backward-compatible — absent means "unknown / assume ok").
  health?: 'ok' | 'unhealthy';
  healthReason?: string;
  lastHealthyAt?: string;
  lastRecoveryAt?: string;
  recoveryAttempts?: number;
}

const DEFAULT_STATE_FILE = join(getCodemieHome(), 'proxy-daemon.json');

/** The `startedAt` a daemon writes into its state: the start of its own process. */
export function daemonStartedAt(): string {
  return new Date(processStartedAt()).toISOString();
}

/** The daemon is always the user's own process: any `kill(pid, 0)` error, EPERM included, means it is gone. */
function isDaemonPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether a CodeMie proxy answers the shallow `/health` on `port` reporting both that port and `pid` as its own. */
async function answersOnOwnPort(port: number, pid: number): Promise<boolean> {
  try {
    const res = await fetchProxyHealth(port);
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: unknown; port?: unknown; pid?: unknown };
    return body.status === 'ok' && body.port === port && body.pid === pid;
  } catch {
    return false;
  }
}

/**
 * Whether the state's daemon still runs: its pid alive as the user's own process, then its start time
 * matching the recorded one. A dead daemon's pid reused by a later process of the same user has a later
 * start; a state without a parsable `startedAt`, or on Windows, is judged by its pid alone. A live pid that
 * fails the start check (a wall-clock step skews it) still counts when the proxy answers on the state's port.
 */
export async function isDaemonAlive(state: Pick<DaemonState, 'pid' | 'startedAt' | 'port'>): Promise<boolean> {
  if (!isDaemonPidAlive(state.pid)) return false;
  if (process.platform === 'win32') return true;
  const startedAt = Date.parse(state.startedAt);
  if (await isOwnerAlive({ pid: state.pid, ...(Number.isFinite(startedAt) && { startedAt }) })) return true;
  return answersOnOwnPort(state.port, state.pid);
}

export async function readState(stateFile: string = DEFAULT_STATE_FILE): Promise<DaemonState | null> {
  try {
    const raw = await readFile(stateFile, 'utf-8');
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

export async function writeState(
  state: DaemonState,
  stateFile: string = DEFAULT_STATE_FILE
): Promise<void> {
  // Per process: two CLI runs writing at once never rename each other's half-written file.
  const tmp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, stateFile);
}

export async function clearState(stateFile: string = DEFAULT_STATE_FILE): Promise<void> {
  try {
    await unlink(stateFile);
  } catch {
    // Already gone — no-op
  }
}

export async function checkStatus(
  stateFile: string = DEFAULT_STATE_FILE
): Promise<{ running: boolean; state: DaemonState | null }> {
  const state = await readState(stateFile);
  if (!state) return { running: false, state: null };

  if (!(await isDaemonAlive(state))) {
    await clearState(stateFile);
    return { running: false, state: null };
  }

  return { running: true, state };
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
  clientType?: string;
  telemetryMode?: 'none' | 'claude-desktop';
  syncApiUrl?: string;
  syncCodeMieUrl?: string;
}

export async function spawnDaemon(opts: SpawnOptions): Promise<DaemonState> {
  const stateFile = DEFAULT_STATE_FILE;
  const gatewayKey = opts.gatewayKey ?? 'codemie-proxy';

  // Locate the daemon binary relative to this compiled file:
  // dist/cli/commands/proxy/daemon-manager.js → ../../../../bin/proxy-daemon.js
  const daemonBin = join(getDirname(import.meta.url), '../../../../bin/proxy-daemon.js');

  const args = [
    daemonBin,
    '--target-url', opts.targetUrl,
    '--provider', opts.provider,
    '--profile', opts.profile,
    '--gateway-key', gatewayKey,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.project ? ['--project', opts.project] : []),
    ...(opts.projectBinding ? ['--project-binding', opts.projectBinding] : []),
    ...(opts.clientType ? ['--client-type', opts.clientType] : []),
    '--state-file', stateFile,
    ...(opts.port ? ['--port', String(opts.port)] : []),
    ...(opts.telemetryMode ? ['--telemetry-mode', opts.telemetryMode] : []),
    ...(opts.syncApiUrl ? ['--sync-api-url', opts.syncApiUrl] : []),
    ...(opts.syncCodeMieUrl ? ['--sync-codemie-url', opts.syncCodeMieUrl] : []),
  ];

  logger.debug(
    '[daemon-manager] Spawning daemon',
    ...sanitizeLogArgs({
      daemonBin,
      targetUrl: opts.targetUrl,
      provider: opts.provider,
      profile: opts.profile,
      port: opts.port,
      gatewayKey,
      model: opts.model,
      project: opts.project,
      clientType: opts.clientType,
      telemetryMode: opts.telemetryMode,
      syncApiUrl: opts.syncApiUrl,
      syncCodeMieUrl: opts.syncCodeMieUrl
    })
  );

  spawnDetached(process.execPath, args);

  // Poll up to 5 s for daemon readiness
  for (let i = 0; i < 50; i++) {
    await new Promise<void>(r => setTimeout(r, 100));
    const state = await readState(stateFile);
    if (state && (await isDaemonAlive(state))) return state;
  }

  throw new ToolExecutionError(
    'proxy-daemon',
    'Daemon failed to start within 5 seconds. Check logs: ~/.codemie/logs/'
  );
}

export async function stopDaemon(): Promise<void> {
  const stateFile = DEFAULT_STATE_FILE;
  const state = await readState(stateFile);
  if (!state) return;

  if (!(await isDaemonAlive(state))) {
    await clearState(stateFile);
    return;
  }

  // 1. Graceful: SIGTERM, wait up to 5s.
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    // ESRCH: gone since the check; EPERM: the pid now belongs to another user — not our daemon either way
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    await clearState(stateFile);
    return;
  }
  // The identity is confirmed above; the waits watch the pid alone, with no `ps` per tick.
  for (let i = 0; i < 50; i++) {
    await new Promise<void>(r => setTimeout(r, 100));
    if (!isDaemonPidAlive(state.pid)) {
      await clearState(stateFile);
      return;
    }
  }

  // 2. Escalate: SIGKILL so a wedged daemon can never block the next connect.
  logger.warn(
    '[daemon-manager] Daemon ignored SIGTERM; escalating to SIGKILL',
    ...sanitizeLogArgs({ pid: state.pid })
  );
  try {
    process.kill(state.pid, 'SIGKILL');
  } catch {
    // Already gone between the check and the signal — fine.
  }
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(r => setTimeout(r, 100));
    if (!isDaemonPidAlive(state.pid)) break;
  }

  // 3. Always clear state — the SIGKILL'd process won't run its own cleanup.
  await clearState(stateFile);
}
