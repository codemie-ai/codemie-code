/**
 * Builds an `opencode.db` the way the reader reads it: node:sqlite (Node 22.5+), else the sqlite3 CLI.
 */
import { execFileSync } from 'child_process';

export async function writeDb(dbPath: string, sql: string): Promise<void> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(sql);
    db.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    execFileSync('sqlite3', [dbPath, sql]);
  }
}

/** A JSON value as a SQL string literal. */
export const sqlText = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'`;
