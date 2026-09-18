/**
 * Stage-1 processor gap coverage (fixture-driven, pure).
 *
 * These processors turn a native agent transcript into MetricDelta /
 * ConversationPayloadRecord rows. The existing suites exercise them only
 * end-to-end through the session adapter (gemini) or the metrics side
 * (opencode); the conversation side of opencode and the copilot-cli metrics
 * processor had no direct coverage at all.
 *
 * This file calls `process()` on each processor directly with a minimal
 * in-memory ParsedSession and pins the emitted shape (token/tool/role fields)
 * plus the empty / malformed edge cases. Every expected value here was probed
 * against the real compiled processor first — these are regression pins of
 * today's contract, not aspirations.
 *
 * Isolation: each test uses a unique sessionId; the unit project already
 * points CODEMIE_HOME at a per-pid temp dir, and every file a processor writes
 * (metrics / conversation / session-metadata JSON) is removed in afterEach.
 *
 * @group unit
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';

import { GeminiMetricsProcessor } from '../../../src/agents/plugins/gemini/session/processors/gemini.metrics-processor.js';
import { GeminiConversationsProcessor } from '../../../src/agents/plugins/gemini/session/processors/gemini.conversations-processor.js';
import { OpenCodeConversationsProcessor } from '../../../src/agents/plugins/opencode/session/processors/opencode.conversations-processor.js';
import { CopilotCliMetricsProcessor } from '../../../src/agents/plugins/copilot-cli/session/processors/copilot-cli.metrics-processor.js';

import { SessionStore } from '../../../src/agents/core/session/SessionStore.js';
import {
  getSessionMetricsPath,
  getSessionConversationPath,
  getSessionPath,
} from '../../../src/agents/core/session/session-config.js';
import { CODEMIE_ASSISTANT_ID } from '../../../src/providers/plugins/sso/session/processors/conversations/constants.js';

import type { ParsedSession } from '../../../src/agents/core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../src/agents/core/session/BaseProcessor.js';
import type { MetricDelta } from '../../../src/agents/core/metrics/types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Session ids created during a test, so afterEach can scrub every artifact. */
const createdSessionIds: string[] = [];

function newSessionId(prefix: string): string {
  const id = `test-${prefix}-${Math.random().toString(36).slice(2)}`;
  createdSessionIds.push(id);
  return id;
}

