import { ConfigLoader } from '../../../utils/config.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { syncRegisteredSkills } from '../skills/setup/sync.js';
import { syncPluginSkills } from '../skills/setup/sync-plugin.js';
import { readConnectionRecord, spawnDaemon, type DaemonState, type SpawnOptions } from './daemon-manager.js';
import { verifySsoCredentials } from './connect-orchestrator.js';

export type LoadedConfig = Awaited<ReturnType<typeof ConfigLoader.load>>;

/** A loaded profile config whose base URL has been checked. */
export type LaunchableConfig = LoadedConfig & { baseUrl: string };

/**
 * Everything that can fail or take time before a daemon is spawned: the base
 * URL check, SSO credential verification and skill sync. `proxy restart` runs
 * this before stopping the old daemon, so a bad profile leaves it running.
 */
export async function prepareDaemonLaunch(config: LoadedConfig, profile: string): Promise<LaunchableConfig> {
  if (!config.baseUrl) {
    throw new ConfigurationError('No API URL configured for this profile.\nRun: codemie setup');
  }

  await verifySsoCredentials(config.baseUrl, profile, config.codeMieUrl);

  await Promise.allSettled([
    syncRegisteredSkills(profile, process.cwd()),
    syncPluginSkills(),
  ]);

  return config as LaunchableConfig;
}

/**
 * Whether `proxy start` / `proxy restart` should (re)write proxy-connection.json: an explicit
 * `--profile` always does; without it the daemon may have loaded the cwd profile, so an existing
 * valid record (set by `proxy connect`) is left alone. Once the daemon runs, the command moves the client configs
 * to their named keys, which can drop an older CLI's client identity from the record.
 */
export async function shouldWriteConnectionRecord(profileOption: string | undefined): Promise<boolean> {
  return Boolean(profileOption) || !(await readConnectionRecord());
}

/** Spawn the daemon for a prepared config; `overrides` carries the port and what a restart keeps. */
export async function spawnForProfile(
  config: LaunchableConfig,
  profile: string,
  overrides: Partial<SpawnOptions>
): Promise<DaemonState> {
  console.log('Starting proxy daemon...');
  return spawnDaemon({
    targetUrl: config.baseUrl,
    provider: config.provider ?? 'ai-run-sso',
    profile,
    project: config.codeMieProject,
    syncApiUrl: config.ssoConfig?.apiUrl,
    syncCodeMieUrl: config.codeMieUrl,
    ...overrides,
  });
}
