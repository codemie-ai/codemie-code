/**
 * Version comparison utilities for semantic versioning
 * Used for Claude Code version management
 */

/**
 * Semantic version components
 */
export interface SemanticVersion {
	major: number;
	minor: number;
	patch: number;
	raw: string; // Original version string
}

/**
 * Parse semantic version string into comparable components
 *
 * @param version - Version string (e.g., '2.0.30')
 * @returns Version components { major, minor, patch, raw }
 * @throws {Error} If version string is invalid
 *
 * @example
 * parseSemanticVersion('2.0.30') // Returns { major: 2, minor: 0, patch: 30, raw: '2.0.30' }
 */
export function parseSemanticVersion(version: string): SemanticVersion {
	// Remove 'v' prefix if present
	const cleanVersion = version.trim().replace(/^v/, '');

	// Match semantic version pattern: major.minor.patch
	const match = cleanVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);

	if (!match) {
		throw new Error(
			`Invalid semantic version format: "${version}". Expected format: major.minor.patch (e.g., "2.0.30")`
		);
	}

	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		raw: version,
	};
}

/**
 * Check if version string is valid semantic version
 *
 * @param version - Version string to validate
 * @returns true if valid semantic version
 *
 * @example
 * isValidSemanticVersion('2.0.30') // true
 * isValidSemanticVersion('v2.0.30') // true
 * isValidSemanticVersion('invalid') // false
 */
export function isValidSemanticVersion(version: string): boolean {
	try {
		parseSemanticVersion(version);
		return true;
	} catch {
		return false;
	}
}

/**
 * Compare two semantic versions
 *
 * @param version1 - First version string (e.g., '2.0.30')
 * @param version2 - Second version string (e.g., '2.0.45')
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 *
 * @example
 * compareVersions('2.0.30', '2.0.45') // Returns -1
 * compareVersions('2.0.45', '2.0.30') // Returns 1
 * compareVersions('2.0.30', '2.0.30') // Returns 0
 */
export function compareVersions(version1: string, version2: string): number {
	// Handle special channel names (treat as highest version)
	const isSpecialChannel = (v: string): boolean =>
		['latest', 'stable'].includes(v.toLowerCase());

	if (isSpecialChannel(version1) && isSpecialChannel(version2)) {
		return 0; // Both special channels, consider equal
	}
	if (isSpecialChannel(version1)) {
		return 1; // v1 is latest/stable, higher than any specific version
	}
	if (isSpecialChannel(version2)) {
		return -1; // v2 is latest/stable, higher than v1
	}

	// Parse both versions
	const v1 = parseSemanticVersion(version1);
	const v2 = parseSemanticVersion(version2);

	// Compare major version
	if (v1.major !== v2.major) {
		return v1.major < v2.major ? -1 : 1;
	}

	// Compare minor version
	if (v1.minor !== v2.minor) {
		return v1.minor < v2.minor ? -1 : 1;
	}

	// Compare patch version
	if (v1.patch !== v2.patch) {
		return v1.patch < v2.patch ? -1 : 1;
	}

	// Versions are equal
	return 0;
}
