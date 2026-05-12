import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

describe('CodexConversationsProcessor — incremental', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'codex-conv-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    vi.resetModules();

    // Pre-create the session record so SessionStore.loadSession returns metadata.
    const sessionsDir = join(tempHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sess-conv-1.json'),
      JSON.stringify({
        sessionId: 'sess-conv-1',
        agentName: 'codex',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/work',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', agentSessionId: '019e-test', retryCount: 0 },
      })
    );
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  function buildSession(messages: unknown[]) {
    return {
      sessionId: 'sess-conv-1',
      agentName: 'Codex CLI',
      metadata: {
        codexSessionId: '019e-test',
        createdAt: '2026-05-09T12:00:00Z',
      },
      messages,
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
  }

  it('appends only new messages on subsequent runs', async () => {
    const { CodexConversationsProcessor } = await import('../session/processors/codex.conversations-processor.js');
    const processor = new CodexConversationsProcessor();

    const baseMessages = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } },
    ];

    const ctx = { agentSessionId: '019e-test' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;

    const first = await processor.process(buildSession(baseMessages), ctx);
    expect(first.success).toBe(true);
    expect(first.metadata?.recordsProcessed).toBe(2);

    // The codex processor records the sentinel on the JSONL payload; the SSO
    // sync processor is what advances session.sync.conversations after a
    // successful upload. Simulate that here so the next run can dedup.
    const conversationsPathFirst = join(tempHome, 'sessions', 'sess-conv-1_conversation.jsonl');
    const firstPayload = JSON.parse(readFileSync(conversationsPathFirst, 'utf-8').trim().split('\n')[0]);
    const sessionPath = join(tempHome, 'sessions', 'sess-conv-1.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.sync = {
      conversations: {
        lastSyncedMessageUuid: firstPayload.lastProcessedMessageUuid,
        lastSyncedHistoryIndex: Math.max(...(firstPayload.historyIndices as number[])),
      },
    };
    writeFileSync(sessionPath, JSON.stringify(session));

    const second = await processor.process(
      buildSession([
        ...baseMessages,
        { type: 'event_msg', payload: { type: 'user_message', message: 'follow-up' } },
      ]),
      ctx
    );
    expect(second.success).toBe(true);
    expect(second.metadata?.recordsProcessed).toBe(1);

    const conversationsPath = join(tempHome, 'sessions', 'sess-conv-1_conversation.jsonl');
    expect(existsSync(conversationsPath)).toBe(true);
    const lines = readFileSync(conversationsPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].messageCount).toBe(2);
    expect(lines[0].payload.history[0]).toMatchObject({
      role: 'User',
      message: 'hello',
      message_raw: 'hello',
      history_index: 0,
    });
    expect(lines[0].payload.history[1]).toMatchObject({
      role: 'Assistant',
      message: 'hi there',
      history_index: 0,
    });
    expect(lines[1].messageCount).toBe(1);
    expect(lines[1].payload.history[0].history_index).toBe(1);
  });

  it('returns recordsProcessed=0 when there are no new messages beyond lastSyncedHistoryIndex', async () => {
    const { CodexConversationsProcessor } = await import('../session/processors/codex.conversations-processor.js');
    const processor = new CodexConversationsProcessor();

    const baseMessages = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } },
    ];

    const ctx = { agentSessionId: '019e-test' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;

    await processor.process(buildSession(baseMessages), ctx);

    // Persist the high-water mark.
    const sessionPath = join(tempHome, 'sessions', 'sess-conv-1.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.sync = {
      conversations: {
        lastSyncedMessageUuid: '019e-test@1',
        lastSyncedHistoryIndex: 1,
      },
    };
    writeFileSync(sessionPath, JSON.stringify(session));

    // Same messages again — no new content past the high-water mark.
    const second = await processor.process(buildSession(baseMessages), ctx);
    expect(second.success).toBe(true);
    expect(second.metadata?.recordsProcessed).toBe(0);
  });
});
