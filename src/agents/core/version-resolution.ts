import { getCachedLatestVersion } from '@/utils/version-cache.js';
import { compareVersions, extractVersion } from '@/utils/version-utils.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import { AgentInstallationError } from '@/utils/errors.js';
import { getAgentInstallCommand } from './agent-aliases.js';

// The ticket's four agents; kimi-acp runs the same package and binary as kimi.
export const LIVE_TRACKED_AGENT_NAMES = ['claude', 'codex', 'gemini', 'kimi', 'kimi-acp'] as const;

/**
 * Whether the agent's tracked version follows its npm `latest` release (see
 * {@link LIVE_TRACKED_AGENT_NAMES}). Other agents are never looked up live.
 *
 * @param agentName - agent metadata `name`, e.g. `codex`
 */
export function isLiveTrackedAgent(agentName: string): boolean {
  return (LIVE_TRACKED_AGENT_NAMES as readonly string[]).includes(agentName);
}

/**
 * Whether a live-tracked agent is installed ahead of its tracked version. That usually means it
 * self-updated since the (up to 24h old) cached lookup, so advising `install --supported` there
 * would suggest a downgrade; the launch notice and `codemie doctor` stay quiet instead.
 *
 * @param agentName - agent metadata `name`
 * @param compat - the agent's version compatibility result
 */
export function isAheadOfLiveTracking(agentName: string, compat: { isNewer?: boolean }): boolean {
  return Boolean(compat.isNewer) && isLiveTrackedAgent(agentName);
}

export interface ResolveSupportedVersionInput {
  agentName: string;
  npmPackage?: string | null;
  fallbackSupportedVersion?: string;
  /** The agent's hard minimum; a live version below it is not treated as current. */
  minimumSupportedVersion?: string;
  /** Always query the registry instead of a fresh cache entry (explicit `codemie update`). */
  bypassCache?: boolean;
}

/**
 * Whether the `versionChecks.enabled` toggle permits version checks.
 *
 * Resolved field by field — `CODEMIE_VERSION_CHECKS_ENABLED`, then the project's
 * `workspace.versionChecks`, then the global one — rather than through ConfigLoader.load(),
 * because load() swaps in a project's whole `workspace` block (hiding a global setting it
 * doesn't repeat) and throws when no profile is active (hiding the env var). Fail-safe: only an
 * explicit `false` disables checks; an unreadable config or unrecognized value leaves them on.
 */
export async function isVersionChecksEnabled(workingDir: string = process.cwd()): Promise<boolean> {
  // An empty value (e.g. `CODEMIE_VERSION_CHECKS_ENABLED=`) counts as unset, so it can't override
  // an explicit `false` in the config.
  const envValue = process.env.CODEMIE_VERSION_CHECKS_ENABLED?.trim();
  if (envValue) {
    return envValue !== 'false';
  }

  const scopes: Array<{ scope: string; load: () => Promise<{ workspace?: { versionChecks?: { enabled?: unknown } } }> }> = [
    { scope: 'local', load: () => ConfigLoader.loadLocalMultiProviderConfig(workingDir) },
    { scope: 'global', load: () => ConfigLoader.loadMultiProviderConfig() },
  ];
  for (const { scope, load } of scopes) {
    try {
      const enabled = (await load()).workspace?.versionChecks?.enabled;
      if (enabled !== undefined) {
        return enabled !== false;
      }
    } catch (error) {
      logger.debug('[version-resolution] config read failed, skipping scope', { scope, error: String(error) });
    }
  }
  return true;
}

// Matches a prerelease/build-metadata suffix after the numeric version, e.g. "1.2.3-beta.1" or
// "v1.2.3-rc1+build5" — npm's `latest` dist-tag should never point at one, but a live lookup is
// external input and this guards against silently presenting it as the tracked version.
const PRERELEASE_SUFFIX_PATTERN = /\d+\.\d+\.\d+[-+]/;

