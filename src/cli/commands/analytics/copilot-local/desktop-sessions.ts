/**
 * Which sessions belong to the GitHub Copilot desktop app, from the app's own `data.db`.
 *
 * Copilot Desktop, the CLI and VS Code's agent host all write usage into the SAME
 * `session-store.db`, so the store cannot say which surface a session ran on. The documented
 * signal is each session's `workspace.yaml` `client_name`, but that file is per-session and
 * absent on some installs, which silently re-labels every Desktop session as CLI.
 *
 * The desktop app keeps its own database at `<home>/data.db`, and every row in its `sessions`
 * table is by construction a Desktop session. Reading just those ids gives a store-wide
 * Desktop set in one query, independent of any per-session file. Verified against a real
 * machine (2026-11-18): 13 desktop sessions, 6 of which had usage rows in the shared store.
 *
 * PRIVACY: `data.db` also holds the user's GitHub `access_token` (in `accounts`), chat titles
 * and review threads. This module issues exactly ONE query — `SELECT id FROM sessions` — and
 * must never be extended to read another table. Everything else in that file is off limits to
 * an analytics scan.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { FULL_SESSION_UUID } from '@/agents/plugins/copilot-cli/copilot-cli.constants.js';

/** Minimal `node:sqlite` surface used here. */
interface SqliteDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/** The desktop app's database inside a Copilot home. */
export function desktopDbPath(home: string): string {
  return join(home, 'data.db');
}

/**
 * Session ids the desktop app owns, or an empty set when its database is absent or unreadable.
 *
 * Never throws: Desktop attribution is an enrichment, so a machine without the desktop app
 * (or without `node:sqlite`) simply gets no Desktop labels rather than a failed scan.
 */
export async function readDesktopSessionIds(home: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const source = desktopDbPath(home);
  try {
    if (!statSync(source).isFile()) {
      return ids;
    }
  } catch {
    return ids;
  }

  let sqlite: SqliteModule;
  try {
    sqlite = (await import('node:sqlite')) as unknown as SqliteModule;
  } catch {
    return ids;
  }

  // Same copy-mode snapshot as the usage store: the desktop app holds the file open in WAL
  // mode while it runs, and its -wal sibling carries the newest sessions.
  let dir: string | undefined;
  let db: SqliteDatabase | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'codemie-copilot-desktop-'));
    const file = join(dir, 'data.db');
    copyFileSync(source, file);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${source}${suffix}`)) {
        try {
          copyFileSync(`${source}${suffix}`, `${file}${suffix}`);
        } catch {
          // Checkpointed mid-copy; the main file still stands on its own.
        }
      }
    }
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    for (const row of db.prepare('SELECT id FROM sessions').all() as Array<{ id?: unknown }>) {
      if (typeof row.id === 'string' && FULL_SESSION_UUID.test(row.id)) {
        ids.add(row.id);
      }
    }
  } catch (error) {
    logger.debug('[copilot-local] desktop session lookup failed:', error);
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to do if it never opened.
    }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp directory must never fail a report.
      }
    }
  }
  return ids;
}
