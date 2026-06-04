import { writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemieHome, getDirname } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { ToolExecutionError } from '../../../utils/errors.js';
import { spawnDetached } from '../../../utils/processes.js';

export interface DaemonState {
  pid: number;
  port: number;
  url: string;
  profile: string;
  gatewayKey: string;
  telemetryMode?: 'none' | 'claude-desktop';
  targetUrl?: string;
  provider?: string;
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
  const tmp = stateFile + '.tmp';
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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function checkStatus(
  stateFile: string = DEFAULT_STATE_FILE
): Promise<{ running: boolean; state: DaemonState | null }> {
  const state = await readState(stateFile);
  if (!state) return { running: false, state: null };

  if (!isProcessAlive(state.pid)) {
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
  project?: string;
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
    ...(opts.project ? ['--project', opts.project] : []),
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
      project: opts.project,
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
    if (state && isProcessAlive(state.pid)) return state;
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

  if (!isProcessAlive(state.pid)) {
    await clearState(stateFile);
    return;
  }

  // 1. Graceful: SIGTERM, wait up to 5s.
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    await new Promise<void>(r => setTimeout(r, 100));
    if (!isProcessAlive(state.pid)) {
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
    if (!isProcessAlive(state.pid)) break;
  }

  // 3. Always clear state — the SIGKILL'd process won't run its own cleanup.
  await clearState(stateFile);
}
