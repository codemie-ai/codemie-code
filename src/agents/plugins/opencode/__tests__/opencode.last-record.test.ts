/**
 * OpenCodeSessionAdapter.processSession reports `lastRecordAt` as the latest row of the session —
 * the session, its messages and its parts — in both storages: a run killed during a running tool
 * ends at that part's time, not at its message's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { OpenCodeSessionAdapter } = await import('../opencode.session.js');
const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');

const MINUTE = 60_000;
const SESSION_ID = '00000000-0000-4000-8000-0000000000aa';

/** Builds the db the way the reader reads it: node:sqlite (Node 22.5+), else the sqlite3 CLI. */
async function writeDb(dbPath: string, sql: string): Promise<void> {
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

const hasSqlite3 = spawnSync('sqlite3', ['--version']).status === 0;

const sqlText = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'`;

let root: string;
const previousHome = process.env.CODEMIE_HOME;

function context() {
  return {
    sessionId: SESSION_ID,
    agentSessionId: 'ses_running',
    apiBaseUrl: '',
    cookies: '',
    clientType: 'codemie-opencode',
    version: '0.0.0',
    dryRun: true,
  } as never;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-last-record-'));
  process.env.CODEMIE_HOME = join(root, 'codemie');
  mkdirSync(join(root, 'codemie', 'sessions'), { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('opencode lastRecordAt', () => {
  it.skipIf(!hasSqlite3)('SQLite: a running tool part written after every message time is the last record', async () => {
    const t0 = Date.now() - 30 * MINUTE;
    const dbPath = join(root, 'opencode.db');
    await writeDb(dbPath, `
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('ses_running', 'p', 's', '${root}', 't', '1.0.0', ${t0}, ${t0 + MINUTE});
      INSERT INTO message VALUES ('msg_1', 'ses_running', ${t0 + 2 * MINUTE}, ${t0 + 3 * MINUTE},
        ${sqlText({ role: 'assistant', time: { created: t0 + 2 * MINUTE } })});
      INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_running', ${t0 + 4 * MINUTE}, ${t0 + 9 * MINUTE},
        ${sqlText({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running', time: { start: t0 + 4 * MINUTE } } })});
    `);

    const result = await new OpenCodeSessionAdapter(OpenCodePluginMetadata).processSession(dbPath, SESSION_ID, context());

    expect(result.lastRecordAt).toBe(t0 + 9 * MINUTE);
  });

  it('file storage: a running tool part started after every message time is the last record', async () => {
    const t0 = Date.now() - 30 * MINUTE;
    const storage = join(root, 'storage');
    mkdirSync(join(storage, 'session', 'project-1'), { recursive: true });
    mkdirSync(join(storage, 'message', 'ses_running'), { recursive: true });
    mkdirSync(join(storage, 'part', 'msg_1'), { recursive: true });
    const sessionFile = join(storage, 'session', 'project-1', 'ses_running.json');
    writeFileSync(sessionFile, JSON.stringify({ id: 'ses_running', directory: root, time: { created: t0, updated: t0 + MINUTE } }));
    writeFileSync(join(storage, 'message', 'ses_running', 'msg_1.json'), JSON.stringify({
      id: 'msg_1', sessionID: 'ses_running', role: 'assistant', time: { created: t0 + 2 * MINUTE },
    }));
    writeFileSync(join(storage, 'part', 'msg_1', 'prt_1.json'), JSON.stringify({
      id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_running', type: 'tool', tool: 'bash', callID: 'c1',
      state: { status: 'running', time: { start: t0 + 7 * MINUTE } },
    }));

    const result = await new OpenCodeSessionAdapter(OpenCodePluginMetadata).processSession(sessionFile, SESSION_ID, context());

    expect(result.lastRecordAt).toBe(t0 + 7 * MINUTE);
  });
});
