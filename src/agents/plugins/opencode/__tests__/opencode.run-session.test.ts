/**
 * The OpenCode sessions of a record's run, read from a real opencode.db through
 * OpenCodeSessionAdapter.processSession and locateTranscript: the session the launch named;
 * else every one created inside the run window, plus for a continued run the one it continued —
 * in the record's directory by realpath, never a session created at or after a later record's start —
 * except in a `codemie hook` process (a live run's own hook), which scans for no later record, so its
 * creation window has no upper bound. The selected sessions are read off the conversation payloads' ids.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../../../core/session/types.js';
import { writeDb, sqlText } from './opencode-db.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { OpenCodeSessionAdapter } = await import('../opencode.session.js');
const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');
const { isSqliteAvailable } = await import('../opencode.sqlite-reader.js');
const sqliteAvailable = await isSqliteAvailable();

const SECOND = 1000;
// Recent: a record file older than its own start is never scanned as a later record
const T0 = Date.now() - 10 * 60 * SECOND;

let root: string;
let project: string;
let dbPath: string;
const previousHome = process.env.CODEMIE_HOME;

interface DbSession {
  id: string;
  created: number;
  updated: number;
  directory?: string;
  /** Times of the session's user prompts; each gets an assistant reply one second later */
  prompts: number[];
  /** The parent session of a subagent's child session */
  parentId?: string;
  /** A completed call of this tool on each assistant reply */
  tool?: string;
}

async function writeSessions(sessions: DbSession[]): Promise<void> {
  const rows = sessions.flatMap((s) => [
    `INSERT INTO session VALUES ('${s.id}', 'p', 's', '${s.directory ?? project}', 't', '1.0.0', ${s.created}, ${s.updated}, ${s.parentId ? `'${s.parentId}'` : 'NULL'});`,
    ...s.prompts.flatMap((at, i) => [
      `INSERT INTO message VALUES ('msg_${s.id}_u${i}', '${s.id}', ${at}, ${at}, ${sqlText({ role: 'user', time: { created: at } })});`,
      `INSERT INTO part VALUES ('prt_${s.id}_u${i}', 'msg_${s.id}_u${i}', '${s.id}', ${at}, ${at}, ${sqlText({ type: 'text', text: `prompt ${s.id} ${i}` })});`,
      `INSERT INTO message VALUES ('msg_${s.id}_a${i}', '${s.id}', ${at + SECOND}, ${at + SECOND}, ${sqlText({ role: 'assistant', modelID: 'm', time: { created: at + SECOND } })});`,
      `INSERT INTO part VALUES ('prt_${s.id}_a${i}', 'msg_${s.id}_a${i}', '${s.id}', ${at + SECOND}, ${at + SECOND}, ${sqlText({ type: 'text', text: `reply ${s.id} ${i}` })});`,
      ...(s.tool ? [`INSERT INTO part VALUES ('prt_${s.id}_t${i}', 'msg_${s.id}_a${i}', '${s.id}', ${at + SECOND}, ${at + SECOND}, ${sqlText({ type: 'tool', tool: s.tool, callID: `call_${s.id}_${i}`, state: { status: 'completed', input: {} } })});`] : []),
    ]),
  ]);
  await writeDb(dbPath, `
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    ${rows.join('\n')}
  `);
}

let idCounter = 0;
function writeRecord(overrides: Partial<Session>): Session {
  idCounter += 1;
  const record: Session = {
    sessionId: `aaaaaaaa-0000-4000-8000-${String(idCounter).padStart(12, '0')}`,
    agentName: 'opencode',
    provider: 'ai-run-sso',
    startTime: T0,
    workingDirectory: project,
    status: 'active',
    activeDurationMs: 0,
    correlation: { status: 'matched', retryCount: 0, agentSessionId: 'unused' },
    ...overrides,
  };
  record.correlation.agentSessionId = record.sessionId;
  writeFileSync(join(root, 'codemie', 'sessions', `${record.sessionId}.json`), JSON.stringify(record));
  return record;
}

