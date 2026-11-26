import { writeFile, readFile, unlink, rename } from 'node:fs/promises';
import type { ProjectBindingState } from '../../../utils/project-binding.js';
import { join } from 'node:path';
import { getCodemieHome, getDirname } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { ToolExecutionError } from '../../../utils/errors.js';
import { isOwnerAlive, processStartedAt, spawnDetached } from '../../../utils/processes.js';
import { comparePrereleaseVersions } from '../../../utils/version-utils.js';
import { fetchProxyHealth } from './health-check.js';

/** Poll interval `spawnDaemon` uses while waiting for the daemon to become ready. */
const DAEMON_READY_POLL_INTERVAL_MS = 100;

/**
 * Upper bound on how long `spawnDaemon` waits for the daemon to become ready. Exported so
 * callers that race their own timeout against a spawn (e.g. the Claude plugin's pre-spawn
 * OTLP endpoint refresh, EPMCDME-16647) can derive their budget from this one instead of
 * guessing at a separate magic number that can drift out of sync with it.
 */
export const DAEMON_READY_TIMEOUT_MS = 5_000;

/** The gateway key a daemon is spawned with when the caller names none. */
export const DEFAULT_GATEWAY_KEY = 'codemie-proxy';

export interface DaemonState {
  pid: number;
  port: number;
  url: string;
  profile: string;
  gatewayKey: string;
  targetUrl?: string;
  provider?: string;
  project?: string;
  /** Binding state `project` was resolved with at start (absent in state files from older CLIs). */
  projectBinding?: ProjectBindingState;
  model?: string;
  syncApiUrl?: string;
  syncCodeMieUrl?: string;
  /** Version of the CLI that started the daemon (absent in state files from older CLIs). */
  version?: string;
  /** When the daemon noticed Claude Desktop connected to it; absent while it is not. Written by the daemon alone. */
  desktopConnectedSince?: string;
  startedAt: string;
  // Health tracking (written by the daemon's watcher; all optional and
  // backward-compatible — absent means "unknown / assume ok").
  health?: 'ok' | 'unhealthy';
  healthReason?: string;
  lastHealthyAt?: string;
  lastRecoveryAt?: string;
  recoveryAttempts?: number;
}

/**
 * The last daemon start, persisted in proxy-connection.json (no secrets, URL, model, provider or project): its
 * profile and the port the clients were connected with. The legacy identity fields are kept as an older CLI left them,
 * read for the daemon's default client and never written.
 */
export interface ProxyConnectionRecord {
  version: 1;
  profile: string;
  updatedAt: string;
  port?: number;
  clientType?: string;
  telemetryMode?: 'none' | 'claude-desktop';
}

const DEFAULT_STATE_FILE = join(getCodemieHome(), 'proxy-daemon.json');
const CONNECTION_FILE = join(getCodemieHome(), 'proxy-connection.json');

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

/** Reads and parses the record file into a plain object; null (with a warning unless absent) otherwise. */
async function readRecordObject(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[daemon-manager] Cannot read proxy-connection.json', ...sanitizeLogArgs(error));
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn('[daemon-manager] Ignoring proxy-connection.json: not valid JSON', ...sanitizeLogArgs(error));
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('[daemon-manager] Ignoring proxy-connection.json: not a JSON object');
    return null;
  }

  return parsed as Record<string, unknown>;
}

