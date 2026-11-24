/**
 * The OpenCode v2 path of the SQLite reader, against a real opencode.db. OpenCode v2 keeps
 * sessions in `session_v2` and a whole message in one `session_message` row; a database
 * upgraded from v1 still holds the old `session` / `message` / `part` tables with stale rows,
 * so the v2 tables must win whenever they exist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeDb, sqlText } from './opencode-db.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  isSqliteAvailable,
  readSessionsFromDb,
  readSessionIdsWithMessages,
  readMessagesFromDb,
  readAllPartsForSessionFromDb,
  readRowTimesFromDb,
} = await import('../opencode.sqlite-reader.js');
const sqliteAvailable = await isSqliteAvailable();

const SECOND = 1000;
// Recent: by default readSessionsFromDb drops sessions created more than 30 days ago
const T0 = Date.now() - 10 * 60 * SECOND;

const V1_TABLES = `
  CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
`;
// The columns the reader selects, as OpenCode 2.2.7 names them
const V2_TABLES = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
`;

const SESSION_COLUMNS = {
  projectId: 'prj_1',
  slug: 'calm-river',
  directory: '/work/project',
  title: 'Fix the build',
  version: '2.2.7',
};

interface SessionFixture {
  id: string;
  created?: number;
  updated?: number;
  parentId?: string;
}

/** Both layouts keep the session columns the reader selects under the same names. */
function sessionRow(table: 'session' | 'session_v2', { id, created = T0, updated = created, parentId }: SessionFixture): string {
  const { projectId, slug, directory, title, version } = SESSION_COLUMNS;
  return (
    `INSERT INTO ${table} (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) ` +
    `VALUES ('${id}', '${projectId}', ${parentId ? `'${parentId}'` : 'NULL'}, '${slug}', '${directory}', '${title}', '${version}', ${created}, ${updated});`
  );
}

interface V2MessageFixture {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  created: number;
  updated?: number;
  /** Stored as JSON */
  data?: unknown;
  /** Stored verbatim instead of `data`: a blob OpenCode had not finished writing */
  rawData?: string;
}

function v2MessageRow({ id, sessionId, type, seq, created, updated = created, data, rawData }: V2MessageFixture): string {
  const dataSql = rawData === undefined ? sqlText(data) : `'${rawData}'`;
  return (
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) ` +
    `VALUES ('${id}', '${sessionId}', '${type}', ${seq}, ${created}, ${updated}, ${dataSql});`
  );
}

function v1MessageRow(id: string, sessionId: string, created: number): string {
  return (
    `INSERT INTO message (id, session_id, time_created, time_updated, data) ` +
    `VALUES ('${id}', '${sessionId}', ${created}, ${created}, ${sqlText({ role: 'user', time: { created } })});`
  );
}

function v1PartRow(id: string, messageId: string, sessionId: string, created: number): string {
  return (
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) ` +
    `VALUES ('${id}', '${messageId}', '${sessionId}', ${created}, ${created}, ${sqlText({ type: 'text', text: 'stale prompt' })});`
  );
}

const userData = (created: number, text: string) => ({ time: { created }, text, files: [] });

function assistantData(created: number, content: unknown[]) {
  return {
    time: { created, streamed: created, completed: created + SECOND },
    agent: 'build',
    model: { id: 'gpt-6.1-sol', providerID: 'codemie-openai' },
    content,
    finish: 'stop',
  };
}

let root: string;
let dbPath: string;

