/**
 * Hook cold start of the proxy daemon: restores the profile `proxy connect` recorded in
 * proxy-connection.json instead of the working directory's active profile, and replaces a
 * daemon of an older CLI from that daemon's own state.
 */
import { ConfigLoader } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { reportDaemonProfileIdentity } from '../../../agents/core/launch-identity.js';
import {
  isDaemonAlive,
  isOlderDaemon,
  readConnectionRecord,
  readState,
  seedConnectionRecord,
  spawnDaemon,
  stopDaemon,
  writeState,
  type DaemonState,
} from './daemon-manager.js';
import { DAEMON_LOCK_HOOK_BUDGET_MS, withDaemonLock } from './daemon-lock.js';
import {
  assertSsoCredentials,
  buildRequestedConfig,
  ensureDaemon,
  normalizeDaemonModel,
  requestedDaemonPort,
  type LoadedConfig,
} from './connect-orchestrator.js';
import { refreshClaudeCodeOtlpEndpoint } from './connectors/claude-code-otlp-endpoint.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '../../../agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';

/**
 * Claude Code's hook events whose time belongs to other work (the sign-in wait, the transcript work): on them, in
 * Claude Code's hook alone, a live daemon of an older CLI is adopted as it is, and the next other event replaces it.
 * Another client's hook of the same event name replaces it.
 */
const ADOPT_OLDER_DAEMON_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'PostCompact']);

/** A daemon state a start can rebuild the daemon from: one that names its upstream. */
export type RestartableState = DaemonState & { targetUrl: string; provider: string };

export function isRestartableState(state: DaemonState): state is RestartableState {
  return Boolean(state.targetUrl && state.provider);
}

/**
 * The model of a start from a daemon's state: the state's own; for a state of an older CLI that wrote neither
 * version nor model, the model of the global profile of the state's name; otherwise none.
 */
export async function modelFromState(state: DaemonState): Promise<string | undefined> {
  if (normalizeDaemonModel(state.model)) return normalizeDaemonModel(state.model);
  if (state.version !== undefined) return undefined;
  // A legacy global config answers `default` for any name, hence the name check.
  const profile = await ConfigLoader.loadGlobalConfigProfile(state.profile);
  return profile.name === state.profile ? normalizeDaemonModel(profile.model) : undefined;
}

/**
 * Replaces the daemon from its own state, with everything it ran with — profile, provider, target and sync URLs,
 * project and binding, gateway key, model — on `port`; no config of the working directory is read. The stopped
 * daemon deletes its own state file, so the state is written back before the spawn: a start cut between the two
 * leaves the state of a dead daemon, from which the next start comes back. The record gets nothing but its port.
 * Called under the daemon lock.
 */
export async function startFromState(state: RestartableState, port: number): Promise<DaemonState> {
  const model = await modelFromState(state);
  await stopDaemon();
  await writeState(state);
  const started = await spawnDaemon({
    targetUrl: state.targetUrl,
    provider: state.provider,
    profile: state.profile,
    port,
    gatewayKey: state.gatewayKey,
    ...(model ? { model } : {}),
    ...(state.project ? { project: state.project } : {}),
    ...(state.projectBinding ? { projectBinding: state.projectBinding } : {}),
    syncApiUrl: state.syncApiUrl,
    syncCodeMieUrl: state.syncCodeMieUrl,
    writeRecord: false,
  });
  await refreshClaudeCodeOtlpEndpoint(started);
  return started;
}

/**
 * Why the profile has no usable SSO login, or undefined when it has one. Never throws and never
 * blocks a start: a daemon without credentials holds its port and answers 401 until the user signs in.
 */
async function ssoCredentialsProblem(config: LoadedConfig, name: string): Promise<string | undefined> {
  return assertSsoCredentials(config.baseUrl as string, name, config.codeMieUrl)
    .then(() => undefined, (error: Error) => error.message);
}

/**
 * Loads the recorded profile (a repo-local one wins over the global one) and checks it can
 * start a daemon. Returns the config, or the reason it cannot, with the scope that was found.
 */
