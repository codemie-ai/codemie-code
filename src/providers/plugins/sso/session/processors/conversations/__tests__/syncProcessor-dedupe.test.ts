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
});