/** Validates the profile and keeps only well-typed identity fields, warning about each dropped one. */
function normalizeConnectionRecord(data: Record<string, unknown>): ProxyConnectionRecord | null {
  if (typeof data.profile !== 'string' || data.profile === '') {
    logger.warn('[daemon-manager] Ignoring proxy-connection.json: missing or empty profile');
    return null;
  }

  const record: ProxyConnectionRecord = {
    version: 1,
    profile: data.profile,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : ''
  };

  if (typeof data.clientType === 'string') {
    record.clientType = data.clientType;
  } else if (data.clientType !== undefined) {
    logger.warn('[daemon-manager] Dropping proxy-connection.json field "clientType": not a string');
  }

  if (data.telemetryMode === 'none' || data.telemetryMode === 'claude-desktop') {
    record.telemetryMode = data.telemetryMode;
  } else if (data.telemetryMode !== undefined) {
    logger.warn('[daemon-manager] Dropping proxy-connection.json field "telemetryMode": unsupported value');
  }

  if (typeof data.port === 'number' && Number.isInteger(data.port) && data.port > 0 && data.port < 65536) {
    record.port = data.port;
  } else if (data.port !== undefined) {
    logger.warn('[daemon-manager] Dropping proxy-connection.json field "port": not a valid port');
  }

  return record;
}

/**
 * Reads the proxy connection record. A missing file is `null`; so is anything that is not a
 * JSON object with a non-empty string `profile` (with a warning giving the reason). Wrongly
 * typed optional fields are dropped with a warning naming the field.
 */
export async function readConnectionRecord(
  file: string = CONNECTION_FILE
): Promise<ProxyConnectionRecord | null> {
  const data = await readRecordObject(file);
  return data ? normalizeConnectionRecord(data) : null;
}

let connectionTmpCounter = 0;

/** The current record file as a plain object, or empty when missing or unreadable (silent). */
async function readExistingRecord(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable — start from an empty record
  }
  return {};
}

/** Merges the daemon's profile (and `port`, when given) over the existing record, keeping every other field. */
function buildConnectionRecord(
  existing: Record<string, unknown>,
  state: DaemonState,
  port: number | undefined
): Record<string, unknown> {
  return {
    ...existing,
    version: 1,
    profile: state.profile,
    ...(port !== undefined ? { port } : {}),
    updatedAt: new Date().toISOString()
  };
}

/** Replaces the record file by tmp + rename; false (with a warning) when that fails. Never throws. */
async function replaceRecordFile(record: Record<string, unknown>, file: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${++connectionTmpCounter}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, file);
    return true;
  } catch (error) {
    logger.warn('[daemon-manager] Failed to write proxy-connection.json', ...sanitizeLogArgs(error));
    try {
      await unlink(tmp);
    } catch {
      // Nothing to clean up
    }
    return false;
  }
}

/**
 * Records a daemon start: the daemon's profile, and `options.port` when given (else the record's port stays).
 * `profile` is what the caller asked for; the write is refused (false) when the daemon state disagrees. Never throws.
 */
export async function writeConnectionRecord(
  state: DaemonState,
  profile: string,
  options: { port?: number } = {},
  file: string = CONNECTION_FILE
): Promise<boolean> {
  if (state.profile !== profile) {
    logger.warn(
      `[daemon-manager] Not recording proxy-connection.json: daemon profile "${state.profile}" differs from requested profile "${profile}"`
    );
    return false;
  }
  return replaceRecordFile(buildConnectionRecord(await readExistingRecord(file), state, options.port), file);
}

/** Sets the port of an existing valid record and nothing else; with no record nothing is written. Never throws. */
export async function writeConnectionPort(port: number, file: string = CONNECTION_FILE): Promise<boolean> {
  if (!(await readConnectionRecord(file))) return false;
  return replaceRecordFile({ ...(await readExistingRecord(file)), port }, file);
}

/**
 * Removes `clientType` and `telemetryMode`, the client identity an older CLI wrote, from an existing valid record,
 * every other field kept; a record without them, or no valid record, is not written. Never throws.
 */
export async function clearLegacyClientIdentity(file: string = CONNECTION_FILE): Promise<boolean> {
  if (!(await readConnectionRecord(file))) return false;
  const record = await readExistingRecord(file);
  if (!('clientType' in record) && !('telemetryMode' in record)) return false;
  delete record.clientType;
  delete record.telemetryMode;
  return replaceRecordFile(record, file);
}

/**
 * Whether the record file holds `clientType` or `telemetryMode`, the client identity an older CLI wrote, whatever
 * their values; false for no record and an unreadable one. Never throws.
 */
