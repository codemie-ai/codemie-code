/**
 * Native installer utilities for platform-specific agent installation
 * Used for Claude Code native installation management
 */

import { exec } from './processes.js';
import { AgentInstallationError } from './errors.js';
import { logger } from './logger.js';
import { sanitizeLogArgs, sanitizeValue } from './security.js';
import { isValidSemanticVersion } from './version-utils.js';
import { ensureCommandInPath } from './windows-path.js';

/**
 * Platform-specific installer URLs
 */
export interface PlatformInstallerUrls {
	macOS: string; // Shell script URL
	windows: string; // PowerShell script URL
	linux: string; // Shell script URL
}

/**
 * Native installation options
 */
export interface NativeInstallOptions {
	timeout?: number; // Installation timeout (ms)
	env?: Record<string, string>; // Environment variables
	verifyCommand?: string; // Command to verify installation (e.g., 'claude')
	installFlags?: string[]; // Additional flags to pass to installer (e.g., ['--force'])
}

/**
 * Native installation result
 */
export interface NativeInstallResult {
	success: boolean; // Installation succeeded
	installedVersion: string | null; // Installed version (null if verification failed)
	output: string; // Installation output
}

/**
 * Detect current platform
 * @returns Platform identifier: 'macOS' | 'windows' | 'linux'
 */
function detectPlatform(): 'macOS' | 'windows' | 'linux' {
	const platform = process.platform;

	if (platform === 'darwin') {
		return 'macOS';
	} else if (platform === 'win32') {
		return 'windows';
	} else {
		// Assume Linux for all other platforms (linux, freebsd, etc.)
		return 'linux';
	}
}

/**
 * Build installer command for the detected platform
 *
 * @param agentName - Agent name for error messages
 * @param installerUrls - Platform-specific installer URLs
 * @param version - Optional version to install
 * @param platform - Detected platform
 * @param installFlags - Additional flags to pass to installer (e.g., ['--force'])
 * @returns Command string to execute
 */
function buildInstallerCommand(
	agentName: string,
	installerUrls: PlatformInstallerUrls,
	version: string | undefined,
	platform: 'macOS' | 'windows' | 'linux',
	installFlags?: string[]
): string {
	// Validate installer URLs are HTTPS (security requirement)
	const url = installerUrls[platform];
	if (!url.startsWith('https://')) {
		throw new AgentInstallationError(
			agentName,
			`Installer URL must use HTTPS: ${url}`
		);
	}

	// SECURITY: Validate version string to prevent command injection
	// Only allow semantic versions or special channels (latest, stable)
	if (version) {
		const allowedChannels = ['latest', 'stable'];
		const isValidChannel = allowedChannels.includes(version.toLowerCase());
		const isValidVersion = isValidSemanticVersion(version);

		if (!isValidChannel && !isValidVersion) {
			throw new AgentInstallationError(
				agentName,
				`Invalid version format: "${version}". Expected semantic version (e.g., "2.0.30"), "latest", or "stable".`
			);
		}
	}

	// SECURITY: Validate install flags against whitelist
	// Only allow known safe flags to prevent command injection
	const allowedFlags = ['--force', '--silent', '--yes', '-y', '-f', '--no-progress'];
	if (installFlags && installFlags.length > 0) {
		for (const flag of installFlags) {
			if (!allowedFlags.includes(flag)) {
				throw new AgentInstallationError(
					agentName,
					`Invalid install flag: "${flag}". Allowed flags: ${allowedFlags.join(', ')}`
				);
			}
		}
	}

	// Build platform-specific command
	if (platform === 'windows') {
		// Windows CMD command (simpler and more universal than PowerShell)
		// Download install.cmd, execute with args, then delete
		const versionArg = version ? ` ${version}` : '';
		const flagsArg = installFlags && installFlags.length > 0 ? ` ${installFlags.join(' ')}` : '';
		return `curl -fsSL ${url} -o install.cmd && install.cmd${versionArg}${flagsArg} && del install.cmd`;
	} else {
		// macOS/Linux shell script command
		const versionArg = version ? ` -s -- ${version}` : '';
		const scriptFlags = installFlags && installFlags.length > 0 ? ` ${installFlags.join(' ')}` : '';
		return `curl -fsSL ${url} | bash${versionArg}${scriptFlags}`;
	}
}

/**
 * Verify installation by running the verify command
 * On Windows, retries with backoff to allow PATH updates to propagate
 *
 * @param verifyCommand - Command to verify (e.g., 'claude')
 * @param retries - Number of retry attempts (default: 3 on Windows, 1 on Unix)
 * @returns Installed version string or null if verification failed
 */
async function verifyInstallation(
	verifyCommand: string,
	retries?: number
): Promise<string | null> {
	// Windows requires more retries due to PATH refresh delays
	// Unix also benefits from 2 retries (network-mounted home dirs, slow filesystems)
	const isWindows: boolean = process.platform === 'win32';
	const maxRetries = retries ?? (isWindows ? 3 : 2);

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			logger.debug(
				`Verifying installation (attempt ${attempt}/${maxRetries})`,
				{ command: verifyCommand }
			);

			// Run version check command (e.g., 'claude --version')
			const result = await exec(verifyCommand, ['--version'], {
				timeout: 5000, // 5 second timeout for version check
			});

			if (result.code === 0 && result.stdout) {
				// Parse version from output (usually first line, may have 'v' prefix)
				const versionMatch = result.stdout.trim().match(/v?(\d+\.\d+\.\d+)/);
				if (versionMatch) {
					logger.debug('Installation verified successfully', {
						version: versionMatch[1],
						attempt,
					});
					return versionMatch[1];
				}
			}
		} catch (error) {
			logger.debug(
				`Installation verification attempt ${attempt} failed`,
				...sanitizeLogArgs({ error, attempt, maxRetries })
			);
		}

		// Wait before retry (exponential backoff with cap: 1s, 2s, 4s max)
		// Gives Windows time to update PATH without excessive wait
		if (attempt < maxRetries) {
			const delayMs = Math.min(Math.pow(2, attempt - 1) * 1000, 4000);
			// USER FEEDBACK: Show progress during wait
			logger.info(`Waiting for PATH update to propagate (${delayMs / 1000}s)...`);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	// All retries failed
	logger.debug('Installation verification failed after all retries', {
		command: verifyCommand,
		attempts: maxRetries,
	});
	return null;
}