function baseContext(sessionId: string, agentSessionId: string): ProcessingContext {
  return {
    apiBaseUrl: 'http://localhost',
    cookies: '',
    clientType: 'test-client',
    version: '1.0.0',
    dryRun: true,
    gitBranch: 'main',
    sessionId,
    agentSessionId,
  };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

afterEach(() => {
  for (const id of createdSessionIds) {
    rmSync(getSessionMetricsPath(id), { force: true });
    rmSync(getSessionConversationPath(id), { force: true });
    rmSync(getSessionPath(id), { force: true });
  }
  createdSessionIds.length = 0;
});

// ---------------------------------------------------------------------------
// Gemini metrics processor
// ---------------------------------------------------------------------------

describe('GeminiMetricsProcessor.process', () => {
  function buildSession(sessionId: string, messages: unknown[], agentSessionId?: string): ParsedSession {
    const session = {
      sessionId,
      agentName: 'Gemini',
      metadata: {},
      messages,
    } as unknown as ParsedSession;
    if (agentSessionId) (session as Record<string, unknown>).agentSessionId = agentSessionId;
    return session;
  }

  it('emits one delta per assistant turn with tools, file ops and the user prompt', async () => {
    const sessionId = newSessionId('gemini-metrics');
    const session = buildSession(
      sessionId,
      [
        { id: 'u1', type: 'user', timestamp: '2025-01-01T00:00:00Z', content: 'read the file' },
        {
          id: 'a1',
          type: 'gemini',
          timestamp: '2025-01-01T00:00:05Z',
          content: 'done',
          model: 'gemini-3-pro',
          tokens: { input: 10, output: 5, cached: 0, thoughts: 0, tool: 0, total: 15 },
          toolCalls: [
            { id: 't1', name: 'read_file', args: { file_path: 'a.ts' }, status: 'success', timestamp: '2025-01-01T00:00:04Z' },
          ],
        },
      ],
      'agent-gemini-1',
    );

    const result = await new GeminiMetricsProcessor().process(session, baseContext(sessionId, 'agent-gemini-1'));
    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(1);

    const deltas = readJsonl<MetricDelta>(getSessionMetricsPath(sessionId));
    expect(deltas).toHaveLength(1);

    const [delta] = deltas;
    // User messages never generate their own delta; the prompt rides on the reply.
    expect(delta.recordId).toBe('a1');
    expect(delta.sessionId).toBe(sessionId);
    // agentSessionId comes off session.agentSessionId when present.
    expect(delta.agentSessionId).toBe('agent-gemini-1');
    expect(typeof delta.timestamp).toBe('number');
    expect(delta.models).toEqual(['gemini-3-pro']);
    expect(delta.tools).toEqual({ read_file: 1 });
    expect(delta.toolStatus).toEqual({ read_file: { success: 1, failure: 0 } });
    expect(delta.fileOperations).toEqual([
      { type: 'read', path: 'a.ts', format: 'ts', language: 'typescript' },
    ]);
    expect(delta.userPrompts).toEqual([{ count: 1, text: 'read the file' }]);
    // Writer stamps sync bookkeeping.
    expect(delta.syncStatus).toBe('pending');
    expect(delta.syncAttempts).toBe(0);
  });

  it('does not carry Gemini token fields onto the delta (they are dropped by this processor)', async () => {
    const sessionId = newSessionId('gemini-metrics-tokens');
    const session = buildSession(sessionId, [
      { id: 'u1', type: 'user', timestamp: '2025-01-01T00:00:00Z', content: 'hi' },
      {
        id: 'a1',
        type: 'gemini',
        timestamp: '2025-01-01T00:00:03Z',
        content: 'hey',
        model: 'gemini-3-pro',
        tokens: { input: 100, output: 200, cached: 10, thoughts: 5, tool: 1, total: 316 },
      },
    ]);

    await new GeminiMetricsProcessor().process(session, baseContext(sessionId, sessionId));
    const [delta] = readJsonl<Record<string, unknown>>(getSessionMetricsPath(sessionId));
    expect(delta).toBeDefined();
    // Gemini metrics deltas intentionally omit tokens/cost, matching the Claude contract.
    expect(delta).not.toHaveProperty('tokens');
    expect(delta).not.toHaveProperty('cost');
  });

  it('falls back to the CodeMie sessionId for agentSessionId when the session omits one', async () => {
    const sessionId = newSessionId('gemini-metrics-fallback');
    const session = buildSession(sessionId, [
      { id: 'u1', type: 'user', timestamp: '2025-01-01T00:00:00Z', content: 'go' },
      { id: 'a1', type: 'gemini', timestamp: '2025-01-01T00:00:02Z', content: 'ok', model: 'gemini-3-pro' },
    ]);

    await new GeminiMetricsProcessor().process(session, baseContext(sessionId, 'ignored'));
    const [delta] = readJsonl<MetricDelta>(getSessionMetricsPath(sessionId));
    expect(delta.agentSessionId).toBe(sessionId);
  });

  it('writes nothing and reports zero for an empty transcript', async () => {
    const sessionId = newSessionId('gemini-metrics-empty');
    const session = buildSession(sessionId, []);

    const result = await new GeminiMetricsProcessor().process(session, baseContext(sessionId, sessionId));
    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(0);
    expect(existsSync(getSessionMetricsPath(sessionId))).toBe(false);
  });

  it('does not throw on a malformed message with a missing timestamp', async () => {
    const sessionId = newSessionId('gemini-metrics-malformed');
    // No timestamp -> new Date(undefined) -> NaN; the processor must still succeed.
    const session = buildSession(sessionId, [
      { id: 'a1', type: 'gemini', content: 'orphan reply with no prior user and no timestamp', model: 'gemini-3-pro' },
    ]);

    const result = await new GeminiMetricsProcessor().process(session, baseContext(sessionId, sessionId));
    expect(result.success).toBe(true);
    const deltas = readJsonl<MetricDelta>(getSessionMetricsPath(sessionId));
    expect(deltas).toHaveLength(1);
    // NaN timestamp is serialised to JSON null - pin that it did not crash the writer.
    expect(deltas[0].timestamp).toBeNull();
    // No preceding user message, so no prompt is attached.
    expect(deltas[0].userPrompts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gemini conversations processor
// ---------------------------------------------------------------------------

describe('GeminiConversationsProcessor.process', () => {
  const store = new SessionStore();

  async function seedSession(sessionId: string, agentSessionId: string): Promise<void> {
    await store.saveSession({
      sessionId,
      agentName: 'gemini',
      provider: 'test-provider',
      project: 'test-project',
      startTime: Date.now(),
      workingDirectory: '/test',
      gitBranch: 'main',
      status: 'active',
      correlation: {
        status: 'matched',
        agentSessionId,
        agentSessionFile: '/tmp/does-not-exist.json',
        retryCount: 0,
      },
    } as never);
  }

  function buildSession(sessionId: string, messages: unknown[]): ParsedSession {
    return { sessionId, agentName: 'gemini', metadata: {}, messages } as unknown as ParsedSession;
  }

  it('turns a user/gemini pair into a two-role ConversationPayloadRecord and advances sync state', async () => {
    const sessionId = newSessionId('gemini-conv');
    const agentSessionId = 'agent-gemini-conv';
    await seedSession(sessionId, agentSessionId);

    const session = buildSession(sessionId, [
      { id: 'u1', type: 'user', timestamp: '2025-01-01T00:00:00Z', content: 'do task' },
      {
        id: 'a1',
        type: 'gemini',
        timestamp: '2025-01-01T00:00:05Z',
        content: 'done',
        model: 'gemini-3-pro',
        toolCalls: [
          { id: 't1', name: 'read_file', args: { file_path: 'a.ts' }, status: 'success', timestamp: '2025-01-01T00:00:04Z', result: [] },
        ],
      },
    ]);

    const result = await new GeminiConversationsProcessor().process(session, baseContext(sessionId, agentSessionId));
    expect(result.success).toBe(true);
    expect(result.metadata?.turnsProcessed).toBe(1);
    expect(result.metadata?.messagesProcessed).toBe(2);

    const records = readJsonl<Record<string, any>>(getSessionConversationPath(sessionId));
    expect(records).toHaveLength(1);

    const [record] = records;
    expect(record.status).toBe('pending');
    expect(record.isTurnContinuation).toBe(false);
    expect(record.messageCount).toBe(2);
    expect(record.historyIndices).toEqual([0, 0]);
    expect(record.payload.conversationId).toBe(agentSessionId);

    const [user, assistant] = record.payload.history;
    expect(user.role).toBe('User');
    expect(user.message).toBe('do task');
    expect(user.history_index).toBe(0);
    expect(assistant.role).toBe('Assistant');
    expect(assistant.message).toBe('done');
    expect(assistant.assistant_id).toBe('5a430368-9e91-4564-be20-989803bf4da2');
    expect(assistant.response_time).toBe(5);

    // Tool call is attached as a thought on the assistant entry.
    const toolThought = assistant.thoughts.find((t: any) => t.author_type === 'Tool');
    expect(toolThought).toBeDefined();
    expect(toolThought.author_name).toBe('read_file');
    expect(toolThought.input_text).toBe(JSON.stringify({ file_path: 'a.ts' }));

    // Sync watermark advanced to the last message.
    const persisted = await store.loadSession(sessionId);
    expect(persisted?.sync?.conversations?.lastSyncedMessageUuid).toBe('a1');
    expect(persisted?.sync?.conversations?.lastSyncedHistoryIndex).toBe(0);
  });

  it('is idempotent - a second pass over the same transcript queues no new records', async () => {
    const sessionId = newSessionId('gemini-conv-idem');
    const agentSessionId = 'agent-gemini-idem';
    await seedSession(sessionId, agentSessionId);

    const messages = [
      { id: 'u1', type: 'user', timestamp: '2025-01-01T00:00:00Z', content: 'first' },
      { id: 'a1', type: 'gemini', timestamp: '2025-01-01T00:00:02Z', content: 'reply', model: 'gemini-3-pro' },
    ];

    const proc = new GeminiConversationsProcessor();
    await proc.process(buildSession(sessionId, messages), baseContext(sessionId, agentSessionId));
    const afterFirst = readJsonl(getSessionConversationPath(sessionId)).length;

    const second = await proc.process(buildSession(sessionId, messages), baseContext(sessionId, agentSessionId));
    expect(second.success).toBe(true);
    expect(second.message).toBe('No new messages');
    expect(readJsonl(getSessionConversationPath(sessionId)).length).toBe(afterFirst);
  });

  it('returns "No complete turns" and writes nothing when there is no user message', async () => {
    const sessionId = newSessionId('gemini-conv-noturn');
    await seedSession(sessionId, sessionId);

    const result = await new GeminiConversationsProcessor().process(
      buildSession(sessionId, [
        { id: 'a1', type: 'gemini', timestamp: '2025-01-01T00:00:00Z', content: 'orphan' },
      ]),
      baseContext(sessionId, sessionId),
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('No complete turns');
    expect(existsSync(getSessionConversationPath(sessionId))).toBe(false);
  });

  it('returns "No new messages" and writes nothing for an empty transcript', async () => {
    const sessionId = newSessionId('gemini-conv-empty');
    await seedSession(sessionId, sessionId);

    const result = await new GeminiConversationsProcessor().process(
      buildSession(sessionId, []),
      baseContext(sessionId, sessionId),
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('No new messages');
    expect(existsSync(getSessionConversationPath(sessionId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpenCode conversations processor
// ---------------------------------------------------------------------------

describe('OpenCodeConversationsProcessor.process', () => {
  const OC_SESSION_ID = 'ses_gap_test';

  function buildSession(
    sessionId: string,
    messages: Array<Record<string, unknown>>,
    partsMap: Record<string, Array<Record<string, unknown>>>,
    metadataOverride?: Record<string, unknown>,
  ): ParsedSession {
    return {
      sessionId,
      agentName: 'OpenCode CLI',
      messages: messages as never,
      metadata: {
        storagePath: '/nonexistent/storage',
        openCodeSessionId: OC_SESSION_ID,
        projectPath: '/repo',
        partsMap,
        storageType: 'sqlite',
        ...metadataOverride,
      },
    } as unknown as ParsedSession;
  }

  const userMessage = { id: 'msg-u', sessionID: OC_SESSION_ID, role: 'user', time: { created: 1_700_000_000_000 } };
  const assistantMessage = {
    id: 'msg-a',
    sessionID: OC_SESSION_ID,
    role: 'assistant',
    time: { created: 1_700_000_005_000 },
    providerID: 'codemie-proxy',
    modelID: 'kimi-k2',
  };

  it('builds a User+Assistant payload with the tool call attached as a thought', async () => {
    const sessionId = newSessionId('oc-conv');
    const session = buildSession(
      sessionId,
      [userMessage, assistantMessage],
      {
        'msg-u': [{ id: 'pu1', messageID: 'msg-u', sessionID: OC_SESSION_ID, type: 'text', text: 'please read a.ts' }],
        'msg-a': [
          { id: 'pa1', messageID: 'msg-a', sessionID: OC_SESSION_ID, type: 'tool', callID: 'call-1', tool: 'read', state: { status: 'completed', input: { filePath: 'a.ts' }, output: 'file contents' } },
          { id: 'pa2', messageID: 'msg-a', sessionID: OC_SESSION_ID, type: 'text', text: 'I read the file' },
        ],
      },
    );

    const result = await new OpenCodeConversationsProcessor().process(session, baseContext(sessionId, OC_SESSION_ID));
    expect(result.success).toBe(true);
    expect(result.metadata?.userMessages).toBe(1);
    expect(result.metadata?.assistantMessages).toBe(1);

    const records = readJsonl<Record<string, any>>(getSessionConversationPath(sessionId));
    expect(records).toHaveLength(1);

    const [record] = records;
    expect(record.status).toBe('pending');
    expect(record.isTurnContinuation).toBe(false);
    expect(record.messageCount).toBe(2);
    // Conversation identity is the opencode ses_* id, NOT context.agentSessionId.
    expect(record.payload.conversationId).toBe(OC_SESSION_ID);
    expect(record.payload.folder).toBe('opencode');
    expect(record.payload.assistantId).toBe(CODEMIE_ASSISTANT_ID);
    expect(record.payload.llmModel).toBe('kimi-k2');

    const [user, assistant] = record.payload.history;
    expect(user.role).toBe('User');
    expect(user.message).toBe('please read a.ts');
    expect(assistant.role).toBe('Assistant');
    expect(assistant.message).toBe('I read the file');
    expect(assistant.assistant_id).toBe(CODEMIE_ASSISTANT_ID);

    const toolThought = assistant.thoughts.find((t: any) => t.author_type === 'Tool');
    expect(toolThought).toBeDefined();
    expect(toolThought.author_name).toBe('read');
    expect(toolThought.error).toBe(false);
    expect(toolThought.input_text).toBe(JSON.stringify({ filePath: 'a.ts' }));

    // Checkpoint sentinel is <ocSessionId>@<lastSourceIndex>.
    expect(record.payloadId).toBe(`${OC_SESSION_ID}@2`);
    expect(record.lastProcessedMessageUuid).toBe(`${OC_SESSION_ID}@2`);
  });

  it('marks a failed tool call as an error thought', async () => {
    const sessionId = newSessionId('oc-conv-err');
    const session = buildSession(
      sessionId,
      [userMessage, assistantMessage],
      {
        'msg-u': [{ id: 'pu1', messageID: 'msg-u', sessionID: OC_SESSION_ID, type: 'text', text: 'read missing' }],
        'msg-a': [
          { id: 'pa1', messageID: 'msg-a', sessionID: OC_SESSION_ID, type: 'tool', callID: 'call-x', tool: 'read', state: { status: 'error', input: { filePath: 'missing.ts' }, error: 'ENOENT' } },
          { id: 'pa2', messageID: 'msg-a', sessionID: OC_SESSION_ID, type: 'text', text: 'that file does not exist' },
        ],
      },
    );

    await new OpenCodeConversationsProcessor().process(session, baseContext(sessionId, OC_SESSION_ID));
    const [record] = readJsonl<Record<string, any>>(getSessionConversationPath(sessionId));
    const assistant = record.payload.history.find((h: any) => h.role === 'Assistant');
    const toolThought = assistant.thoughts.find((t: any) => t.author_type === 'Tool');
    expect(toolThought.error).toBe(true);
    // On error the tool output carries the error string.
    expect(toolThought.message).toBe('ENOENT');
  });

  it('fails cleanly when opencode metadata is missing', async () => {
    const sessionId = newSessionId('oc-conv-nometa');
    const session = {
      sessionId,
      agentName: 'OpenCode CLI',
      messages: [userMessage] as never,
      metadata: {},
    } as unknown as ParsedSession;

    const result = await new OpenCodeConversationsProcessor().process(session, baseContext(sessionId, OC_SESSION_ID));
    expect(result.success).toBe(false);
    expect(result.metadata?.failureReason).toBe('NO_OPENCODE_SESSION_ID');
    expect(existsSync(getSessionConversationPath(sessionId))).toBe(false);
  });

  it('emits nothing for an empty transcript without throwing', async () => {
    const sessionId = newSessionId('oc-conv-empty');
    const session = buildSession(sessionId, [], {});

    const result = await new OpenCodeConversationsProcessor().process(session, baseContext(sessionId, OC_SESSION_ID));
    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(0);
    expect(existsSync(getSessionConversationPath(sessionId))).toBe(false);
  });

  it('queues a user-only payload when the prompt has no assistant reply yet', async () => {
    const sessionId = newSessionId('oc-conv-noreply');
    // A brand-new user prompt is published immediately (messageCount 1, no
    // assistant entry); the reply is appended later as a turn continuation.
    const session = buildSession(
      sessionId,
      [userMessage],
      { 'msg-u': [{ id: 'pu1', messageID: 'msg-u', sessionID: OC_SESSION_ID, type: 'text', text: 'hanging prompt' }] },
    );

    const result = await new OpenCodeConversationsProcessor().process(session, baseContext(sessionId, OC_SESSION_ID));
    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(1);
    expect(result.metadata?.userMessages).toBe(1);
    expect(result.metadata?.assistantMessages).toBe(0);

    const [record] = readJsonl<Record<string, any>>(getSessionConversationPath(sessionId));
    expect(record.messageCount).toBe(1);
    expect(record.historyIndices).toEqual([0]);
    expect(record.payload.history).toHaveLength(1);
    expect(record.payload.history[0].role).toBe('User');
    expect(record.payload.history[0].message).toBe('hanging prompt');
  });
});

// ---------------------------------------------------------------------------
// Copilot CLI metrics processor
// ---------------------------------------------------------------------------

describe('CopilotCliMetricsProcessor', () => {
  const processor = new CopilotCliMetricsProcessor();
  const context = baseContext('copilot-metrics', 'copilot-agent');

  it('only runs when the session carries parsed metrics', () => {
    expect(processor.shouldProcess({ metrics: { tools: {} } } as unknown as ParsedSession)).toBe(true);
    expect(processor.shouldProcess({} as unknown as ParsedSession)).toBe(false);
  });

  it('reports the total tool-call count as recordsProcessed', async () => {
    const result = await processor.process(
      { metrics: { tools: { read: 2, write: 1, bash: 3 } } } as unknown as ParsedSession,
      context,
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(6);
  });

  it('returns zero when metrics carry no tools', async () => {
    const result = await processor.process({ metrics: {} } as unknown as ParsedSession, context);
    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(0);
  });

  it('does not throw when metrics is entirely absent (returns zero)', async () => {
    const result = await processor.process({} as unknown as ParsedSession, context);
    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(0);
  });
});
