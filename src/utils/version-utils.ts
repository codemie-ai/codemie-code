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

const SEMVER_WITH_PRERELEASE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function sign(a: number | string, b: number | string): -1 | 0 | 1 {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

// Digit strings without leading zeros, compared by length then digits: Number() loses precision past 2^53.
function compareNumerals(a: string, b: string): -1 | 0 | 1 {
	return a.length !== b.length ? sign(a.length, b.length) : sign(a, b);
}

function comparePrereleaseIdentifiers(a: string, b: string): -1 | 0 | 1 {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) return compareNumerals(a, b);
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return sign(a, b);
}

/**
 * Compare two versions by semantic-version precedence, pre-release suffixes included; build metadata
 * takes no part. A leading `v` and surrounding whitespace are ignored.
 *
 * @returns -1, 0 or 1, or null when either string is not `x.y.z[-pre-release][+build]`
 *
 * @example
 * comparePrereleaseVersions('0.17.0-rc.1', '0.17.0') // -1
 * comparePrereleaseVersions('latest', '0.17.0') // null
 */
export function comparePrereleaseVersions(version1: string, version2: string): -1 | 0 | 1 | null {
	const m1 = version1.trim().replace(/^v/, '').match(SEMVER_WITH_PRERELEASE);
	const m2 = version2.trim().replace(/^v/, '').match(SEMVER_WITH_PRERELEASE);
	if (!m1 || !m2) return null;

	for (let i = 1; i <= 3; i++) {
		const core = compareNumerals(m1[i], m2[i]);
		if (core !== 0) return core;
	}

	const pre1 = m1[4];
	const pre2 = m2[4];
	if (pre1 === undefined || pre2 === undefined) {
		if (pre1 === pre2) return 0;
		return pre1 === undefined ? 1 : -1;
	}

	const ids1 = pre1.split('.');
	const ids2 = pre2.split('.');
	for (let i = 0; i < Math.min(ids1.length, ids2.length); i++) {
		const order = comparePrereleaseIdentifiers(ids1[i], ids2[i]);
		if (order !== 0) return order;
	}
	return sign(ids1.length, ids2.length);
}