async function resolveColdStartProfile(
  name: string
): Promise<{ scope?: 'local' | 'global'; config?: LoadedConfig; skipReason?: string }> {
  const cwd = process.cwd();
  let scope: 'local' | 'global';
  // A legacy global config answers `default` for any name, hence the name checks.
  if ((await ConfigLoader.loadLocalConfigProfile(cwd, name)).name === name) {
    scope = 'local';
  } else if ((await ConfigLoader.loadGlobalConfigProfile(name)).name === name) {
    scope = 'global';
  } else {
    return { skipReason: 'profile not found' };
  }

  const config = await ConfigLoader.load(cwd, { name });
  if (config.name !== name) return { scope, skipReason: `profile resolved to '${config.name}'` };
  if (!config.baseUrl?.trim()) return { scope, skipReason: 'no baseUrl configured' };
  return { scope, config };
}

function warnStartingWithoutCredentials(name: string, problem: string, scope?: string): void {
  logger.warn(
    `[ensureOtlpProxy] no SSO credentials (profile: ${name}${scope ? `, ${scope} scope` : ''}): ${problem}; ` +
      'starting the proxy anyway, it holds the port until you sign in'
  );
}

/**
 * Adopts the state's daemon when it is alive and not of an older CLI (or `acceptOlder`): seeds the connection
 * record and re-points Claude Code's OTLP endpoint at it.
 */
async function adoptLiveDaemon(state: DaemonState | null, acceptOlder: boolean): Promise<boolean> {
  if (!state || !(await isDaemonAlive(state))) return false;
  if (!acceptOlder && (await isOlderDaemon(state))) return false;
  await seedConnectionRecord(state);
  await refreshClaudeCodeOtlpEndpoint(state);
  return true;
}

/**
 * Starts the daemon for the profile on `port`. With `stopOlder` the live older daemon read under the lock is
 * stopped first; `ensureDaemon` then adopts a live daemon it still finds (one an older install's hook, which
 * takes no lock, started after that read).
 */
async function startDaemon(
  name: string,
  config: LoadedConfig,
  projectBinding: Awaited<ReturnType<typeof reportDaemonProfileIdentity>>,
  port: number,
  stopOlder: boolean
): Promise<void> {
  const requested = buildRequestedConfig(name, config, projectBinding, port);
  if (stopOlder) await stopDaemon();
  const { state: live, startedInThisRun } = await ensureDaemon(requested, config, false, false, true, true);
  if (!startedInThisRun) await seedConnectionRecord(live);
  await refreshClaudeCodeOtlpEndpoint(live);
}

/**
 * Cold start when there is no usable connection record and no live daemon (first hook after an
 * upgrade, or a deleted or malformed record): start on the working directory's profile as hooks
 * did before the record existed. The daemon's successful start creates the record. Like the
 * record path, a blank baseUrl returns silently, missing SSO credentials are only warned (the
 * daemon holds its port until login), and nothing here writes to the console or exits.
 */
async function coldStartOnWorkingDirectoryProfile(port: number, stopOlder: boolean): Promise<void> {
  const cwd = process.cwd();
  let name = 'default';
  try {
    const activeProfileName = await ConfigLoader.getActiveProfileName(cwd);
    if (activeProfileName) name = activeProfileName;
    const config = await ConfigLoader.load(cwd, activeProfileName ? { name: activeProfileName } : undefined);
    name = config.name ?? name;

    // Hooks run on every tracked project; an unconfigured baseUrl must never fail one.
    if (!config.baseUrl?.trim()) return;

    const credentialsProblem = await ssoCredentialsProblem(config, name);
    if (credentialsProblem) warnStartingWithoutCredentials(name, credentialsProblem);

    logger.warn(
      `[ensureOtlpProxy] no recorded proxy connection; starting on the working directory's profile (profile: ${name})`
    );
    // An unowned profile is only logged here, never printed or prompted.
    const projectBinding = await reportDaemonProfileIdentity(config, 'hook', cwd);
    await startDaemon(name, config, projectBinding, port, stopOlder);
  } catch (error) {
    logger.warn(`[ensureOtlpProxy] cold start failed (profile: ${name})`, ...sanitizeLogArgs(error));
    throw error;
  }
}