export async function hasLegacyClientIdentity(file: string = CONNECTION_FILE): Promise<boolean> {
  const record = await readExistingRecord(file);
  return 'clientType' in record || 'telemetryMode' in record;
}

/** The port a start records: the one it asked for, once the daemon runs on it, when the record has none. */
async function startPortToRecord(asked: number | undefined, state: DaemonState): Promise<number | undefined> {
  if (asked === undefined || state.port !== asked) return undefined;
  return (await readConnectionRecord())?.port === undefined ? asked : undefined;
}

/** Creates the connection record from a running daemon when none (valid) exists yet. */
export async function seedConnectionRecord(
  state: DaemonState,
  file: string = CONNECTION_FILE
): Promise<void> {
  if (await readConnectionRecord(file)) return;
  if (await writeConnectionRecord(state, state.profile, {}, file)) {
    logger.info(`Seeding proxy-connection.json from the running daemon (profile: ${state.profile})`);
  }
}

export async function clearState(stateFile: string = DEFAULT_STATE_FILE): Promise<void> {
  try {
    await unlink(stateFile);
  } catch {
    // Already gone — no-op
  }
}

/** The daemon's status; the state of a daemon that is no longer alive is deleted. Called under the daemon lock only. */
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

/** The daemon's status for a command that only reads it: a daemon that is not alive reads as stopped, its file stays. */
export async function readDaemonStatus(
  stateFile: string = DEFAULT_STATE_FILE
): Promise<{ running: boolean; state: DaemonState | null }> {
  const state = await readState(stateFile);
  return state && (await isDaemonAlive(state)) ? { running: true, state } : { running: false, state: null };
}

/**
 * Whether the daemon was started by an older CLI than this one: a state without `version` is; one with a
 * version is not when this CLI's own version is unreadable or either version is not `x.y.z` with an optional
 * pre-release suffix and build metadata; otherwise it is when its version is lower by semantic-version precedence.
 */
export async function isOlderDaemon(state: Pick<DaemonState, 'version'>): Promise<boolean> {
  if (state.version === undefined) return true;
  // Loaded on first use: the many importers of this module need none of the updater's dependencies.
  const { getCurrentCliVersion } = await import('../../../utils/cli-updater.js');
  const own = await getCurrentCliVersion();
  if (!own || typeof state.version !== 'string') return false;
  return comparePrereleaseVersions(state.version, own) === -1;
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

export async function spawnDaemon(opts: SpawnOptions): Promise<DaemonState> {
  const stateFile = DEFAULT_STATE_FILE;
  const gatewayKey = opts.gatewayKey ?? DEFAULT_GATEWAY_KEY;

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
    '--state-file', stateFile,
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

  // The child's pid is the one its daemon writes into the state: a state naming another pid is another daemon.
  // A failed spawn returns -1, which no state names, so it ends in the timeout below.
  const pid = spawnDetached(process.execPath, args);

  // Poll for daemon readiness, up to DAEMON_READY_TIMEOUT_MS. A child slower than that is left running: it
  // comes up and the next start adopts it.
  const attempts = DAEMON_READY_TIMEOUT_MS / DAEMON_READY_POLL_INTERVAL_MS;
  for (let i = 0; i < attempts; i++) {
    await new Promise<void>(r => setTimeout(r, DAEMON_READY_POLL_INTERVAL_MS));
    const state = await readState(stateFile);
    if (state && state.pid === pid && (await isDaemonAlive(state))) {
      const port = await startPortToRecord(opts.port, state);
      if (opts.writeRecord !== false) {
        await writeConnectionRecord(state, opts.profile, { port });
      } else if (opts.recordPort !== false && port !== undefined) {
        await writeConnectionPort(port);
      }
      return state;
    }
  }

  throw new ToolExecutionError(
    'proxy-daemon',
    `Daemon failed to start within ${DAEMON_READY_TIMEOUT_MS / 1000} seconds. Check logs: ~/.codemie/logs/`
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
