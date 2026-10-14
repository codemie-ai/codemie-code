import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const SESSION_ID = 'sess-claude-dedupe';
const AGENT_SESSION_ID = 'agent-sess-1';

const messages = [
  {
    type: 'user',
    uuid: 'u1',
    timestamp: new Date(1_700_000_000_000).toISOString(),
    message: { role: 'user', content: 'what is in this repo?' },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: new Date(1_700_000_001_000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'a CLI.' }] },
  },
];

const baseSession = {
  sessionId: SESSION_ID,
  agentName: 'claude',
  provider: 'ai-run-sso',
  startTime: 1_700_000_000_000,
  workingDirectory: '/tmp/work',
  status: 'active',
  activeDurationMs: 0,
  correlation: { status: 'matched', agentSessionId: AGENT_SESSION_ID, retryCount: 0 },
};

interface QueuedRecord {
  payloadId?: string;
  lastProcessedMessageUuid?: string;
  status: string;
}

describe('ClaudeConversationsProcessor — dedupe before append (AC5)', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;
  let conversationsFile: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'claude-conv-dedupe-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    vi.resetModules();
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    conversationsFile = join(tempHome, 'sessions', `${SESSION_ID}_conversation.jsonl`);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  async function seedSession(): Promise<void> {
    const { SessionStore } = await import('../../../core/session/SessionStore.js');
    await new SessionStore().saveSession({ ...baseSession } as never);
  }

  async function loadPointer(): Promise<string | undefined> {
    const { SessionStore } = await import('../../../core/session/SessionStore.js');
    const saved = await new SessionStore().loadSession(SESSION_ID);
    return saved?.sync?.conversations?.lastSyncedMessageUuid;
  }

  function readQueued(): QueuedRecord[] {
    if (!existsSync(conversationsFile)) return [];
    return readFileSync(conversationsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as QueuedRecord);
  }

  async function processSession(
    sessionMessages: unknown[] = messages
  ): Promise<{ success: boolean; metadata?: Record<string, unknown> }> {
    const { ConversationsProcessor } = await import('../session/processors/claude.conversations-processor.js');
    const proc = new ConversationsProcessor();
    return proc.process(
      { sessionId: SESSION_ID, agentName: 'claude', messages: sessionMessages } as never,
      { agentSessionId: AGENT_SESSION_ID } as never,
    ) as never;
  }

  interface TransformResult {
    lastProcessedMessageUuid: string;
    currentHistoryIndex: number;
  }

  async function transformFrom(
    sessionMessages: unknown[],
    syncState: { lastSyncedMessageUuid?: string; lastSyncedHistoryIndex: number }
  ): Promise<TransformResult> {
    const { ConversationsProcessor } = await import('../session/processors/claude.conversations-processor.js');
    const proc = new ConversationsProcessor() as unknown as {
      transformMessages: (...args: unknown[]) => Promise<TransformResult>;
    };
    return proc.transformMessages(sessionMessages, syncState, 'assistant-id', 'claude', undefined);
  }

  async function nextTurnUuid(): Promise<string> {
    const result = await transformFrom(messages, { lastSyncedHistoryIndex: -1 });
    return result.lastProcessedMessageUuid;
  }

  it('skips a turn whose payloadId is already queued and still advances the pointer', async () => {
    await seedSession();
    const uuid = await nextTurnUuid();
    writeFileSync(
      conversationsFile,
      JSON.stringify({
        payloadId: uuid,
        timestamp: 1_700_000_002_000,
        isTurnContinuation: false,
        historyIndices: [0, 0],
        messageCount: 2,
        lastProcessedMessageUuid: uuid,
        payload: { conversationId: AGENT_SESSION_ID, history: [] },
        status: 'success',
      }) + '\n'
    );

    const result = await processSession();

    expect(result.success).toBe(true);
    expect(readQueued()).toHaveLength(1);
    expect(await loadPointer()).toBe(uuid);
    const syncUpdates = result.metadata?.syncUpdates as { conversations: { lastSyncedMessageUuid: string } } | undefined;
    expect(syncUpdates?.conversations.lastSyncedMessageUuid).toBe(uuid);
  });

  it('still queues the next turn after skipping an already-queued one in the same drain', async () => {
    const twoTurns = [
      ...messages,
      {
        type: 'user',
        uuid: 'u2',
        timestamp: new Date(1_700_000_002_000).toISOString(),
        message: { role: 'user', content: 'and the tests?' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: new Date(1_700_000_003_000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'vitest.' }] },
      },
    ];
    await seedSession();
    const turn1 = await transformFrom(twoTurns, { lastSyncedHistoryIndex: -1 });
    const turn2 = await transformFrom(twoTurns, {
      lastSyncedMessageUuid: turn1.lastProcessedMessageUuid,
      lastSyncedHistoryIndex: turn1.currentHistoryIndex,
    });
    // Only turn 1 is queued; the session pointer is unset, so the drain starts at turn 1.
    writeFileSync(
      conversationsFile,
      JSON.stringify({
        payloadId: turn1.lastProcessedMessageUuid,
        timestamp: 1_700_000_002_000,
        isTurnContinuation: false,
        historyIndices: [0, 0],
        messageCount: 2,
        lastProcessedMessageUuid: turn1.lastProcessedMessageUuid,
        payload: { conversationId: AGENT_SESSION_ID, history: [] },
        status: 'success',
      }) + '\n'
    );

    await processSession(twoTurns);

    const queued = readQueued() as Array<QueuedRecord & { historyIndices: number[] }>;
    expect(queued).toHaveLength(2);
    expect(queued[1].payloadId).toBe(turn2.lastProcessedMessageUuid);
    expect(queued[1].payloadId).not.toBe(turn1.lastProcessedMessageUuid);
    expect(queued[1].historyIndices).toEqual([1, 1]);
    expect(await loadPointer()).toBe(turn2.lastProcessedMessageUuid);
  });

  it('queues a turn once when two hook events start from the same pointer', async () => {
    await seedSession();
    await processSession();
    // Second hook (e.g. SubagentStop) read the session before the first one saved its pointer
    await seedSession();
    await processSession();

    const queued = readQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0].payloadId).toBe(await nextTurnUuid());
  });
});
