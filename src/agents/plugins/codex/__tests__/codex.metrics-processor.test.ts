import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: (...args: unknown[]) => args,
}));

describe('CodexMetricsProcessor — per-call_id deltas', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'codex-metrics-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    // The live record the metrics writer needs: its start time and its existence
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeFileSync(join(tempHome, 'sessions', 'codemie-session-xyz.json'), JSON.stringify({ sessionId: 'codemie-session-xyz', startTime: 0 }));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  function buildSession(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: 'codemie-session-xyz',
      agentName: 'Codex CLI',
      metadata: {
        codexSessionId: '019e0e09-110a-7ce0-b17b-16f5b5dc5efb',
        projectPath: '/tmp/work',
        createdAt: '2026-05-09T12:00:00Z',
        branch: 'feat/codex-agent-plugin',
        model: 'gpt-5.4',
        ...overrides,
      },
      messages: [
        { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1' } },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'update_plan' } },
        // c2 has no output → no delta
      ],
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
  }

  it('writes one delta per function_call with gitBranch from session metadata', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = buildSession();

    const result = await new CodexMetricsProcessor().process(session, {} as never);
    expect(result.success).toBe(true);
    expect(result.metadata?.deltasWritten).toBe(1);

    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    expect(existsSync(jsonlPath)).toBe(true);

    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      recordId: 'c1',
      gitBranch: 'feat/codex-agent-plugin',
      tools: { exec_command: 1 },
      toolStatus: { exec_command: { success: 1, failure: 0 } },
      models: ['gpt-5.4'],
    });
  });

  it('writes no delta for a call whose output never arrives, and no failure', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = buildSession();

    await new CodexMetricsProcessor().process(session, {} as never);

    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.recordId)).toEqual(['c1']);
  });

  it('emits a pending call once its output appears, with success and the call line timestamp', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const processor = new CodexMetricsProcessor();
    const session = buildSession();
    (session.messages as unknown[]).length = 0;
    (session.messages as unknown[]).push({
      timestamp: '2026-05-09T12:05:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'p1', name: 'exec_command' },
    });
    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);

    const first = await processor.process(session, {} as never);
    expect(first.metadata?.deltasWritten).toBe(0);
    expect(existsSync(jsonlPath)).toBe(false);

    (session.messages as unknown[]).push({
      timestamp: '2026-05-09T12:05:09.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'p1' },
    });
    const second = await processor.process(session, {} as never);
    expect(second.metadata?.deltasWritten).toBe(1);

    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      recordId: 'p1',
      toolStatus: { exec_command: { success: 1, failure: 0 } },
    });
    expect(lines[0].timestamp).toBe(Date.parse('2026-05-09T12:05:00.000Z'));
  });

  it('takes the session_meta time for a call line without a timestamp', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = buildSession();

    await new CodexMetricsProcessor().process(session, {} as never);

    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    const line = JSON.parse(readFileSync(jsonlPath, 'utf-8').trim().split('\n')[0]);
    expect(line.timestamp).toBe(Date.parse('2026-05-09T12:00:00Z'));
  });

  it('skips function_calls already present in the JSONL on subsequent runs', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const processor = new CodexMetricsProcessor();
    const session = buildSession();

    await processor.process(session, {} as never);
    const second = await processor.process(session, {} as never);

    expect(second.success).toBe(true);
    expect(second.metadata?.deltasWritten).toBe(0);

    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('appends only newly-emitted call_ids on a partial rerun', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const processor = new CodexMetricsProcessor();
    const session = buildSession();

    await processor.process(session, {} as never);

    (session.messages as unknown[]).push(
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c3', name: 'apply_patch' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3' } }
    );

    const second = await processor.process(session, {} as never);
    expect(second.metadata?.deltasWritten).toBe(1);

    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ recordId: 'c3', tools: { apply_patch: 1 } });
  });

  it('writes calls of a resumed rollout whose time predates the record start, and dedupes them by recordId', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    // createdAt (2026-05-09) is long before the record's start
    writeFileSync(join(tempHome, 'sessions', 'codemie-session-xyz.json'), JSON.stringify({ sessionId: 'codemie-session-xyz', startTime: Date.parse('2026-10-01T00:00:00Z') }));
    const session = buildSession();

    const first = await new CodexMetricsProcessor().process(session, {} as never);
    const second = await new CodexMetricsProcessor().process(session, {} as never);

    expect(first.metadata?.deltasWritten).toBe(1);
    expect(second.metadata?.deltasWritten).toBe(0);
    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    expect(readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).recordId)).toEqual(['c1']);
  });

  it('returns success with deltasWritten=0 when there are no function_calls', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = {
      ...buildSession(),
      messages: [{ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }],
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;

    const result = await new CodexMetricsProcessor().process(session, {} as never);
    expect(result.success).toBe(true);
    expect(result.metadata?.deltasWritten).toBe(0);
  });

  it('fails gracefully when codexSessionId is missing', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = buildSession({ codexSessionId: undefined });

    const result = await new CodexMetricsProcessor().process(session, {} as never);
    expect(result.success).toBe(false);
    expect(result.metadata?.failureReason).toBe('NO_CODEX_SESSION_ID');
  });
});

describe('CodexMetricsProcessor — gitBranch fallback', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'codex-metrics-fallback-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    // The live record the metrics writer needs: its start time and its existence
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeFileSync(join(tempHome, 'sessions', 'sess-no-branch.json'), JSON.stringify({ sessionId: 'sess-no-branch', startTime: 0 }));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  it('falls back to detectGitBranch when session metadata has no branch', async () => {
    const detectGitBranch = vi.fn().mockResolvedValue('main');
    vi.doMock('../../../../utils/processes.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../../utils/processes.js')>()),
      detectGitBranch,
    }));

    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = {
      sessionId: 'sess-no-branch',
      agentName: 'Codex CLI',
      metadata: {
        codexSessionId: 'codex-x',
        projectPath: '/tmp/work',
        createdAt: '2026-05-09T12:00:00Z',
        model: 'gpt-5.4',
      },
      messages: [
        { type: 'response_item', payload: { type: 'function_call', call_id: 'cx', name: 'exec_command' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cx' } },
      ],
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;

    const result = await new CodexMetricsProcessor().process(session, {} as never);
    expect(result.success).toBe(true);

    const path = join(tempHome, 'sessions', 'sess-no-branch_metrics.jsonl');
    const line = JSON.parse(readFileSync(path, 'utf-8').trim());
    expect(line.gitBranch).toBe('main');
    expect(detectGitBranch).toHaveBeenCalledWith('/tmp/work');
  });
});
