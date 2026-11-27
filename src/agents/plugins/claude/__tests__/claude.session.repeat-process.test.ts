/**
 * Spike (EPMCDME-14384). OUTCOME: sums
 * processSession called repeatedly on one CodeMie session id with different transcripts
 * accumulates fileOperations deltas across transcripts; the same transcript twice is
 * idempotent (processedRecordIds dedupe). The claude-acp lifecycle may process every
 * transcript in time order.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const SESSION_ID = 'repeat-process-session';
const START_MS = Date.parse('2026-11-01T12:00:00Z');
const at = (m: number) => new Date(START_MS + m * 60_000).toISOString();

/** A transcript with one Write (n lines) turn. */
function transcript(tag: string, lines: number, minute: number): string {
  const agentSessionId = `agent-${tag}`;
  const rows = [
    { type: 'user', uuid: `u-${tag}`, timestamp: at(minute), sessionId: agentSessionId, message: { role: 'user', content: `go ${tag}` } },
    {
      type: 'assistant', uuid: `a-${tag}`, timestamp: at(minute + 1), sessionId: agentSessionId,
      message: {
        id: `msg-${tag}`, role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: `tool-${tag}`, name: 'Write', input: { file_path: `/tmp/${tag}.txt`, content: 'x\n'.repeat(lines) } }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    },
    {
      type: 'user', uuid: `r-${tag}`, parentUuid: `a-${tag}`, timestamp: at(minute + 1), sessionId: agentSessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${tag}`, content: 'ok' }] }
    },
    {
      type: 'assistant', uuid: `t-${tag}`, timestamp: at(minute + 2), sessionId: agentSessionId,
      message: { id: `msg-end-${tag}`, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } }
    }
  ];
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

describe('claude processSession repeated on one CodeMie id (spike)', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  const deltas = () => {
    const path = join(tempHome, 'sessions', `${SESSION_ID}_metrics.jsonl`);
    return existsSync(path)
      ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
  };
  const linesAdded = () =>
    deltas().flatMap(d => d.fileOperations ?? []).reduce((s: number, f: { linesAdded?: number }) => s + (f.linesAdded ?? 0), 0);

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'claude-repeat-process-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeFileSync(join(tempHome, 'sessions', `${SESSION_ID}.json`), JSON.stringify({
      sessionId: SESSION_ID, agentName: 'claude-acp', provider: 'ai-run-sso',
      startTime: START_MS - 24 * 60 * 60_000, workingDirectory: tempHome, status: 'active', activeDurationMs: 0,
      correlation: { status: 'pending', retryCount: 0 }
    }));
    writeFileSync(join(tempHome, 'a.jsonl'), transcript('a', 3, 1));
    writeFileSync(join(tempHome, 'b.jsonl'), transcript('b', 4, 10));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
    else delete process.env.CODEMIE_HOME;
  });

  async function process_(file: string, agentSessionId: string) {
    const { ClaudeSessionAdapter } = await import('../claude.session.js');
    const adapter = new ClaudeSessionAdapter({ name: 'claude', dataPaths: { home: '.claude' } } as never);
    return adapter.processSession(join(tempHome, file), SESSION_ID, { agentSessionId, finalPass: true } as never);
  }

  it('sums fileOperations across two distinct transcripts', async () => {
    await process_('a.jsonl', 'agent-a');
    expect(linesAdded()).toBe(3);
    await process_('b.jsonl', 'agent-b');
    expect(linesAdded()).toBe(7);
  });

  it('is idempotent when the same transcript is processed twice', async () => {
    await process_('a.jsonl', 'agent-a');
    await process_('a.jsonl', 'agent-a');
    expect(linesAdded()).toBe(3);
  });
});
