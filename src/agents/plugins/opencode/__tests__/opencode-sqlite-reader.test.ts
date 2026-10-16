/**
 * Tests for the OpenCode session-database reader.
 *
 * OpenCode 1.x wrote `session` / `message` / `part`; 2.x renamed and rebuilt
 * them as `session_v2` / `session_message`, moved role into a `type` column and
 * nested parts inside the message row's `data.content[]`. A reader pinned to the
 * 1.x names fails every query on a 2.x database, and because those failures used
 * to be swallowed at debug level the result was an empty session list presented
 * as "no sessions" — hooks fired, metrics landed nowhere.
 *
 * The layout is detected from `sqlite_master` rather than from a version probe,
 * because the database on disk can have been written by a different OpenCode
 * release than the binary on PATH.
 *
 * Each case builds a real database file in a temp directory, so a fresh path
 * means a fresh layout probe (the reader caches the layout per database path).
 *
 * @group unit
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OpenCodePart, OpenCodeToolPart } from '../opencode-message-types.js';

const sqlite = await import('node:sqlite').catch(() => ({ DatabaseSync: undefined }));
const DatabaseSync = (sqlite as { DatabaseSync?: new (path: string, opts?: { open?: boolean }) => FixtureDb })
  .DatabaseSync;

// node:sqlite needs Node 22.5+; on older runtimes the reader falls back to the
// sqlite3 CLI, which cannot build a fixture from here.
const describeWithSqlite = DatabaseSync ? describe : describe.skip;

interface FixtureDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
}

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'opencode-reader-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Create an empty database file and return its path. */
function newDb(name: string): string {
  const path = join(workDir, `${name}.db`);
  new DatabaseSync!(path).close();
  return path;
}

/** A 2.x-shaped database: session_v2 + session_message, no parts table. */
function buildV2Db(path: string): void {
  const db = new DatabaseSync!(path);
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT,
      version TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE session_message (
      id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);
  const now = Date.now();
  db.prepare(
    'INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)'
  ).run('ses_v2', 'proj', 'slug', '/home/u/proj', 'a v2 session', '2.0.27', now, now + 1000);

  db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
  ).run(
    'msg_user', 'ses_v2', 'user', 0, now, now,
    JSON.stringify({ time: { created: now }, text: 'hello', files: [], agents: [] })
  );
  db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
  ).run(
    'msg_asst', 'ses_v2', 'assistant', 1, now + 5, now + 50,
    JSON.stringify({
      time: { created: now + 5, completed: now + 50 },
      agent: 'build',
      model: { id: 'gpt-6-luna', providerID: 'codemie-proxy', variant: 'xhigh' },
      content: [
        { type: 'text', text: 'working on it' },
        {
          type: 'tool',
          id: 'call_abc',
          name: 'read',
          executed: true,
          state: {
            status: 'completed',
            input: { path: 'a.ts' },
            content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
            metadata: { truncated: false },
          },
        },
      ],
    })
  );
  // Non-message rows share the table and must be skipped, not read as turns.
  for (const [id, seq] of [['msg_idle', 2], ['msg_system', 3], ['msg_shell', 4], ['msg_synth', 5]]) {
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
    ).run(id, 'ses_v2', id.replace('msg_', ''), seq, now, now, JSON.stringify({ time: { created: now } }));
  }
  db.close();
}

