/**
 * A Claude transcript whose last line was cut (the agent killed mid-write) still flushes its valid lines.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { ClaudeSessionAdapter } = await import('../claude.session.js');
const { logger } = await import('@/utils/logger.js');

const SESSION_ID = 'corrupted-transcript-session';
const AGENT_SESSION_ID = 'agent-corrupted-transcript';
const START_MS = Date.parse('2026-10-31T12:00:00Z');
const at = (minutes: number) => new Date(START_MS + minutes * 60_000).toISOString();

const validLines = [
  { type: 'user', uuid: 'u-1', timestamp: at(1), sessionId: AGENT_SESSION_ID, message: { role: 'user', content: 'hello' } },
  {
    type: 'assistant', uuid: 'a-1', timestamp: at(2), sessionId: AGENT_SESSION_ID,
    message: {
      id: 'msg-a-1', role: 'assistant', model: 'claude-sonnet-5',
      content: [{ type: 'tool_use', id: 'tool-a-1', name: 'Read', input: { file_path: '/tmp/x' } }],
      usage: { input_tokens: 10, output_tokens: 5 }
    }
  },
  {
    type: 'user', uuid: 'res-a-1', parentUuid: 'a-1', timestamp: at(2), sessionId: AGENT_SESSION_ID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-a-1', content: 'ok' }] }
  },
];

describe('ClaudeSessionAdapter.processSession over a transcript with a cut last line', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'claude-corrupted-transcript-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeFileSync(join(tempHome, 'sessions', `${SESSION_ID}.json`), JSON.stringify({
      sessionId: SESSION_ID,
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: START_MS,
      workingDirectory: '/tmp/work',
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', agentSessionId: AGENT_SESSION_ID, retryCount: 0 },
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
    else delete process.env.CODEMIE_HOME;
  });

  it('skips the broken line, counts the valid ones and warns once', async () => {
    const transcript = join(tempHome, 'transcript.jsonl');
    writeFileSync(transcript, `${validLines.map((line) => JSON.stringify(line)).join('\n')}\n{"type":"user","uuid":`);
    const adapter = new ClaudeSessionAdapter({ name: 'claude', dataPaths: { home: '.claude' } } as never);

    const result = await adapter.processSession(transcript, SESSION_ID, { agentSessionId: AGENT_SESSION_ID } as never);

    expect(result.success).toBe(true);
    const deltasPath = join(tempHome, 'sessions', `${SESSION_ID}_metrics.jsonl`);
    const deltas = existsSync(deltasPath)
      ? readFileSync(deltasPath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    expect(deltas.map((delta: { recordId: string }) => delta.recordId)).toEqual(['a-1']);
    const warnings = vi.mocked(logger.warn).mock.calls.map(([line]) => String(line));
    expect(warnings.filter((line) => line.includes('Skipped 1 corrupted JSONL lines'))).toHaveLength(1);
  });
});
