import { getCachedLatestVersion } from '../../utils/version-cache.js';
import { extractVersion } from '../../utils/version-utils.js';
import { ConfigLoader } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

export const LIVE_TRACKED_AGENT_NAMES = ['claude', 'codex', 'gemini', 'kimi', 'copilot-cli'] as const;

export function isLiveTrackedAgent(agentName: string): boolean {
	return (LIVE_TRACKED_AGENT_NAMES as readonly string[]).includes(agentName);
}

export interface ResolveSupportedVersionInput {
	agentName: string;
	npmPackage?: string | null;
	fallbackSupportedVersion?: string;
	/** Bypass the 24h cache TTL for this package's lookup only (does not touch the toggle). */
	forceRefresh?: boolean;
}

/**
 * Whether the global `versionChecks.enabled` toggle permits live version lookups, resolved
 * through ConfigLoader's standard priority chain. Fail-safe: any load failure or unrecognized
 * value defaults to enabled — only an explicit `false` disables checks.
 */
export async function isVersionChecksEnabled(): Promise<boolean> {
	try {
		const config = await ConfigLoader.load();
		return config.versionChecks?.enabled !== false;
	} catch (error) {
		logger.debug('[version-resolution] config load failed, defaulting to enabled', { error: String(error) });
		return true;
	}
}

// Matches a prerelease/build-metadata suffix after the numeric version, e.g. "1.2.3-beta.1" or
// "v1.2.3-rc1+build5" — npm's `latest` dist-tag should never point at one, but a live lookup is
// external input and this guards against silently presenting it as the recommended version.
const PRERELEASE_SUFFIX_PATTERN = /\d+\.\d+\.\d+[-+]/;

export async function resolveSupportedVersion(
	input: ResolveSupportedVersionInput
): Promise<string | undefined> {
	const { agentName, npmPackage, fallbackSupportedVersion, forceRefresh } = input;

	if (!isLiveTrackedAgent(agentName) || !npmPackage) {
		return fallbackSupportedVersion;
	}

	const enabled = await isVersionChecksEnabled();
	if (!enabled) {
		return fallbackSupportedVersion;
	}

	try {
		const live = await getCachedLatestVersion(npmPackage, { forceRefresh });
		if (live && PRERELEASE_SUFFIX_PATTERN.test(live)) {
			logger.debug('[resolveSupportedVersion] live version looks like a prerelease, using fallback', {
				agentName,
				live,
			});
			return fallbackSupportedVersion;
		}
		const extracted = live ? extractVersion(live) : null;
		return extracted ?? fallbackSupportedVersion;
	} catch (error) {
		logger.debug('[resolveSupportedVersion] live lookup failed, using fallback', { agentName, error: String(error) });
		return fallbackSupportedVersion;
	}
}
