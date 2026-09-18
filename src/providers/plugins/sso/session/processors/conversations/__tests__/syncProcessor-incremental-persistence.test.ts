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

const SESSION_ID = 'sess-incremental';

function makePayload(conversationId: string): Record<string, unknown> {
  return {
    payloadId: `${conversationId}@0`,
    timestamp: Date.now(),
    isTurnContinuation: false,
    historyIndices: [0],
    messageCount: 1,
    lastProcessedMessageUuid: `${conversationId}@0`,
    payload: {
      conversationId,
      history: [{ role: 'User', message: `hello from ${conversationId}`, history_index: 0 }],
    },
    status: 'pending',
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

describe('createSyncProcessor — incremental persistence and deferral', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;
  let conversationsFile: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'conv-sync-incremental-'));
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

  function writePayloads(count: number): void {
    const lines = Array.from({ length: count }, (_, i) =>
      JSON.stringify(makePayload(`conv-${i + 1}`))
    ).join('\n');
    writeFileSync(conversationsFile, lines + '\n');
  }

  function readStatuses(): string[] {
    return readFileSync(conversationsFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { status: string }).status);
  }

  it('persists each payload outcome immediately and defers the rest when aborted mid-loop', async () => {
    writePayloads(5);
    const controller = new AbortController();
    const midLoopStatuses: string[][] = [];
    let calls = 0;

    upsertConversation.mockImplementation(async (conversationId: string) => {
      calls++;
      if (calls === 2) {
        // While the 2nd payload is still in flight, the 1st must already be on disk
        midLoopStatuses.push(readStatuses());
        controller.abort(); // Simulate SIGTERM landing mid-sync
      }
      return {
        success: true,
        message: 'ok',
        conversation_id: conversationId,
        new_messages: 1,
        total_messages: 1,
      };
    });

    const { createSyncProcessor } = await import('../syncProcessor.js');
    const processor = createSyncProcessor();
    const result = await processor.process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      makeContext({ abortSignal: controller.signal }) as never,
    );

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Sync deferred: 3 items remaining/);
    expect(upsertConversation).toHaveBeenCalledTimes(2);
    // Incremental persistence: the 1st payload was marked success before the 2nd finished
    expect(midLoopStatuses[0]).toEqual(['success', 'pending', 'pending', 'pending', 'pending']);
    // Final state: 2 success, 3 still pending for the next run
    expect(readStatuses()).toEqual(['success', 'success', 'pending', 'pending', 'pending']);
  });

  it('does not re-send payloads already marked success by a killed previous run', async () => {
    writePayloads(5);
    const controller = new AbortController();
    let calls = 0;

    upsertConversation.mockImplementation(async (conversationId: string) => {
      calls++;
      if (calls === 2) {
        controller.abort(); // "Kill" the first run after 2 of 5 payloads
      }
      return {
        success: true,
        message: 'ok',
        conversation_id: conversationId,
        new_messages: 1,
        total_messages: 1,
      };
    });

    const { createSyncProcessor } = await import('../syncProcessor.js');
    const firstRun = createSyncProcessor();
    const firstResult = await firstRun.process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      makeContext({ abortSignal: controller.signal }) as never,
    );

    expect(firstResult.success).toBe(true);
    expect(firstResult.message).toMatch(/deferred/i);
    expect(readStatuses()).toEqual(['success', 'success', 'pending', 'pending', 'pending']);

    // Second run (fresh processor instance = new process): only the 3 leftovers may be sent
    upsertConversation.mockReset();
    upsertConversation.mockResolvedValue({
      success: true,
      message: 'ok',
      new_messages: 1,
      total_messages: 1,
    });

    const secondRun = createSyncProcessor();
    const secondResult = await secondRun.process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      makeContext() as never,
    );

    expect(secondResult.success).toBe(true);
    expect(upsertConversation).toHaveBeenCalledTimes(3);
    const sentConversationIds = upsertConversation.mock.calls.map(call => call[0]);
    expect(sentConversationIds).toEqual(['conv-3', 'conv-4', 'conv-5']);
    expect(readStatuses()).toEqual(['success', 'success', 'success', 'success', 'success']);
  });
});
