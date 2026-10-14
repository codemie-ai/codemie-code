import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upsertConversation = vi.fn();

vi.mock('../apiClient.js', () => ({
  createApiClient: vi.fn(() => ({
    upsertConversation,
  })),
}));

const SESSION_ID = 'sess-dedupe';

interface TestRecord {
  payloadId?: string;
  timestamp: number;
  isTurnContinuation: boolean;
  historyIndices: number[];
  messageCount: number;
  lastProcessedMessageUuid?: string;
  payload: {
    conversationId: string;
    history: Record<string, unknown>[];
  };
  status: string;
  syncAttempts?: number;
  error?: string;
}

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    payloadId: 'conv-1@0',
    timestamp: 1_700_000_000_000,
    isTurnContinuation: false,
    historyIndices: [0],
    messageCount: 1,
    lastProcessedMessageUuid: 'conv-1@0',
    payload: {
      conversationId: 'conv-1',
      history: [{ role: 'User', message: 'hello', history_index: 0 }],
    },
    status: 'pending',
    ...overrides,
  };
}

function makeContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiBaseUrl: 'http://localhost:4000',
    cookies: '',
    clientType: 'codemie-claude',
    version: '0.0.0',
    dryRun: false,
    ...overrides,
  };
}

const okResponse = {
  success: true,
  message: 'ok',
  new_messages: 1,
  total_messages: 1,
};

const SESSION = { sessionId: SESSION_ID, agentName: 'claude' } as never;

