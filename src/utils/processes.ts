/**
 * High-Level Process Utilities
 *
 * Command detection, npm package management, and git operations.
 * Built on top of the foundational exec utility.
 */

import { exec as childProcessExec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { logger } from './logger.js';
import { exec, type ExecOptions, type ExecResult } from './exec.js';
import { extractRepository } from './paths.js';
import { getNpmPrefixArgs } from '@/utils/npm-prefix.js';

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

    // `$PATH:` stops where.exe from searching the cwd first (a repo-local shim would win).
    const result = await exec(whichCommand, [isWindows ? `$PATH:${command}` : command]);
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

    // `$PATH:` stops where.exe from searching the cwd first (a repo-local shim would win).
    const result = await exec(whichCommand, [isWindows ? `$PATH:${command}` : command]);

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
  /** Force install (useful for updates where directory conflicts occur) */
  force?: boolean;
}

/**
 * Options for npx run operations
 */
export interface NpxRunOptions extends NpmOptions {
  /** Enable interactive mode for user prompts */
  interactive?: boolean;
}

export interface DetachedSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'ignore' | 'inherit';
  windowsHide?: boolean;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function spawnDetached(
  command: string,
  args: string[] = [],
  options: DetachedSpawnOptions = {}
): number {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.stdio ?? 'ignore',
    windowsHide: options.windowsHide,
  });
  // A failed spawn emits 'error' on the next tick; unhandled, it crashes the process.
  // The caller learns of the failure from the missing pid (-1).
  child.on('error', (error) => {
    logger.debug(`[spawnDetached] Failed to spawn ${command}:`, error);
  });
  child.unref();
  return child.pid ?? -1;
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
  const timeout = options.timeout ?? 300000; // 5 minutes default

  logger.info(`Installing ${packageSpec} globally...`);

  try {
    const isWindows = os.platform() === 'win32';
    const execOptions: ExecOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout,
      shell: isWindows // npm is a .cmd file on Windows
    };

    const args = ['install', '-g', ...(await getNpmPrefixArgs())];
    if (options.force) {
      args.push('--force');
    }
    args.push(packageSpec);

    const result = await exec('npm', args, execOptions);

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

    const args = ['uninstall', '-g', ...(await getNpmPrefixArgs()), packageName];
    const result = await exec('npm', args, execOptions);

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

    const args = ['list', '-g', ...(await getNpmPrefixArgs()), packageName];
    const result = await exec('npm', args, execOptions);
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
 * Parse a git remote origin URL into a canonical, lower-cased repository identifier.
 * Supports HTTPS/SSH `scheme://` URLs, SCP-style and SSH-alias remotes (`user@host:path`,
 * `host:path`), and bare filesystem paths; strips Azure DevOps's `_git`/`v3` markers and a
 * Bitbucket Server `scm/` context-path prefix; preserves arbitrary-depth GitLab subgroups.
 *
 * @param remoteUrl - The raw remote URL, as returned by `git remote get-url origin`
 * @returns The repository identifier, or undefined if the URL carries no usable repository path
 */
