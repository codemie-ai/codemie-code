/**
 * Verifies that MetricsProcessor only processes messages from the last /clear segment.
 * Uses the same temp-home harness as claude.metrics-processor-names.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../../../utils/security.js', () => ({
  sanitizeLogArgs: (...args: unknown[]) => args,
}));

const SESSION_ID = 'test-session-clear';

function makeAssistantMsg(id: string) {
  return {
    uuid: id,
    type: 'assistant',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

function makeUserMsg(id: string, text: string) {
  return {
    uuid: id,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

function makeClearMsg() {
  return {
    uuid: 'clear-sentinel',
    type: 'user',
    message: { role: 'user', content: '<command-name>/clear</command-name>' },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

describe('MetricsProcessor — /clear boundary', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'metrics-clear-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;

    const sessionsDir = join(tempHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${SESSION_ID}.json`),
      JSON.stringify({
        sessionId: SESSION_ID,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/work',
        status: 'active',
        activeDurationMs: 0,
        sync: { metrics: { processedRecordIds: [] } },
      })
    );
    vi.resetModules();
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* ignore cleanup races */ }
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  async function runProcessor(messages: unknown[]) {
    const { MetricsProcessor } = await import('../claude.metrics-processor.js');
    const session = {
      sessionId: SESSION_ID,
      agentName: 'claude',
      agentSessionId: 'agent-clear',
      messages,
    } as unknown as import('../../../../core/session/BaseSessionAdapter.js').ParsedSession;
    await new MetricsProcessor().process(session, {} as never);
    const metricsPath = join(tempHome, 'sessions', `${SESSION_ID}_metrics.jsonl`);
    if (!existsSync(metricsPath)) return [];
    return readFileSync(metricsPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('produces one delta per assistant message when there is no /clear', async () => {
    const msgs = [
      makeUserMsg('u1', 'prompt one'),
      makeAssistantMsg('a1'),
      makeUserMsg('u2', 'prompt two'),
      makeAssistantMsg('a2'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas).toHaveLength(2);
  });

  it('only produces deltas for assistant messages after the last /clear', async () => {
    // 2 turns before /clear, 1 turn after — should see 1 delta (not 3)
    const msgs = [
      makeUserMsg('u1', 'pre-clear prompt one'),
      makeAssistantMsg('a1'),
      makeUserMsg('u2', 'pre-clear prompt two'),
      makeAssistantMsg('a2'),
      makeClearMsg(),
      makeUserMsg('u3', 'post-clear prompt'),
      makeAssistantMsg('a3'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].recordId).toBe('a3');
  });

  it('attaches only post-clear user prompts to the first delta', async () => {
    const msgs = [
      makeUserMsg('u1', 'pre-clear prompt'),
      makeAssistantMsg('a1'),
      makeClearMsg(),
      makeUserMsg('u2', 'post-clear prompt'),
      makeAssistantMsg('a2'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas).toHaveLength(1);
    const promptTexts = (deltas[0].userPrompts as Array<{ text: string }> | undefined)?.map(
      (p) => p.text
    );
    expect(promptTexts).toEqual(['post-clear prompt']);
  });

  it('handles multiple /clears — only the last segment counts', async () => {
    const msgs = [
      makeUserMsg('u1', 'segment 1'),
      makeAssistantMsg('a1'),
      makeClearMsg(),
      makeUserMsg('u2', 'segment 2'),
      makeAssistantMsg('a2'),
      makeAssistantMsg('a3'),
      makeClearMsg(),
      makeUserMsg('u3', 'segment 3'),
      makeAssistantMsg('a4'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].recordId).toBe('a4');
  });
});
