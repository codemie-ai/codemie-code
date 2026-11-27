/**
 * Copilot CLI / Desktop `session-store.db` scanner.
 *
 * Reads only allowlisted columns of `assistant_usage_events`, plus `sessions.id/cwd/host_type`
 * for surface classification. `turns` text, `sessions.summary` and `session_files.file_path`
 * are never queried here: they are prompt-derived, and an analytics scan has no business
 * reading them.
 *
 * SQLite access is OPTIONAL by design. `node:sqlite` lands in Node 22.5 while this package
 * declares `engines.node >= 20`, so the import is guarded and an unavailable module degrades
 * the scan to zero rows with reason `sqlite_unavailable` — the caller then falls back to
 * `events.jsonl`, which covers every Desktop session anyway.
 *
 * The live store is locked and in WAL mode while Copilot runs, so it is never opened in
 * place: the file and its `-wal`/`-shm` siblings are copied to a temp directory first (the
 * copy-mode snapshot of the Python original, which deliberately avoids the SQLite backup API).
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { categoryOf, readClientName, resolveSurface } from './copilot-surfaces.js';
import { sessionStoreDb } from './copilot-local-paths.js';
import {
  emptyHealth,
  toCount,
  toInt,
  type CopilotScanReason,
  type CopilotScanResult,
  type CopilotUsageRow,
} from './types.js';

/** `assistant_usage_events` columns this scanner is allowed to read. */
const USAGE_COLUMNS = [
  'id',
  'session_id',
  'turn_index',
  'agent_id',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'total_nano_aiu',
  'request_multiplier',
  'duration_ms',
  'initiator',
  'created_at',
  // Copilot's own stable id for the usage event, and the one the hook-based `copilot-cli-otlp`
  // pipeline dedups on. Preferred over the autoincrement `id`, which is local to this store.
  'event_id',
  'content_filter_triggered',
  'finish_reason',
] as const;

/** Columns without which a row cannot be priced or placed in time. */
const REQUIRED_COLUMNS = [
  'session_id',
  'model',
  'input_tokens',
  'output_tokens',
  'created_at',
] as const;

/**
 * Schema versions this reader was written against; anything else is reported as drift.
 *
 * 10 is what current Copilot writes (verified against a real store, 2026-11-18); 8 is kept for
 * older installs. Listing only 8 made every current machine report drift.
 */
const KNOWN_SCHEMA_VERSIONS = new Set([8, 10]);

/** Minimal shape of the `node:sqlite` surface used here, so the guarded import stays typed. */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/**
 * `node:sqlite`, or undefined on a runtime without it.
 *
 * Node 20 has no such module; the dynamic import is the only way to ask without crashing the
 * whole analytics command at module-load time.
 *
 * KNOWN WART: Node prints `ExperimentalWarning: SQLite is an experimental feature` to stderr
 * the first time this module is used, so it lands in the middle of a report on a machine that
 * has a store to read. It cannot be filtered from here — the warning is emitted on a later
 * tick than any scoped `process.on('warning')` window, and a scoped listener never receives
 * it (verified). The fixes available are a run-level flag
 * (`NODE_OPTIONS=--disable-warning=ExperimentalWarning`, Node >= 21.3) or adding that flag at
 * the `bin/` entry point; both are out of this module's scope.
 */
async function loadSqlite(): Promise<SqliteModule | undefined> {
  try {
    return (await import('node:sqlite')) as unknown as SqliteModule;
  } catch {
    return undefined;
  }
}

/** A temp copy of the store and its WAL siblings, plus a disposer. */
interface StoreSnapshot {
  file: string;
  dispose(): void;
}

/**
 * Copy the store (and `-wal`/`-shm`, which hold writes not yet checkpointed into the main
 * file) into a private temp directory. Omitting the siblings yields a readable database that
 * is silently missing the most recent sessions.
 */
function snapshotStore(db: string): StoreSnapshot {
  const dir = mkdtempSync(join(tmpdir(), 'codemie-copilot-store-'));
  const file = join(dir, basename(db));
  copyFileSync(db, file);
  for (const suffix of ['-wal', '-shm']) {
    const sibling = `${db}${suffix}`;
    if (existsSync(sibling)) {
      try {
        copyFileSync(sibling, `${file}${suffix}`);
      } catch {
        // A sibling that vanished mid-copy means Copilot just checkpointed; the main
        // file is still consistent, so the snapshot stands.
      }
    }
  }
  return {
    file,
    dispose(): void {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp directory is harmless; never fail a report over cleanup.
      }
    },
  };
}

