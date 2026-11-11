/**
 * Hook cold start of the proxy daemon: restores the profile `proxy connect` recorded in
 * proxy-connection.json instead of the working directory's active profile.
 */
import { ConfigLoader } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { reportDaemonProfileIdentity } from '../../../agents/core/launch-identity.js';
import {
  isDaemonAlive,
  readConnectionRecord,
  readState,
  seedConnectionRecord,
  type ClientIdentity,
} from './daemon-manager.js';
import { getEffectiveClientType } from './client-type.js';
import {
  assertSsoCredentials,
  buildRequestedConfig,
  DEFAULT_DAEMON_PORT,
  ensureDaemon,
  withDesktopIdentity,
  type LoadedConfig,
} from './connect-orchestrator.js';
import { readConfiguredOtlpPort, refreshClaudeCodeOtlpEndpoint } from './connectors/claude-code-otlp-endpoint.js';

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

/** Adopts a live daemon, if there is one: seeds the connection record and re-points Claude Code's OTLP endpoint at it. */
async function adoptLiveDaemon(): Promise<boolean> {
  const state = await readState();
  if (!state || !(await isDaemonAlive(state))) return false;
  await seedConnectionRecord(state);
  await refreshClaudeCodeOtlpEndpoint(state);
  return true;
}

/** The port to respawn on: the one Claude Code is already told to export to, else the dead daemon's, else the default. */
async function respawnPort(): Promise<number> {
  return (await readConfiguredOtlpPort()) ?? (await readState())?.port ?? DEFAULT_DAEMON_PORT;
}

/**
 * Matches and spawns the daemon for `identity`; with Claude Desktop connected, in Desktop mode,
 * asking for the gateway's port and kept wherever it came up.
 */
async function startDaemon(
  name: string,
  identity: ClientIdentity,
  config: LoadedConfig,
  projectBinding: Awaited<ReturnType<typeof reportDaemonProfileIdentity>>
): Promise<void> {
  const { identity: spawnIdentity, gatewayPort } = await withDesktopIdentity(identity);
  const requested = buildRequestedConfig(
    name,
    getEffectiveClientType(spawnIdentity),
    config,
    projectBinding,
    gatewayPort ?? (await respawnPort())
  );
  const { state: live } = await ensureDaemon(requested, spawnIdentity, config);
  await refreshClaudeCodeOtlpEndpoint(live);
}

/**
 * Cold start when there is no usable connection record and no live daemon (first hook after an
 * upgrade, or a deleted or malformed record): start on the working directory's profile as hooks
 * did before the record existed. The daemon's successful start creates the record. Like the
 * record path, a blank baseUrl returns silently, missing SSO credentials are only warned (the
 * daemon holds its port until login), and nothing here writes to the console or exits.
 */
async function coldStartOnWorkingDirectoryProfile(agentName: string): Promise<void> {
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

    // A daemon may have come up while the profile and credentials were being resolved.
    if (await adoptLiveDaemon()) return;

    logger.warn(
      `[ensureOtlpProxy] no recorded proxy connection; starting on the working directory's profile (profile: ${name})`
    );
    // An unowned profile is only logged here, never printed or prompted.
    const projectBinding = await reportDaemonProfileIdentity(config, 'hook', cwd);
    await startDaemon(name, { clientType: agentName }, config, projectBinding);
  } catch (error) {
    logger.warn(`[ensureOtlpProxy] cold start failed (profile: ${name})`, ...sanitizeLogArgs(error));
    throw error;
  }
}

/**
 * Hook cold start. Restarts the daemon on the profile `proxy connect` recorded in
 * proxy-connection.json, never on the cwd's active profile (only with no record at all does it
 * fall back to the cwd's profile, see `coldStartOnWorkingDirectoryProfile`). Hooks run as a background
 * side effect on every tracked project, so an unusable profile (not found, no baseUrl)
 * is warned and skipped rather than thrown, and nothing here writes to the console or exits:
 * a hook's stdout is the agent's protocol channel. Missing or expired SSO credentials do not
 * stop the start: the daemon holds its port and answers 401 until the user signs in, and then
 * swaps the real proxy in by itself. The daemon's
 * project comes from the loaded config; the record supplies profile, clientType and
 * telemetryMode only. With Claude Desktop connected, both paths start in Desktop mode on the
 * gateway's port.
 */
export async function ensureOtlpProxy(agentName: string): Promise<void> {
  if (await adoptLiveDaemon()) return;

  const record = await readConnectionRecord();
  if (!record) {
    await coldStartOnWorkingDirectoryProfile(agentName);
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

    const { clientType, telemetryMode } = record;
    const spawnIdentity: ClientIdentity = clientType || telemetryMode
      ? { clientType, telemetryMode }
      : { clientType: agentName };

    // A daemon may have come up while the profile and credentials were being resolved.
    if (await adoptLiveDaemon()) return;

    logger.info(`[ensureOtlpProxy] cold start (profile: ${name}, ${scope} scope)`);
    // An unowned profile is only logged here, never printed or prompted.
    const projectBinding = await reportDaemonProfileIdentity(config, 'hook', process.cwd());
    await startDaemon(name, spawnIdentity, config, projectBinding);
  } catch (error) {
    logger.warn(`[ensureOtlpProxy] cold start failed (profile: ${name})`, ...sanitizeLogArgs(error));
    throw error;
  }
}
