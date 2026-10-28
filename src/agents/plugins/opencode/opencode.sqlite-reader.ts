/**
 * OpenCode SQLite Reader
 *
 * Reads session/message/part data from OpenCode's SQLite database (opencode.db).
 *
 * OpenCode migrated from file-based storage (JSON in storage/session/, storage/message/,
 * storage/part/) to SQLite. This module provides read access to the new format.
 *
 * OpenCode 2.x then rebuilt that schema: `session` became `session_v2`, `message`
 * became `session_message` (role moved into a `type` column, ordering into `seq`),
 * and the separate `part` table disappeared — parts are nested in the message row's
 * `data.content[]`. The database on disk may have been written by a different
 * OpenCode version than the binary currently on PATH (and `codemie opencode-metrics`
 * runs without launching the binary at all), so the layout is detected from the
 * database itself rather than from a version probe.
 *
 * Query strategy (in priority order):
 * 1. node:sqlite — Node.js built-in (22.5+, no external tools required)
 * 2. sqlite3 CLI — fallback for older Node.js versions
 *
 * Failures are reported, never silently turned into "no sessions": a read error
 * throws so callers can distinguish it from a genuinely empty database.
 *
 * Usage: Called once at session end (not performance-critical).
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { commandExists } from '../../../utils/processes.js';
import { exec } from '../../../utils/exec.js';
import { logger } from '../../../utils/logger.js';
import { AnalyticsSourceError } from '../../../utils/errors.js';
import { normalizePathSeparators } from '@/utils/paths.js';
import type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeUserMessage,
  OpenCodeAssistantMessage,
  OpenCodePart,
  OpenCodeToolPart,
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

/** One attempt at running a query: rows when it worked, a reason when it did not. */
interface QueryAttempt<T> {
  readonly rows: T[] | null;
  readonly reason?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrow an unknown JSON value to a plain record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Table names for one of the two known OpenCode database layouts.
 */
interface DbLayout {
  readonly version: 1 | 2;
  readonly sessions: string;
  readonly messages: string;
  /** v2 nests parts inside the message row, so there is no parts table. */
  readonly parts: string | null;
}

const V1_LAYOUT: DbLayout = { version: 1, sessions: 'session', messages: 'message', parts: 'part' };
const V2_LAYOUT: DbLayout = { version: 2, sessions: 'session_v2', messages: 'session_message', parts: null };

/**
 * Detected layouts, keyed by database path.
 *
 * Only a successful detection is cached: an unrecognized layout is re-checked on
 * the next call so a database created mid-process (first-ever OpenCode run) is
 * picked up rather than reported as unknown forever.
 */
const layoutCache = new Map<string, DbLayout>();

/**
 * Execute a read-only SQLite query using Node.js native node:sqlite (Node.js 22.5+).
 *
 * The database is opened READ-ONLY: codemie-opencode reads the user's live
 * ~/.local/share/opencode/opencode.db, which the plain `opencode` binary may be
 * writing to concurrently. Opening read-write risks lock contention and, worse,
 * WAL recovery writes into a database we do not own.
 */
async function queryDbViaNative<T>(
  dbPath: string,
  sql: string,
  params: SqlParam[]
): Promise<QueryAttempt<T>> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
      const stmt = db.prepare(sql);
      return { rows: stmt.all(...params) as unknown as T[] };
    } finally {
      db.close();
    }
  } catch (error) {
    // Reported, not swallowed: callers decide whether an unavailable backend or a
    // genuine query fault should surface to the user.
    return { rows: null, reason: errorMessage(error) };
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
 * Escape a string for safe use in SQL single-quoted literals.
 * Only needed for the sqlite3 CLI fallback, which cannot bind parameters.
 */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** sqlite3 CLI fallback, for Node.js versions without node:sqlite. */
async function queryDbViaCli<T>(
  dbPath: string,
  sql: string,
  params: SqlParam[]
): Promise<QueryAttempt<T>> {
  try {
    const result = await exec('sqlite3', ['-json', '-readonly', dbPath, inlineParams(sql, params)], {
      timeout: 10_000,
    });

    if (result.code !== 0) {
      return { rows: null, reason: `sqlite3 exited with code ${result.code}: ${result.stderr?.trim() ?? ''}` };
    }

    const output = result.stdout.trim();
    if (!output || output === '[]') {
      return { rows: [] };
    }

    return { rows: JSON.parse(output) as T[] };
  } catch (error) {
    return { rows: null, reason: errorMessage(error) };
  }
}

/** Try node:sqlite first (no external tool required), then the sqlite3 CLI. */
async function attemptQuery<T>(
  dbPath: string,
  sql: string,
  params: SqlParam[] = []
): Promise<QueryAttempt<T>> {
  const native = await queryDbViaNative<T>(dbPath, sql, params);
  if (native.rows) {
    return native;
  }

  const cli = await queryDbViaCli<T>(dbPath, sql, params);
  if (cli.rows) {
    return cli;
  }

  return {
    rows: null,
    reason: `node:sqlite: ${native.reason ?? 'unavailable'}; sqlite3: ${cli.reason ?? 'unavailable'}`,
  };
}

/**
 * Execute a read-only SQLite query and return parsed JSON rows.
 *
 * @throws {AnalyticsSourceError} when neither backend could run the query, so a
 *         broken read is never presented as an empty result.
 */
async function queryDb<T>(dbPath: string, sql: string, params: SqlParam[] = []): Promise<T[]> {
  const attempt = await attemptQuery<T>(dbPath, sql, params);
  if (attempt.rows) {
    return attempt.rows;
  }

  throw new AnalyticsSourceError(
    `[sqlite-reader] Query failed against ${dbPath}: ${attempt.reason ?? 'unknown error'}`
  );
}

/**
 * Detect which OpenCode database layout is on disk.
 *
 * One `sqlite_master` lookup, cached per database path. Layout is read from the
 * file rather than inferred from a binary version: the database may have been
 * written by a different OpenCode release than the one currently installed.
 *
 * @throws {AnalyticsSourceError} when the database is missing, unreadable, or has
 *         an unrecognized shape.
 */
async function detectDbLayout(dbPath: string): Promise<DbLayout> {
  const cached = layoutCache.get(dbPath);
  if (cached) {
    return cached;
  }

  if (!existsSync(dbPath)) {
    throw new AnalyticsSourceError(`[sqlite-reader] Database not found: ${dbPath}`);
  }

  const known = await attemptQuery<{ name: string }>(
    dbPath,
    `SELECT name FROM sqlite_master WHERE type = 'table' ` +
      `AND name IN ('session', 'session_v2', 'message', 'session_message', 'part')`
  );
  if (!known.rows) {
    throw new AnalyticsSourceError(
      `[sqlite-reader] Could not inspect database schema at ${dbPath}: ${known.reason ?? 'unknown error'}`
    );
  }

  const names = new Set(known.rows.map((row) => row.name));
  let layout: DbLayout | null = null;
  if (names.has('session_v2') || names.has('session_message')) {
    layout = V2_LAYOUT;
  } else if (names.has('session') || names.has('message') || names.has('part')) {
    layout = V1_LAYOUT;
  }

  if (!layout) {
    const all = await attemptQuery<{ name: string }>(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    );
    const tableList = all.rows?.map((row) => row.name).join(', ') ?? 'unknown';
    throw new AnalyticsSourceError(
      `[sqlite-reader] Unrecognized OpenCode database layout at ${dbPath} (tables: ${tableList})`
    );
  }

  layoutCache.set(dbPath, layout);
  logger.debug(
    `[sqlite-reader] Detected OpenCode v${layout.version} database layout ` +
      `(sessions: ${layout.sessions}, messages: ${layout.messages})`
  );
  return layout;
}

/**
 * Raw row shape from the session table (`session` in 1.x, `session_v2` in 2.x).
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
 * Raw row shape from the 1.x `message` table.
 */
interface MessageRow {
  id: string;
  session_id: string;
  data: string; // JSON blob
}

/**
 * Raw row shape from the 2.x `session_message` table: role lives in the `type`
 * column rather than in the JSON blob.
 */
interface SessionMessageRow {
  id: string;
  session_id: string;
  type: string;
  time_created: number;
  data: string; // JSON blob
}

/**
 * Raw row shape from the 1.x `part` table.
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
 * @param options - Optional filtering (sessionId, maxAgeDays, cwd, limit).
 *   An exact sessionId lookup ignores the age filter.
 * @returns Array of OpenCodeSession objects, newest first
 */
export async function readSessionsFromDb(
  dbPath: string,
  options?: { sessionId?: string; maxAgeDays?: number; cwd?: string; limit?: number }
): Promise<OpenCodeSession[]> {
  const layout = await detectDbLayout(dbPath);

  const maxAgeMs = (options?.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  // V2 persists Windows paths with '/', while cwd and filesystem consumers use
  // native separators. Gate by the DB layout, not the installed binary version.
  const isV2Windows = layout.version === 2 && process.platform === 'win32';
  const cwd = options?.cwd;
  const normalizedCwd = (isV2Windows && cwd ? normalizePathSeparators(cwd) : cwd)?.replace(/\/+$/, '');

  // Age limits apply to discovery, not explicit retrieval. Keep exact identity
  // in the parameterized SQL query so old sessions need no unbounded scan.
  const conditions: string[] = options?.sessionId
    ? ['id = ?']
    : ['(time_created IS NULL OR time_created >= ?)'];
  const params: SqlParam[] = [options?.sessionId ?? cutoff];

  if (normalizedCwd) {
    // OpenCode stores `directory` without a trailing separator; accept both forms.
    conditions.push('(directory = ? OR directory = ?)');
    params.push(normalizedCwd, `${normalizedCwd}/`);
  }

  // session_v2 carries every column 1.x had (plus cost/token counters), so the
  // projection is identical across layouts — only the table name differs.
  let sql =
    `SELECT id, project_id, slug, directory, title, version, time_created, time_updated ` +
    `FROM ${layout.sessions} WHERE ${conditions.join(' AND ')} ORDER BY time_created DESC`;

  if (options?.limit && options.limit > 0) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = await queryDb<SessionRow>(dbPath, sql, params);

  return rows.map((row) => {
    const directory = row.directory || '';
    return {
      id: row.id,
      title: row.title,
      // Match upstream fromDriver: leave POSIX/migrated paths and empty legacy
      // directories alone; convert only Windows drive/UNC storage paths.
      directory: isV2Windows && (/^[A-Za-z]:\//.test(directory) || directory.startsWith('//'))
        ? directory.replaceAll('/', '\\')
        : directory,
      time: {
        created: row.time_created ?? 0,
        updated: row.time_updated ?? 0,
      },
      projectID: row.project_id,
      slug: row.slug,
      version: row.version,
    };
  });
}

/** Tool execution states accepted by OpenCodeToolPart. */
const TOOL_STATUSES = ['pending', 'running', 'completed', 'error'] as const;

/**
 * Read the agent name from a 2.x user message, whose `data.agents[]` was empty in
 * the observed live data. Left unset rather than fabricated when the shape is not
 * a plain name.
 */
function readAgentName(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const first = value[0];
  if (typeof first === 'string') {
    return first;
  }
  if (first && typeof first === 'object') {
    const name = (first as Record<string, unknown>).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return undefined;
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
  const layout = await detectDbLayout(dbPath);
  const messages: OpenCodeMessage[] = [];

  if (layout.version === 1) {
    const rows = await queryDb<MessageRow>(
      dbPath,
      `SELECT id, session_id, data FROM ${layout.messages} WHERE session_id = ?`,
      [sessionId]
    );

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
  } else {
    // 2.x keeps role in the `type` column; the same column also carries
    // `idle`, `system`, `shell`, `synthetic`, `agent-switched` and
    // `model-switched` rows, which are not messages.
    const rows = await queryDb<SessionMessageRow>(
      dbPath,
      `SELECT id, session_id, type, time_created, data FROM ${layout.messages} ` +
        `WHERE session_id = ? ORDER BY seq ASC`,
      [sessionId]
    );

    for (const row of rows) {
      if (row.type !== 'user' && row.type !== 'assistant') {
        continue;
      }

      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        const time = data.time as { created?: number; completed?: number } | undefined;

        const base = {
          id: row.id,
          sessionID: row.session_id,
          time: {
            created: time?.created ?? row.time_created ?? 0,
            ...(typeof time?.completed === 'number' && { completed: time.completed }),
          },
        };

        if (row.type === 'assistant') {
          // 2.x nests the model as an object: {id, providerID, variant}.
          const model = data.model as { id?: string; providerID?: string } | undefined;
          const msg: OpenCodeAssistantMessage = {
            ...base,
            role: 'assistant',
            providerID: model?.providerID,
            modelID: model?.id,
            agent: typeof data.agent === 'string' ? data.agent : undefined,
            error: toOpenCodeAssistantError(data.error),
          };
          messages.push(msg);
        } else {
          // 2.x user rows carry `{time, text, files, agents[]}` — no model.
          const msg: OpenCodeUserMessage = {
            ...base,
            role: 'user',
            agent: readAgentName(data.agents),
          };
          messages.push(msg);
        }
      } catch {
        logger.debug(`[sqlite-reader] Failed to parse message row: ${row.id}`);
      }
    }
  }

  // Sort by creation time
  return messages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
}

/**
 * Translate the V2 structured failure into the contract used by error metrics.
 */
function toOpenCodeAssistantError(value: unknown): OpenCodeAssistantMessage['error'] {
  const error = asRecord(value);
  if (!error || typeof error.type !== 'string' || typeof error.message !== 'string') {
    return undefined;
  }
  return { name: error.type, data: { message: error.message } };
}

/**
 * Assemble the text output of a 2.x tool call.
 *
 * 2.x returns rendered output as a content list (`state.content[].text`) rather
 * than the single output string 1.x stored.
 */
function renderToolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => entry.text)
    .filter((text): text is string => typeof text === 'string');
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Convert one 2.x content entry into an OpenCode part.
 *
 * 2.x stores no per-part id, so a stable synthetic id is derived from the message
 * id and the entry index.
 */
function toOpenCodePart(
  entry: unknown,
  messageID: string,
  sessionID: string,
  index: number
): OpenCodePart | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const raw = entry as Record<string, unknown>;
  if (typeof raw.type !== 'string') {
    return null;
  }

  const id = `${messageID}:${index}`;

  if (raw.type === 'tool') {
    const state = asRecord(raw.state) ?? {};
    const status = TOOL_STATUSES.find((candidate) => candidate === state.status);
    const output = renderToolOutput(state.content);
    const input = asRecord(state.input);
    const metadata = asRecord(state.metadata);
    const time = asRecord(state.time);
    const error = typeof state.error === 'string' ? state.error : asRecord(state.error)?.message;

    const part: OpenCodeToolPart = {
      type: 'tool',
      id,
      messageID,
      sessionID,
      // 2.x names the call id `id` and the tool `name`; 1.x named them
      // `callID` and `tool`. `id` is already taken by the synthetic part id.
      callID: typeof raw.id === 'string' ? raw.id : id,
      tool: typeof raw.name === 'string' ? raw.name : 'unknown',
      state: {
        status: status ?? (raw.executed === true ? 'completed' : 'pending'),
        ...(input && { input }),
        ...(output !== undefined && { output }),
        ...(typeof error === 'string' && { error }),
        ...(typeof state.title === 'string' && { title: state.title }),
        ...(metadata && { metadata }),
        ...(time && { time: time as { start?: number; end?: number } }),
      },
    };
    return part;
  }

  // Unknown part types are passed through: the union already covers step-start,
  // step-finish, patch, file and reasoning, so a future OpenCode part type
  // degrades into a raw part rather than disappearing from the transcript.
  return { ...raw, id, messageID, sessionID } as OpenCodePart;
}

/**
 * Read all parts for a session from the SQLite database, grouped by message ID.
 *
 * On 1.x this is a single bulk query against the `part` table. On 2.x there is no
 * parts table: assistant parts come from `data.content[]`, while user text is
 * normalized into a text part from `data.text`.
 *
 * @param dbPath - Path to opencode.db
 * @param sessionId - The OpenCode session ID
 * @returns Map of messageId -> OpenCodePart[]
 */
export async function readAllPartsForSessionFromDb(
  dbPath: string,
  sessionId: string
): Promise<Record<string, OpenCodePart[]>> {
  const layout = await detectDbLayout(dbPath);
  const partsMap: Record<string, OpenCodePart[]> = {};

  if (layout.version === 1) {
    const rows = await queryDb<PartRow>(
      dbPath,
      `SELECT id, message_id, session_id, data FROM ${layout.parts} WHERE session_id = ? ORDER BY id ASC`,
      [sessionId]
    );

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

  const rows = await queryDb<SessionMessageRow>(
    dbPath,
    `SELECT id, session_id, type, time_created, data FROM ${layout.messages} ` +
      `WHERE session_id = ? ORDER BY seq ASC`,
    [sessionId]
  );

  for (const row of rows) {
    if (row.type !== 'user' && row.type !== 'assistant') {
      continue;
    }

    let content: unknown;
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      // User prompts are real text, not synthetic content to exclude downstream.
      // The generated part id is stable, but must not set a `synthetic` flag.
      content = row.type === 'user'
        ? (typeof data.text === 'string' ? [{ type: 'text', text: data.text }] : [])
        : data.content;
    } catch {
      logger.debug(`[sqlite-reader] Failed to parse message row: ${row.id}`);
      continue;
    }

    if (!Array.isArray(content) || content.length === 0) {
      continue;
    }

    const parts: OpenCodePart[] = [];
    content.forEach((entry, index) => {
      const part = toOpenCodePart(entry, row.id, row.session_id, index);
      if (part) {
        parts.push(part);
      }
    });

    if (parts.length > 0) {
      partsMap[row.id] = parts;
    }
  }

  return partsMap;
}
