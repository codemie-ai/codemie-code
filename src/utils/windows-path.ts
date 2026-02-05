/**
 * Windows PATH management utilities
 * Handles adding CLI tools to Windows PATH environment variable
 */

import { win32 as pathWin32 } from 'path';
import { existsSync } from 'fs';
import { exec } from './exec.js';
import { logger } from './logger.js';
import { sanitizeLogArgs } from './security.js';

/**
 * Result of PATH update operation
 */
export interface PathUpdateResult {
	success: boolean;
	pathAdded?: string;
	error?: string;
	requiresRestart: boolean;
	alreadyInPath?: boolean;
}

/**
 * Get Windows System32 directory path
 * Defaults to C:\Windows\System32 if SystemRoot env var not set
 */
const getWindowsSystem32 = (): string => {
	return process.env.SystemRoot
		? `${process.env.SystemRoot}\\System32`
		: 'C:\\Windows\\System32';
};

/**
 * Validate directory path for security
 * Ensures path is absolute and doesn't contain shell metacharacters
 *
 * @param directory - Directory path to validate
 * @returns Normalized path if valid, null if invalid
 */
function validateDirectoryPath(directory: string): string | null {
	try {
		// Normalize path (resolve .., ., etc.)
		const normalizedPath = pathWin32.normalize(directory);

		// Must be absolute path
		if (!pathWin32.isAbsolute(normalizedPath)) {
			logger.debug('Directory path is not absolute', { directory });
			return null;
		}

		// SECURITY: Check for shell metacharacters that could enable command injection
		// Windows shell special chars: & | < > ^ ( ) " ; , \n \r
		const dangerousChars = /[&|<>^();,\n\r"]/;
		if (dangerousChars.test(normalizedPath)) {
			logger.warn('Directory path contains dangerous shell metacharacters', {
				directory: normalizedPath
			});
			return null;
		}

		return normalizedPath;
	} catch (error) {
		logger.debug('Failed to validate directory path', ...sanitizeLogArgs({ directory, error }));
		return null;
	}
}

/**
 * Check common installation directories for a command
 * Checks standard Windows installation locations without relying on PATH
 *
 * @param command - Command name (e.g., 'claude')
 * @returns Full path to the executable directory or null if not found
 */
function checkCommonInstallLocations(command: string): string | null {
	const userProfile = process.env.USERPROFILE || '';
	const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
	const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
	const localAppData = process.env.LOCALAPPDATA || `${userProfile}\\AppData\\Local`;

	// Common installation locations for CLI tools on Windows
	const commonLocations = [
		// XDG-style user installation (Claude's preferred location)
		`${userProfile}\\.local\\bin`,
		// AppData Local
		`${localAppData}\\Programs\\${command}`,
		`${localAppData}\\${command}`,
		`${localAppData}\\bin`,
		// Program Files
		`${programFiles}\\${command}`,
		`${programFilesX86}\\${command}`,
		// User-specific npm global
		`${process.env.APPDATA || userProfile}\\npm`,
	];

	const exeName = `${command}.exe`;

	for (const dir of commonLocations) {
		try {
			const exePath = `${dir}\\${exeName}`;
			if (existsSync(exePath)) {
				logger.debug('Found command in common location', { command, directory: dir });
				return dir;
			}
		} catch {
			// Continue checking other locations
		}
	}

	return null;
}

/**
 * Find the installation directory of a command on Windows
 * First tries `where` command, then falls back to checking common locations
 *
 * @param command - Command name (e.g., 'claude')
 * @returns Full path to the executable directory or null if not found
 */
export async function findCommandDirectory(command: string): Promise<string | null> {
	if (process.platform !== 'win32') {
		return null;
	}

	try {
		// SECURITY: Use full path to where.exe to avoid PATH hijacking
		const wherePath = `${getWindowsSystem32()}\\where.exe`;
		const result = await exec(wherePath, [command], { timeout: 5000 });

		if (result.code === 0 && result.stdout) {
			// Parse first line (where command may return multiple results)
			const executablePath = result.stdout.trim().split('\n')[0].trim();

			// Extract directory from full path
			// Example: C:\Users\Username\AppData\Local\Programs\Claude\claude.exe
			// -> C:\Users\Username\AppData\Local\Programs\Claude
			const lastSlashIndex = executablePath.lastIndexOf('\\');
			if (lastSlashIndex !== -1) {
				const directory = executablePath.substring(0, lastSlashIndex);
				logger.debug('Found command via where.exe', { command, directory });
				return directory;
			}
		}
	} catch (error) {
		logger.debug('where.exe failed, trying common locations', ...sanitizeLogArgs({ command, error }));
	}

	// Fallback: Check common installation directories
	// This is crucial for newly installed commands that aren't in PATH yet
	logger.debug('Checking common installation locations', { command });
	return checkCommonInstallLocations(command);
}

/**
 * Check if a directory is in the user's PATH environment variable
 * Queries Windows registry for current PATH value
 *
 * @param directory - Directory path to check
 * @returns true if directory is in PATH
 */
export async function isInUserPath(directory: string): Promise<boolean> {
	if (process.platform !== 'win32') {
		return false;
	}

	// SECURITY: Validate and normalize directory path
	const normalizedDirectory = validateDirectoryPath(directory);
	if (!normalizedDirectory) {
		logger.debug('Invalid directory path for PATH check', { directory });
		return false;
	}

	try {
		// SECURITY: Use full path to reg.exe to avoid PATH hijacking
		const regPath = `${getWindowsSystem32()}\\reg.exe`;
		const result = await exec(regPath, [
			'query',
			'HKCU\\Environment',
			'/v',
			'PATH'
		], { timeout: 5000 });

		if (result.code === 0 && result.stdout) {
			// Parse registry output
			// Format: PATH    REG_EXPAND_SZ    C:\path1;C:\path2;...
			const pathMatch = result.stdout.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
			if (pathMatch) {
				const pathValue = pathMatch[1].trim();

				// Normalize paths for comparison (case-insensitive, handle trailing slashes)
				const dirForComparison = normalizedDirectory.toLowerCase().replace(/\\+$/, '');
				const pathEntries = pathValue.split(';').map(p =>
					pathWin32.normalize(p.trim()).toLowerCase().replace(/\\+$/, '')
				);

				return pathEntries.includes(dirForComparison);
			}
		}
	} catch (error) {
		logger.debug('Failed to check user PATH', ...sanitizeLogArgs({ directory, error }));
	}

	return false;
}

/**
 * Add a directory to the user's PATH environment variable on Windows
 * Uses `setx` command to update the registry
 *
 * IMPORTANT: Changes take effect in NEW sessions only. Current session is unaffected.
 *
 * @param directory - Directory path to add to PATH
 * @returns Result with success status and whether restart is required
 */
export async function addToUserPath(directory: string): Promise<PathUpdateResult> {
	if (process.platform !== 'win32') {
		return {
			success: false,
			error: 'Not Windows platform',
			requiresRestart: false,
			alreadyInPath: false
		};
	}

	// SECURITY: Validate and normalize directory path
	const normalizedDirectory = validateDirectoryPath(directory);
	if (!normalizedDirectory) {
		return {
			success: false,
			error: 'Invalid directory path: must be absolute and contain no shell metacharacters',
			requiresRestart: false,
			alreadyInPath: false
		};
	}

	try {
		logger.debug('Adding directory to user PATH', { directory: normalizedDirectory });

		// Get current user PATH
		// SECURITY: Use full path to reg.exe to avoid PATH hijacking
		const regPath = `${getWindowsSystem32()}\\reg.exe`;
		const queryResult = await exec(regPath, [
			'query',
			'HKCU\\Environment',
			'/v',
			'PATH'
		], { timeout: 5000 });

		let currentPath = '';
		if (queryResult.code === 0 && queryResult.stdout) {
			const pathMatch = queryResult.stdout.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
			if (pathMatch) {
				currentPath = pathMatch[1].trim();
			}
		}

		// Check for duplicates before adding
		const dirForComparison = normalizedDirectory.toLowerCase().replace(/\\+$/, '');
		const pathEntries = currentPath.split(';').map(p =>
			pathWin32.normalize(p.trim()).toLowerCase().replace(/\\+$/, '')
		);

		if (pathEntries.includes(dirForComparison)) {
			logger.debug('Directory already in PATH, skipping', { directory: normalizedDirectory });
			return {
				success: true,
				pathAdded: normalizedDirectory,
				requiresRestart: true,
				alreadyInPath: true
			};
		}

		// Append new directory
		const newPath = currentPath ? `${currentPath};${normalizedDirectory}` : normalizedDirectory;

		// SECURITY: Check setx 1024 character limit
		if (newPath.length > 1024) {
			logger.warn('PATH exceeds setx 1024 character limit', {
				currentLength: newPath.length,
				limit: 1024
			});

			return {
				success: false,
				error: `PATH too long (${newPath.length} chars, limit 1024). Must update PATH manually via Registry Editor or System Properties.`,
				requiresRestart: false,
				alreadyInPath: false
			};
		}

		// Update PATH using setx
		// SECURITY: Use full path to setx.exe to avoid PATH hijacking
		const setxPath = `${getWindowsSystem32()}\\setx.exe`;
		const setxResult = await exec(setxPath, ['PATH', newPath], { timeout: 10000 });

		if (setxResult.code === 0) {
			logger.debug('Successfully added to PATH', { directory: normalizedDirectory });
			return {
				success: true,
				pathAdded: normalizedDirectory,
				requiresRestart: true,
				alreadyInPath: false
			};
		} else {
			const errorMsg = setxResult.stderr || setxResult.stdout || 'Unknown error';
			logger.warn('Failed to update PATH with setx', {
				directory: normalizedDirectory,
				error: errorMsg
			});

			return {
				success: false,
				error: `setx failed: ${errorMsg}`,
				requiresRestart: false,
				alreadyInPath: false
			};
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error('Failed to add to user PATH', ...sanitizeLogArgs({
			directory: normalizedDirectory,
			error: errorMsg
		}));

		return {
			success: false,
			error: errorMsg,
			requiresRestart: false,
			alreadyInPath: false
		};
	}
}

/**
 * Attempt to fix PATH for a command that was installed but is not in PATH
 *
 * Workflow:
 * 1. Find where the command was installed (using `where` on the installer's session)
 * 2. Check if that directory is already in user PATH
 * 3. If not, add it using `setx`
 * 4. Return result with instructions for user
 *
 * @param command - Command name (e.g., 'claude')
 * @returns Result with success status and whether restart is required
 */
export async function ensureCommandInPath(command: string): Promise<PathUpdateResult> {
	if (process.platform !== 'win32') {
		return {
			success: false,
			error: 'Not Windows platform',
			requiresRestart: false,
			alreadyInPath: false
		};
	}

	logger.debug('Ensuring command is in PATH', { command });

	// Step 1: Try to find where the command was installed
	// This works if the installer added it to the SYSTEM path or current session
	const installDir = await findCommandDirectory(command);

	if (!installDir) {
		// Command not found anywhere, installation may have failed
		logger.warn('Command not found in any PATH', { command });
		return {
			success: false,
			error: `Could not locate ${command} installation directory`,
			requiresRestart: false,
			alreadyInPath: false
		};
	}

	logger.debug('Found command installation directory', {
		command,
		directory: installDir
	});

	// Step 2: Check if already in user PATH
	const alreadyInPath = await isInUserPath(installDir);

	if (alreadyInPath) {
		logger.debug('Command directory already in user PATH', {
			command,
			directory: installDir
		});
		return {
			success: true,
			pathAdded: installDir,
			requiresRestart: true, // Still need restart even if already in registry
			alreadyInPath: true
		};
	}

	// Step 3: Add to PATH
	logger.info('Adding command to user PATH', {
		command,
		directory: installDir
	});

	return await addToUserPath(installDir);
}
