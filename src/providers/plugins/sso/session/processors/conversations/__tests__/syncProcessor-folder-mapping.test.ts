import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upsertConversation = vi.fn();

vi.mock('../apiClient.js', () => ({
  createApiClient: vi.fn(() => ({
    upsertConversation,
  })),
}));

describe('createSyncProcessor — Copilot folder mapping', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'copilot-sync-folder-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    upsertConversation.mockReset();
    upsertConversation.mockResolvedValue({
      success: true,
      message: 'Conversation synced successfully',
      conversation_id: 'cp-conv-1',
      new_messages: 2,
      total_messages: 2,
    });
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

  it('routes codemie-copilot sessions to the copilot-cli folder', async () => {
    const { createSyncProcessor } = await import('../syncProcessor.js');

    const sessionsDir = join(tempHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sess-copilot_conversation.jsonl'),
      JSON.stringify({
        payloadId: 'cp-conv-1@0',
        timestamp: Date.now(),
        isTurnContinuation: false,
        historyIndices: [0, 0],
        messageCount: 2,
        lastProcessedMessageUuid: 'cp-conv-1@0',
        payload: {
          conversationId: 'cp-conv-1',
          history: [
            { role: 'User', message: 'hello', history_index: 0 },
            { role: 'Assistant', message: 'world', history_index: 0 },
          ],
        },
        status: 'pending',
      }) + '\n'
    );

    const processor = createSyncProcessor();
    const result = await processor.process(
      { sessionId: 'sess-copilot', agentName: 'copilot-cli' } as never,
      {
        apiBaseUrl: 'http://localhost:4000',
        cookies: '',
        clientType: 'codemie-copilot',
        version: '0.0.0',
        dryRun: false,
      } as never,
    );

    expect(result.success).toBe(true);
    expect(upsertConversation).toHaveBeenCalledTimes(1);
    expect(upsertConversation.mock.calls[0][3]).toBe('copilot-cli');
  });
});