/** A 1.x-shaped database: the original session / message / part tables. */
function buildV1Db(path: string): void {
  const db = new DatabaseSync!(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT,
      version TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);
  `);
  const now = Date.now();
  db.prepare(
    'INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)'
  ).run('ses_v1', 'proj', 'slug', '/home/u/proj', 'a v1 session', '1.18.35', now, now + 1000);

  db.prepare('INSERT INTO message (id, session_id, data) VALUES (?,?,?)').run(
    'msg_user', 'ses_v1', JSON.stringify({ role: 'user', time: { created: now }, agent: 'build' })
  );
  db.prepare('INSERT INTO message (id, session_id, data) VALUES (?,?,?)').run(
    'msg_asst', 'ses_v1', JSON.stringify({
      role: 'assistant', time: { created: now + 5, completed: now + 50 },
      providerID: 'openai', modelID: 'gpt-5-2', agent: 'build',
    })
  );
  db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)').run(
    'pt_text', 'msg_asst', 'ses_v1', JSON.stringify({ type: 'text', text: 'hello from v1' })
  );
  db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)').run(
    'pt_tool', 'msg_asst', 'ses_v1', JSON.stringify({
      type: 'tool', callID: 'call_v1', tool: 'read',
      state: { status: 'completed', output: 'v1 output' },
    })
  );
  db.close();
}

describeWithSqlite('readSessionsFromDb', () => {
  it.each([1, 2])('exactly retrieves old v%s sessions without an age cutoff or newest-session substitution', async version => {
    const path = newDb(`exact-old-v${version}`);
    const table = version === 1 ? 'session' : 'session_v2';
    const id = `ses_v${version}`;
    if (version === 1) buildV1Db(path); else buildV2Db(path);
    const db = new DatabaseSync!(path);
    db.prepare(`UPDATE ${table} SET time_created = ? WHERE id = ?`).run(1, id);
    db.prepare(`INSERT INTO ${table} (id, directory, time_created) VALUES (?,?,?)`)
      .run('ses_newer', '/other/repo', Date.now());
    db.close();
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');
    expect((await readSessionsFromDb(path, { sessionId: id, maxAgeDays: 1 })).map(row => row.id)).toEqual([id]);
    expect(await readSessionsFromDb(path, { sessionId: 'ses_absent' })).toEqual([]);
    expect(await readSessionsFromDb(path, { sessionId: `${id}' OR 1=1 --` })).toEqual([]);
    expect((await readSessionsFromDb(path, { maxAgeDays: 1 })).map(row => row.id)).toEqual(['ses_newer']);
  });

  it('reads sessions from a 2.x database', async () => {
    const path = newDb('sessions-v2');
    buildV2Db(path);
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    const sessions = await readSessionsFromDb(path, { maxAgeDays: 30 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'ses_v2',
      title: 'a v2 session',
      directory: '/home/u/proj',
      version: '2.0.27',
      projectID: 'proj',
    });
  });

  it('reads sessions from a 1.x database', async () => {
    const path = newDb('sessions-v1');
    buildV1Db(path);
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    const sessions = await readSessionsFromDb(path, { maxAgeDays: 30 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'ses_v1', version: '1.18.35' });
  });

  it('filters by directory and honours the row limit', async () => {
    const path = newDb('sessions-filter');
    buildV2Db(path);
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    expect(await readSessionsFromDb(path, { cwd: '/home/u/proj' })).toHaveLength(1);
    expect(await readSessionsFromDb(path, { cwd: '/elsewhere' })).toHaveLength(0);
  });

  it('rejects an unrecognized database layout instead of reporting no sessions', async () => {
    const path = newDb('unknown-shape');
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    // An empty result here is indistinguishable from "no sessions", which is how
    // the whole analytics path went dark on 2.x without anyone noticing.
    await expect(readSessionsFromDb(path, { maxAgeDays: 30 })).rejects.toThrow(
      /Unrecognized OpenCode database layout/
    );
  });

  it('reports a missing database rather than returning an empty list', async () => {
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    await expect(readSessionsFromDb(join(workDir, 'absent.db'))).rejects.toThrow(/Database not found/);
  });
});

