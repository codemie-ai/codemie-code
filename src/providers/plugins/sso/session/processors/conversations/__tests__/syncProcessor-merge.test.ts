import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upsertConversation = vi.fn();

vi.mock('../apiClient.js', () => ({
  createApiClient: vi.fn(() => ({ upsertConversation })),
}));

vi.mock('../../../utils/locked-jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/locked-jsonl.js')>();
  return { ...actual, rewriteSessionFile: vi.fn(actual.rewriteSessionFile) };
});

const SESSION_ID = 'sess-merge';

function makePayload(conversationId: string): Record<string, unknown> {
  return {
    payloadId: `${conversationId}@0`,
    timestamp: Date.now(),
    isTurnContinuation: false,
    historyIndices: [0],
    messageCount: 1,
    lastProcessedMessageUuid: `${conversationId}@0`,
    payload: { conversationId, history: [{ role: 'User', message: `hello from ${conversationId}`, history_index: 0 }] },
    status: 'pending',
  };
}

describe('createSyncProcessor — the rewrite merges by payloadId', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;
  let conversationsFile: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'conv-sync-merge-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    const sessionsDir = join(tempHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    conversationsFile = join(sessionsDir, `${SESSION_ID}_conversation.jsonl`);
    writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({ sessionId: SESSION_ID, startTime: 0 }));
    upsertConversation.mockReset();
  });

  afterEach(async () => {
    const { logger } = await import('@/utils/logger.js');
    await logger.close();
    await rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (originalCodemieHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalCodemieHome;
  });

  it('sends the payloads around a torn line and rewrites the file without it', async () => {
    writeFileSync(conversationsFile, `${JSON.stringify(makePayload('conv-1'))}\n{"payloadId":"torn\n${JSON.stringify(makePayload('conv-2'))}\n`);
    upsertConversation.mockResolvedValue({ success: true, message: 'ok', new_messages: 1, total_messages: 1 });
    const { logger } = await import('@/utils/logger.js');
    const warn = vi.spyOn(logger, 'warn');

    const { createSyncProcessor } = await import('../syncProcessor.js');
    await createSyncProcessor().process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      { apiBaseUrl: 'http://localhost:4000', cookies: '', clientType: 'codemie-claude', version: '0.0.0', dryRun: false } as never
    );

    const warns = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();
    const records = readFileSync(conversationsFile, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { payloadId: string; status: string });
    expect(records.map((r) => [r.payloadId, r.status])).toEqual([['conv-1@0', 'success'], ['conv-2@0', 'success']]);
    expect(warns).toContain(`[conversation-sync] Skipped 1 corrupted JSONL lines in ${conversationsFile}`);
  });

  it('keeps a payload appended while the first one was being sent', async () => {
    writeFileSync(conversationsFile, JSON.stringify(makePayload('conv-1')) + '\n');
    const { appendSessionFile } = await import('../../../utils/locked-jsonl.js');
    upsertConversation.mockImplementationOnce(async () => {
      await appendSessionFile('conversation', SESSION_ID, JSON.stringify(makePayload('conv-2')) + '\n');
      return { success: true, message: 'ok', new_messages: 1, total_messages: 1 };
    });
    upsertConversation.mockResolvedValue({ success: true, message: 'ok', new_messages: 1, total_messages: 1 });

    const { createSyncProcessor } = await import('../syncProcessor.js');
    const processor = createSyncProcessor();
    await processor.process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      { apiBaseUrl: 'http://localhost:4000', cookies: '', clientType: 'codemie-claude', version: '0.0.0', dryRun: false } as never
    );

    const records = readFileSync(conversationsFile, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { payloadId: string; status: string });
    expect(records.map((r) => [r.payloadId, r.status])).toEqual([['conv-1@0', 'success'], ['conv-2@0', 'pending']]);
  });

  it('persists the outcome of a payload whose own rewrite failed with the next rewrite', async () => {
    writeFileSync(conversationsFile, [makePayload('conv-1'), makePayload('conv-2')].map((p) => JSON.stringify(p) + '\n').join(''));
    const { appendSessionFile, rewriteSessionFile } = await import('../../../utils/locked-jsonl.js');
    vi.mocked(rewriteSessionFile).mockRejectedValueOnce(new Error('disk full'));
    upsertConversation.mockImplementationOnce(async () => {
      await appendSessionFile('conversation', SESSION_ID, JSON.stringify(makePayload('conv-3')) + '\n');
      return { success: true, message: 'ok', new_messages: 1, total_messages: 1 };
    });
    upsertConversation.mockResolvedValue({ success: true, message: 'ok', new_messages: 1, total_messages: 1 });

    const { createSyncProcessor } = await import('../syncProcessor.js');
    const processor = createSyncProcessor();
    await processor.process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      { apiBaseUrl: 'http://localhost:4000', cookies: '', clientType: 'codemie-claude', version: '0.0.0', dryRun: false } as never
    );

    const records = readFileSync(conversationsFile, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { payloadId: string; status: string });
    expect(records.map((r) => [r.payloadId, r.status])).toEqual([
      ['conv-1@0', 'success'],
      ['conv-2@0', 'success'],
      ['conv-3@0', 'pending'],
    ]);
  });

  async function runOnce(): Promise<{ success: boolean; message?: string }> {
    const { createSyncProcessor } = await import('../syncProcessor.js');
    return createSyncProcessor().process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      { apiBaseUrl: 'http://localhost:4000', cookies: '', clientType: 'codemie-claude', version: '0.0.0', dryRun: false } as never
    );
  }

  function readRecords(): Array<{ payloadId: string; status: string; syncAttempts?: number }> {
    return readFileSync(conversationsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  }

  it('counts a failed send once however many rewrites follow it in the run, and once more in the next run', async () => {
    writeFileSync(conversationsFile, ['conv-1', 'conv-2', 'conv-3'].map((id) => JSON.stringify(makePayload(id)) + '\n').join(''));
    upsertConversation.mockResolvedValueOnce({ success: false, message: 'server error' });
    upsertConversation.mockResolvedValue({ success: true, message: 'ok', new_messages: 1, total_messages: 1 });

    await runOnce();
    expect(readRecords()[0]).toMatchObject({ payloadId: 'conv-1@0', status: 'failed', syncAttempts: 1 });

    upsertConversation.mockResolvedValueOnce({ success: false, message: 'server error' });
    await runOnce();
    expect(readRecords()[0]).toMatchObject({ payloadId: 'conv-1@0', status: 'failed', syncAttempts: 2 });
  });

  it('stops the run as deferred when the live file is gone after a send: one warn, the next payload not sent', async () => {
    writeFileSync(conversationsFile, ['conv-1', 'conv-2'].map((id) => JSON.stringify(makePayload(id)) + '\n').join(''));
    upsertConversation.mockImplementation(async () => {
      rmSync(conversationsFile);
      return { success: true, message: 'ok', new_messages: 1, total_messages: 1 };
    });
    const { logger } = await import('@/utils/logger.js');
    const warn = vi.spyOn(logger, 'warn');

    const result = await runOnce();

    expect(upsertConversation.mock.calls.map(([conversationId]) => conversationId)).toEqual(['conv-1']);
    expect(result.message).toMatch(/^Sync deferred/);
    expect(warn.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[conversation-sync]')))
      .toEqual([expect.stringContaining(SESSION_ID)]);
    warn.mockRestore();
  });
});
