import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
});