describeWithSqlite('readMessagesFromDb', () => {
  it('translates a structured assistant error into the internal metric contract', async () => {
    const path = newDb('structured-error');
    buildV2Db(path);
    const db = new DatabaseSync!(path);
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({
      error: { type: 'provider.error', message: 'model rejected request', status: 400 },
    }), 'msg_asst');
    db.close();
    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');
    expect((await readMessagesFromDb(path, 'ses_v2'))[1]).toMatchObject({
      error: { name: 'provider.error', data: { message: 'model rejected request' } },
    });
  });

  it.each([null, 'error text', { type: 'error' }, { message: 'error' }, { type: 1, message: 'error' }])(
    'does not invent an assistant error from an invalid shape %j', async error => {
      const path = newDb(`invalid-error-${Math.random()}`);
      buildV2Db(path);
      const db = new DatabaseSync!(path);
      db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({ error }), 'msg_asst');
      db.close();
      const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');
      expect((await readMessagesFromDb(path, 'ses_v2'))[1]).toMatchObject({ error: undefined });
    },
  );

  it('maps the 2.x type column and the nested model object', async () => {
    const path = newDb('messages-v2');
    buildV2Db(path);
    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');

    const messages = await readMessagesFromDb(path, 'ses_v2');

    // Only user and assistant rows: the same table also holds idle, system,
    // shell, synthetic and switch rows.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    const assistant = messages[1];
    expect(assistant).toMatchObject({
      id: 'msg_asst',
      sessionID: 'ses_v2',
      role: 'assistant',
      providerID: 'codemie-proxy',
      modelID: 'gpt-6-luna',
      agent: 'build',
    });
    expect(assistant.time.completed).toBeTypeOf('number');
  });

  it('leaves the user role without a model rather than inventing one', async () => {
    const path = newDb('messages-user');
    buildV2Db(path);
    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');

    const user = (await readMessagesFromDb(path, 'ses_v2'))[0];

    expect(user.role).toBe('user');
    // 2.x user rows carry {time, text, files, agents[]} — no model.
    expect('model' in user && user.model !== undefined).toBe(false);
  });

  it('keeps reading 1.x rows through data.role', async () => {
    const path = newDb('messages-v1');
    buildV1Db(path);
    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');

    const messages = await readMessagesFromDb(path, 'ses_v1');

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({ providerID: 'openai', modelID: 'gpt-5-2' });
  });
});

