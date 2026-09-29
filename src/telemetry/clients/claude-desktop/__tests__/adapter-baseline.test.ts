/**
 * ClaudeDesktopTelemetryAdapter.applyBaseline — chats that existed before the daemon started
 * are not backfilled; only content written after the cutoff is queued for sync.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const SESSION_ID = 'baseline-session';
const AGENT_SESSION_ID = 'agent-baseline';
const CUTOFF_MS = Date.parse('2026-09-29T12:00:00Z');

const at = (offsetMinutes: number) => new Date(CUTOFF_MS + offsetMinutes * 60_000).toISOString();

function userMessage(uuid: string, text: string, timestamp: string) {
  return { type: 'user', uuid, timestamp, sessionId: AGENT_SESSION_ID, message: { role: 'user', content: text } };
}

function assistantMessage(uuid: string, text: string, timestamp: string) {
  return {
    type: 'assistant',
    uuid,
    timestamp,
    sessionId: AGENT_SESSION_ID,
    message: {
      id: `msg-${uuid}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-5',
    },
  };
}

/** Two turns written a day before the daemon started, one turn right after it. */
function transcript() {
  return [
    userMessage('u1', 'first question', at(-1440)),
    assistantMessage('a1', 'first answer', at(-1439)),
    userMessage('u2', 'second question', at(-1400)),
    assistantMessage('a2', 'second answer', at(-1399)),
    userMessage('u3', 'question after the daemon started', at(1)),
    assistantMessage('a3', 'answer after the daemon started', at(2)),
  ];
}

function parsedSession(messages: unknown[]): ParsedSession {
  return {
    sessionId: SESSION_ID,
    agentName: 'claude-desktop',
    metadata: {},
    messages,
  } as unknown as ParsedSession;
}

describe('ClaudeDesktopTelemetryAdapter.applyBaseline', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;
  const sessionFile = () => join(tempHome, 'sessions', `${SESSION_ID}.json`);

  const readJsonl = (suffix: string) => {
    const path = join(tempHome, 'sessions', `${SESSION_ID}_${suffix}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'desktop-baseline-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeFileSync(sessionFile(), JSON.stringify({
      sessionId: SESSION_ID,
      agentName: 'claude-desktop',
      provider: 'ai-run-sso',
      startTime: CUTOFF_MS,
      workingDirectory: '/tmp/work',
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', agentSessionId: AGENT_SESSION_ID, retryCount: 0 },
      runtimeCheckpoint: {
        externalSessionId: 'local_baseline',
        transcriptPath: '/tmp/transcript.jsonl',
        lastDiscoveredAt: CUTOFF_MS,
        baselineCutoffMs: CUTOFF_MS
      }
    }));
    vi.resetModules();
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore temp-dir cleanup races */
    }
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  async function adapter() {
    const { ClaudeDesktopTelemetryAdapter } = await import('../ClaudeDesktopTelemetryAdapter.js');
    return new ClaudeDesktopTelemetryAdapter();
  }

  const context = { agentSessionId: AGENT_SESSION_ID, sessionId: SESSION_ID } as never;

  it('queues only the turn written after the cutoff, at its real history index', async () => {
    const desktop = await adapter();
    const session = parsedSession(transcript());

    await desktop.applyBaseline(session, CUTOFF_MS, context);
    await desktop.processParsedSession(session, context);

    const conversations = readJsonl('conversation');
    expect(conversations).toHaveLength(1);
    const history = conversations[0].payload.history;
    expect(history.map((entry: { message: string }) => entry.message)).toEqual([
      'question after the daemon started',
      'answer after the daemon started'
    ]);
    // Two turns precede it, so it lands at index 2 and never overwrites earlier history.
    expect(conversations[0].historyIndices).toEqual([2, 2]);
  });

  it('emits metrics only for the assistant response after the cutoff', async () => {
    const desktop = await adapter();
    const session = parsedSession(transcript());

    await desktop.applyBaseline(session, CUTOFF_MS, context);
    await desktop.processParsedSession(session, context);

    const deltas = readJsonl('metrics');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].recordId).toBe('a3');
  });

  it('clears the baseline marker in the same write as the sync pointers', async () => {
    const desktop = await adapter();

    await desktop.applyBaseline(parsedSession(transcript()), CUTOFF_MS, context);

    const stored = JSON.parse(readFileSync(sessionFile(), 'utf-8'));
    expect(stored.runtimeCheckpoint.baselineCutoffMs).toBeUndefined();
    expect(stored.sync.conversations).toMatchObject({ lastSyncedMessageUuid: 'a2', lastSyncedHistoryIndex: 1 });
    expect(stored.sync.metrics.processedRecordIds).toEqual(expect.arrayContaining(['msg-a1', 'msg-a2']));
    expect(stored.sync.metrics.processedRecordIds).not.toContain('msg-a3');
  });

  it('writes no pending records for the skipped history itself', async () => {
    const desktop = await adapter();
    const beforeOnly = transcript().slice(0, 4);

    await desktop.applyBaseline(parsedSession(beforeOnly), CUTOFF_MS, context);
    await desktop.processParsedSession(parsedSession(beforeOnly), context);

    expect(readJsonl('conversation')).toEqual([]);
    expect(readJsonl('metrics')).toEqual([]);
  });

  it('keeps full sync for content that is entirely after the cutoff', async () => {
    const desktop = await adapter();
    const afterOnly = transcript().slice(4);

    await desktop.applyBaseline(parsedSession(afterOnly), CUTOFF_MS, context);
    await desktop.processParsedSession(parsedSession(afterOnly), context);

    expect(readJsonl('conversation')[0].historyIndices).toEqual([0, 0]);
    expect(readJsonl('metrics')).toHaveLength(1);
  });
});
