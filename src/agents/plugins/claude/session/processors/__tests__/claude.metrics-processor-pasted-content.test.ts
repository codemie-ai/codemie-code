/**
 * Verifies that MetricsProcessor stores user prompts without Claude's pasted-content wrapper
 * tags while still counting every user message as a prompt.
 * Uses the same temp-home harness as claude.metrics-processor-clear.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Aliased, not relative: a relative specifier copied from the module under test is one
// directory short from here, resolves to nothing, and leaves the real file logger running —
// which opens a write stream under the temp CODEMIE_HOME that afterEach then deletes out
// from under it, failing the run with an unhandled ENOENT.
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/utils/security.js', () => ({
  sanitizeLogArgs: (...args: unknown[]) => args,
}));

const SESSION_ID = 'test-session-pasted';

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

const paste = (text: string): string => `<pasted_content id="b23a">\n${text}\n</pasted_content id="b23a">\n`;

describe('MetricsProcessor — pasted-content tags in user prompts', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'metrics-pasted-test-'));
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
      agentSessionId: 'agent-pasted',
      messages,
    } as unknown as import('@/agents/core/session/BaseSessionAdapter.js').ParsedSession;
    await new MetricsProcessor().process(session, {} as never);
    const metricsPath = join(tempHome, 'sessions', `${SESSION_ID}_metrics.jsonl`);
    if (!existsSync(metricsPath)) return [];
    return readFileSync(metricsPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const promptTexts = (delta: { userPrompts?: Array<{ text: string }> }): string[] | undefined =>
    delta.userPrompts?.map((p) => p.text);

  it('stores string-content pasted prompts without the tags', async () => {
    const msgs = [
      {
        uuid: 'u1',
        type: 'user',
        message: { role: 'user', content: paste('Step 1\nStep 2') },
        timestamp: new Date().toISOString(),
        sessionId: SESSION_ID,
      },
      makeAssistantMsg('a1'),
    ];
    const deltas = await runProcessor(msgs);
    expect(promptTexts(deltas[0])).toEqual(['Step 1\nStep 2']);
    expect(JSON.stringify(deltas[0].userPrompts)).not.toContain('pasted_content');
  });

  it('stores block-content pasted prompts without the tags', async () => {
    const deltas = await runProcessor([makeUserMsg('u1', `Run smoke\n\n${paste('A\nB')}`), makeAssistantMsg('a1')]);
    expect(promptTexts(deltas[0])).toEqual(['Run smoke\n\n\nA\nB']);
    expect(JSON.stringify(deltas[0].userPrompts)).not.toContain('pasted_content');
  });

  it('leaves a typed prompt unchanged', async () => {
    const deltas = await runProcessor([makeUserMsg('u1', '  typed prompt \n'), makeAssistantMsg('a1')]);
    expect(promptTexts(deltas[0])).toEqual(['  typed prompt \n']);
  });

  it('still counts an empty paste block as one prompt', async () => {
    const deltas = await runProcessor([
      makeUserMsg('u1', '<pasted_content id="x"></pasted_content id="x">'),
      makeAssistantMsg('a1'),
    ]);
    expect(promptTexts(deltas[0])).toEqual(['']);
  });

  it('counts one prompt per user message across pasted and typed prompts', async () => {
    const deltas = await runProcessor([
      makeUserMsg('u1', paste('pasted one')),
      makeAssistantMsg('a1'),
      makeUserMsg('u2', 'typed two'),
      makeAssistantMsg('a2'),
    ]);
    expect(deltas.flatMap((d) => promptTexts(d) ?? [])).toEqual(['pasted one', 'typed two']);
  });
});