describeWithSqlite('readAllPartsForSessionFromDb', () => {
  it('derives parts from data.content[] with synthetic ids', async () => {
    const path = newDb('parts-v2');
    buildV2Db(path);
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const parts = await readAllPartsForSessionFromDb(path, 'ses_v2');

    // User text is normalized separately; assistant parts come from content[].
    expect(Object.keys(parts)).toEqual(['msg_user', 'msg_asst']);
    expect(parts.msg_asst).toHaveLength(2);
    expect(parts.msg_asst[0]).toMatchObject({
      type: 'text',
      text: 'working on it',
      messageID: 'msg_asst',
      sessionID: 'ses_v2',
    });
  });

  it('normalizes real user text into a stable part without synthetic/ignored flags', async () => {
    const path = newDb('user-text-part');
    buildV2Db(path);
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');
    const first = (await readAllPartsForSessionFromDb(path, 'ses_v2')).msg_user;
    expect(first).toEqual([{
      id: 'msg_user:0', type: 'text', text: 'hello', messageID: 'msg_user', sessionID: 'ses_v2',
    }]);
    expect(first[0]).not.toHaveProperty('synthetic');
    expect(first[0]).not.toHaveProperty('ignored');
    expect((await readAllPartsForSessionFromDb(path, 'ses_v2')).msg_user).toEqual(first);
  });

  it.each(['tool failure', { type: 'tool.error', message: 'tool failure' }])(
    'retains tool error text from %j', async error => {
      const path = newDb(`tool-error-${Math.random()}`);
      buildV2Db(path);
      const db = new DatabaseSync!(path);
      db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({ content: [{
        type: 'tool', id: 'call_error', name: 'bash', state: { status: 'error', error },
      }] }), 'msg_asst');
      db.close();
      const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');
      const part = (await readAllPartsForSessionFromDb(path, 'ses_v2')).msg_asst[0] as OpenCodeToolPart;
      expect(part.state.error).toBe('tool failure');
      expect(part.state.status).toBe('error');
    },
  );

  it('does not stringify an unsupported structured tool error', async () => {
    const path = newDb('tool-error-invalid');
    buildV2Db(path);
    const db = new DatabaseSync!(path);
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({ content: [{
      type: 'tool', id: 'call_error', name: 'bash', state: { status: 'error', error: { code: 400 } },
    }] }), 'msg_asst');
    db.close();
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');
    const part = (await readAllPartsForSessionFromDb(path, 'ses_v2')).msg_asst[0] as OpenCodeToolPart;
    expect(part.state.error).toBeUndefined();
  });

  it('translates a 2.x tool entry onto the v1 tool-part shape', async () => {
    const path = newDb('parts-tool');
    buildV2Db(path);
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const parts = await readAllPartsForSessionFromDb(path, 'ses_v2');
    const tool = parts.msg_asst.find((p) => p.type === 'tool') as OpenCodeToolPart;

    // 2.x names these `id` / `name` and returns rendered output as a content
    // list; `id` is already taken by the synthetic part id.
    expect(tool.id).toBe('msg_asst:1');
    expect(tool.callID).toBe('call_abc');
    expect(tool.tool).toBe('read');
    expect(tool.state.status).toBe('completed');
    expect(tool.state.input).toEqual({ path: 'a.ts' });
    expect(tool.state.output).toBe('line one\nline two');
    expect(tool.state.metadata).toEqual({ truncated: false });
  });

  it('passes unknown part types through instead of dropping them', async () => {
    const path = newDb('parts-unknown');
    const db = new DatabaseSync!(path);
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT,
        version TEXT, time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE session_message (
        id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT
      );
    `);
    const now = Date.now();
    db.prepare(
      'INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)'
    ).run('ses_x', 'p', 's', '/tmp', 't', '2.0.27', now, now);
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
    ).run('m1', 'ses_x', 'assistant', 0, now, now, JSON.stringify({
      time: { created: now },
      content: [{ type: 'some-future-type', payload: 1 }],
    }));
    db.close();
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const parts = await readAllPartsForSessionFromDb(path, 'ses_x');

    expect((parts.m1?.[0] as OpenCodePart | undefined)?.type).toBe('some-future-type');
  });

  it('keeps reading 1.x parts from the part table with real row ids', async () => {
    const path = newDb('parts-v1');
    buildV1Db(path);
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const parts = await readAllPartsForSessionFromDb(path, 'ses_v1');

    expect(Object.keys(parts)).toEqual(['msg_asst']);
    expect(parts.msg_asst.map((p) => p.id)).toEqual(['pt_text', 'pt_tool']);
    expect(parts.msg_asst[1]).toMatchObject({ callID: 'call_v1', tool: 'read' });
  });
});

describeWithSqlite('read robustness', () => {
  it('reports an unreadable database rather than an empty session list', async () => {
    // A file that exists but is not a database: both backends fail, and the
    // failure must surface. Reporting "no sessions" here is what made the whole
    // v2 analytics path go dark without a warning.
    const path = join(workDir, 'not-a-database.db');
    writeFileSync(path, 'this is not sqlite');
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    await expect(readSessionsFromDb(path, { maxAgeDays: 30 })).rejects.toThrow(
      /Could not inspect database schema/
    );
  });

  it('skips malformed message rows instead of aborting the read', async () => {
    const path = newDb('malformed-rows');
    buildV2Db(path);
    const db = new DatabaseSync!(path);
    const now = Date.now();
    for (const [id, type] of [['msg_bad1', 'user'], ['msg_bad2', 'assistant']]) {
      db.prepare(
        'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
      ).run(id, 'ses_v2', type, 90, now, now, '{not json');
    }
    db.close();
    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');

    const messages = await readMessagesFromDb(path, 'ses_v2');

    // One bad row must not cost the good ones.
    expect(messages.map((m) => m.id)).toEqual(['msg_user', 'msg_asst']);
  });

  it('ignores content entries that are not typed objects', async () => {
    const path = newDb('content-entries');
    buildV2Db(path);
    const db = new DatabaseSync!(path);
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
    ).run('msg_odd', 'ses_v2', 'assistant', 90, Date.now(), Date.now(), JSON.stringify({
      time: { created: Date.now() },
      content: [null, 'a string', { noType: true }, { type: 'text', text: 'kept' }],
    }));
    db.close();
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const parts = await readAllPartsForSessionFromDb(path, 'ses_v2');

    expect(parts.msg_odd).toHaveLength(1);
    expect(parts.msg_odd[0]).toMatchObject({ type: 'text', text: 'kept' });
  });

  it('leaves tool output unset when 2.x returns no content list', async () => {
    const path = newDb('tool-no-content');
    const db = new DatabaseSync!(path);
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT,
        version TEXT, time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE session_message (
        id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT
      );
    `);
    const now = Date.now();
    db.prepare(
      'INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)'
    ).run('ses_t', 'p', 's', '/tmp', 't', '2.0.27', now, now);
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
    ).run('m1', 'ses_t', 'assistant', 0, now, now, JSON.stringify({
      time: { created: now },
      content: [{ type: 'tool', id: 'call_x', name: 'shell', state: { status: 'running' } }],
    }));
    db.close();
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const tool = (await readAllPartsForSessionFromDb(path, 'ses_t')).m1[0] as OpenCodeToolPart;

    expect(tool.state.status).toBe('running');
    expect(tool.state.output).toBeUndefined();
  });

  it('skips malformed part rows on the 1.x path', async () => {
    const path = newDb('malformed-parts');
    buildV1Db(path);
    const db = new DatabaseSync!(path);
    db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)').run(
      'pt_bad', 'msg_asst', 'ses_v1', '{not json'
    );
    db.close();
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const parts = await readAllPartsForSessionFromDb(path, 'ses_v1');

    expect(parts.msg_asst.map((p) => p.id)).toEqual(['pt_text', 'pt_tool']);
  });

  it('maps the user agent from either entry shape', async () => {
    const path = newDb('agent-names');
    buildV2Db(path);
    const db = new DatabaseSync!(path);
    const now = Date.now();
    for (const [id, agents] of [
      ['msg_str', ['build']],
      ['msg_obj', [{ name: 'plan' }]],
      ['msg_none', []],
      ['msg_bad', 'build'],
    ]) {
      db.prepare(
        'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
      ).run(id, 'ses_v2', 'user', 91, now, now, JSON.stringify({ time: { created: now }, agents }));
    }
    db.close();
    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');

    const byId = new Map((await readMessagesFromDb(path, 'ses_v2')).map((m) => [m.id, m]));

    expect(byId.get('msg_str')?.agent).toBe('build');
    expect(byId.get('msg_obj')?.agent).toBe('plan');
    expect(byId.get('msg_none')?.agent).toBeUndefined();
    // A shape that is not a list is left unset rather than guessed at.
    expect(byId.get('msg_bad')?.agent).toBeUndefined();
  });

  it('skips malformed 1.x message rows instead of aborting the read', async () => {
    const path = newDb('malformed-v1-messages');
    buildV1Db(path);
    const db = new DatabaseSync!(path);
    db.prepare('INSERT INTO message (id, session_id, data) VALUES (?,?,?)').run(
      'msg_bad', 'ses_v1', '{not json'
    );
    db.close();
    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');

    const messages = await readMessagesFromDb(path, 'ses_v1');

    expect(messages.map((m) => m.id)).toEqual(['msg_user', 'msg_asst']);
  });

  it('skips malformed 2.x message rows while deriving parts', async () => {
    const path = newDb('malformed-parts-v2');
    buildV2Db(path);
    const db = new DatabaseSync!(path);
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)'
    ).run('msg_bad', 'ses_v2', 'assistant', 92, Date.now(), Date.now(), '{not json');
    db.close();
    const { readAllPartsForSessionFromDb } = await import('../opencode.sqlite-reader.js');

    const parts = await readAllPartsForSessionFromDb(path, 'ses_v2');

    expect(Object.keys(parts)).toEqual(['msg_user', 'msg_asst']);
  });
});

