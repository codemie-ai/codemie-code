/**
 * High-Level Process Utilities
 *
 * Command detection, npm package management, and git operations.
 * Built on top of the foundational exec utility.
 */

import { exec as childProcessExec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { logger } from './logger.js';
import { exec, type ExecOptions, type ExecResult } from './exec.js';

const execAsync = promisify(childProcessExec);

// ============================================================================
// Command Detection
// ============================================================================

/**
 * Check if a command is available in PATH
 *
 * @param command - Command name to check (e.g., 'npm', 'python', 'git')
 * @returns True if command exists, false otherwise
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    const isWindows = os.platform() === 'win32';
    // On Windows, use full path to where.exe to avoid shell: true deprecation (DEP0190)
    const whichCommand = isWindows ? 'C:\\Windows\\System32\\where.exe' : 'which';

    const result = await exec(whichCommand, [command]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Get the full path to a command
 *
 * @param command - Command name to locate
 * @returns Full path to command, or null if not found
 */
export async function getCommandPath(command: string): Promise<string | null> {
  try {
    const isWindows = os.platform() === 'win32';
    // On Windows, use full path to where.exe to avoid shell: true deprecation (DEP0190)
    const whichCommand = isWindows ? 'C:\\Windows\\System32\\where.exe' : 'which';

    const result = await exec(whichCommand, [command]);

    if (result.code === 0) {
      // On Windows, 'where' can return multiple paths, take the first one
      // Split by any line ending (\n, \r\n, or \r) for maximum compatibility
      // This handles Unix (\n), Windows (\r\n), and old Mac (\r) line endings
      const paths = result.stdout
        .split(/\r?\n|\r/)  // Split by \r\n, \n, or \r
        .map(p => p.trim())
        .filter(p => p);
      return paths[0] || null;
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// npm Package Management
// ============================================================================

/**
 * Base options for npm operations
 */
export interface NpmOptions {
  /** Working directory for npm command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Operation timeout in milliseconds */
  timeout?: number;
}

/**
 * Options for npm install operations
 */
export interface NpmInstallOptions extends NpmOptions {
  /** Package version (e.g., '1.0.0', 'latest') */
  version?: string;
}

/**
 * Options for npx run operations
 */
export interface NpxRunOptions extends NpmOptions {
  /** Enable interactive mode for user prompts */
  interactive?: boolean;
}

/**
 * Install a package globally via npm
 *
 * @param packageName - Package name to install (e.g., 'typescript')
 * @param options - Installation options
 * @throws {NpmError} If installation fails
 *
 * @example
 * ```typescript
 * // Install latest version
 * await installGlobal('typescript');
 *
 * // Install specific version
 * await installGlobal('typescript', { version: '5.0.0' });
 * ```
 */
export async function installGlobal(
  packageName: string,
  options: NpmInstallOptions = {}
): Promise<void> {
  const packageSpec = options.version ? `${packageName}@${options.version}` : packageName;
  const timeout = options.timeout ?? 120000; // 2 minutes default

  logger.info(`Installing ${packageSpec} globally...`);

  try {
    const isWindows = os.platform() === 'win32';
    const execOptions: ExecOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout,
      shell: isWindows // npm is a .cmd file on Windows
    };

    const result = await exec('npm', ['install', '-g', packageSpec], execOptions);

    if (result.code !== 0) {
      throw new Error(
        `npm install exited with code ${result.code}: ${result.stderr || result.stdout}`
      );
    }

    logger.success(`${packageSpec} installed successfully`);
  } catch (error: unknown) {
    const { parseNpmError } = await import('./errors.js');
    throw parseNpmError(error, `Failed to install ${packageSpec}`);
  }
}

/**
 * Uninstall a package globally via npm
 *
 * @param packageName - Package name to uninstall
 * @param options - Uninstallation options
 * @throws {NpmError} If uninstallation fails
 *
 * @example
 * ```typescript
 * await uninstallGlobal('typescript');
 * ```
 */
export async function uninstallGlobal(
  packageName: string,
  options: NpmOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 30000; // 30 seconds default

  logger.info(`Uninstalling ${packageName} globally...`);

  try {
    const isWindows = os.platform() === 'win32';
    const execOptions: ExecOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout,
      shell: isWindows // npm is a .cmd file on Windows
    };

    const result = await exec('npm', ['uninstall', '-g', packageName], execOptions);

    if (result.code !== 0) {
      throw new Error(
        `npm uninstall exited with code ${result.code}: ${result.stderr || result.stdout}`
      );
    }

    logger.success(`${packageName} uninstalled successfully`);
  } catch (error: unknown) {
    const { parseNpmError } = await import('./errors.js');
    throw parseNpmError(error, `Failed to uninstall ${packageName}`);
  }
}

/**
 * Check if a package is installed globally
 *
 * @param packageName - Package name to check
 * @param options - Check options
 * @returns True if package is installed globally, false otherwise
 *
 * @example
 * ```typescript
 * const isInstalled = await listGlobal('typescript');
 * if (isInstalled) {
 *   console.log('TypeScript is installed');
 * }
 * ```
 */
export async function listGlobal(
  packageName: string,
  options: NpmOptions = {}
): Promise<boolean> {
  const timeout = options.timeout ?? 5000; // 5 seconds default

  try {
    const isWindows = os.platform() === 'win32';
    const execOptions: ExecOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout,
      shell: isWindows // npm is a .cmd file on Windows
    };

    const result = await exec('npm', ['list', '-g', packageName], execOptions);
    // Exit code 0 = installed, 1 = not found, >1 = error
    return result.code === 0;
  } catch {
    // If exec throws, treat as not installed (unless it's a real error)
    return false;
  }
}

/**
 * Get npm version
 *
 * @param options - Version check options
 * @returns npm version string, or null if npm not found
 *
 * @example
 * ```typescript
 * const version = await getVersion();
 * if (version) {
 *   console.log(`npm version: ${version}`);
 * } else {
 *   console.log('npm not installed');
 * }
 * ```
 */
export async function getVersion(
  options: NpmOptions = {}
): Promise<string | null> {
  const timeout = options.timeout ?? 5000; // 5 seconds default

  try {
    const isWindows = os.platform() === 'win32';
    const execOptions: ExecOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout,
      shell: isWindows // npm is a .cmd file on Windows
    };

    const result = await exec('npm', ['--version'], execOptions);
    const match = result.stdout.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Get latest version of a package from npm registry
 *
 * @param packageName - Package name to check (e.g., '@anthropic-ai/claude-code')
 * @param options - Options including timeout
 * @returns Latest version string, or null if package not found
 *
 * @example
 * ```typescript
 * const latest = await getLatestVersion('@anthropic-ai/claude-code');
 * // Returns: '1.0.51' or null
 * ```
 */
export async function getLatestVersion(
  packageName: string,
  options: NpmOptions = {}
): Promise<string | null> {
  const timeout = options.timeout ?? 10000; // 10 seconds default

  try {
    const isWindows = os.platform() === 'win32';
    const execOptions: ExecOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout,
      shell: isWindows // npm is a .cmd file on Windows
    };

    const result = await exec('npm', ['view', packageName, 'version'], execOptions);

    if (result.code !== 0) {
      return null;
    }

    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run a command via npx
 *
 * @param command - Command to run (e.g., 'create-react-app')
 * @param args - Command arguments
 * @param options - Execution options
 * @throws {NpmError} If execution fails
 *
 * @example
 * ```typescript
 * // Run with interactive mode
 * await npxRun('create-react-app', ['my-app'], { interactive: true });
 *
 * // Run with custom timeout
 * await npxRun('eslint', ['src/'], { timeout: 60000 });
 * ```
 */
export async function npxRun(
  command: string,
  args: string[] = [],
  options: NpxRunOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 300000; // 5 minutes default (download + execution)

  logger.info(`Running npx ${command} ${args.join(' ')}...`);

  try {
    const isWindows = os.platform() === 'win32';
    const execOptions: ExecOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout,
      interactive: options.interactive,
      shell: isWindows // npx is a .cmd file on Windows
    };

    await exec('npx', [command, ...args], execOptions);
    logger.success(`npx ${command} completed successfully`);
  } catch (error: unknown) {
    const { parseNpmError } = await import('./errors.js');
    throw parseNpmError(error, `Failed to run npx ${command}`);
  }
}

// ============================================================================
// Git Operations
// ============================================================================

/**
 * Detect current git branch from working directory
 *
 * @param cwd - Working directory path
 * @returns Git branch name or undefined if not in a git repo
 */
export async function detectGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      timeout: 5000 // 5 second timeout
    });

    const branch = stdout.trim();

    // Handle detached HEAD state
    if (branch === 'HEAD') {
      logger.debug('[GitUtils] Detached HEAD state detected');
      return undefined;
    }

    logger.debug(`[GitUtils] Detected git branch: ${branch}`);
    return branch;
  } catch (error) {
    // Not a git repo or git command failed
    logger.debug('[GitUtils] Failed to detect git branch:', error);
    return undefined;
  }
}

// Re-export exec function and types for convenience
export { exec };
export type { ExecOptions, ExecResult };