/**
 * Install agent using native platform installer
 * Detects platform and executes appropriate installation script
 *
 * @param agentName - Agent name for logging (e.g., 'claude')
 * @param installerUrls - Platform-specific installer URLs
 * @param version - Version to install (e.g., '2.0.30', 'latest', 'stable', or undefined)
 * @param options - Installation options (timeout, env, etc.)
 * @returns Installation result with success status and installed version
 * @throws {AgentInstallationError} If installation fails
 *
 * @example
 * await installNativeAgent('claude', {
 *   macOS: 'https://claude.ai/install.sh',
 *   windows: 'https://claude.ai/install.ps1',
 *   linux: 'https://claude.ai/install.sh'
 * }, '2.0.30');
 */
export async function installNativeAgent(
	agentName: string,
	installerUrls: PlatformInstallerUrls,
	version?: string,
	options?: NativeInstallOptions
): Promise<NativeInstallResult> {
	const platform = detectPlatform();
	const timeout = options?.timeout || 300000; // 5 minute default timeout

	logger.debug('Starting native agent installation', {
		agentName,
		platform,
		version: version || 'latest',
	});

	try {
		// Build installer command
		const command = buildInstallerCommand(agentName, installerUrls, version, platform, options?.installFlags);

		logger.debug('Executing installer command', {
			agentName,
			platform,
			// Don't log full command (may contain sensitive URLs)
		});

		// Execute installer
		const result = await exec(command, [], {
			timeout,
			env: options?.env,
			shell: true, // Required for piped commands (curl | bash)
		});

		// Check if installation succeeded
		if (result.code !== 0) {
			// SECURITY: Sanitize output before including in error message
			// Installer scripts might echo sensitive environment variables
			const sanitizedOutput = sanitizeValue(result.stderr || result.stdout);
			throw new AgentInstallationError(
				agentName,
				`Installer exited with code ${result.code}. Output: ${sanitizedOutput}`
			);
		}

		logger.debug('Installer completed successfully', {
			agentName,
			platform,
		});

		// WINDOWS-SPECIFIC: Auto-fix PATH before verification
		// Use ensureCommandInPath to automatically add command to PATH if missing
		if (platform === 'windows' && options?.verifyCommand) {
			logger.debug('Ensuring command is in Windows PATH', {
				command: options.verifyCommand,
			});

			try {
				const pathResult = await ensureCommandInPath(options.verifyCommand);

				if (pathResult.success) {
					if (pathResult.alreadyInPath) {
						logger.debug('Command directory already in PATH', {
							directory: pathResult.pathAdded,
						});
					} else if (pathResult.pathAdded) {
						logger.success(
							`Automatically added ${options.verifyCommand} to PATH: ${pathResult.pathAdded}`,
						);
						logger.info(
							'PATH updated. Please restart your terminal for changes to take effect.',
						);
					}
				} else if (pathResult.error) {
					// PATH fix failed, but installation succeeded
					// Log warning but don't fail installation
					logger.warn('Could not automatically update PATH', {
						error: pathResult.error,
					});
					logger.info(
						`You may need to manually add ${options.verifyCommand} to your PATH.`,
					);
				}
			} catch (error) {
				// PATH utilities failed, but don't fail installation
				logger.debug('ensureCommandInPath failed', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Verify installation if verify command provided
		let installedVersion: string | null = null;
		if (options?.verifyCommand) {
			logger.debug('Verifying installation', {
				agentName,
				verifyCommand: options.verifyCommand,
			});

			installedVersion = await verifyInstallation(options.verifyCommand);

			if (!installedVersion) {
				// Add platform-specific context for troubleshooting
				const isWindows = platform === 'windows';
				const troubleshootingHint = isWindows
					? 'Restart your terminal to refresh PATH. The installation directory was automatically added to your PATH.'
					: 'Verify that the command is in your PATH.';

				logger.warn('Installation verification failed', {
					agentName,
					verifyCommand: options.verifyCommand,
					platform,
					hint: troubleshootingHint,
				});
			} else {
				logger.debug('Installation verified', {
					agentName,
					installedVersion,
				});
			}
		}

		// SECURITY: Sanitize output before returning
		// Prevents exposure of sensitive data in logs or UI
		const sanitizedOutput = sanitizeValue(result.stdout || result.stderr || '');

		return {
			success: true,
			installedVersion,
			output: sanitizedOutput as string,
		};
	} catch (error) {
		// If it's already an AgentInstallationError, rethrow
		if (error instanceof AgentInstallationError) {
			throw error;
		}

		// Wrap other errors
		throw new AgentInstallationError(
			agentName,
			`Failed to install: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}
