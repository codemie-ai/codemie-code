// src/agents/plugins/opencode/opencode.paths.ts
// FIXED: Use named imports per repo conventions
import { homedir } from 'os';
import { join, dirname, isAbsolute, resolve } from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { logger } from '../../../utils/logger.js';
import { exec } from '../../../utils/exec.js';

interface DbPathCacheEntry {
  path: string;
  expiresAt: number;
}

const dbPathCache = new Map<string, DbPathCacheEntry>();

/** Runtime inputs for resolving the same storage used by the launched agent. */
export interface OpenCodePathContext {
  /** Actual metadata CLI command; null means no binary is configured. */
  command?: string | null;
  /** Child environment overrides, without mutating the parent process. */
  env?: NodeJS.ProcessEnv;
  /** Explicit legacy/file storage data directory, used only as a fallback. */
  dataDir?: string;
}

/**
 * Storage layout detection result
 * Per tech spec ADR-2
 */
export interface StorageLayoutResult {
  layout: 'post-migration' | 'legacy' | 'mixed' | 'sqlite' | 'unknown';
  migrationVersion: number;
  postMigrationPath?: string;
  legacyPaths?: string[];  // Multiple project directories possible
  dbPath?: string;          // Path to opencode.db when layout is 'sqlite'
}

/**
 * Detect OpenCode storage layout (post-migration vs legacy)
 *
 * Per tech spec ADR-2:
 * - Post-migration: storage/session/, storage/message/, storage/part/
 * - Legacy: project/{projectDir}/storage/session/info/
 * - Migration file: plain text numeric version (not JSON)
 */
export async function detectStorageLayout(
  storagePath: string,
  context: OpenCodePathContext = {},
): Promise<StorageLayoutResult> {
  let migrationVersion = 0;

  // Check migration file (numeric string, not just presence)
  const migrationFile = join(storagePath, 'migration');
  if (existsSync(migrationFile)) {
    try {
      const content = await readFile(migrationFile, 'utf-8');
      migrationVersion = parseInt(content.trim(), 10) || 0;
    } catch {
      migrationVersion = 0;
    }
  }

  // Post-migration structure check
  const hasPostMigration = (
    existsSync(join(storagePath, 'session')) &&
    existsSync(join(storagePath, 'message')) &&
    existsSync(join(storagePath, 'part'))
  );

  // Query the binary for the channel-specific path; do not infer the channel
  // from whichever database happens to be newest in this directory.
  const dbPath = await resolveOpenCodeDbPath(dirname(storagePath), context);
  const hasSqlite = dbPath !== ':memory:' && existsSync(dbPath);

  // Legacy structure check (project directories above storage/)
  const dataDir = dirname(storagePath);  // Goes up to ~/.local/share/opencode/
  const projectDir = join(dataDir, 'project');
  const hasLegacy = existsSync(projectDir);

  // Determine layout
  // SQLite takes priority when file-based dirs are absent
  if (migrationVersion >= 1 && hasPostMigration) {
    return { layout: 'post-migration', migrationVersion, postMigrationPath: storagePath, ...(hasSqlite && { dbPath }) };
  }
  if (hasPostMigration && hasLegacy) {
    return { layout: 'mixed', migrationVersion, postMigrationPath: storagePath, legacyPaths: [projectDir], ...(hasSqlite && { dbPath }) };
  }
  if (hasPostMigration) {
    return { layout: 'post-migration', migrationVersion, postMigrationPath: storagePath, ...(hasSqlite && { dbPath }) };
  }
  if (hasSqlite && !hasPostMigration) {
    return { layout: 'sqlite', migrationVersion, dbPath };
  }
  if (hasLegacy) {
    return { layout: 'legacy', migrationVersion, legacyPaths: [projectDir] };
  }

  return { layout: 'unknown', migrationVersion };
}

/**
 * Get OpenCode storage root path based on platform
 *
 * Legacy/file-backed fallback locations (not authoritative for OpenCode v2):
 * - Linux/WSL: ~/.local/share/opencode/storage/
 * - macOS: ~/Library/Application Support/opencode/storage/
 * - Windows: %LOCALAPPDATA%/opencode/storage/
 *
 * Priority order:
 * 1. OPENCODE_STORAGE_PATH (explicit override)
 * 2. XDG_DATA_HOME (standard XDG convention)
 * 3. Platform-specific defaults
 *
 * @returns Path to storage root directory or null if not found
 */