export interface ResolvedSupportedVersion {
  /**
   * The tracked version. Only meaningful when `isCurrent` is true; otherwise it carries the
   * metadata value, which callers must not install, display or compare against.
   */
  version: string | undefined;
  /**
   * Whether `version` can be treated as the current tracked version: a successful (possibly
   * cached) npm lookup for a live-tracked agent, or the maintainer-pinned value for any other
   * agent. False when checks are off, or a live-tracked agent's lookup failed or was rejected —
   * callers must then behave as if no supported version were configured.
   */
  isCurrent: boolean;
  /**
   * Set only when a live-tracked agent's registry `latest` is below its hard minimum (e.g. a
   * lagging mirror). The tracked version is then unknown, and installing it must stop: the
   * `latest` channel would resolve to that same release the minimum gate refuses.
   */
  liveBelowMinimum?: true;
  /** The registry `latest` that was rejected; set together with `liveBelowMinimum`. */
  registryLatestVersion?: string;
}

/**
 * Why an install of the tracked version cannot proceed when the registry `latest` is below the
 * agent's hard minimum, with the command to install an explicit version instead.
 *
 * @param agentName - agent metadata `name`
 * @param registryLatestVersion - the registry's `latest` release
 * @param minimumSupportedVersion - the agent's hard minimum
 */
export function liveBelowMinimumReason(
  agentName: string,
  registryLatestVersion: string,
  minimumSupportedVersion: string
): string {
  return (
    `the registry's latest release v${registryLatestVersion} is below the minimum supported ` +
    `v${minimumSupportedVersion} (a lagging mirror?). ` +
    `Install a specific version: ${getAgentInstallCommand(agentName)} <version>`
  );
}

/**
 * Resolve the version CodeMie tracks for an agent. Live-tracked agents use the npm `latest`
 * release; a failed or rejected lookup returns the metadata fallback with `isCurrent: false`.
 * Other agents keep their maintainer-pinned version, unchanged. With checks off nothing is current.
 *
 * @param input - agent name, npm package and metadata fallback
 * @returns the resolved version and whether it is current
 */
export async function resolveSupportedVersionDetailed(
  input: ResolveSupportedVersionInput
): Promise<ResolvedSupportedVersion> {
  const { agentName, npmPackage, fallbackSupportedVersion, minimumSupportedVersion, bypassCache } = input;
  const fallback: ResolvedSupportedVersion = { version: fallbackSupportedVersion, isCurrent: false };

  if (!(await isVersionChecksEnabled())) {
    return fallback;
  }

  if (!isLiveTrackedAgent(agentName) || !npmPackage) {
    return { version: fallbackSupportedVersion, isCurrent: Boolean(fallbackSupportedVersion) };
  }

  try {
    const live = await getCachedLatestVersion(npmPackage, { bypassCache });
    if (live && PRERELEASE_SUFFIX_PATTERN.test(live)) {
      logger.debug('[resolveSupportedVersion] live version looks like a prerelease, using fallback', {
        agentName,
        live,
      });
      return fallback;
    }
    const extracted = live ? extractVersion(live) : null;
    // A lagging mirror or a mis-set dist-tag can report a `latest` below the hard minimum;
    // tracking it would advise (and install) a version the minimum gate then refuses.
    if (extracted && minimumSupportedVersion && compareVersions(extracted, minimumSupportedVersion) < 0) {
      logger.debug('[resolveSupportedVersion] live version is below the minimum, using fallback', {
        agentName,
        live: extracted,
        minimumSupportedVersion,
      });
      return { ...fallback, liveBelowMinimum: true, registryLatestVersion: extracted };
    }
    return extracted ? { version: extracted, isCurrent: true } : fallback;
  } catch (error) {
    logger.debug('[resolveSupportedVersion] live lookup failed, using fallback', { agentName, error: String(error) });
    return fallback;
  }
}

/**
 * Install target for `installVersion('supported')`: the current tracked version, or the `latest`
 * channel when it is unknown (checks off, lookup failed). Never a stale fallback, which can be far
 * behind upstream and would install — or downgrade to — an old release.
 *
 * @throws {AgentInstallationError} when the registry `latest` is below the hard minimum: the
 * `latest` channel would install the release the minimum gate refuses to launch.
 */
export async function resolveSupportedInstallVersion(input: ResolveSupportedVersionInput): Promise<string> {
  const { version, isCurrent, liveBelowMinimum, registryLatestVersion } = await resolveSupportedVersionDetailed(input);
  if (liveBelowMinimum && registryLatestVersion && input.minimumSupportedVersion) {
    throw new AgentInstallationError(
      input.agentName,
      liveBelowMinimumReason(input.agentName, registryLatestVersion, input.minimumSupportedVersion)
    );
  }
  return isCurrent && version ? version : 'latest';
}