/** Column names of `table`, or an empty set when the table is absent. */
function columnsOf(db: SqliteDatabase, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    return new Set(rows.map((r) => String(r.name ?? '')));
  } catch {
    return new Set();
  }
}

/** The store's declared schema version, when it records one. */
function schemaVersion(db: SqliteDatabase): number | undefined {
  try {
    const rows = db.prepare('SELECT version FROM schema_version LIMIT 1').all() as Array<{ version?: unknown }>;
    const version = rows[0]?.version;
    return typeof version === 'number' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Epoch ms from the store's `created_at`, or undefined when it is unusable. */
function parseCreatedAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs milliseconds: anything below ~1e11 cannot be a modern ms timestamp.
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  // A naive timestamp from SQLite is UTC by Copilot's convention; make that explicit so the
  // host's local offset is not applied twice.
  const text = value.trim().replace(' ', 'T');
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * A row's status from what the store records about how the call ended.
 *
 * `finish_reason` is `tool_calls` or `stop` on a real store — both successful completions — so
 * the only failure signal available is the content filter. A filtered response is reported as
 * cancelled rather than error, matching how the VS Code reader treats `responseIsFiltered`.
 */
function statusOf(record: Record<string, unknown>): CopilotUsageRow['status'] {
  return toInt(record.content_filter_triggered) > 0 ? 'cancelled' : 'success';
}

/** `{ [field]: value }` when the column holds non-empty text, else nothing to spread. */
function textField<K extends string>(value: unknown, field: K): Partial<Record<K, string>> {
  return typeof value === 'string' && value ? ({ [field]: value } as Record<K, string>) : {};
}

/** How far back to scan, as an epoch-ms floor. */
function cutoffMs(maxAgeDays: number | undefined): number {
  return maxAgeDays === undefined ? 0 : Date.now() - maxAgeDays * 86_400_000;
}

export interface StoreScanOptions {
  /** Copilot home holding `session-store.db`. */
  home: string;
  maxAgeDays?: number;
  /** Set when the home lives inside a WSL distro; forces a `(WSL:<distro>)` surface. */
  wslDistro?: string;
  /** Sessions the desktop app owns, from its own `data.db`. */
  desktopSessionIds?: ReadonlySet<string>;
}

/**
 * Scan one Copilot home's `session-store.db`.
 *
 * Never throws: every failure is recorded as a closed {@link CopilotScanReason} and the scan
 * returns the rows it did manage to read.
 */
export async function scanSessionStore(opts: StoreScanOptions): Promise<CopilotScanResult> {
  const health = emptyHealth('copilot-cli-store');
  const rows: CopilotUsageRow[] = [];
  const coveredSessionIds = new Set<string>();
  const fail = (reason: CopilotScanReason, note: string): CopilotScanResult => {
    health.reasons.push(reason);
    health.notes.push(note);
    return { rows, health, coveredSessionIds };
  };

  const db = sessionStoreDb(opts.home);
  try {
    if (!statSync(db).isFile()) {
      return fail('no_store', 'session-store.db is not a file');
    }
  } catch {
    // Older Copilot builds keep only events.jsonl; an absent store is "no store", not an error.
    return fail('no_store', 'session-store.db absent');
  }
  health.filesSeen = 1;

  const sqlite = await loadSqlite();
  if (!sqlite) {
    return fail(
      'sqlite_unavailable',
      'node:sqlite unavailable (Node >= 22.5 required); falling back to events.jsonl'
    );
  }

  let snapshot: StoreSnapshot;
  try {
    snapshot = snapshotStore(db);
  } catch (error) {
    health.errors += 1;
    logger.debug('[copilot-local] store snapshot failed:', error);
    const reason: CopilotScanReason =
      (error as NodeJS.ErrnoException)?.code === 'EACCES' ? 'permission' : 'snapshot_failed';
    return fail(reason, 'session-store.db could not be copied for reading');
  }

  let connection: SqliteDatabase | undefined;
  try {
    connection = new sqlite.DatabaseSync(snapshot.file, { readOnly: true });

    const available = columnsOf(connection, 'assistant_usage_events');
    if (available.size === 0) {
      return fail('schema_drift', 'assistant_usage_events is absent');
    }
    const missingRequired = REQUIRED_COLUMNS.filter((c) => !available.has(c));
    if (missingRequired.length > 0) {
      return fail('schema_drift', `assistant_usage_events is missing ${missingRequired.length} required column(s)`);
    }
    const version = schemaVersion(connection);
    if (version !== undefined && !KNOWN_SCHEMA_VERSIONS.has(version)) {
      // Drift is reported, not fatal: the allowlisted columns are still read, because a
      // version bump that only adds columns must not silently zero a user's whole report.
      health.reasons.push('schema_drift');
      health.notes.push(`unknown session-store schema version ${version}`);
    }

    // Only the allowlisted columns that this store actually has, so one added or removed
    // column cannot fail the whole query.
    const selected = USAGE_COLUMNS.filter((c) => available.has(c));
    // `sessions` carries where the work happened. Reading only `cwd` left `--branch` unable to
    // match anything and `gitBranch` absent from every delta, even though both columns are
    // populated on a real store (52/96 sessions carry a branch).
    const sessionColumns = columnsOf(connection, 'sessions');
    const joined = (['cwd', 'repository', 'branch'] as const).filter((c) => sessionColumns.has(c));
    const joinSessions = sessionColumns.has('id') && joined.length > 0;
    const sql = joinSessions
      ? `SELECT ${selected.map((c) => `e.${c}`).join(', ')}, ${joined
          .map((c) => `s.${c} AS session_${c}`)
          .join(', ')}
         FROM assistant_usage_events e LEFT JOIN sessions s ON s.id = e.session_id`
      : `SELECT ${selected.join(', ')} FROM assistant_usage_events`;

    const records = connection.prepare(sql).all() as Array<Record<string, unknown>>;
    const floor = cutoffMs(opts.maxAgeDays);
    // One workspace.yaml read per session, not per row: a long session has hundreds of rows.
    const clientNames = new Map<string, string | undefined>();

    for (const record of records) {
      const sessionId = typeof record.session_id === 'string' ? record.session_id : '';
      const tsMs = parseCreatedAt(record.created_at);
      if (!sessionId || tsMs === undefined) {
        health.rowsSkipped += 1;
        continue;
      }
      if (tsMs < floor) {
        health.rowsSkipped += 1;
        continue;
      }
      if (!clientNames.has(sessionId)) {
        clientNames.set(sessionId, await readClientName(opts.home, sessionId, opts.wslDistro));
      }
      const { agentName, surface } = resolveSurface(
        clientNames.get(sessionId),
        opts.wslDistro,
        opts.desktopSessionIds?.has(sessionId)
      );
      const initiator = record.initiator;
      const nanoAiu = record.total_nano_aiu;
      const multiplier = record.request_multiplier;
      // Copilot's own event id when present (319 of 9,834 rows on a real store carry none),
      // else the local autoincrement id, else the turn ordinal.
      const rowKey = typeof record.event_id === 'string' && record.event_id
        ? record.event_id
        : String(record.id ?? `${sessionId}:${toInt(record.turn_index)}`);

      rows.push({
        sessionId,
        requestId: `store:${rowKey}`,
        tsMs,
        agentName,
        surface,
        source: 'copilot-cli-store',
        model: typeof record.model === 'string' && record.model ? record.model : 'unknown',
        modelConfidence: 'exact',
        category: categoryOf(initiator),
        status: statusOf(record),
        isUserTurn: initiator === 'user',
        usage: {
          inputTokens: toCount(record.input_tokens),
          outputTokens: toCount(record.output_tokens),
          cacheReadTokens: toCount(record.cache_read_tokens),
          cacheWriteTokens: toCount(record.cache_write_tokens),
          reasoningTokens: toCount(record.reasoning_tokens),
        },
        durationMs: toCount(record.duration_ms),
        apiCalls: 1,
        ...textField(record.session_cwd, 'workingDirectory'),
        ...textField(record.session_repository, 'repository'),
        ...textField(record.session_branch, 'branch'),
        ...(typeof nanoAiu === 'number' && Number.isFinite(nanoAiu) ? { billedNanoAiu: nanoAiu } : {}),
        ...(typeof multiplier === 'number' && Number.isFinite(multiplier)
          ? { requestMultiplier: multiplier }
          : {}),
      });
      health.rowsRead += 1;
      coveredSessionIds.add(sessionId);
    }
  } catch (error) {
    health.errors += 1;
    logger.debug('[copilot-local] store read failed:', error);
    health.reasons.push('sqlite_error');
    health.notes.push('session-store.db could not be queried');
  } finally {
    try {
      connection?.close();
    } catch {
      // Closing a database that failed to open is not an error worth surfacing.
    }
    snapshot.dispose();
  }

  return { rows, health, coveredSessionIds };
}