export function getOpenCodeStoragePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  let storagePath: string;

  // Priority 0: Custom storage path override (most explicit)
  if (env.OPENCODE_STORAGE_PATH) {
    const customPath = env.OPENCODE_STORAGE_PATH;
    logger.debug(`[opencode-paths] Using OPENCODE_STORAGE_PATH: ${customPath}`);
    return existsSync(customPath) ? customPath : null;
  }

  // Priority 1: XDG_DATA_HOME (standard XDG convention)
  if (env.XDG_DATA_HOME) {
    storagePath = join(env.XDG_DATA_HOME, 'opencode', 'storage');
  } else {
    // Priority 2: Platform-specific defaults
    switch (process.platform) {
      case 'darwin':  // macOS
        storagePath = join(home, 'Library', 'Application Support', 'opencode', 'storage');
        break;
      case 'win32': { // Native Windows (WSL reports 'linux')
        const appData = env.LOCALAPPDATA;
        storagePath = appData
          ? join(appData, 'opencode', 'storage')
          : join(home, '.local', 'share', 'opencode', 'storage');
        break;
      }
      default:        // Linux, WSL, other Unix
        storagePath = join(home, '.local', 'share', 'opencode', 'storage');
    }
  }

  // Return null if path doesn't exist (don't create directories)
  if (!existsSync(storagePath)) {
    return null;
  }
  return storagePath;
}

/**
 * Get the legacy fallback data directory (parent of `storage/` and `opencode.db`).
 * A successful binary path probe is authoritative for v2, whose defaults differ.
 *
 * Unlike getOpenCodeStoragePath() this never gates on existence: a SQLite-only
 * install has no `storage/` subdirectory at all, so gating there would make the
 * database undiscoverable.
 *
 * Priority mirrors getOpenCodeStoragePath():
 * 1. dirname(OPENCODE_STORAGE_PATH)
 * 2. XDG_DATA_HOME/opencode
 * 3. Platform-specific defaults
 */
export function getOpenCodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();

  if (env.OPENCODE_STORAGE_PATH) {
    return dirname(resolve(env.OPENCODE_STORAGE_PATH));
  }

  if (env.XDG_DATA_HOME) {
    return join(env.XDG_DATA_HOME, 'opencode');
  }

  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'opencode');
    case 'win32': {
      const appData = env.LOCALAPPDATA;
      return appData
        ? join(appData, 'opencode')
        : join(home, '.local', 'share', 'opencode');
    }
    default:
      return join(home, '.local', 'share', 'opencode');
  }
}

/**
 * Get OpenCode sessions directory path
 * Sessions are stored at: storage/session/{projectID}/{sessionID}.json
 *
 * @returns Path to sessions directory or null if storage not found
 */
export function getOpenCodeSessionsPath(
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): string | null {
  const storagePath = dataDir ? join(dataDir, 'storage') : getOpenCodeStoragePath(env);
  if (!storagePath) return null;
  const sessionsPath = join(storagePath, 'session');
  return existsSync(sessionsPath) ? sessionsPath : null;
}

/**
 * Get OpenCode messages directory path
 * Messages are stored at: storage/message/{sessionID}/{messageID}.json
 *
 * @returns Path to messages directory or null if storage not found
 */
export function getOpenCodeMessagesPath(): string | null {
  const storagePath = getOpenCodeStoragePath();
  if (!storagePath) return null;
  const messagesPath = join(storagePath, 'message');
  return existsSync(messagesPath) ? messagesPath : null;
}

/**
 * Get OpenCode parts directory path
 * Parts are stored at: storage/part/{messageID}/{partID}.json
 *
 * @returns Path to parts directory or null if storage not found
 */
export function getOpenCodePartsPath(): string | null {
  const storagePath = getOpenCodeStoragePath();
  if (!storagePath) return null;
  const partsPath = join(storagePath, 'part');
  return existsSync(partsPath) ? partsPath : null;
}

/**
 * Get OpenCode home directory (~/.opencode)
 */
export function getOpenCodeHome(): string {
  return join(homedir(), '.opencode');
}

/**
 * Get OpenCode config directory
 */
export function getOpenCodeConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  return join(homedir(), '.config', 'opencode');
}