function parseGitRemoteUrl(remoteUrl: string): string | undefined {
  const withoutGitSuffix = remoteUrl.replace(/[?#].*$/, '').replace(/\.git$/i, '');
  // The userinfo group `[^@/]+@` stops at the first unencoded '@' or '/'. Git requires those to
  // be percent-encoded in a URL, but if a caller's password contains one anyway, part of the
  // password (everything after that character) ends up read as host/path instead of being
  // dropped, e.g. "https://user:p@ss@host/org/repo" -> "ss@host/org/repo" rather than "org/repo".
  const urlMatch = withoutGitSuffix.match(/^(\w+):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  // SSH scp-style remotes come in two shapes: "user@host:path" and, for an `ssh_config` Host
  // alias with no explicit user (e.g. "github-work:org/repo.git"), bare "host:path". The alias
  // form requires a 2+ character host (so a single-letter Windows drive like "C:\..." is still
  // treated as a filesystem path) and forbids both "scheme://" and any '@' in the remainder, so
  // it never swallows a credential-bearing or scheme-qualified remote.
  const scpMatch =
    withoutGitSuffix.match(/^[^/@]+@([^:]+):(.+)$/) ??
    withoutGitSuffix.match(/^([^/@\\:]{2,}):(?!\/\/)([^@]+)$/);
  const match = urlMatch ?? scpMatch;

  // A scheme:// or user@host[:...] remote that did not match above (e.g. no repository path, or
  // no colon before the host) is not a filesystem path. Falling through to the bare-filesystem
  // handling below would split its userinfo/host into the result and leak credentials; bail out
  // instead. A real filesystem path essentially never contains '@', so that alone is sufficient
  // to catch every credential-bearing shape, including a bare "user:token@host" with no scheme
  // and no trailing ":path". `file://` is exempt since it carries no credentials.
  if (!match && (/^(?!file:)\w+:\/\//i.test(withoutGitSuffix) || withoutGitSuffix.includes('@'))) {
    return undefined;
  }

  // Bare filesystem remote (e.g. "/home/user/repo.git", "../repo.git"): neither the
  // scheme:// form nor the scp-style user@host: form applies, so there is no host and the
  // whole (suffix-stripped) string is the path to split on.
  const [scheme, host, path]: Array<string | undefined> = urlMatch
    ? [urlMatch[1], urlMatch[2], urlMatch[3]]
    : scpMatch
      ? [undefined, scpMatch[1], scpMatch[2]]
      : [undefined, undefined, withoutGitSuffix];
  const hostname = host?.replace(/:\d+$/, '').toLowerCase();

  // A matched URL/SCP remote uses POSIX-style '/' exclusively. An unmatched, bare-filesystem
  // remote may be a Windows absolute or UNC path, so split on either separator there, or it
  // would come out as one giant segment instead of being reduced to the last two.
  const segments = (path as string)
    .split(match ? '/' : /[/\\]/)
    .filter(Boolean)
    .map((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        // A decoded control character (e.g. %0D%0A, %00), any character outside Latin-1
        // (code > 0xFF — including the Unicode line/paragraph separators U+2028/U+2029), would
        // break a downstream HTTP header (Node's http.request only accepts Latin-1 header
        // values), a log line, or argv; keep the raw, still-encoded segment instead. Likewise, a
        // decoded '/' (from an encoded %2F) would silently introduce an extra path level once
        // segments are rejoined, letting two distinct remotes collide on the same derived name.
        const hasUnsafeChar =
          decoded.includes('/') ||
          Array.from(decoded).some((char) => {
            const code = char.codePointAt(0) ?? 0;
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code > 0xff;
          });
        return hasUnsafeChar ? segment : decoded;
      } catch {
        // Malformed %-escape: degrade to the raw segment rather than discarding the parse.
        return segment;
      }
    });

  const isAzureDevOps = hostname === 'dev.azure.com' || hostname === 'ssh.dev.azure.com';
  const isLegacyVsSsh = hostname === 'vs-ssh.visualstudio.com';
  const isLegacyVsHttps =
    !!hostname && hostname.endsWith('.visualstudio.com') && !isLegacyVsSsh;

  let result: string[];
  if (isAzureDevOps || isLegacyVsSsh) {
    result = segments.filter((segment, index) => segment !== '_git' && !(index === 0 && segment === 'v3'));
  } else if (isLegacyVsHttps) {
    // Organization lives in the hostname (org.visualstudio.com); casing is normalised by the final lower-casing.
    const org = (host as string).replace(/:\d+$/, '').split('.')[0];
    const rest = segments.filter(
      (segment, index) =>
        segment !== '_git' && !(index === 0 && segment.toLowerCase() === 'defaultcollection')
    );
    if (rest.length === 0) return undefined;
    result = [org, ...rest];
  } else {
    // Bitbucket Server/DC HTTPS clone URLs prefix the repository path with "scm/", which may
    // itself sit under a context path (e.g. "bitbucket/scm/PROJ/repo" for an install mounted at
    // "/bitbucket"). Strip up to the first "scm" segment that still has at least a project and a
    // repo segment after it, so both the context-path and root-mounted forms converge on
    // "PROJ/repo" the way the matching SSH remote already does. A GitLab group literally named
    // "scm" on an http(s) remote is a known, accepted false positive.
    const isHttpScheme = scheme?.toLowerCase() === 'http' || scheme?.toLowerCase() === 'https';
    const scmIndex = isHttpScheme
      ? segments.findIndex((segment, index) => segment === 'scm' && segments.length - index - 1 >= 2)
      : -1;
    result = scmIndex === -1 ? segments : segments.slice(scmIndex + 1);
  }

  // Bitbucket personal repositories use "~user" as the project key.
  if (result.length > 0 && result[0].length > 1 && result[0].startsWith('~')) {
    result = [result[0].slice(1), ...result.slice(1)];
  }

  // A lone "~" with nothing else is not a useful repository name.
  if (result.length === 1 && result[0] === '~') return undefined;

  if (result.length === 0) return undefined;

  // Best-effort fallback for the bare-filesystem shape: restore the prior behavior of
  // using only the last two path segments (owner/repo), rather than the full path.
  const joined = match ? result.join('/') : result.slice(-2).join('/');
  return joined ? joined.toLowerCase() : undefined;
}

/**
 * Detect the canonical repository identifier from a working directory's git `origin` remote.
 * Supports both HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git) formats.
 * Works with GitHub, GitLab, Bitbucket, Azure DevOps and self-hosted instances.
 *
 * @param cwd - Working directory path
 * @returns Repository in lower-cased "owner/repo" format (or a longer path for subgroups/Azure
 *   DevOps projects), or undefined if no remote is configured
 */
export async function detectGitRemoteRepo(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', { cwd, timeout: 5000, windowsHide: true });
    return parseGitRemoteUrl(stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * Canonical repository name for a working directory.
 *
 * Prefers the git `origin` remote (`owner/repo`) and falls back to deriving a name from the
 * path, which also maps Claude Desktop sandbox directories to `Cowork`. This is the same rule
 * the metrics client applies via `session.repository ?? extractRepository(workingDirectory)`,
 * so every client — CLI, Claude Desktop Code tab and Cowork — reports one folder identically.
 *
 * @param workingDirectory - Directory to identify
 * @returns Repository name; never empty
 */
export async function resolveRepositoryName(workingDirectory: string): Promise<string> {
  return (await detectGitRemoteRepo(workingDirectory)) ?? extractRepository(workingDirectory);
}

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
      timeout: 5000,
      windowsHide: true,
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

/**
 * Full SHA of the current HEAD commit.
 * Returns undefined when not in a git repo or when HEAD is unborn (no commits yet).
 */
export async function detectGitHeadSha(cwd: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000 });
    const sha = result.stdout.trim();
    if (result.code !== 0 || !sha) {
      logger.debug('[GitUtils] No HEAD commit detected');
      return undefined;
    }
    return sha;
  } catch (error) {
    logger.debug('[GitUtils] Failed to detect git HEAD sha:', error);
    return undefined;
  }
}

/** One commit's metadata — sha/time/counts only, never diff content. */
export interface GitCommitSummary {
  sha: string;
  time: string;
  files: number;
  added: number;
  removed: number;
}

const GIT_LOG_RECORD_SEP = '\x1e';
const GIT_LOG_FIELD_SEP = '\x1f';

/** Parses `git log --numstat --format=<RS>%H<FS>%at` output into per-commit metadata. */
function parseGitLogNumstat(stdout: string): GitCommitSummary[] {
  const commits: GitCommitSummary[] = [];
  for (const block of stdout.split(GIT_LOG_RECORD_SEP)) {
    if (!block.trim()) continue;
    const lines = block.split('\n').filter((line) => line.length > 0);
    const [header, ...numstatLines] = lines;
    const [sha, authorTime] = (header ?? '').split(GIT_LOG_FIELD_SEP);
    if (!sha) continue;

    const authorTimeSeconds = Number(authorTime);
    const authorDate = new Date(authorTimeSeconds * 1000);
    const time =
      authorTime && Number.isFinite(authorTimeSeconds) && Number.isFinite(authorDate.getTime())
        ? authorDate.toISOString()
        : '';

    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of numstatLines) {
      const [addedRaw, removedRaw] = line.split('\t');
      if (addedRaw === undefined) continue;
      files += 1;
      const addedCount = Number.parseInt(addedRaw, 10);
      const removedCount = Number.parseInt(removedRaw, 10);
      if (Number.isFinite(addedCount)) added += addedCount;
      if (Number.isFinite(removedCount)) removed += removedCount;
    }
    commits.push({ sha, time, files, added, removed });
  }
  return commits;
}

/**
 * Commits whose author email exactly matches `authorEmail` since `sinceIso` on the current branch,
 * metadata only (sha, timestamp, file count, lines +/-) — never file paths or diff content.
 * Returns `[]` when not in a git repo, on any git failure, or when either input is empty.
 */
export async function detectGitCommitsByAuthor(
  cwd: string,
  sinceIso: string,
  authorEmail: string
): Promise<GitCommitSummary[]> {
  if (!cwd || !sinceIso || !authorEmail) {
    return [];
  }
  try {
    const result = await exec(
      'git',
      [
        'log',
        `--since=${sinceIso}`,
        '--fixed-strings',
        `--author=<${authorEmail}>`,
        '--numstat',
        `--format=${GIT_LOG_RECORD_SEP}%H${GIT_LOG_FIELD_SEP}%at`,
      ],
      { cwd, timeout: 10000 }
    );
    if (result.code !== 0) {
      return [];
    }
    return parseGitLogNumstat(result.stdout);
  } catch (error) {
    logger.debug('[GitUtils] Failed to detect git commits by author:', error);
    return [];
  }
}

// Re-export exec function and types for convenience
export { exec };
export type { ExecOptions, ExecResult };
