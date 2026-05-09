import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
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
        // c2 has no output → counted as failure
      ],
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
  }

  it('writes one delta per function_call with gitBranch from session metadata', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = buildSession();

    const result = await new CodexMetricsProcessor().process(session, {} as never);
    expect(result.success).toBe(true);
    expect(result.metadata?.deltasWritten).toBe(2);

    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    expect(existsSync(jsonlPath)).toBe(true);

    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      recordId: 'c1',
      gitBranch: 'feat/codex-agent-plugin',
      tools: { exec_command: 1 },
      toolStatus: { exec_command: { success: 1, failure: 0 } },
      models: ['gpt-5.4'],
    });
    expect(lines[1]).toMatchObject({
      recordId: 'c2',
      gitBranch: 'feat/codex-agent-plugin',
      tools: { update_plan: 1 },
      toolStatus: { update_plan: { success: 0, failure: 1 } },
    });
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
    expect(lines).toHaveLength(2);
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
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ recordId: 'c3', tools: { apply_patch: 1 } });
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
