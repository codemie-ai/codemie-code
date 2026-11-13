import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

describe('CopilotCliConversationsProcessor', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'copilot-conv-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    vi.resetModules();

    const sessionsDir = join(tempHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sess-copilot.json'),
      JSON.stringify({
        sessionId: 'sess-copilot',
        agentName: 'copilot-cli',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/repo/app',
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', agentSessionId: 'cp-turn-1', retryCount: 0 },
      })
    );
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = originalCodemieHome;
    }
  });

  it('writes assistant thoughts for tool calls and stores response_time in seconds', async () => {
    const { CopilotCliConversationsProcessor } = await import('../session/processors/copilot-cli.conversations-processor.js');
    const processor = new CopilotCliConversationsProcessor();

    const parsedSession = {
      sessionId: 'sess-copilot',
      agentName: 'GitHub Copilot CLI',
      metadata: {
        createdAt: '2026-08-11T11:29:15.437Z',
        projectPath: '/repo/app',
      },
      messages: [
        {
          type: 'user',
          timestamp: '2026-08-11T11:29:21.539Z',
          message: { role: 'user', content: 'Hi' },
        },
        {
          type: 'assistant',
          timestamp: '2026-08-11T11:29:25.092Z',
          message: {
            role: 'assistant',
            model: 'gpt-5.5-2026-04-24',
            content: 'Hello there',
            toolRequests: [
              { toolCallId: 'call-1', name: 'view', arguments: { path: '/repo/app/file.ts' } },
            ],
          },
        },
      ],
      metrics: { userPrompts: [{ count: 1, text: 'Hi' }] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;

    const result = await processor.process(
      parsedSession,
      {
        agentSessionId: 'cp-turn-1',
      } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(2);

    const spool = join(tempHome, 'sessions', 'sess-copilot_conversation.jsonl');
    expect(existsSync(spool)).toBe(true);
    const [line] = readFileSync(spool, 'utf-8').trim().split('\n').map((entry) => JSON.parse(entry));
    const assistant = line.payload.history[1];

    expect(assistant.response_time).toBe(3.55);
    expect(assistant.thoughts).toHaveLength(1);
    expect(assistant.thoughts[0]).toMatchObject({
      author_type: 'Tool',
      author_name: 'view',
      input_text: JSON.stringify({ path: '/repo/app/file.ts' }, null, 2),
      metadata: {
        call_id: 'call-1',
        event_kind: 'tool_call',
      },
    });
  });

  it('reads the conversation file past a torn line and appends the next turn after it', async () => {
    const { CopilotCliConversationsProcessor } = await import('../session/processors/copilot-cli.conversations-processor.js');
    const processor = new CopilotCliConversationsProcessor();
    const turn = (n: number) => [
      { type: 'user', timestamp: `2026-08-11T11:3${n}:00.000Z`, message: { role: 'user', content: `question ${n}` } },
      {
        type: 'assistant',
        timestamp: `2026-08-11T11:3${n}:05.000Z`,
        message: { role: 'assistant', model: 'gpt-5.5-2026-04-24', content: `answer ${n}` },
      },
    ];
    const session = (messages: unknown[]) => ({
      sessionId: 'sess-copilot',
      agentName: 'GitHub Copilot CLI',
      metadata: { createdAt: '2026-08-11T11:29:15.437Z', projectPath: '/repo/app' },
      messages,
      metrics: {},
    }) as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
    const ctx = { agentSessionId: 'cp-turn-1' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;
    const spool = join(tempHome, 'sessions', 'sess-copilot_conversation.jsonl');

    await processor.process(session(turn(1)), ctx);
    await processor.process(session([...turn(1), ...turn(2)]), ctx);
    const [first, second] = readFileSync(spool, 'utf-8').trim().split('\n');
    writeFileSync(spool, `${first}\n{"payloadId":"torn\n${second}\n`);

    const result = await processor.process(session([...turn(1), ...turn(2), ...turn(3)]), ctx);

    expect(result.success).toBe(true);
    const lines = readFileSync(spool, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.slice(0, 3)).toEqual([first, '{"payloadId":"torn', second]);
    expect(JSON.parse(lines[3]).payload.history.map((h: { message: string }) => h.message)).toEqual([
      'question 3',
      'answer 3',
    ]);
  });

  describe('conversation id of a run whose transcript is another native session', () => {
    const parsedSession = {
      sessionId: 'sess-copilot',
      agentName: 'GitHub Copilot CLI',
      metadata: { createdAt: '2026-08-11T11:29:15.437Z', projectPath: '/repo/app' },
      messages: [
        { type: 'user', timestamp: '2026-08-11T11:29:21.539Z', message: { role: 'user', content: 'ALPHA' } },
        {
          type: 'assistant',
          timestamp: '2026-08-11T11:29:25.092Z',
          message: { role: 'assistant', model: 'gpt-5.5-2026-04-24', content: 'ok' },
        },
        { type: 'user', timestamp: '2026-08-11T11:30:21.539Z', message: { role: 'user', content: 'ping' } },
        {
          type: 'assistant',
          timestamp: '2026-08-11T11:30:25.092Z',
          message: { role: 'assistant', model: 'gpt-5.5-2026-04-24', content: 'pong' },
        },
      ],
      metrics: { userPrompts: [{ count: 2, text: 'ping' }] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;

    async function spooledIds(agentSessionFile: string) {
      const { CopilotCliConversationsProcessor } = await import('../session/processors/copilot-cli.conversations-processor.js');
      const ctx = {
        agentSessionId: 'sess-copilot',
        agentSessionFile,
      } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;
      await new CopilotCliConversationsProcessor().process(parsedSession, ctx);
      const spool = join(tempHome, 'sessions', 'sess-copilot_conversation.jsonl');
      return readFileSync(spool, 'utf-8')
        .trim()
        .split('\n')
        .map((entry) => JSON.parse(entry))
        .map((line) => ({ conversationId: line.payload.conversationId, payloadId: line.payloadId }));
    }

    it('goes under the session of a session-state/<uuid>/events.jsonl transcript, lower-cased', async () => {
      const ids = await spooledIds(
        '/home/u/.copilot/session-state/0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D/events.jsonl'
      );

      expect(ids).toEqual([
        {
          conversationId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
          payloadId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d@0',
        },
        {
          conversationId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
          payloadId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d@1',
        },
      ]);
    });

    it('stays under the run session when the transcript is not under session-state/<uuid>/', async () => {
      const ids = await spooledIds('/home/u/.copilot/history/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/events.jsonl');

      expect(ids).toEqual([
        { conversationId: 'sess-copilot', payloadId: 'sess-copilot@0' },
        { conversationId: 'sess-copilot', payloadId: 'sess-copilot@1' },
      ]);
    });
  });

  describe('a run\'s window over a transcript three runs share', () => {
    const exchange = (minute: number, text: string) => [
      { type: 'user', timestamp: `2026-08-11T11:${minute}:00.000Z`, message: { role: 'user', content: text } },
      {
        type: 'assistant',
        timestamp: `2026-08-11T11:${minute}:30.000Z`,
        message: { role: 'assistant', model: 'gpt-5.5-2026-04-24', content: `re ${text}` },
      },
    ];

    async function spooledPayloadIds(runWindow?: { startTime: number; upperBound?: number }) {
      const { CopilotCliConversationsProcessor } = await import('../session/processors/copilot-cli.conversations-processor.js');
      const parsedSession = {
        sessionId: 'sess-copilot',
        agentName: 'GitHub Copilot CLI',
        metadata: { createdAt: '2026-08-11T11:00:00.000Z', projectPath: '/repo/app' },
        messages: [...exchange(10, 'A'), ...exchange(20, 'C'), ...exchange(30, 'D')],
        metrics: {},
        runWindow,
      } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
      const ctx = { agentSessionId: 'cp-turn-1' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;
      await new CopilotCliConversationsProcessor().process(parsedSession, ctx);
      const spool = join(tempHome, 'sessions', 'sess-copilot_conversation.jsonl');
      if (!existsSync(spool)) return [];
      return readFileSync(spool, 'utf-8').trim().split('\n').map((entry) => JSON.parse(entry).payloadId);
    }

    it('a bounded run emits only its own turn, numbered over the full transcript', async () => {
      const ids = await spooledPayloadIds({
        startTime: Date.parse('2026-08-11T11:15:00.000Z'),
        upperBound: Date.parse('2026-08-11T11:25:00.000Z'),
      });

      expect(ids).toEqual(['cp-turn-1@1']);
    });

    it('the whole-session window emits every turn', async () => {
      const ids = await spooledPayloadIds({ startTime: -Infinity });

      expect(ids).toEqual(['cp-turn-1@0', 'cp-turn-1@1', 'cp-turn-1@2']);
    });

    it('resumes after the conversation\'s own checkpoint, not a legacy one naming another conversation', async () => {
      const record = join(tempHome, 'sessions', 'sess-copilot.json');
      writeFileSync(record, JSON.stringify({
        ...JSON.parse(readFileSync(record, 'utf-8')),
        sync: { conversations: { historyIndexByConversation: { 'cp-turn-1': 1 }, conversationId: 'other-conversation', lastSyncedHistoryIndex: 5 } },
      }));

      const ids = await spooledPayloadIds({ startTime: -Infinity });

      expect(ids).toEqual(['cp-turn-1@2']);
    });
  });

  it('does not report a dropped write as queued, so the next pass writes it', async () => {
    const { CopilotCliConversationsProcessor } = await import('../session/processors/copilot-cli.conversations-processor.js');
    const parsedSession = {
      sessionId: 'sess-copilot',
      agentName: 'GitHub Copilot CLI',
      metadata: { createdAt: '2026-08-11T11:29:15.437Z', projectPath: '/repo/app' },
      messages: [
        { type: 'user', timestamp: '2026-08-11T11:29:21.539Z', message: { role: 'user', content: 'Hi' } },
        {
          type: 'assistant',
          timestamp: '2026-08-11T11:29:25.092Z',
          message: { role: 'assistant', model: 'gpt-5.5-2026-04-24', content: 'Hello there' },
        },
      ],
      metrics: { userPrompts: [{ count: 1, text: 'Hi' }] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
    const ctx = { agentSessionId: 'cp-turn-1' } as unknown as import('../../../core/session/BaseProcessor.js').ProcessingContext;
    const record = join(tempHome, 'sessions', 'sess-copilot.json');
    const hidden = join(tempHome, 'sessions', 'completed_sess-copilot.json');
    const spool = join(tempHome, 'sessions', 'sess-copilot_conversation.jsonl');

    // A SessionEnd rename in flight: the live record is gone, so the conversation write is dropped
    renameSync(record, hidden);
    const dropped = await new CopilotCliConversationsProcessor().process(parsedSession, ctx);
    expect(dropped.success).toBe(true);
    expect(dropped.metadata?.recordsProcessed).toBe(0);
    expect(dropped.metadata?.syncUpdates).toBeUndefined();
    expect(existsSync(spool)).toBe(false);

    renameSync(hidden, record);
    const retried = await new CopilotCliConversationsProcessor().process(parsedSession, ctx);
    expect(retried.metadata?.recordsProcessed).toBe(2);
    expect(readFileSync(spool, 'utf-8').trim().split('\n')).toHaveLength(1);
  });
});