/**
 * Hook cold start. A live daemon of this CLI's version or a newer one is adopted without the lock,
 * whatever else differs. Otherwise, under the daemon lock and after reading the state again: a live
 * daemon that is not older is adopted; a state that names its upstream — of a live older daemon, or of
 * a daemon that is no longer alive — brings the daemon back from that state (`startFromState`); with
 * no such state the daemon starts on the profile `proxy connect` recorded in proxy-connection.json,
 * never on the cwd's active profile (only with no record at all does it fall back to the cwd's
 * profile, see `coldStartOnWorkingDirectoryProfile`), its project from the loaded config; a live older
 * daemon is stopped first, once that profile is loaded and a start is due. When `agentName`
 * is Claude Code's hook adapter and `event` is one of {@link ADOPT_OLDER_DAEMON_EVENTS}, a live older daemon
 * is adopted as it is; every other agent, and a call without an event (the Claude launcher), replaces it.
 *
 * Hooks run as a background side effect on every tracked project, so an unusable profile (not found,
 * no baseUrl) is warned and skipped rather than thrown, and nothing here writes to the console or
 * exits: a hook's stdout is the agent's protocol channel. Missing or expired SSO credentials do not
 * stop the start: the daemon holds its port and answers 401 until the user signs in, and then swaps
 * the real proxy in by itself. A lock still held after its budget throws to the caller, which goes
 * on without the daemon.
 */
export async function ensureOtlpProxy(agentName: string, event?: string): Promise<void> {
  const acceptOlder =
    agentName === CLAUDE_CODE_OTLP_AGENT_NAME && event !== undefined && ADOPT_OLDER_DAEMON_EVENTS.has(event);
  if (await adoptLiveDaemon(await readState(), acceptOlder)) return;

  await withDaemonLock(DAEMON_LOCK_HOOK_BUDGET_MS, async () => {
    const state = await readState();
    if (await adoptLiveDaemon(state, acceptOlder)) return;
    const port = await requestedDaemonPort();
    if (state && isRestartableState(state)) {
      logger.info(`[ensureOtlpProxy] starting the proxy from its last state (profile: ${state.profile})`);
      await startFromState(state, port);
      return;
    }
    // Not adopted above, so a daemon still alive here is an older one this event does not accept.
    await coldStartOnRecord(port, state !== null && (await isDaemonAlive(state)));
  });
}

/**
 * Today's cold start: the recorded profile, else the working directory's, on `port`; with `stopOlder` the live
 * older daemon is stopped right before the start.
 */
async function coldStartOnRecord(port: number, stopOlder: boolean): Promise<void> {
  const record = await readConnectionRecord();
  if (!record) {
    await coldStartOnWorkingDirectoryProfile(port, stopOlder);
    return;
  }

  const name = record.profile;
  try {
    const { scope, config, skipReason } = await resolveColdStartProfile(name);
    if (!config) {
      logger.warn(
        `[ensureOtlpProxy] proxy not started (profile: ${name}${scope ? `, ${scope}` : ''}): ${skipReason}`
      );
      return;
    }

    const credentialsProblem = await ssoCredentialsProblem(config, name);
    if (credentialsProblem) warnStartingWithoutCredentials(name, credentialsProblem, scope);

    logger.info(`[ensureOtlpProxy] cold start (profile: ${name}, ${scope} scope)`);
    // An unowned profile is only logged here, never printed or prompted.
    const projectBinding = await reportDaemonProfileIdentity(config, 'hook', process.cwd());
    await startDaemon(name, config, projectBinding, port, stopOlder);
  } catch (error) {
    logger.warn(`[ensureOtlpProxy] cold start failed (profile: ${name})`, ...sanitizeLogArgs(error));
    throw error;
  }
}