describeWithSqlite('v2 user text reaches real processors', () => {
  it('writes prompt metrics and a user conversation event from a SQLite-only session', async () => {
    const path = newDb('user-text-pipeline');
    buildV2Db(path);
    const { OpenCodeSessionAdapter } = await import('../opencode.session.js');
    const { getSessionMetricsPath, getSessionConversationPath } = await import('../../../core/session/session-config.js');
    const outputId = `reader-pipeline-${process.pid}`;
    const adapter = new OpenCodeSessionAdapter({
      name: 'opencode', displayName: 'OpenCode', description: 'test', cliCommand: 'opencode', dataPaths: { home: '.opencode' },
    });
    const metricsPath = getSessionMetricsPath(outputId);
    const conversationsPath = getSessionConversationPath(outputId);
    try {
      const result = await adapter.processSession(path, outputId, {
        sessionId: outputId, agentSessionId: 'ses_v2', apiBaseUrl: '', cookies: '',
        clientType: 'codemie-opencode', version: 'test', dryRun: true, gitBranch: 'test-branch',
      });
      expect(result.success).toBe(true);
      expect(readFileSync(metricsPath, 'utf8')).toContain('hello');
      const conversations = readFileSync(conversationsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(conversations[0].payload.conversationId).toBe('ses_v2');
      expect(conversations[0].payload.history.some((entry: { role: string }) => entry.role === 'User')).toBe(true);
      expect(JSON.stringify(conversations[0])).toContain('hello');
    } finally {
      rmSync(metricsPath, { force: true });
      rmSync(conversationsPath, { force: true });
    }
  });
});
