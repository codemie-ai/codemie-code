/**
 * Native installer utilities for platform-specific agent installation
 * Used for Claude Code native installation management
 */

import path from 'path';
import { rm } from 'fs/promises';
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
	windows: string; // Batch (.cmd) or PowerShell (.ps1) script URL
	linux: string; // Shell script URL
}

/**
 * Native installation options
 */
export interface NativeInstallOptions {
	timeout?: number; // Installation timeout (ms)
	env?: Record<string, string>; // Environment variables
	verifyCommand?: string; // Command to verify installation (e.g., 'claude')
	verifyPath?: string; // Full path to verify (e.g., '~/.local/bin/claude') - used instead of PATH-based verification
	installFlags?: string[]; // Additional flags to pass to installer (e.g., ['--force'])
	versionEnvVar?: string; // Env var used to pass a pinned version to a PowerShell installer (e.g., 'KIMI_VERSION')
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
export function buildInstallerCommand(
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
		// Windows batch command (.cmd installers; .ps1 installers use buildPowerShellInstallerArgs)
		// Download install.cmd, execute with args, then delete
		const versionArg = version ? ` ${version}` : '';
		const flagsArg = installFlags && installFlags.length > 0 ? ` ${installFlags.join(' ')}` : '';
		return `curl -fsSL ${url} -o install.cmd && install.cmd${versionArg}${flagsArg} && del install.cmd`;
		} else {
			// macOS/Linux shell script command
			const scriptArgs = [
				...(version ? [version] : []),
				...(installFlags || []),
			];
			const argsArg = scriptArgs.length > 0 ? ` -s -- ${scriptArgs.join(' ')}` : '';
			return `curl -fsSL ${url} | bash${argsArg}`;
		}
	}

/**
 * Whether a Windows installer URL points at a PowerShell script (.ps1)
 */
export function isPowerShellInstallerUrl(url: string): boolean {
	try {
		return new URL(url).pathname.toLowerCase().endsWith('.ps1');
	} catch {
		return false;
	}
}

/**
 * Build powershell.exe arguments that download and run a .ps1 installer in memory.
 * Emits [codemie-step:download] / [codemie-step:run] markers so failures can be attributed.
 */
