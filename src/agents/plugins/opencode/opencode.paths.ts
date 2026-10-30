// src/agents/plugins/opencode/opencode.paths.ts
// FIXED: Use named imports per repo conventions
import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { logger } from '../../../utils/logger.js';
import { getCodemieHome } from '../../../utils/paths.js';

/**
 * The user's own XDG_DATA_HOME, read at load: a codemie-code launch later points this
 * process's XDG_DATA_HOME at its private storage.
 */
const USER_XDG_DATA_HOME = process.env.XDG_DATA_HOME;

/** The data home codemie-code's OpenCode runs use (their XDG_DATA_HOME). */
export function getOpenCodeStorageBase(): string {
  return join(getCodemieHome(), 'opencode-storage');
}

/**
 * The OpenCode storage dir (`…/opencode/storage`) an agent's runs write: codemie-code's private
 * data home, or — for opencode / opencode-acp — the user's XDG_DATA_HOME, else the platform default.
 */
export function getAgentOpenCodeStoragePath(agentName: string): string {
  if (agentName === 'codemie-code') {
    return join(getOpenCodeStorageBase(), 'opencode', 'storage');
  }
  return USER_XDG_DATA_HOME
    ? join(USER_XDG_DATA_HOME, 'opencode', 'storage')
    : join(platformOpenCodeDataDir(), 'storage');
}

function platformOpenCodeDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'opencode');
    case 'win32': {
      const appData = process.env.LOCALAPPDATA;
      return appData
        ? join(appData, 'opencode')
        : join(home, '.local', 'share', 'opencode');
    }
    default:
      return join(home, '.local', 'share', 'opencode');
  }
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
export async function detectStorageLayout(storagePath: string): Promise<StorageLayoutResult> {
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

  // SQLite check: opencode.db lives one level above storage/
  const dbPath = join(dirname(storagePath), 'opencode.db');
  const hasSqlite = existsSync(dbPath);

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
 * OpenCode uses XDG conventions for data storage:
 * - Linux/WSL: ~/.local/share/opencode/storage/
 * - macOS: ~/Library/Application Support/opencode/storage/
 * - Windows: %LOCALAPPDATA%/opencode/storage/
 *
 * Priority order:
 * 1. `storagePathOverride`, else OPENCODE_STORAGE_PATH (explicit override)
 * 2. XDG_DATA_HOME (standard XDG convention)
 * 3. Platform-specific defaults
 *
 * @returns Path to storage root directory or null if not found
 */
export function getOpenCodeStoragePath(storagePathOverride?: string): string | null {
  const home = homedir();
  let storagePath: string;

  // Priority 0: Custom storage path override (most explicit)
  const customPath = storagePathOverride ?? process.env.OPENCODE_STORAGE_PATH;
  if (customPath) {
    logger.debug(`[opencode-paths] Using OPENCODE_STORAGE_PATH: ${customPath}`);
    return existsSync(customPath) ? customPath : null;
  }

  // Priority 1: XDG_DATA_HOME (standard XDG convention)
  if (process.env.XDG_DATA_HOME) {
    storagePath = join(process.env.XDG_DATA_HOME, 'opencode', 'storage');
  } else {
    // Priority 2: Platform-specific defaults
    switch (process.platform) {
      case 'darwin':  // macOS
        storagePath = join(home, 'Library', 'Application Support', 'opencode', 'storage');
        break;
      case 'win32': { // Native Windows (WSL reports 'linux')
        const appData = process.env.LOCALAPPDATA;
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
 * Get OpenCode's data directory (the parent of both `storage/` and `opencode.db`).
 *
 * Unlike getOpenCodeStoragePath() this never gates on existence: a SQLite-only
 * install has no `storage/` subdirectory at all, so gating there would make the
 * database undiscoverable.
 *
 * Priority mirrors getOpenCodeStoragePath():
 * 1. dirname(`storagePathOverride`, else OPENCODE_STORAGE_PATH)
 * 2. XDG_DATA_HOME/opencode
 * 3. Platform-specific defaults
 */
export function getOpenCodeDataDir(storagePathOverride?: string): string {
  const customPath = storagePathOverride ?? process.env.OPENCODE_STORAGE_PATH;
  if (customPath) {
    return dirname(customPath);
  }

  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, 'opencode');
  }

  return platformOpenCodeDataDir();
}

/**
 * Get OpenCode sessions directory path
 * Sessions are stored at: storage/session/{projectID}/{sessionID}.json
 *
 * @returns Path to sessions directory or null if storage not found
 */
export function getOpenCodeSessionsPath(storagePathOverride?: string): string | null {
  const storagePath = getOpenCodeStoragePath(storagePathOverride);
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
 * Resolved via getOpenCodeDataDir() rather than getOpenCodeStoragePath() so a
 * SQLite-only install (no storage/ directory) is still discovered.
 *
 * @returns Path to opencode.db or null if not found
 */
export function getOpenCodeDbPath(storagePathOverride?: string): string | null {
  const dbPath = join(getOpenCodeDataDir(storagePathOverride), 'opencode.db');
  if (existsSync(dbPath)) {
    logger.debug(`[opencode-paths] Found SQLite DB: ${dbPath}`);
    return dbPath;
  }
  return null;
}

// Legacy alias for backward compatibility
/** @deprecated Use getOpenCodeStoragePath() instead */
export const getSessionStoragePath = getOpenCodeStoragePath;
