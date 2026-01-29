/**
 * Simple installation method detector for external agents
 * Detects whether agents were installed via npm or native installers
 */

import { getCommandPath } from './processes.js';

/**
 * Installation method type
 */
export type InstallationMethod = 'npm' | 'native' | 'unknown';

/**
 * Detect if a command was installed via npm by checking its path
 *
 * @param commandName - Command to check (e.g., 'claude')
 * @returns Installation method: 'npm', 'native', or 'unknown'
 *
 * @example
 * const method = await detectInstallationMethod('claude');
 * if (method === 'npm') {
 *   console.log('Installed via npm (deprecated)');
 * }
 */
export async function detectInstallationMethod(commandName: string): Promise<InstallationMethod> {
	try {
		// Get the full path to the command
		const commandPath = await getCommandPath(commandName);

		if (!commandPath) {
			return 'unknown';
		}

		// npm-specific path patterns (cross-platform)
		const npmPatterns = [
			'/node_modules/',     // Unix: npm global/local
			'/.nvm/',             // Unix: nvm installations
			'/.npm-global/',      // Unix: npm custom prefix
			'\\node_modules\\',   // Windows: npm global/local
			'\\npm\\',            // Windows: npm directories
			'AppData\\npm',       // Windows: user npm directory
			'Program Files\\nodejs\\node_modules', // Windows: system npm
		];

		// Check if path contains any npm-specific pattern
		for (const pattern of npmPatterns) {
			if (commandPath.includes(pattern)) {
				return 'npm';
			}
		}

		// If not in npm directory, assume native installation
		return 'native';
	} catch {
		// If detection fails, return unknown
		return 'unknown';
	}
}