export function buildPowerShellInstallerArgs(url: string): string[] {
	if (!url.startsWith('https://')) {
		throw new AgentInstallationError('installer', `Installer URL must use HTTPS: ${url}`);
	}
	if (url.includes("'")) {
		throw new AgentInstallationError('installer', 'Installer URL must not contain single quotes');
	}
	const script = [
		"$ErrorActionPreference='Stop'",
		`try { $s = irm '${url}' } catch { Write-Output "[codemie-step:download] $_"; exit 1 }`,
		'try { iex $s } catch { Write-Output "[codemie-step:run] $_"; exit 1 }',
		'exit 0',
	].join('; ');
	return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

/**
 * Build a step-aware error message for a failed Windows PowerShell installer run
 */
export function describeWindowsPowerShellFailure(output: string, code: number | null | undefined, url: string): string {
	const step = output.match(/\[codemie-step:(download|run)\]/)?.[1];
	if (step === 'download') {
		return `Failed to download the Kimi installer from ${url} (check network/proxy/TLS access to code.kimi.com)`;
	}
	if (step === 'run') {
		return (
			'Kimi installer script failed while running. kimi.exe may already be copied to ' +
			'%USERPROFILE%\\.kimi-code\\bin, a kimi.exe.bak backup may exist, and the user PATH may have been modified. ' +
			'To remove, delete that folder and its PATH entry, or restore the .bak. ' +
			`Output: ${sanitizeValue(output.trim())}`
		);
	}
	return `Installer exited with code ${code}. Output: ${sanitizeValue(output.trim())}`;
}

/**
 * Verify installation by running the verify command
 * On Windows, retries with backoff to allow PATH updates to propagate
 *
 * @param verifyCommand - Command to verify (e.g., 'claude' or '/path/to/claude')
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
			// If verifyCommand is a path, use shell to resolve ~ and execute
			const useShell = verifyCommand.includes('/') || verifyCommand.includes('\\');
			const result = await exec(verifyCommand, ['--version'], {
				timeout: 5000, // 5 second timeout for version check
				shell: useShell, // Use shell for path-based commands to resolve ~
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
 * Detect Windows PowerShell execution policy error in command output
 */
function isExecutionPolicyError(output: string): boolean {
	return /cannot be loaded because running scripts is disabled/i.test(output) ||
		/PSSecurityException|UnauthorizedAccess/i.test(output);
}

/**
 * Auto-fix Windows PowerShell execution policy for the current user.
 * Uses RemoteSigned scope — does not require admin rights.
 * Returns true if the fix was applied successfully.
 */
async function fixWindowsExecutionPolicy(): Promise<boolean> {
	try {
		const result = await exec(
			'powershell',
			['-Command', 'Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force'],
			{ timeout: 15000 }
		);
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * Detect if installer output contains HTML instead of expected script output
 * This occurs when the installer URL returns an HTML page (e.g., region block,
 * maintenance page) instead of the actual installer script. Bash then fails
 * trying to execute HTML as shell commands.
 *
 * @param output - Combined stdout/stderr from the installer process
 * @returns true if the output contains HTML markers
 */
function isHtmlInstallerResponse(output: string): boolean {
	return /<!DOCTYPE\s+html/i.test(output) || /<html[\s>]/i.test(output);
}

/**
 * Extract a user-friendly error message from HTML installer response
 * Checks for known error patterns (region block, service unavailability)
 * and returns an appropriate message.
 *
 * @param output - Combined stdout/stderr containing HTML content
 * @returns User-friendly error message
 */
function detectHtmlErrorMessage(output: string): string {
	// Check for region-specific unavailability
	if (/unavailable.*region|not.*available.*here|app.unavailable/i.test(output)) {
		return 'Claude Code is not available in your current region. Visit https://claude.ai for information about supported regions.';
	}

	// Generic HTML response (maintenance page, unexpected redirect, etc.)
	return 'Installer URL returned an HTML page instead of an installation script. The service may be temporarily unavailable or not accessible from your location. Visit https://claude.ai for more information.';
}

type ExecResult = Awaited<ReturnType<typeof exec>>;

/**
 * Run a Windows .ps1 installer through PowerShell (download + run, no cmd/shell piping)
 */
async function runPowerShellInstaller(
	agentName: string,
	url: string,
	version: string | undefined,
	timeout: number,
	env: Record<string, string> | undefined,
	versionEnvVar: string | undefined
): Promise<ExecResult> {
	if (!url.startsWith('https://')) {
		throw new AgentInstallationError(agentName, `Installer URL must use HTTPS: ${url}`);
	}
	const isPinnedVersion = !!version && !['latest', 'stable'].includes(version.toLowerCase());
	if (isPinnedVersion && !isValidSemanticVersion(version)) {
		throw new AgentInstallationError(
			agentName,
			`Invalid version format: "${version}". Expected semantic version (e.g., "2.0.30"), "latest", or "stable".`
		);
	}
	const psEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...env };
	if (versionEnvVar && isPinnedVersion) {
		psEnv[versionEnvVar] = version;
	}
	logger.debug('Executing PowerShell installer', {
		agentName,
		executable: 'powershell',
		steps: ['download', 'run'],
	});
	return exec('powershell', buildPowerShellInstallerArgs(url), { timeout, env: psEnv, shell: false });
}

/**
 * Run the platform's shell installer command (curl | bash, or install.cmd on Windows)
 */
async function runShellInstaller(
	agentName: string,
	installerUrls: PlatformInstallerUrls,
	version: string | undefined,
	platform: 'macOS' | 'windows' | 'linux',
	timeout: number,
	env: Record<string, string> | undefined,
	installFlags: string[] | undefined
): Promise<ExecResult> {
	const command = buildInstallerCommand(agentName, installerUrls, version, platform, installFlags);

	logger.debug('Executing installer command', {
		agentName,
		platform,
		// Don't log full command (may contain sensitive URLs)
	});

	try {
		let result = await exec(command, [], {
			timeout,
			env,
			shell: true, // Required for piped commands (curl | bash)
		});

		// Windows-specific: auto-fix PowerShell execution policy and retry once
		if (result.code !== 0 && platform === 'windows') {
			const combinedOutput = `${result.stderr || ''} ${result.stdout || ''}`;
			if (isExecutionPolicyError(combinedOutput)) {
				logger.info('PowerShell execution policy is blocking installation. Attempting auto-fix...');
				const fixed = await fixWindowsExecutionPolicy();
				if (fixed) {
					logger.info('Execution policy updated. Retrying installation...');
					result = await exec(command, [], { timeout, env, shell: true });
				} else {
					logger.warn('Could not update execution policy automatically. Manual fix required.');
				}
			}
		}
		return result;
	} finally {
		// The command string's trailing `del` is skipped when an earlier step fails
		if (platform === 'windows') {
			await rm(path.join(process.cwd(), 'install.cmd'), { force: true }).catch(() => undefined);
		}
	}
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
	const env = options?.env;

	logger.debug('Starting native agent installation', {
		agentName,
		platform,
		version: version || 'latest',
	});

	try {
		const windowsUrl = installerUrls.windows;
		const usePowerShell = platform === 'windows' && isPowerShellInstallerUrl(windowsUrl);
		const result = usePowerShell
			? await runPowerShellInstaller(agentName, windowsUrl, version, timeout, env, options?.versionEnvVar)
			: await runShellInstaller(agentName, installerUrls, version, platform, timeout, env, options?.installFlags);

		// Check if installation succeeded
		if (result.code !== 0) {
			const combinedOutput = `${result.stderr || ''} ${result.stdout || ''}`;

			if (usePowerShell) {
				throw new AgentInstallationError(
					agentName,
					isExecutionPolicyError(combinedOutput)
						? 'PowerShell execution policy is blocking the installer. Run this in PowerShell and retry: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser'
						: describeWindowsPowerShellFailure(combinedOutput, result.code, windowsUrl)
				);
			}

			// Detect HTML response instead of installer script
			// This happens when the service returns an error page (e.g., region block)
			// instead of the actual installer script, and bash fails trying to parse HTML
			if (isHtmlInstallerResponse(combinedOutput)) {
				throw new AgentInstallationError(
					agentName,
					detectHtmlErrorMessage(combinedOutput)
				);
			}

			// Execution policy error still present after attempted fix
			if (platform === 'windows' && isExecutionPolicyError(combinedOutput)) {
				throw new AgentInstallationError(
					agentName,
					'PowerShell execution policy is blocking the installer. Run this in PowerShell and retry: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser'
				);
			}

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
		if (options?.verifyCommand || options?.verifyPath) {
			// Prefer verifyPath (full path) over verifyCommand (PATH-based)
			// This avoids PATH refresh issues on macOS/Linux
			const commandToVerify = options?.verifyPath || options.verifyCommand!;

			logger.debug('Verifying installation', {
				agentName,
				verifyCommand: commandToVerify,
				usingFullPath: !!options?.verifyPath,
			});

			installedVersion = await verifyInstallation(commandToVerify);

			if (!installedVersion) {
				// Add platform-specific context for troubleshooting
				const isWindows = platform === 'windows';
				const troubleshootingHint = isWindows
					? 'Restart your terminal to refresh PATH. The installation directory was automatically added to your PATH.'
					: options?.verifyPath
						? `Binary exists at ${options.verifyPath} but failed to execute. Check permissions: chmod +x ${options.verifyPath}`
						: 'Verify that the command is in your PATH.';

				logger.warn('Installation verification failed', {
					agentName,
					verifyCommand: commandToVerify,
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

		// If verification was enabled and failed, mark installation as unsuccessful
		// This ensures that failed verifications are properly reported to the user
		const verificationEnabled = !!options?.verifyCommand;
		const verificationPassed = !!installedVersion;
		const installSuccess = verificationEnabled ? verificationPassed : true;

		return {
			success: installSuccess,
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
