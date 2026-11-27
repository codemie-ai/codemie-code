/**
 * The local mode's proxy daemon: started with `--mode local`, no upstream, no profile, no connection record. A hook's
 * launcher adopts a live local daemon as it finds it; a spawn — the launcher's, `proxy start`'s, `proxy restart`'s — is
 * one function, run under the daemon lock after the caller's `installed` (the sync settings read again) answered true.
 */
import { ConfigurationError } from '@/utils/errors.js';
import {
  DEFAULT_GATEWAY_KEY,
  DEFAULT_STATE_FILE,
  isDaemonAlive,
  isOlderDaemon,
  readState,
  stopDaemon,
  type DaemonState,
} from './daemon-manager.js';
import { daemonEntry, spawnDaemonProcess } from './daemon-spawn.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, DAEMON_LOCK_HOOK_BUDGET_MS, withDaemonLock } from './daemon-lock.js';
import { requestedDaemonPort } from './connect-orchestrator.js';
import { refreshClaudeCodeOtlpEndpoint } from './connectors/claude-code-otlp-endpoint.js';
import { adoptsOlderDaemon } from './otlp-cold-start.js';

/** The daemon's arguments after its entry: the local mode, the gateway key, the state file, the port when given. */
export function localDaemonArgs(opts: { port?: number; gatewayKey: string; stateFile: string }): string[] {
  return [
    '--mode', 'local',
    '--gateway-key', opts.gatewayKey,
    '--state-file', opts.stateFile,
    ...(opts.port ? ['--port', String(opts.port)] : []),
  ];
}

/** The live local daemon of `state`: alive, `mode: 'local'`, and not of an older CLI unless `acceptOlder`. */
export async function isLiveLocal(state: DaemonState | null, acceptOlder: boolean): Promise<boolean> {
  if (state?.mode !== 'local' || !(await isDaemonAlive(state))) return false;
  return acceptOlder || !(await isOlderDaemon(state));
}

/**
 * Stops whatever daemon runs and spawns the local one on `port`, with the gateway key of the state left behind (the
 * shared key when there is none), then points Claude Code's OTLP endpoint at it. Called under the daemon lock.
 */
export async function spawnLocalDaemon(port: number): Promise<DaemonState> {
  const gatewayKey = (await readState())?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
  await stopDaemon();
  const state = await spawnDaemonProcess([daemonEntry(), ...localDaemonArgs({ port, gatewayKey, stateFile: DEFAULT_STATE_FILE })]);
  await refreshClaudeCodeOtlpEndpoint(state);
  return state;
}

/**
 * The hook's launcher in the local mode: a live local daemon is adopted; otherwise, under the daemon lock, the local
 * daemon replaces whatever runs, on the requested port, while `installed` still answers true. A lock still held
 * after its budget throws to the hook, which goes on without the daemon.
 */
export async function ensureLocalOtlpProxy(installed: () => Promise<boolean>, agentName: string, event?: string): Promise<void> {
  const acceptOlder = adoptsOlderDaemon(agentName, event);
  const state = await readState();
  if (state && (await isLiveLocal(state, acceptOlder))) {
    await refreshClaudeCodeOtlpEndpoint(state);
    return;
  }
  await withDaemonLock(DAEMON_LOCK_HOOK_BUDGET_MS, async () => {
    const current = await readState();
    if (current && (await isLiveLocal(current, acceptOlder))) {
      await refreshClaudeCodeOtlpEndpoint(current);
      return;
    }
    // An uninstall, or an install undone, got here first.
    if (!(await installed())) return;
    await spawnLocalDaemon(await requestedDaemonPort());
  });
}

function notLocalError(): ConfigurationError {
  return new ConfigurationError('Local analytics collection is not installed: run codemie analytics sync install.');
}

/**
 * `proxy start` in the local mode: the state of a live local daemon of this CLI, else a new one on `port`; throws
 * when `installed` answers false.
 */
export async function startLocalDaemon(installed: () => Promise<boolean>, port?: number): Promise<DaemonState> {
  return withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
    if (!(await installed())) throw notLocalError();
    const state = await readState();
    if (state && (await isLiveLocal(state, false))) {
      await refreshClaudeCodeOtlpEndpoint(state);
      return state;
    }
    return spawnLocalDaemon(port ?? (await requestedDaemonPort()));
  });
}

/**
 * `proxy restart` in the local mode: the daemon stopped and the local one started on its port; throws when
 * `installed` answers false.
 */
export async function restartLocalDaemon(installed: () => Promise<boolean>): Promise<DaemonState> {
  return withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
    if (!(await installed())) throw notLocalError();
    const state = await readState();
    return spawnLocalDaemon(state?.port ?? (await requestedDaemonPort()));
  });
}