function context(record: Session, extra: Record<string, unknown> = {}) {
  return {
    sessionId: record.sessionId,
    agentSessionId: record.sessionId,
    apiBaseUrl: '',
    cookies: '',
    clientType: 'codemie-opencode',
    version: '0.0.0',
    dryRun: true,
    ...extra,
  } as never;
}

/** The OpenCode session ids the run's conversation payloads were filed under. */
function conversationIds(record: Session): string[] {
  const path = join(root, 'codemie', 'sessions', `${record.sessionId}_conversation.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line).payload.conversationId);
}

/** The run's metrics deltas: record id, OpenCode session, user prompts, tools. */
function deltas(record: Session): Array<{ recordId: string; agentSessionId: string; userPrompts?: unknown[]; tools?: Record<string, number> }> {
  const path = join(root, 'codemie', 'sessions', `${record.sessionId}_metrics.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** The run's queued conversation payloads: conversation id, history indices, payload id. */
function queued(record: Session): Array<{ conversationId: string; historyIndices: number[]; payloadId: string }> {
  const path = join(root, 'codemie', 'sessions', `${record.sessionId}_conversation.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => {
    const { payload, historyIndices, payloadId } = JSON.parse(line);
    return { conversationId: payload.conversationId, historyIndices, payloadId };
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-run-session-'));
  project = join(root, 'project');
  mkdirSync(project);
  dbPath = join(root, 'opencode.db');
  process.env.CODEMIE_HOME = join(root, 'codemie');
  mkdirSync(join(root, 'codemie', 'sessions'), { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('opencode run session selection', () => {
  const adapter = () => new OpenCodeSessionAdapter(OpenCodePluginMetadata);

  it('a run selects the session it created, though a later run continuing an older session updated that one last', async () => {
    const a = writeRecord({ startTime: T0 + 10 * SECOND });
    writeRecord({ startTime: T0 + 60 * SECOND, resumeSessionId: 'ses_x' });
    await writeSessions([
      // X: created before A, continued by B, so updated after A's own session
      { id: 'ses_x', created: T0, updated: T0 + 90 * SECOND, prompts: [T0 + SECOND, T0 + 70 * SECOND] },
      { id: 'ses_a_own', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      // Another repository's session, the newest of all
      { id: 'ses_other_repo', created: T0 + 40 * SECOND, updated: T0 + 50 * SECOND, directory: root, prompts: [T0 + 41 * SECOND] },
    ]);

    await adapter().processSession(dbPath, a.sessionId, context(a));

    expect(conversationIds(a)).toEqual(['ses_a_own']);
  });

  it('a run that named a session (`--session X`) selects it first, plus a session it opened (`/new`) in its directory; one in another directory is not its', async () => {
    writeRecord({ startTime: T0 + 10 * SECOND });
    const b = writeRecord({ startTime: T0 + 60 * SECOND, resumeSessionId: 'ses_x' });
    await writeSessions([
      { id: 'ses_x', created: T0, updated: T0 + 90 * SECOND, prompts: [T0 + SECOND, T0 + 70 * SECOND] },
      { id: 'ses_a_own', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_newer', created: T0 + 65 * SECOND, updated: T0 + 95 * SECOND, prompts: [T0 + 66 * SECOND] },
      { id: 'ses_elsewhere', created: T0 + 66 * SECOND, updated: T0 + 96 * SECOND, directory: root, prompts: [T0 + 67 * SECOND] },
    ]);

    await adapter().processSession(dbPath, b.sessionId, context(b));

    expect(conversationIds(b)).toEqual(['ses_x', 'ses_newer']);
  });

  it('a run that created no session selects the older one it continued (`--continue`)', async () => {
    const c = writeRecord({ startTime: T0 + 50 * SECOND, continuesPriorSession: true });
    await writeSessions([
      // Created before the run, updated inside it; nothing created inside the run's window
      { id: 'ses_continued', created: T0, updated: T0 + 80 * SECOND, prompts: [T0 + SECOND, T0 + 60 * SECOND] },
    ]);

    await adapter().processSession(dbPath, c.sessionId, context(c));

    expect(conversationIds(c)).toEqual(['ses_continued']);
  });

  it.each([
    ['--continue', { continuesPriorSession: true }],
    ['--session', { resumeSessionId: 'ses_x' }],
  ])('a continued run (`%s`) takes its own deltas and exchange, none of the earlier run\'s', async (_flag, launch) => {
    const c = writeRecord({ startTime: T0 + 50 * SECOND, ...launch });
    await writeSessions([
      { id: 'ses_x', created: T0, updated: T0 + 80 * SECOND, prompts: [T0 + SECOND, T0 + 60 * SECOND], tool: 'read' },
    ]);

    await adapter().processSession(dbPath, c.sessionId, context(c));

    const recordIds = deltas(c).map((d) => d.recordId);
    expect(recordIds).toEqual(['msg_ses_x_u1:prompt', 'msg_ses_x_a1:call_ses_x_1']);
    expect(queued(c).map(({ conversationId, historyIndices }) => ({ conversationId, historyIndices }))).toEqual([
      { conversationId: 'ses_x', historyIndices: [1, 1] },
    ]);
    const conversation = readFileSync(join(root, 'codemie', 'sessions', `${c.sessionId}_conversation.jsonl`), 'utf-8');
    expect(conversation).toContain('prompt ses_x 1');
    expect(conversation).not.toContain('prompt ses_x 0');
    expect(conversation).not.toContain('reply ses_x 0');
  });

  it('a continued run picks, of two older sessions updated inside its window, the one with a message there', async () => {
    const c = writeRecord({ startTime: T0 + 50 * SECOND, continuesPriorSession: true });
    await writeSessions([
      // Updated last, but its only message is before the run
      { id: 'ses_touched', created: T0, updated: T0 + 90 * SECOND, prompts: [T0 + SECOND] },
      { id: 'ses_continued', created: T0 + 2 * SECOND, updated: T0 + 80 * SECOND, prompts: [T0 + 3 * SECOND, T0 + 60 * SECOND] },
    ]);

    await adapter().processSession(dbPath, c.sessionId, context(c));

    expect(conversationIds(c)).toEqual(['ses_continued']);
  });

  it('a continued run whose older sessions have no message inside its window picks the newest-updated one', async () => {
    // A codemie-code record reads its private storage under CODEMIE_HOME
    dbPath = join(root, 'codemie', 'opencode-storage', 'opencode', 'opencode.db');
    mkdirSync(join(root, 'codemie', 'opencode-storage', 'opencode', 'storage'), { recursive: true });
    const c = writeRecord({ agentName: 'codemie-code', startTime: T0 + 50 * SECOND, continuesPriorSession: true });
    await writeSessions([
      { id: 'ses_touched', created: T0, updated: T0 + 90 * SECOND, prompts: [T0 + SECOND] },
      { id: 'ses_older', created: T0 + 2 * SECOND, updated: T0 + 80 * SECOND, prompts: [T0 + 3 * SECOND] },
    ]);

    expect((await adapter().locateSessionTranscript(c.sessionId))?.sessionIds).toEqual(['ses_touched']);
  });

  it('a continued run continues the parent, never a subagent\'s child updated later with a message in the window', async () => {
    dbPath = join(root, 'codemie', 'opencode-storage', 'opencode', 'opencode.db');
    mkdirSync(join(root, 'codemie', 'opencode-storage', 'opencode', 'storage'), { recursive: true });
    const c = writeRecord({ agentName: 'codemie-code', startTime: T0 + 50 * SECOND, continuesPriorSession: true });
    await writeSessions([
      { id: 'ses_parent', created: T0, updated: T0 + 80 * SECOND, prompts: [T0 + SECOND, T0 + 60 * SECOND] },
      { id: 'ses_child', created: T0 + 2 * SECOND, updated: T0 + 90 * SECOND, parentId: 'ses_parent', prompts: [T0 + 3 * SECOND, T0 + 65 * SECOND] },
    ]);

    expect((await adapter().locateSessionTranscript(c.sessionId))?.sessionIds).toEqual(['ses_parent']);
  });

  it('a subagent\'s child session counts in the run\'s metrics, but is no conversation and no user prompt', async () => {
    const a = writeRecord({ startTime: T0 + 10 * SECOND });
    await writeSessions([
      { id: 'ses_parent', created: T0 + 15 * SECOND, updated: T0 + 40 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_child', created: T0 + 25 * SECOND, updated: T0 + 30 * SECOND, parentId: 'ses_parent', prompts: [T0 + 26 * SECOND], tool: 'read' },
    ]);

    await adapter().processSession(dbPath, a.sessionId, context(a));

    expect(conversationIds(a)).toEqual(['ses_parent']);
    expect(deltas(a).filter((d) => d.userPrompts).map((d) => d.agentSessionId)).toEqual(['ses_parent']);
    expect(deltas(a).filter((d) => d.tools).map((d) => [d.agentSessionId, d.tools])).toEqual([['ses_child', { read: 1 }]]);
  });

  it('a fresh run that created no session selects none, though an older session was updated inside its window', async () => {
    const fresh = writeRecord({ startTime: T0 + 50 * SECOND });
    await writeSessions([
      { id: 'ses_continued', created: T0, updated: T0 + 80 * SECOND, prompts: [T0 + SECOND, T0 + 60 * SECOND] },
    ]);

    await adapter().processSession(dbPath, fresh.sessionId, context(fresh));

    expect(conversationIds(fresh)).toEqual([]);
  });

  it('the incremental-sync lookup of a fresh run finds no session before the run creates its own', async () => {
    // A codemie-code record reads its private storage under CODEMIE_HOME
    dbPath = join(root, 'codemie', 'opencode-storage', 'opencode', 'opencode.db');
    mkdirSync(join(root, 'codemie', 'opencode-storage', 'opencode', 'storage'), { recursive: true });
    const fresh = writeRecord({ agentName: 'codemie-code', startTime: T0 + 50 * SECOND });
    await writeSessions([
      { id: 'ses_other', created: T0, updated: T0 + 80 * SECOND, prompts: [T0 + SECOND, T0 + 60 * SECOND] },
    ]);

    expect(await adapter().locateSessionTranscript(fresh.sessionId)).toBeUndefined();
  });

  it('the SessionEnd lookup of a run with two sessions names the db, both sessions and the later record\'s start', async () => {
    dbPath = join(root, 'codemie', 'opencode-storage', 'opencode', 'opencode.db');
    mkdirSync(join(root, 'codemie', 'opencode-storage', 'opencode', 'storage'), { recursive: true });
    const a = writeRecord({ agentName: 'codemie-code', startTime: T0 + 10 * SECOND });
    writeRecord({ agentName: 'codemie-code', startTime: T0 + 60 * SECOND });
    await writeSessions([
      { id: 'ses_first', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_after_new', created: T0 + 40 * SECOND, updated: T0 + 50 * SECOND, prompts: [T0 + 45 * SECOND] },
    ]);

    expect(await adapter().locateSessionTranscript(a.sessionId)).toEqual({
      transcript: dbPath,
      sessionIds: ['ses_after_new', 'ses_first'],
      recordsBeforeMs: T0 + 60 * SECOND,
    });
  });

  it('parses a discovered descriptor by its own `ses_` id; a CodeMie id names no session in the db', async () => {
    await writeSessions([{ id: 'ses_x', created: T0, updated: T0 + 10 * SECOND, prompts: [T0 + SECOND] }]);

    const parsed = await adapter().parseSessionFile(dbPath, 'ses_x');

    expect(parsed.metadata).toMatchObject({ openCodeSessionId: 'ses_x' });
    await expect(adapter().parseSessionFile(dbPath, 'aaaaaaaa-0000-4000-8000-000000000999')).rejects.toThrow('not found');
  });

  it('a run with no session created or updated inside its window selects none: nothing flushed', async () => {
    const died = writeRecord({ startTime: T0 + 100 * SECOND });
    await writeSessions([
      { id: 'ses_x', created: T0, updated: T0 + 90 * SECOND, prompts: [T0 + SECOND] },
    ]);

    const result = await adapter().processSession(dbPath, died.sessionId, context(died));

    expect(result.totalRecords).toBe(0);
    expect(conversationIds(died)).toEqual([]);
    expect(await adapter().locateTranscript(died)).toEqual([]);
  });

  it('a session created at or after a later record\'s start is that record\'s, never this run\'s', async () => {
    const d = writeRecord({ startTime: T0 + 10 * SECOND });
    writeRecord({ startTime: T0 + 60 * SECOND });
    await writeSessions([
      { id: 'ses_later_run', created: T0 + 61 * SECOND, updated: T0 + 80 * SECOND, prompts: [T0 + 62 * SECOND] },
    ]);

    await adapter().processSession(dbPath, d.sessionId, context(d));

    expect(conversationIds(d)).toEqual([]);
  });

  it('inside a hook process (no later-record scan) the creation window has no upper bound', async () => {
    const d = writeRecord({ startTime: T0 + 10 * SECOND });
    writeRecord({ startTime: T0 + 60 * SECOND });
    await writeSessions([
      { id: 'ses_later_run', created: T0 + 61 * SECOND, updated: T0 + 80 * SECOND, prompts: [T0 + 62 * SECOND] },
    ]);

    await adapter().processSession(dbPath, d.sessionId, context(d, { hookProcess: true }));

    expect(conversationIds(d)).toEqual(['ses_later_run']);
  });

  it('a run that opened a second session (`/new`) selects both, newest-updated first', async () => {
    const a = writeRecord({ startTime: T0 + 10 * SECOND });
    await writeSessions([
      { id: 'ses_first', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_after_new', created: T0 + 40 * SECOND, updated: T0 + 50 * SECOND, prompts: [T0 + 45 * SECOND] },
    ]);

    await adapter().processSession(dbPath, a.sessionId, context(a));

    expect(conversationIds(a)).toEqual(['ses_after_new', 'ses_first']);
  });

  it('a continued run that also opened a new session selects the continued one and the new one', async () => {
    const c = writeRecord({ startTime: T0 + 50 * SECOND, continuesPriorSession: true });
    await writeSessions([
      // The continued session is the newest by update: the new one is still selected
      { id: 'ses_continued', created: T0, updated: T0 + 90 * SECOND, prompts: [T0 + SECOND, T0 + 80 * SECOND] },
      { id: 'ses_new', created: T0 + 55 * SECOND, updated: T0 + 70 * SECOND, prompts: [T0 + 60 * SECOND] },
    ]);

    await adapter().processSession(dbPath, c.sessionId, context(c));

    expect(conversationIds(c)).toEqual(['ses_continued', 'ses_new']);
  });

  it('of a run\'s sessions, one created at or after a later record\'s start is dropped', async () => {
    const d = writeRecord({ startTime: T0 + 10 * SECOND });
    writeRecord({ startTime: T0 + 60 * SECOND });
    await writeSessions([
      { id: 'ses_own', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_later_run', created: T0 + 61 * SECOND, updated: T0 + 80 * SECOND, prompts: [T0 + 62 * SECOND] },
    ]);

    await adapter().processSession(dbPath, d.sessionId, context(d));

    expect(conversationIds(d)).toEqual(['ses_own']);
  });

  it('each session of a run is its own conversation from history 0; a second pass queues nothing more', async () => {
    const a = writeRecord({ startTime: T0 + 10 * SECOND });
    await writeSessions([
      { id: 'ses_first', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_after_new', created: T0 + 40 * SECOND, updated: T0 + 50 * SECOND, prompts: [T0 + 45 * SECOND] },
    ]);

    await adapter().processSession(dbPath, a.sessionId, context(a));
    await adapter().processSession(dbPath, a.sessionId, context(a));

    expect(queued(a)).toEqual([
      { conversationId: 'ses_after_new', historyIndices: [0, 0], payloadId: 'ses_after_new@1' },
      { conversationId: 'ses_first', historyIndices: [0, 0], payloadId: 'ses_first@1' },
    ]);
  });

  it('a run over two sessions: the later record time, the summed records, both sessions\' payloads and deltas in order', async () => {
    const a = writeRecord({ startTime: T0 + 10 * SECOND });
    await writeSessions([
      { id: 'ses_first', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_after_new', created: T0 + 40 * SECOND, updated: T0 + 50 * SECOND, prompts: [T0 + 45 * SECOND] },
    ]);

    const result = await adapter().processSession(dbPath, a.sessionId, context(a));

    expect(result.lastRecordAt).toBe(T0 + 50 * SECOND);
    // Each session: its 2 messages through the metrics processor, its 2 history entries through the conversation one
    expect(result.totalRecords).toBe(8);
    expect(queued(a).map((q) => q.payloadId)).toEqual(['ses_after_new@1', 'ses_first@1']);
    expect(deltas(a).map((d) => d.recordId)).toEqual(['msg_ses_after_new_u0:prompt', 'msg_ses_first_u0:prompt']);
  });

  it.each([
    ['per conversation', { historyIndexByConversation: { ses_first: 0 } }],
    ['a single value written before the per-conversation map', {}],
  ])('the synced checkpoint of one session of the run never holds back another (%s)', async (_shape, byConversation) => {
    const a = writeRecord({
      startTime: T0 + 10 * SECOND,
      sync: { conversations: { conversationId: 'ses_first', lastSyncedMessageUuid: 'ses_first@1', lastSyncedHistoryIndex: 0, ...byConversation } },
    });
    await writeSessions([
      { id: 'ses_first', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_after_new', created: T0 + 40 * SECOND, updated: T0 + 50 * SECOND, prompts: [T0 + 45 * SECOND] },
    ]);

    await adapter().processSession(dbPath, a.sessionId, context(a));

    expect(queued(a)).toEqual([{ conversationId: 'ses_after_new', historyIndices: [0, 0], payloadId: 'ses_after_new@1' }]);
  });

  it('matches the record\'s directory by realpath, not by its spelling', async () => {
    const link = join(root, 'project-link');
    symlinkSync(project, link, 'junction');
    const a = writeRecord({ startTime: T0 + 10 * SECOND, workingDirectory: link });
    await writeSessions([
      { id: 'ses_a_own', created: T0 + 15 * SECOND, updated: T0 + 30 * SECOND, directory: realpathSync(project), prompts: [T0 + 20 * SECOND] },
      { id: 'ses_elsewhere', created: T0 + 16 * SECOND, updated: T0 + 40 * SECOND, directory: root, prompts: [T0 + 21 * SECOND] },
    ]);

    await adapter().processSession(dbPath, a.sessionId, context(a));

    expect(conversationIds(a)).toEqual(['ses_a_own']);
  });

  it('a session whose parse throws fails the run\'s result without stopping the run\'s other sessions', async () => {
    const a = writeRecord({ startTime: T0 + 10 * SECOND });
    await writeSessions([
      // Updated past the largest valid Date (8.64e15): newest-updated, so processed first, and its parse
      // throws. Still a safe integer: node:sqlite refuses to read a larger one, failing the whole listing.
      { id: 'ses_broken', created: T0 + 15 * SECOND, updated: 8.7e15, prompts: [T0 + 20 * SECOND] },
      { id: 'ses_ok', created: T0 + 30 * SECOND, updated: T0 + 50 * SECOND, prompts: [T0 + 35 * SECOND] },
    ]);

    const result = await adapter().processSession(dbPath, a.sessionId, context(a)).catch(() => undefined);

    expect(conversationIds(a)).toEqual(['ses_ok']);
    expect(result?.success).toBe(false);
  });
});

describe('selectRunSessions', () => {
  it('a record with no directory selects nothing, not the sessions of the current directory', async () => {
    const { selectRunSessions } = await import('../opencode.run-session.js');
    const here = { sessionId: 'ses_here', filePath: 'opencode.db', projectPath: process.cwd(), createdAt: T0 + 20 * SECOND, updatedAt: T0 + 30 * SECOND };

    expect(selectRunSessions([here], { startTime: T0, workingDirectory: '' }, undefined)).toEqual([]);
  });
});