/**
 * Get path to OpenCode's SQLite database (opencode.db)
 *
 * The DB is a sibling of the storage/ directory:
 *   ~/.local/share/opencode/opencode.db
 *
 * The actual binary/environment selects the path, with a legacy fallback that
 * does not require storage/ to exist. SQLite-only installs remain discoverable.
 *
 * @returns Path to opencode.db or null if not found
 */
export async function getOpenCodeDbPath(context: OpenCodePathContext = {}): Promise<string | null> {
  const dbPath = await resolveOpenCodeDbPath(context.dataDir, context);
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    logger.debug(`[opencode-paths] Found SQLite DB: ${dbPath}`);
    return dbPath;
  }
  return null;
}

/**
 * Resolve the database selected by OpenCode, even before its first write.
 * `debug paths db` does not start a server or open the database. The release
 * channel is compiled into the binary, so it cannot be inferred from Node env.
 * The probe receives the actual command/environment, never a fabricated XDG root.
 * Explicit absolute OPENCODE_DB and :memory: are independent of the data root;
 * relative overrides go through the binary so v2 resolves them under its own root.
 * The optional dataDir controls legacy fallback only, not the probe environment.
 */
export async function resolveOpenCodeDbPath(
  dataDir?: string,
  context: OpenCodePathContext = {},
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...context.env };
  const command = context.command !== undefined
    ? context.command
    : env.CODEMIE_OPENCODE_BIN || 'opencode';
  const override = env.OPENCODE_DB;
  if (override === ':memory:') return override;
  if (override !== undefined && isAbsolute(override)) return resolve(override);

  const fallbackDataDir = getFallbackDataDir(env, dataDir ?? context.dataDir);
  const key = getDbPathCacheKey(command, env, fallbackDataDir);
  const cached = dbPathCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.path;

  let dbPath = resolve(fallbackDataDir, override ?? 'opencode.db');
  let ttl = 30_000;
  try {
    if (!command) return dbPath;
    // Match the launcher's executable quoting for Windows .cmd shims/paths.
    // On POSIX, shell:false passes the command and argv without interpretation.
    const quotedCommand = process.platform === 'win32' &&
      /[ \t,;=()&|<>^%[\]{}]/.test(command) && !command.startsWith('"')
      ? `"${command}"`
      : command;
    const result = await exec(quotedCommand, ['debug', 'paths', 'db'], {
      timeout: 3000,
      shell: process.platform === 'win32',
      env,
    });
    const reported = result.stdout.trim();
    if (result.code === 0 && (reported === ':memory:' || isAbsolute(reported)) && !/[\r\n]/.test(reported)) {
      dbPath = reported;
      ttl = 5 * 60_000;
    } else {
      logger.debug('[opencode-paths] Database path probe unavailable; using fallback without verified channel selection');
    }
  } catch {
    logger.debug('[opencode-paths] Database path probe failed; using fallback without verified channel selection');
  }
  // Bound cache growth if a long-lived caller changes PATH/data directories.
  if (dbPathCache.size >= 32) dbPathCache.clear();
  dbPathCache.set(key, { path: dbPath, expiresAt: Date.now() + ttl });
  return dbPath;
}

/** A guessed legacy/v2 root must never be injected into the actual path probe. */
function getFallbackDataDir(env: NodeJS.ProcessEnv, dataDir?: string): string {
  if (dataDir !== undefined) return dataDir;
  if (env.CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION === 'v2') {
    const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
    return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
  }
  return getOpenCodeDataDir(env);
}

/** Isolate binary/root-dependent results without retaining credentials/config. */
function getDbPathCacheKey(command: string | null, env: NodeJS.ProcessEnv, dataDir: string): string {
  return JSON.stringify([
    command, process.cwd(), dataDir, env.PATH, env.Path,
    env.HOME, env.USERPROFILE, env.HOMEDRIVE, env.HOMEPATH,
    env.XDG_DATA_HOME, env.OPENCODE_STORAGE_PATH, env.OPENCODE_DB,
    env.OPENCODE_DISABLE_CHANNEL_DB, env.CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION,
  ]);
}

// Legacy alias for backward compatibility
/** @deprecated Use getOpenCodeStoragePath() instead */
export const getSessionStoragePath = getOpenCodeStoragePath;
