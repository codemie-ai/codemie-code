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
    it('sends a shared payloadId once and marks every record carrying it success', async () => {
      writeRecords([makeRecord(), makeRecord({ timestamp: 1_700_000_000_500 })]);
      upsertConversation.mockResolvedValue(okResponse);

      await runSync();

      expect(upsertConversation).toHaveBeenCalledTimes(1);
      expect(readRecords().map(r => r.status)).toEqual(['success', 'success']);

      upsertConversation.mockClear();
      await runSync();
      expect(upsertConversation).not.toHaveBeenCalled();
    });

    it('marks every record carrying a failed payloadId failed with one attempt', async () => {
      writeRecords([makeRecord(), makeRecord({ timestamp: 1_700_000_000_500 })]);
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
});
