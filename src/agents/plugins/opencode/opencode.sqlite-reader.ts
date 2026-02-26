/**
 * OpenCode SQLite Reader
 *
 * Reads session/message/part data from OpenCode's SQLite database (opencode.db)
 * using the system `sqlite3` CLI with `-json` output.
 *
 * OpenCode migrated from file-based storage (JSON in storage/session/, storage/message/,
 * storage/part/) to SQLite. This module provides read access to the new format without
 * adding any npm dependencies — it shells out to the pre-installed sqlite3 CLI.
 *
 * Usage: Called once at session end (not performance-critical).
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { commandExists } from '../../../utils/processes.js';
import { exec } from '../../../utils/exec.js';
import { logger } from '../../../utils/logger.js';
import type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeUserMessage,
  OpenCodeAssistantMessage,
  OpenCodePart,
} from './opencode-message-types.js';

/**
 * Check if the sqlite3 CLI is available on this system.
 */
export async function isSqliteAvailable(): Promise<boolean> {
  return commandExists('sqlite3');
}

/**
 * Get the path to opencode.db given a storage path.
 *
 * OpenCode's DB lives one level above storage/:
 *   ~/.codemie/opencode-storage/opencode/opencode.db
 *   ~/.codemie/opencode-storage/opencode/storage/  (storagePath)
 *
 * @param storagePath - The storage/ directory path
 * @returns Path to opencode.db, or null if not found
 */
export function getDbPathFromStorage(storagePath: string): string | null {
  const dbPath = join(dirname(storagePath), 'opencode.db');
  return existsSync(dbPath) ? dbPath : null;
}

/**
 * Execute a read-only SQLite query and return parsed JSON rows.
 *
 * @param dbPath - Path to the SQLite database
 * @param sql - SQL query to execute
 * @returns Parsed rows as an array of objects
 */
async function queryDb<T>(dbPath: string, sql: string): Promise<T[]> {
  try {
    const result = await exec('sqlite3', ['-json', '-readonly', dbPath, sql], {
      timeout: 10_000,
    });

    if (result.code !== 0) {
      logger.debug(`[sqlite-reader] sqlite3 exited with code ${result.code}: ${result.stderr}`);
      return [];
    }

    const output = result.stdout.trim();
    if (!output || output === '[]') {
      return [];
    }

    return JSON.parse(output) as T[];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug(`[sqlite-reader] Query failed: ${msg}`);
    return [];
  }
}

/**
 * Raw row shape from the `session` table.
 * OpenCode uses normalized columns (no JSON `data` blob for sessions).
 */
interface SessionRow {
  id: string;
  project_id: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  time_updated: number;
}

/**
 * Raw row shape from the `message` table.
 */
interface MessageRow {
  id: string;
  session_id: string;
  data: string; // JSON blob
}

/**
 * Raw row shape from the `part` table.
 */
interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  data: string; // JSON blob
}

/**
 * Read sessions from the SQLite database.
 *
 * @param dbPath - Path to opencode.db
 * @param options - Optional filtering (maxAgeDays, cwd)
 * @returns Array of OpenCodeSession objects
 */
export async function readSessionsFromDb(
  dbPath: string,
  options?: { maxAgeDays?: number; cwd?: string }
): Promise<OpenCodeSession[]> {
  const rows = await queryDb<SessionRow>(
    dbPath,
    `SELECT id, project_id, slug, directory, title, version, time_created, time_updated FROM session ORDER BY time_created DESC`
  );

  const sessions: OpenCodeSession[] = [];
  const maxAgeMs = (options?.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const normalizedCwd = options?.cwd?.replace(/\/+$/, '');

  for (const row of rows) {
    const session: OpenCodeSession = {
      id: row.id,
      title: row.title,
      directory: row.directory || '',
      time: {
        created: row.time_created ?? 0,
        updated: row.time_updated ?? 0,
      },
      projectID: row.project_id,
      slug: row.slug,
      version: row.version,
    };

    // Apply age filter
    if (session.time.created && session.time.created < cutoff) {
      continue;
    }

    // Apply cwd filter
    if (normalizedCwd && session.directory) {
      const normalizedDir = session.directory.replace(/\/+$/, '');
      if (normalizedDir !== normalizedCwd) {
        continue;
      }
    }

    sessions.push(session);
  }

  return sessions;
}

/**
 * Escape a string for safe use in SQL single-quoted literals.
 */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Read messages for a session from the SQLite database.
 *
 * @param dbPath - Path to opencode.db
 * @param sessionId - The OpenCode session ID
 * @returns Array of OpenCodeMessage objects sorted by creation time
 */
export async function readMessagesFromDb(
  dbPath: string,
  sessionId: string
): Promise<OpenCodeMessage[]> {
  const escapedId = escapeSqlString(sessionId);
  const rows = await queryDb<MessageRow>(
    dbPath,
    `SELECT id, session_id, data FROM message WHERE session_id = '${escapedId}'`
  );

  const messages: OpenCodeMessage[] = [];

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      const role = data.role as string;

      const base = {
        id: row.id,
        sessionID: row.session_id,
        time: {
          created: (data.time as any)?.created ?? 0,
        },
      };

      if (role === 'assistant') {
        const msg: OpenCodeAssistantMessage = {
          ...base,
          role: 'assistant',
          providerID: data.providerID as string | undefined,
          modelID: data.modelID as string | undefined,
          path: data.path as string[] | undefined,
          tokens: data.tokens as OpenCodeAssistantMessage['tokens'],
          cost: data.cost as number | undefined,
          agent: data.agent as string | undefined,
        };
        messages.push(msg);
      } else {
        const msg: OpenCodeUserMessage = {
          ...base,
          role: 'user',
          agent: data.agent as string | undefined,
          model: data.model as OpenCodeUserMessage['model'],
        };
        messages.push(msg);
      }
    } catch {
      logger.debug(`[sqlite-reader] Failed to parse message row: ${row.id}`);
    }
  }

  // Sort by creation time
  return messages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
}

/**
 * Read all parts for a session from the SQLite database, grouped by message ID.
 *
 * Does a single bulk query for all parts in the session, then groups by message_id.
 * This is more efficient than querying per-message.
 *
 * @param dbPath - Path to opencode.db
 * @param sessionId - The OpenCode session ID
 * @returns Map of messageId -> OpenCodePart[]
 */
export async function readAllPartsForSessionFromDb(
  dbPath: string,
  sessionId: string
): Promise<Record<string, OpenCodePart[]>> {
  const escapedId = escapeSqlString(sessionId);
  const rows = await queryDb<PartRow>(
    dbPath,
    `SELECT id, message_id, session_id, data FROM part WHERE session_id = '${escapedId}' ORDER BY id ASC`
  );

  const partsMap: Record<string, OpenCodePart[]> = {};

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;

      // Build the part by merging column values with parsed data
      const part = {
        ...data,
        id: row.id,
        messageID: row.message_id,
        sessionID: row.session_id,
      } as OpenCodePart;

      if (!partsMap[row.message_id]) {
        partsMap[row.message_id] = [];
      }
      partsMap[row.message_id].push(part);
    } catch {
      logger.debug(`[sqlite-reader] Failed to parse part row: ${row.id}`);
    }
  }

  return partsMap;
}
