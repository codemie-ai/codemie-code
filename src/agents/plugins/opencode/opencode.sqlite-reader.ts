/**
 * OpenCode SQLite Reader
 *
 * Reads session/message/part data from OpenCode's SQLite database (opencode.db).
 *
 * OpenCode migrated from file-based storage (JSON in storage/session/, storage/message/,
 * storage/part/) to SQLite. This module provides read access to the new format.
 *
 * Query strategy (in priority order):
 * 1. node:sqlite — Node.js built-in (22.5+, no external tools required)
 * 2. sqlite3 CLI — fallback for older Node.js versions
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
 * Check if SQLite reading is available on this system.
 *
 * Prefers node:sqlite (Node.js 22.5+, no external tools required).
 * Falls back to checking for the sqlite3 CLI binary.
 */
export async function isSqliteAvailable(): Promise<boolean> {
  // Try node:sqlite first (Node.js 22.5+, no external tools required)
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return typeof DatabaseSync === 'function';
  } catch {
    // node:sqlite not available (Node.js < 22.5)
  }
  // Fall back to sqlite3 CLI
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

/** Values accepted as bound SQL parameters. */
type SqlParam = string | number;

/**
 * Execute a read-only SQLite query using Node.js native node:sqlite (Node.js 22.5+).
 *
 * The database is opened READ-ONLY: codemie-opencode reads the user's live
 * ~/.local/share/opencode/opencode.db, which the plain `opencode` binary may be
 * writing to concurrently. Opening read-write risks lock contention and, worse,
 * WAL recovery writes into a database we do not own.
 *
 * @returns Parsed rows, or null if node:sqlite is unavailable or the query fails
 */
async function queryDbViaNative<T>(
  dbPath: string,
  sql: string,
  params: SqlParam[]
): Promise<T[] | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
      const stmt = db.prepare(sql);
      return stmt.all(...params) as unknown as T[];
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Inline bound parameters into a SQL string for the sqlite3 CLI fallback,
 * which has no parameter-binding interface.
 */
function inlineParams(sql: string, params: SqlParam[]): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    const value = params[index++];
    return typeof value === 'number' ? String(value) : `'${escapeSqlString(String(value))}'`;
  });
}

/**
 * Execute a read-only SQLite query and return parsed JSON rows.
 *
 * Tries node:sqlite first (Node.js 22.5+, no external tools required).
 * Falls back to the sqlite3 CLI if node:sqlite is unavailable.
 *
 * @param dbPath - Path to the SQLite database
 * @param sql - SQL query with `?` placeholders
 * @param params - Values bound to the placeholders
 * @returns Parsed rows as an array of objects
 */
async function queryDb<T>(dbPath: string, sql: string, params: SqlParam[] = []): Promise<T[]> {
  // Try native node:sqlite first (no external tool required)
  const nativeResult = await queryDbViaNative<T>(dbPath, sql, params);
  if (nativeResult !== null) {
    return nativeResult;
  }

  // Fallback to sqlite3 CLI
  try {
    const result = await exec('sqlite3', ['-json', '-readonly', dbPath, inlineParams(sql, params)], {
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
 * Age, directory and row-count predicates are pushed into SQL rather than
 * applied in JS: this query runs on every incremental-sync tick against the
 * user's live database, which can hold thousands of sessions across every
 * project they have ever opened.
 *
 * @param dbPath - Path to opencode.db
 * @param options - Optional filtering (maxAgeDays, cwd, limit)
 * @returns Array of OpenCodeSession objects, newest first
 */
export async function readSessionsFromDb(
  dbPath: string,
  options?: { maxAgeDays?: number; cwd?: string; limit?: number }
): Promise<OpenCodeSession[]> {
  const maxAgeMs = (options?.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const normalizedCwd = options?.cwd?.replace(/\/+$/, '');

  const conditions: string[] = ['(time_created IS NULL OR time_created >= ?)'];
  const params: SqlParam[] = [cutoff];

  if (normalizedCwd) {
    // OpenCode stores `directory` without a trailing separator; accept both forms.
    conditions.push('(directory = ? OR directory = ?)');
    params.push(normalizedCwd, `${normalizedCwd}/`);
  }

  let sql =
    `SELECT id, project_id, slug, directory, title, version, time_created, time_updated ` +
    `FROM session WHERE ${conditions.join(' AND ')} ORDER BY time_created DESC`;

  if (options?.limit && options.limit > 0) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = await queryDb<SessionRow>(dbPath, sql, params);

  return rows.map((row) => ({
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
  }));
}

/**
 * Escape a string for safe use in SQL single-quoted literals.
 * Only needed for the sqlite3 CLI fallback, which cannot bind parameters.
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
  const rows = await queryDb<MessageRow>(
    dbPath,
    `SELECT id, session_id, data FROM message WHERE session_id = ?`,
    [sessionId]
  );

  const messages: OpenCodeMessage[] = [];

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      const role = data.role as string;
      const time = data.time as { created?: number; completed?: number } | undefined;

      const base = {
        id: row.id,
        sessionID: row.session_id,
        time: {
          created: time?.created ?? 0,
          ...(typeof time?.completed === 'number' && { completed: time.completed }),
        },
      };

      if (role === 'assistant') {
        // NOTE: token/cost columns are deliberately NOT carried across.
        // codemie-claude sends no token or cost fields on any metric, and
        // codemie-opencode mirrors that exactly. See MetricDelta in
        // src/agents/core/metrics/types.ts.
        const msg: OpenCodeAssistantMessage = {
          ...base,
          role: 'assistant',
          providerID: data.providerID as string | undefined,
          modelID: data.modelID as string | undefined,
          path: data.path as string[] | undefined,
          agent: data.agent as string | undefined,
          error: data.error as OpenCodeAssistantMessage['error'],
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
  const rows = await queryDb<PartRow>(
    dbPath,
    `SELECT id, message_id, session_id, data FROM part WHERE session_id = ? ORDER BY id ASC`,
    [sessionId]
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
