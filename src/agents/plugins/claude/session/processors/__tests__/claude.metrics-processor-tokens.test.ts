/**
 * Verifies that MetricsProcessor captures per-turn Anthropic token usage
 * (input/output/cacheRead/cacheCreation) from `message.usage` into `MetricDelta.tokens`.
 * Uses the same temp-home harness as claude.metrics-processor-clear.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/utils/security.js', () => ({
  sanitizeLogArgs: (...args: unknown[]) => args,
}));

const SESSION_ID = 'test-session-tokens';

function makeAssistantMsg(id: string, usage: Record<string, number>) {
  return {
    uuid: id,
    type: 'assistant',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      usage,
      model: 'claude-sonnet-4-6',
    },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

describe('MetricsProcessor token capture', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'metrics-tokens-test-'));
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
      agentSessionId: 'agent-tokens',
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

  it('captures input/output/cache token counts from a completed assistant message', async () => {
    const msgs = [
      makeAssistantMsg('a1', {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      }),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].tokens).toEqual({ input: 10, output: 5, cacheRead: 2, cacheCreation: 1 });
  });

  it('omits cacheRead/cacheCreation when the usage object does not carry them', async () => {
    const msgs = [makeAssistantMsg('a2', { input_tokens: 7, output_tokens: 3 })];
    const deltas = await runProcessor(msgs);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].tokens).toEqual({ input: 7, output: 3 });
  });

  it('coerces non-numeric usage fields to 0 instead of propagating strings', async () => {
    const msgs = [
      makeAssistantMsg('a3', {
        // @ts-expect-error - simulating a malformed transcript entry
        input_tokens: '12abc',
        // @ts-expect-error - simulating a malformed transcript entry
        output_tokens: null,
        cache_read_input_tokens: 4,
      }),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].tokens).toEqual({ input: 0, output: 0, cacheRead: 4 });
  });
});
