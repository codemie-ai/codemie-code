import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const FIXTURES_DIR = join(process.cwd(), 'src', 'agents', 'plugins', 'codex', '__tests__', 'fixtures');
const REAL_ROLLOUT_FIXTURE = join(
  FIXTURES_DIR,
  'rollout-2026-05-11T11-26-55-019e1625-789d-76c0-80ab-3724b5ddb799.jsonl'
);
const LARGE_ROLLOUT_FIXTURES = [
  join(FIXTURES_DIR, 'rollout-2026-05-11T13-28-45-019e1695-0522-7c83-8b39-0dd379793f80.jsonl'),
];

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

  function buildSession(messages: unknown[], metadataOverrides?: Record<string, unknown>) {
    return {
      sessionId: 'sess-conv-1',
      agentName: 'Codex CLI',
      metadata: {
        codexSessionId: '019e-test',
        createdAt: '2026-05-09T12:00:00Z',
        model: 'gpt-5.4-2026-03-05',
        ...metadataOverrides,
      },
      messages,
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
  }

  function persistSyncStateFromPayload(sessionPath: string, payloadLine: string): void {
    const payload = JSON.parse(payloadLine);
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.sync ??= {};
    session.sync.conversations = {
      lastSyncedMessageUuid: payload.lastProcessedMessageUuid,
      lastSyncedHistoryIndex: Math.max(...(payload.historyIndices as number[])),
      conversationId: payload.payload.conversationId,
      totalMessagesSynced: payload.messageCount,
      totalSyncAttempts: payload.syncAttempts ?? 1,
      lastSyncAt: payload.timestamp,
    };
    writeFileSync(sessionPath, JSON.stringify(session));
  }

  it('appends only new messages on subsequent runs', async () => {
    const { CodexConversationsProcessor } = await import('../session/processors/codex.conversations-processor.js');
    const processor = new CodexConversationsProcessor();

    const baseMessages = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'hi there' }]
        }
      },
    ];

    const ctx = { agentSessionId: '019e-test' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;

    const first = await processor.process(buildSession(baseMessages), ctx);
    expect(first.success).toBe(true);
    expect(first.metadata?.recordsProcessed).toBe(2);

    const conversationsPathFirst = join(tempHome, 'sessions', 'sess-conv-1_conversation.jsonl');
    const sessionPath = join(tempHome, 'sessions', 'sess-conv-1.json');
    persistSyncStateFromPayload(sessionPath, readFileSync(conversationsPathFirst, 'utf-8').trim().split('\n')[0]);

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
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'hi there' }]
        }
      },
    ];

    const ctx = { agentSessionId: '019e-test' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;

    await processor.process(buildSession(baseMessages), ctx);

    const sessionPath = join(tempHome, 'sessions', 'sess-conv-1.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.sync = {
      conversations: {
        lastSyncedMessageUuid: '019e-test@1',
        lastSyncedHistoryIndex: 1,
      },
    };
    writeFileSync(sessionPath, JSON.stringify(session));

    const second = await processor.process(buildSession(baseMessages), ctx);
    expect(second.success).toBe(true);
    expect(second.metadata?.recordsProcessed).toBe(0);
  });

  it('does not emit commentary-only assistant continuation without a new final answer', async () => {
    const { CodexConversationsProcessor } = await import('../session/processors/codex.conversations-processor.js');
    const processor = new CodexConversationsProcessor();

    const initialMessages = [
      { type: 'event_msg', timestamp: '2026-05-12T17:17:13.043Z', payload: { type: 'user_message', message: 'hi' } },
      {
        type: 'response_item',
        timestamp: '2026-05-12T17:17:15.423Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Hi! What can I help with in the repo?' }]
        }
      },
    ];

    const ctx = { agentSessionId: '019e-test' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;
    const first = await processor.process(buildSession(initialMessages), ctx);
    expect(first.success).toBe(true);
    expect(first.metadata?.recordsProcessed).toBe(2);

    const conversationsPath = join(tempHome, 'sessions', 'sess-conv-1_conversation.jsonl');
    const sessionPath = join(tempHome, 'sessions', 'sess-conv-1.json');
    persistSyncStateFromPayload(sessionPath, readFileSync(conversationsPath, 'utf-8').trim().split('\n')[0]);

    const commentaryOnly = await processor.process(
      buildSession([
        ...initialMessages,
        {
          type: 'response_item',
          timestamp: '2026-05-12T17:18:19.537Z',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'Available tools in this session...' }]
          }
        },
      ]),
      ctx
    );

    expect(commentaryOnly.success).toBe(true);
    expect(commentaryOnly.metadata?.recordsProcessed).toBe(0);

    const lines = readFileSync(conversationsPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('stores commentary, reasoning, and tool activity as thoughts on the assistant final answer', async () => {
    const { CodexConversationsProcessor } = await import('../session/processors/codex.conversations-processor.js');
    const processor = new CodexConversationsProcessor();

    const messages = [
      { type: 'event_msg', timestamp: '2026-05-12T17:17:13.043Z', payload: { type: 'user_message', message: 'show tools' } },
      {
        type: 'response_item',
        timestamp: '2026-05-12T17:17:14.000Z',
        payload: {
          type: 'reasoning',
          summary: [{ text: 'Need to enumerate available tools.' }],
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-05-12T17:17:14.500Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'I will inspect the tool registry first.' }]
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-05-12T17:17:14.700Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_tools_1',
          arguments: '{"cmd":"echo tools"}'
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-05-12T17:17:15.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call_tools_1',
          output: 'tool output here'
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-05-12T17:17:15.423Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Available tool groups in this session...' }]
        }
      },
    ];

    const ctx = { agentSessionId: '019e-test' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;
    const result = await processor.process(buildSession(messages), ctx);
    expect(result.success).toBe(true);

    const conversationsPath = join(tempHome, 'sessions', 'sess-conv-1_conversation.jsonl');
    const payload = JSON.parse(readFileSync(conversationsPath, 'utf-8').trim().split('\n')[0]);
    const history = payload.payload.history;

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      role: 'User',
      message: 'show tools',
      history_index: 0,
    });
    expect(history[1]).toMatchObject({
      role: 'Assistant',
      message: 'Available tool groups in this session...',
      history_index: 0,
    });
    expect(Array.isArray(history[1].thoughts)).toBe(true);
    expect(history[1].thoughts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          author_name: 'Codex Reasoning',
          message: 'Need to enumerate available tools.',
        }),
        expect.objectContaining({
          author_name: 'Codex Commentary',
          message: 'I will inspect the tool registry first.',
        }),
        expect.objectContaining({
          author_name: 'exec_command',
          input_text: '{"cmd":"echo tools"}',
          message: 'tool output here',
        }),
      ])
    );
  });

  it('transforms a real codex rollout into Claude-compatible conversation payload without discrepancies', async () => {
    const { CodexConversationsProcessor } = await import('../session/processors/codex.conversations-processor.js');
    const processor = new CodexConversationsProcessor();

    expect(existsSync(REAL_ROLLOUT_FIXTURE)).toBe(true);

    const records = readFileSync(REAL_ROLLOUT_FIXTURE, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    const meta = records[0].payload;
    const session = buildSession(records, {
      codexSessionId: meta.id,
      createdAt: meta.timestamp,
      model: 'gpt-5.4-2026-03-05',
    });

    const ctx = { agentSessionId: meta.id } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;
    const result = await processor.process(session, ctx);

    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBeGreaterThan(0);

    const conversationsPath = join(tempHome, 'sessions', 'sess-conv-1_conversation.jsonl');
    expect(existsSync(conversationsPath)).toBe(true);

    const payload = JSON.parse(readFileSync(conversationsPath, 'utf-8').trim().split('\n')[0]);
    expect(payload.payload.conversationId).toBe(meta.id);
    expect(payload.payload.history).toHaveLength(2);

    const [userEntry, assistantEntry] = payload.payload.history;
    expect(userEntry).toMatchObject({
      role: 'User',
      message: 'show tools',
      message_raw: 'show tools',
      history_index: 0,
    });

    expect(assistantEntry.role).toBe('Assistant');
    expect(assistantEntry.message).toContain('Available tool groups in this session');
    expect(assistantEntry.message).not.toContain('Using `superpowers:brainstorming`');
    expect(assistantEntry.history_index).toBe(0);
    expect(Array.isArray(assistantEntry.thoughts)).toBe(true);

    const thoughts = assistantEntry.thoughts as Array<Record<string, unknown>>;
    const authorNames = thoughts.map((thought) => thought.author_name);

    expect(authorNames).toContain('exec_command');
    expect(authorNames).toContain('write_stdin');
    expect(authorNames).toContain('Codex Reasoning');

    const execCommandThought = thoughts.find((thought) => thought.author_name === 'exec_command');
    expect(execCommandThought).toBeDefined();
    expect(String(execCommandThought?.input_text || '')).toContain('using-superpowers');

    const writeStdinThought = thoughts.find((thought) => thought.author_name === 'write_stdin');
    expect(writeStdinThought).toBeDefined();
    expect(String(writeStdinThought?.message || '')).toContain('name: using-superpowers');

    const commentaryThoughts = thoughts.filter((thought) => thought.author_name === 'Codex Commentary');
    expect(commentaryThoughts).toHaveLength(0);
  });

  it('covers multiple largest real codex rollouts and preserves source invariants', async () => {
    const { CodexConversationsProcessor } = await import('../session/processors/codex.conversations-processor.js');
    const processor = new CodexConversationsProcessor();

    for (const rolloutPath of LARGE_ROLLOUT_FIXTURES) {
      expect(existsSync(rolloutPath)).toBe(true);
      const lines = readFileSync(rolloutPath, 'utf-8').split('\n').filter(Boolean);
      const records = lines.map((line) => JSON.parse(line));
      const meta = records[0].payload;

      const eventUsers = records.filter((record) =>
        record.type === 'event_msg' &&
        record.payload?.type === 'user_message' &&
        typeof record.payload?.message === 'string' &&
        record.payload.message.trim()
      );

      const assistantFinals = records.filter((record) =>
        record.type === 'response_item' &&
        record.payload?.type === 'message' &&
        record.payload?.role === 'assistant' &&
        record.payload?.phase === 'final_answer'
      );

      const toolCalls = records.filter((record) =>
        record.type === 'response_item' &&
        ['function_call', 'custom_tool_call', 'web_search_call'].includes(record.payload?.type)
      );

      const toolOutputs = records.filter((record) =>
        record.type === 'response_item' &&
        ['function_call_output', 'custom_tool_call_output'].includes(record.payload?.type)
      );

      const reasoningRecords = records.filter((record) =>
        record.type === 'response_item' && record.payload?.type === 'reasoning'
      );

      expect(eventUsers.length).toBeGreaterThan(0);
      expect(assistantFinals.length).toBeGreaterThan(0);
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolOutputs.length).toBeGreaterThan(0);

      const uniqueUserCount = new Set(
        eventUsers.map((record) => normalizeText(String(record.payload.message)))
      ).size;

      const uniqueAssistantFinalCount = new Set(
        assistantFinals.map((record) => normalizeText(extractAssistantText(record)))
      ).size;

      const sessionId = `sess-${meta.id}`;
      const sessionsDir = join(tempHome, 'sessions');
      const sessionPath = join(sessionsDir, `${sessionId}.json`);
      writeFileSync(
        sessionPath,
        JSON.stringify({
          sessionId,
          agentName: 'codex',
          provider: 'ai-run-sso',
          startTime: Date.now(),
          workingDirectory: meta.cwd || '/tmp/work',
          status: 'active',
          activeDurationMs: 0,
          correlation: { status: 'matched', agentSessionId: meta.id, retryCount: 0 },
        })
      );

      let previousPayloadCount = 0;
      let stagnationGuard = 0;
      const conversationsPath = join(sessionsDir, `${sessionId}_conversation.jsonl`);

      while (stagnationGuard < 1000) {
        const parsedSession = {
          sessionId,
          agentName: 'Codex CLI',
          metadata: {
            codexSessionId: meta.id,
            createdAt: meta.timestamp,
            model: 'gpt-5.4-2026-03-05',
          },
          messages: records,
          metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
        } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;

        const result = await processor.process(
          parsedSession,
          { agentSessionId: meta.id } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext
        );
        expect(result.success).toBe(true);

        if (!existsSync(conversationsPath)) {
          break;
        }

        const payloadLines = readFileSync(conversationsPath, 'utf-8').trim().split('\n').filter(Boolean);
        if (payloadLines.length === previousPayloadCount) {
          break;
        }

        previousPayloadCount = payloadLines.length;
        persistSyncStateFromPayload(sessionPath, payloadLines[payloadLines.length - 1]);
        stagnationGuard += 1;
      }

      expect(stagnationGuard).toBeLessThan(1000);
      expect(existsSync(conversationsPath)).toBe(true);

      const payloads = readFileSync(conversationsPath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(payloads.length).toBeGreaterThan(0);

      const allHistory = payloads.flatMap((payload) => payload.payload.history as Array<Record<string, unknown>>);
      const userEntries = allHistory.filter((entry) => entry.role === 'User');
      const assistantEntries = allHistory.filter((entry) => entry.role === 'Assistant');

      const transformedUserCount = new Set(
        userEntries.map((entry) => normalizeText(String(entry.message ?? '')))
      ).size;
      const transformedAssistantFinalCount = new Set(
        assistantEntries.map((entry) => normalizeText(String(entry.message ?? '')))
      ).size;

      expect(transformedUserCount).toBe(uniqueUserCount);
      expect(transformedAssistantFinalCount).toBe(uniqueAssistantFinalCount);

      for (const payload of payloads) {
        expect(payload.payload.conversationId).toBe(meta.id);
      }

      const thoughtAuthors = assistantEntries.flatMap((entry) =>
        Array.isArray(entry.thoughts)
          ? entry.thoughts.map((thought: Record<string, unknown>) => String(thought.author_name ?? ''))
          : []
      );

      if (reasoningRecords.length > 0) {
        expect(thoughtAuthors).toContain('Codex Reasoning');
      }

      if (toolCalls.length > 0) {
        expect(thoughtAuthors.some((author) => author && author !== 'Codex Reasoning')).toBe(true);
      }

      const assistantMessages = assistantEntries.map((entry) => String(entry.message ?? ''));
      for (const message of assistantMessages) {
        expect(message).not.toContain('Using `superpowers:brainstorming`');
      }
    }
  });
});

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractAssistantText(record: Record<string, unknown>): string {
  const payload = record.payload as Record<string, unknown>;
  const content = payload?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
          return String((item as Record<string, unknown>).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}
