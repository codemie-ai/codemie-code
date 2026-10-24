import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationsProcessor } from '../session/processors/claude.conversations-processor.js';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const SESSION = 'agent-file-session';

const line = (record: Record<string, unknown>): string => JSON.stringify(record);
const sidechain = (type: 'user' | 'assistant', uuid: string, content: unknown) => ({
  type,
  uuid,
  isSidechain: true,
  agentId: 'child',
  sessionId: SESSION,
  timestamp: '2026-10-01T00:00:01.000Z',
  message: { role: type, content },
});
const blob = (role: string, content: unknown) =>
  ({ type: 'api-request-blob', sessionId: SESSION, hash: 'h', message: { role, content } });

describe('ClaudeConversationsProcessor — subagent transcript lines', () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-agent-file-'));
    sessionFile = join(dir, `${SESSION}.jsonl`);
    writeFileSync(sessionFile, '');
    mkdirSync(join(dir, SESSION, 'subagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeAgentFile = (records: Record<string, unknown>[]): void => {
    writeFileSync(join(dir, SESSION, 'subagents', 'agent-child.jsonl'), records.map(line).join('\n') + '\n');
  };

  /** One main turn whose Agent call returned `agentId: child`, run through the processor's turn transform. */
  const agentThought = async (): Promise<any> => {
    const messages = [
      { type: 'user', uuid: 'm1', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant',
        uuid: 'm2',
        timestamp: '2026-10-01T00:00:00.500Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }] },
      },
      {
        type: 'user',
        uuid: 'm3',
        timestamp: '2026-10-01T00:00:02.000Z',
        toolUseResult: { agentId: 'child' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'done' }] },
      },
      {
        type: 'assistant',
        uuid: 'm4',
        timestamp: '2026-10-01T00:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
      },
    ];
    const proc = new ConversationsProcessor();
    const { history } = await (proc as any).transformMessages(
      messages, { lastSyncedHistoryIndex: -1 }, 'assistant-id', 'claude', sessionFile
    );
    const thoughts = history.flatMap((h: any) => h.thoughts ?? []);
    return thoughts.find((t: any) => t.id === 'agent-child');
  };

  it('parses an agent file whose first line is a blob and keeps no blob content', async () => {
    writeAgentFile([
      blob('user', 'BLOB PROMPT'),
      sidechain('user', 's1', 'real prompt'),
      sidechain('assistant', 's2', [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }]),
      blob('assistant', [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }]),
    ]);

    const thought = await agentThought();

    expect(thought).toBeDefined();
    expect(thought.message).toBe('real prompt');
    expect(thought.children).toHaveLength(1);
  });

  it('keeps one copy of a re-written user line', async () => {
    const prompt = sidechain('user', 's1', 'real prompt');
    writeAgentFile([prompt, sidechain('assistant', 's2', [{ type: 'text', text: 'answer' }]), prompt]);

    const thought = await agentThought();

    expect(thought.message).toBe('real prompt\n\nanswer');
  });
});