const writeRows = (...sql: string[]): Promise<void> => writeDb(dbPath, sql.join('\n'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-reader-v2-'));
  dbPath = join(root, 'opencode.db');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('OpenCode SQLite reader — v2 storage', () => {
  describe('schema detection', () => {
    describe('a database upgraded from v1, which keeps its stale v1 rows', () => {
      const LIVE = 'ses_live';
      const STALE = 'ses_stale';
      const STALE_AT = T0;
      const LIVE_AT = T0 + SECOND;

      beforeEach(async () => {
        await writeRows(
          V1_TABLES,
          V2_TABLES,
          sessionRow('session', { id: STALE }),
          sessionRow('session', { id: LIVE }),
          v1MessageRow('msg_stale_other', STALE, STALE_AT),
          v1MessageRow('msg_stale', LIVE, STALE_AT),
          v1PartRow('prt_stale', 'msg_stale', LIVE, STALE_AT),
          sessionRow('session_v2', { id: LIVE }),
          v2MessageRow({ id: 'msg_live', sessionId: LIVE, type: 'user', seq: 1, created: LIVE_AT, data: userData(LIVE_AT, 'live prompt') })
        );
      });

      it('should list sessions from session_v2', async () => {
        const sessions = await readSessionsFromDb(dbPath);

        expect(sessions.map((session) => session.id)).toEqual([LIVE]);
      });

      it('should find the sessions with messages in session_message', async () => {
        const ids = await readSessionIdsWithMessages(dbPath, [STALE, LIVE], { since: STALE_AT });

        expect(ids).toEqual(new Set([LIVE]));
      });

      it('should read messages from session_message', async () => {
        const messages = await readMessagesFromDb(dbPath, LIVE);

        expect(messages.map((message) => message.id)).toEqual(['msg_live']);
      });

      it('should read parts from session_message', async () => {
        const parts = await readAllPartsForSessionFromDb(dbPath, LIVE);

        expect(Object.keys(parts)).toEqual(['msg_live']);
      });

      it('should read row times from session_message', async () => {
        const times = await readRowTimesFromDb(dbPath, LIVE);

        expect(times).toEqual([LIVE_AT, LIVE_AT]);
      });
    });

    it('should still read a database that only has the v1 tables', async () => {
      await writeRows(V1_TABLES, sessionRow('session', { id: 'ses_v1' }), v1MessageRow('msg_v1', 'ses_v1', T0));

      const sessions = await readSessionsFromDb(dbPath);
      const messages = await readMessagesFromDb(dbPath, 'ses_v1');

      expect(sessions.map((session) => session.id)).toEqual(['ses_v1']);
      expect(messages.map((message) => message.id)).toEqual(['msg_v1']);
    });
  });

  describe('readSessionsFromDb', () => {
    it('should map a session_v2 row to an OpenCode session', async () => {
      await writeRows(V2_TABLES, sessionRow('session_v2', { id: 'ses_1', created: T0, updated: T0 + SECOND }));

      const sessions = await readSessionsFromDb(dbPath);

      expect(sessions).toEqual([
        {
          id: 'ses_1',
          title: SESSION_COLUMNS.title,
          directory: SESSION_COLUMNS.directory,
          time: { created: T0, updated: T0 + SECOND },
          projectID: SESSION_COLUMNS.projectId,
          slug: SESSION_COLUMNS.slug,
          version: SESSION_COLUMNS.version,
        },
      ]);
    });

    it('should carry the parent of a child session', async () => {
      await writeRows(V2_TABLES, sessionRow('session_v2', { id: 'ses_child', parentId: 'ses_parent' }));

      const [session] = await readSessionsFromDb(dbPath);

      expect(session.parentID).toBe('ses_parent');
    });
  });

  describe('readSessionIdsWithMessages', () => {
    it('should return the sessions with a session_message row created inside the window', async () => {
      const prompt = (sessionId: string, created: number): string =>
        v2MessageRow({ id: `msg_${sessionId}`, sessionId, type: 'user', seq: 1, created, data: userData(created, 'hi') });
      const windowEnd = T0 + 10 * SECOND;
      await writeRows(V2_TABLES, prompt('ses_before', T0 - SECOND), prompt('ses_inside', T0), prompt('ses_at_end', windowEnd));

      const ids = await readSessionIdsWithMessages(dbPath, ['ses_before', 'ses_inside', 'ses_at_end'], {
        since: T0,
        until: windowEnd,
      });

      expect(ids).toEqual(new Set(['ses_inside']));
    });
  });

  describe('a v2 conversation', () => {
    const MAIN = 'ses_main';
    const PROMPT_ID = 'msg_z_prompt';
    const REPLY_ID = 'msg_a_reply';
    const IDLE_ID = 'msg_idle';
    const SYSTEM_ID = 'msg_system';
    const OTHER_SESSION_ROW_ID = 'msg_other';
    const BROKEN_ID = 'msg_broken';
    const REPLY_AT = T0 + SECOND;
    const REPLY_UPDATED_AT = T0 + 2 * SECOND;
    const IDLE_AT = T0 + 3 * SECOND;
    const SYSTEM_AT = T0 + 4 * SECOND;
    const OTHER_SESSION_AT = T0 + 5 * SECOND;

    const shellCall = {
      type: 'tool',
      id: 'call_1',
      name: 'shell',
      state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a.ts\nb.ts\n' }], metadata: { exit: 0 } },
      time: { created: REPLY_AT, ran: REPLY_AT, completed: REPLY_UPDATED_AT },
    };

    // The reply is inserted first and its id sorts first: only `seq` puts the prompt ahead of it.
    const conversation = [
      V2_TABLES,
      v2MessageRow({
        id: REPLY_ID,
        sessionId: MAIN,
        type: 'assistant',
        seq: 7,
        created: REPLY_AT,
        updated: REPLY_UPDATED_AT,
        data: assistantData(REPLY_AT, [{ type: 'text', text: 'Two files.' }, shellCall]),
      }),
      v2MessageRow({ id: PROMPT_ID, sessionId: MAIN, type: 'user', seq: 4, created: T0, data: userData(T0, 'list the files') }),
      v2MessageRow({ id: IDLE_ID, sessionId: MAIN, type: 'idle', seq: 14, created: IDLE_AT, data: { time: { created: IDLE_AT }, outcome: 'succeeded' } }),
      v2MessageRow({ id: SYSTEM_ID, sessionId: MAIN, type: 'system', seq: 15, created: SYSTEM_AT, data: { time: { created: SYSTEM_AT }, text: 'The Code Mode tool catalog changed.' } }),
      v2MessageRow({ id: OTHER_SESSION_ROW_ID, sessionId: 'ses_other', type: 'user', seq: 1, created: OTHER_SESSION_AT, data: userData(OTHER_SESSION_AT, 'unrelated') }),
    ];

    const brokenReply = v2MessageRow({ id: BROKEN_ID, sessionId: MAIN, type: 'assistant', seq: 20, created: SYSTEM_AT, rawData: '{"time":' });

    describe('readMessagesFromDb', () => {
      it('should return the turns in sequence order, not id or insertion order', async () => {
        await writeRows(...conversation);

        const messages = await readMessagesFromDb(dbPath, MAIN);

        expect(messages.map((message) => message.id)).toEqual([PROMPT_ID, REPLY_ID]);
      });

      it('should convert each row to the v1 message of its role', async () => {
        await writeRows(...conversation);

        const messages = await readMessagesFromDb(dbPath, MAIN);

        expect(messages).toEqual([
          { id: PROMPT_ID, sessionID: MAIN, role: 'user', time: { created: T0 } },
          {
            id: REPLY_ID,
            sessionID: MAIN,
            role: 'assistant',
            time: { created: REPLY_AT, completed: REPLY_AT + SECOND },
            providerID: 'codemie-openai',
            modelID: 'gpt-6.1-sol',
            agent: 'build',
          },
        ]);
      });

      it.each([
        { type: 'idle', id: IDLE_ID },
        { type: 'system', id: SYSTEM_ID },
      ])('should skip the $type row, which is not a conversation turn', async ({ id }) => {
        await writeRows(...conversation);

        const messages = await readMessagesFromDb(dbPath, MAIN);

        expect(messages.map((message) => message.id)).not.toContain(id);
      });

      it("should not return another session's rows", async () => {
        await writeRows(...conversation);

        const messages = await readMessagesFromDb(dbPath, MAIN);

        expect(messages.map((message) => message.id)).not.toContain(OTHER_SESSION_ROW_ID);
      });

      it('should skip a row whose data is not valid JSON and keep the rest', async () => {
        await writeRows(...conversation, brokenReply);

        const messages = await readMessagesFromDb(dbPath, MAIN);

        expect(messages.map((message) => message.id)).toEqual([PROMPT_ID, REPLY_ID]);
      });

      it('should return no messages for a session without rows', async () => {
        await writeRows(...conversation);

        expect(await readMessagesFromDb(dbPath, 'ses_unknown')).toEqual([]);
      });
    });

    describe('readAllPartsForSessionFromDb', () => {
      it('should key the parts of each turn by its message id', async () => {
        await writeRows(...conversation);

        const parts = await readAllPartsForSessionFromDb(dbPath, MAIN);

        expect(parts[PROMPT_ID]).toEqual([
          { id: `${PROMPT_ID}:0`, messageID: PROMPT_ID, sessionID: MAIN, type: 'text', text: 'list the files' },
        ]);
        expect(parts[REPLY_ID]).toEqual([
          { id: `${REPLY_ID}:0`, messageID: REPLY_ID, sessionID: MAIN, type: 'text', text: 'Two files.' },
          {
            id: `${REPLY_ID}:1`,
            messageID: REPLY_ID,
            sessionID: MAIN,
            type: 'tool',
            callID: 'call_1',
            tool: 'shell',
            state: {
              status: 'completed',
              input: { command: 'ls' },
              output: 'a.ts\nb.ts\n',
              metadata: { exit: 0 },
              time: { start: REPLY_AT, end: REPLY_UPDATED_AT },
            },
          },
        ]);
      });

      it.each([
        { type: 'idle', id: IDLE_ID },
        { type: 'system', id: SYSTEM_ID },
      ])('should skip the $type row, which is not a conversation turn', async ({ id }) => {
        await writeRows(...conversation);

        const parts = await readAllPartsForSessionFromDb(dbPath, MAIN);

        expect(Object.keys(parts)).not.toContain(id);
      });

      it("should not return another session's rows", async () => {
        await writeRows(...conversation);

        const parts = await readAllPartsForSessionFromDb(dbPath, MAIN);

        expect(Object.keys(parts)).not.toContain(OTHER_SESSION_ROW_ID);
      });

      it('should skip a row whose data is not valid JSON and keep the rest', async () => {
        await writeRows(...conversation, brokenReply);

        const parts = await readAllPartsForSessionFromDb(dbPath, MAIN);

        expect(Object.keys(parts).sort()).toEqual([REPLY_ID, PROMPT_ID]);
      });
    });

    describe('readRowTimesFromDb', () => {
      it('should return the created and updated time of every session_message row of the session', async () => {
        await writeRows(...conversation);

        const times = await readRowTimesFromDb(dbPath, MAIN);

        expect([...times].sort((a, b) => a - b)).toEqual([
          T0,
          T0,
          REPLY_AT,
          REPLY_UPDATED_AT,
          IDLE_AT,
          IDLE_AT,
          SYSTEM_AT,
          SYSTEM_AT,
        ]);
      });

      it("should not return another session's row times", async () => {
        await writeRows(...conversation);

        const times = await readRowTimesFromDb(dbPath, MAIN);

        expect(times).not.toContain(OTHER_SESSION_AT);
      });
    });
  });
});