describe('createSyncProcessor — duplicate payload ids', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;
  let conversationsFile: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'conv-sync-dedupe-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    const sessionsDir = join(tempHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    conversationsFile = join(sessionsDir, `${SESSION_ID}_conversation.jsonl`);
    upsertConversation.mockReset();
  });

  afterEach(async () => {
    // Close logger's write stream so Windows releases the lock on the log file before rm
    const { logger } = await import('@/utils/logger.js');
    await logger.close();
    await rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (originalCodemieHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = originalCodemieHome;
    }
  });

  function writeRecords(records: TestRecord[]): void {
    writeFileSync(conversationsFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  function readRecords(): TestRecord[] {
    return readFileSync(conversationsFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as TestRecord);
  }

  async function runSync(context: Record<string, unknown> = {}): Promise<{ success: boolean; message?: string; metadata?: Record<string, unknown> }> {
    const { createSyncProcessor } = await import('../syncProcessor.js');
    const processor = createSyncProcessor();
    return processor.process(SESSION, makeContext(context) as never) as never;
  }

  describe('outcome marking (AC1)', () => {
    // A rewound pointer re-queues the same turn (same payloadId) under a new history
    // index, so the duplicate is not fully covered and collapse leaves it alone.
    const requeued = (): TestRecord => makeRecord({
      timestamp: 1_700_000_000_500,
      historyIndices: [1],
      payload: {
        conversationId: 'conv-1',
        history: [{ role: 'User', message: 'hello', history_index: 1 }],
      },
    });

    it('sends a shared payloadId once and marks every record carrying it success', async () => {
      writeRecords([makeRecord(), requeued()]);
      upsertConversation.mockResolvedValue(okResponse);

      await runSync();

      expect(upsertConversation).toHaveBeenCalledTimes(1);
      expect(readRecords().map(r => r.status)).toEqual(['success', 'success']);

      upsertConversation.mockClear();
      await runSync();
      expect(upsertConversation).not.toHaveBeenCalled();
    });

    it('marks every record carrying a failed payloadId failed with one attempt', async () => {
      writeRecords([makeRecord(), requeued()]);
      upsertConversation.mockResolvedValue({ success: false, message: 'boom' });

      await runSync();

      expect(upsertConversation).toHaveBeenCalledTimes(1);
      const records = readRecords();
      expect(records.map(r => r.status)).toEqual(['failed', 'failed']);
      expect(records.map(r => r.syncAttempts)).toEqual([1, 1]);
    });
  });

  describe('healing on read (AC2)', () => {
    it('marks pending and retryable failed duplicates of a successful id success without sending', async () => {
      writeRecords([
        makeRecord({ status: 'success', syncAttempts: 1 }),
        makeRecord({ timestamp: 1_700_000_000_500 }),
        makeRecord({ timestamp: 1_700_000_000_900, status: 'failed', syncAttempts: 1, error: 'boom' }),
      ]);
      upsertConversation.mockResolvedValue(okResponse);

      await runSync();

      expect(upsertConversation).not.toHaveBeenCalled();
      const records = readRecords();
      expect(records.map(r => r.status)).toEqual(['success', 'success', 'success']);
      // Healing is not a send attempt
      expect(records.map(r => r.syncAttempts)).toEqual([1, undefined, 1]);
    });

    it('matches records without a payloadId through the conversationId:timestamp fallback', async () => {
      const noIds = { payloadId: undefined, lastProcessedMessageUuid: undefined };
      writeRecords([
        makeRecord({ ...noIds, status: 'success' }),
        makeRecord({ ...noIds }),
        // Different timestamp = different fallback id: must still be sent
        makeRecord({ ...noIds, timestamp: 1_700_000_000_500 }),
      ]);
      upsertConversation.mockResolvedValue(okResponse);

      await runSync();

      expect(upsertConversation).toHaveBeenCalledTimes(1);
      expect(readRecords().map(r => r.status)).toEqual(['success', 'success', 'success']);
    });

    it('persists healed statuses even when the run defers immediately', async () => {
      writeRecords([
        makeRecord({ status: 'success' }),
        makeRecord({ timestamp: 1_700_000_000_500 }),
        makeRecord({ payloadId: 'conv-2@0', lastProcessedMessageUuid: 'conv-2@0' }),
      ]);
      const controller = new AbortController();
      controller.abort();

      await runSync({ abortSignal: controller.signal });

      expect(upsertConversation).not.toHaveBeenCalled();
      expect(readRecords().map(r => r.status)).toEqual(['success', 'success', 'pending']);
    });
  });

  describe('sync updates do not rewind the transform pointer (AC3, AC4)', () => {
    const UUIDS = [
      '1234abcd-0000-4000-8000-000000000000',
      '8e2f0000-0000-4000-8000-000000000001',
      'ab120000-0000-4000-8000-000000000002',
    ];

    it('omits lastSyncedMessageUuid and reports the max successful history index', async () => {
      writeRecords(UUIDS.map((uuid, i) => makeRecord({
        payloadId: uuid,
        lastProcessedMessageUuid: uuid,
        timestamp: 1_700_000_000_000 + i,
        historyIndices: [i],
        payload: {
          conversationId: 'conv-1',
          history: [{ role: 'User', message: `turn ${i}`, history_index: i }],
        },
      })));
      upsertConversation.mockImplementation(async (_id: string, history: Array<{ history_index: number }>) =>
        history[0].history_index === 2 ? { success: false, message: 'boom' } : okResponse
      );

      const result = await runSync();

      const syncUpdates = (result.metadata as { syncUpdates: { conversations: Record<string, unknown> } }).syncUpdates;
      const conversations = syncUpdates.conversations;
      expect(conversations).not.toHaveProperty('lastSyncedMessageUuid');
      expect(conversations.lastSyncedHistoryIndex).toBe(1);
      expect(conversations.conversationId).toBe('conv-1');

      const { applyProcessingSyncUpdates } = await import('@/agents/core/session/sync-state-utils.js');
      const session = {
        sync: {
          conversations: {
            lastSyncedMessageUuid: UUIDS[2],
            lastSyncedHistoryIndex: 2,
            totalMessagesSynced: 0,
            totalSyncAttempts: 0,
          },
        },
      };
      applyProcessingSyncUpdates(session as never, [result as never]);
      expect(session.sync.conversations.lastSyncedMessageUuid).toBe(UUIDS[2]);
    });
  });

  describe('collapse superseded payloads (AC7, AC8)', () => {
    let clock = 0;
    function rec(payloadId: string, history: Record<string, unknown>[], conversationId = 'conv-1'): TestRecord {
      clock++;
      return makeRecord({
        payloadId,
        lastProcessedMessageUuid: payloadId,
        timestamp: 1_700_000_000_000 + clock,
        historyIndices: history.map(h => h.history_index as number),
        messageCount: history.length,
        payload: { conversationId, history },
      });
    }
    const user0 = { role: 'User', message: 'question', history_index: 0 };
    const assistant0 = (text: string): Record<string, unknown> => ({ role: 'Assistant', message: text, history_index: 0 });

    function sentPayloads(): Array<{ conversationId: string; history: Record<string, unknown>[] }> {
      return upsertConversation.mock.calls.map(call => ({ conversationId: call[0], history: call[1] }));
    }

    beforeEach(() => {
      upsertConversation.mockResolvedValue(okResponse);
    });

    it('sends only the newest of fully covered records and marks the older ones superseded', async () => {
      writeRecords([
        rec('p1', [assistant0('draft 1')]),
        rec('p2', [assistant0('draft 2')]),
        rec('p3', [assistant0('final')]),
      ]);

      const result = await runSync();

      expect(sentPayloads().map(p => p.history[0].message)).toEqual(['final']);
      expect(readRecords().map(r => r.status)).toEqual(['superseded', 'superseded', 'success']);
      expect(readRecords().map(r => r.syncAttempts)).toEqual([undefined, undefined, 1]);
      expect(result.message).toBe('Synced 1/1 conversations');
    });

    it('sends a partly covered record whole, in queue order', async () => {
      writeRecords([
        rec('pA', [user0, assistant0('partial')]),
        rec('pB', [assistant0('continued')]),
      ]);

      await runSync();

      expect(sentPayloads().map(p => p.history.length)).toEqual([2, 1]);
      expect(readRecords().map(r => r.status)).toEqual(['success', 'success']);
    });

    it('does not supersede across different conversationIds', async () => {
      writeRecords([
        rec('pX', [assistant0('main')], 'conv-main'),
        rec('pY', [assistant0('sub')], 'conv-sub'),
      ]);

      await runSync();

      expect(sentPayloads().map(p => p.conversationId)).toEqual(['conv-main', 'conv-sub']);
    });

    it('never supersedes a record with an empty history', async () => {
      writeRecords([
        rec('pEmpty', []),
        rec('pFull', [user0, assistant0('answer')]),
      ]);

      await runSync();

      expect(upsertConversation).toHaveBeenCalledTimes(2);
      expect(readRecords().map(r => r.status)).toEqual(['success', 'success']);
    });

    it('sends codex sentinel records without roles in order and unchanged', async () => {
      const records = [0, 1, 2].map(i =>
        rec(`c@${i}`, [{ message: `event ${i}`, history_index: 0 }], 'codex-conv')
      );
      writeRecords(records);

      await runSync();

      expect(sentPayloads()).toEqual(records.map(r => ({
        conversationId: 'codex-conv',
        history: r.payload.history,
      })));
      expect(readRecords().map(r => r.status)).toEqual(['success', 'success', 'success']);
    });
  });

  describe('per-run send cap (AC6)', () => {
    function uniqueRecord(i: number, payloadId = `conv-${i}@0`): TestRecord {
      return makeRecord({
        payloadId,
        lastProcessedMessageUuid: payloadId,
        timestamp: 1_700_000_000_000 + i,
        payload: {
          conversationId: `conv-${i}`,
          history: [{ role: 'User', message: `hello ${i}`, history_index: 0 }],
        },
      });
    }

    beforeEach(() => {
      upsertConversation.mockResolvedValue(okResponse);
    });

    it('sends at most 50 payloads per run, oldest first, and leaves the rest pending', async () => {
      writeRecords(Array.from({ length: 51 }, (_, i) => uniqueRecord(i)));

      const result = await runSync();

      expect(upsertConversation).toHaveBeenCalledTimes(50);
      expect(upsertConversation.mock.calls.map(call => call[0])).toEqual(
        Array.from({ length: 50 }, (_, i) => `conv-${i}`)
      );
      expect(result.message).toBe('Synced 50/50 conversations');
      const statuses = readRecords().map(r => r.status);
      expect(statuses.filter(st => st === 'pending')).toHaveLength(1);
      expect(statuses[50]).toBe('pending');

      upsertConversation.mockClear();
      await runSync();
      expect(upsertConversation.mock.calls.map(call => call[0])).toEqual(['conv-50']);
      expect(readRecords().every(r => r.status === 'success')).toBe(true);
    });

    it('does not cap a deadline-bounded run (SessionEnd has no next run)', async () => {
      // Only the SessionEnd hook sets syncDeadlineMs; its queue is renamed to completed_
      // right after, so anything left past the cap would never be synced.
      writeRecords(Array.from({ length: 51 }, (_, i) => uniqueRecord(i)));

      const result = await runSync({ syncDeadlineMs: Date.now() + 60_000 });

      expect(upsertConversation).toHaveBeenCalledTimes(51);
      expect(result.message).toBe('Synced 51/51 conversations');
      expect(readRecords().every(r => r.status === 'success')).toBe(true);
    });

    it('does not count superseded duplicates toward the cap', async () => {
      const duplicates = Array.from({ length: 10 }, (_, i) => uniqueRecord(i, `dup-${i}`));
      const survivors = Array.from({ length: 50 }, (_, i) => uniqueRecord(i));
      writeRecords([...duplicates, ...survivors]);

      await runSync();

      expect(upsertConversation).toHaveBeenCalledTimes(50);
      const statuses = readRecords().map(r => r.status);
      expect(statuses.slice(0, 10).every(st => st === 'superseded')).toBe(true);
      expect(statuses.slice(10).every(st => st === 'success')).toBe(true);
    });
  });
});
