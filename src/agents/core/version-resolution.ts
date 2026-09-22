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
}

export async function resolveSupportedVersion(
	input: ResolveSupportedVersionInput
): Promise<string | undefined> {
	const { agentName, npmPackage, fallbackSupportedVersion } = input;

	if (!isLiveTrackedAgent(agentName) || !npmPackage) {
		return fallbackSupportedVersion;
	}

	let enabled = true;
	try {
		const config = await ConfigLoader.load();
		enabled = config.versionChecks?.enabled !== false; // fail-safe: only explicit `false` disables
	} catch (error) {
		logger.debug('[resolveSupportedVersion] config load failed, defaulting to enabled', { error: String(error) });
	}
	if (!enabled) {
		return fallbackSupportedVersion;
	}

	try {
		const live = await getCachedLatestVersion(npmPackage);
		const extracted = live ? extractVersion(live) : null;
		return extracted ?? fallbackSupportedVersion;
	} catch (error) {
		logger.debug('[resolveSupportedVersion] live lookup failed, using fallback', { agentName, error: String(error) });
		return fallbackSupportedVersion;
	}
}
