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
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c3', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: n.ts\n+x\n*** End Patch' }) } },
      { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c3', success: true } }
    );

    const second = await processor.process(session, {} as never);
    expect(second.metadata?.deltasWritten).toBe(1);

    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ recordId: 'c3', tools: { apply_patch: 1 }, fileOperations: [{ type: 'write', path: 'n.ts', linesAdded: 1 }] });
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

  it('writes a call before recordsBeforeMs, none at it: the next record over the same rollout owns it', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = buildSession();
    (session.messages as unknown[]).length = 0;
    for (const [callId, timestamp] of [['early', '2026-05-09T12:05:00.000Z'], ['at-bound', '2026-05-09T12:06:00.000Z']]) {
      (session.messages as unknown[]).push(
        { timestamp, type: 'response_item', payload: { type: 'function_call', call_id: callId, name: 'exec_command' } },
        { timestamp, type: 'response_item', payload: { type: 'function_call_output', call_id: callId } },
      );
    }

    const result = await new CodexMetricsProcessor().process(session, { recordsBeforeMs: Date.parse('2026-05-09T12:06:00.000Z') } as never);

    expect(result.metadata?.deltasWritten).toBe(1);
    const jsonlPath = join(tempHome, 'sessions', `${session.sessionId}_metrics.jsonl`);
    expect(readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).recordId)).toEqual(['early']);
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

describe('CodexMetricsProcessor — apply_patch deltas', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'codex-patch-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeSessionRecord(0);
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
    else delete process.env.CODEMIE_HOME;
  });

  function writeSessionRecord(startTime: number): void {
    writeFileSync(join(tempHome, 'sessions', 'codemie-session-xyz.json'), JSON.stringify({ sessionId: 'codemie-session-xyz', startTime }));
  }

  const TS = '2026-11-10T10:00:00.000Z';
  const body = (b: string): string => `*** Begin Patch\n${b}\n*** End Patch`;
  const patchCall = (callId: string, input: string, type = 'custom_tool_call', timestamp = TS): unknown => ({
    timestamp,
    type: 'response_item',
    payload: type === 'custom_tool_call'
      ? { type, status: 'completed', call_id: callId, name: 'apply_patch', input }
      : { type, call_id: callId, name: 'apply_patch', arguments: JSON.stringify({ input }) },
  });
  const endEvent = (callId: string, success: boolean): unknown => ({ type: 'event_msg', payload: { type: 'patch_apply_end', call_id: callId, success } });

  function session(messages: unknown[]): import('../../../core/session/BaseSessionAdapter.js').ParsedSession {
    return {
      sessionId: 'codemie-session-xyz',
      agentName: 'Codex CLI',
      metadata: { codexSessionId: 'codex-1', projectPath: '/tmp/work', createdAt: TS, branch: 'main', model: 'gpt-5.4' },
      messages,
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;
  }

  const readDeltas = (): Array<Record<string, any>> => {
    const path = join(tempHome, 'sessions', 'codemie-session-xyz_metrics.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it('writes one delta per apply_patch call with write, edit, delete and move operations', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const messages = [
      patchCall('add', body('*** Add File: a.ts\n+1\n+2')), endEvent('add', true),
      patchCall('upd', body('*** Update File: b.ts\n@@\n-x\n+y')), endEvent('upd', true),
      patchCall('del', body('*** Delete File: c.ts')), endEvent('del', true),
      patchCall('mov', body('*** Update File: d.ts\n*** Move to: e.ts\n@@\n-x\n+y')), endEvent('mov', true),
    ];
    const result = await new CodexMetricsProcessor().process(session(messages), {} as never);
    expect(result.metadata?.deltasWritten).toBe(4);
    const byId = Object.fromEntries(readDeltas().map((d) => [d.recordId, d]));
    expect(byId.add).toMatchObject({ tools: { apply_patch: 1 }, toolStatus: { apply_patch: { success: 1, failure: 0 } }, gitBranch: 'main' });
    expect(byId.add.fileOperations).toEqual([{ type: 'write', path: 'a.ts', linesAdded: 2, linesRemoved: 0, linesModified: 2 }]);
    expect(byId.upd.fileOperations[0]).toMatchObject({ type: 'edit', path: 'b.ts' });
    expect(byId.del.fileOperations[0]).toMatchObject({ type: 'delete', path: 'c.ts' });
    expect(byId.mov.fileOperations).toHaveLength(1);
    expect(byId.mov.fileOperations[0]).toMatchObject({ type: 'edit', path: 'e.ts' });
  });

  it('writes a failure delta without file operations for both failure shapes, and nothing for a pending call', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const records = readFileSync(join(__dirname, 'fixtures', 'apply-patch-failures.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const result = await new CodexMetricsProcessor().process(session(records), {} as never);
    expect(result.metadata?.deltasWritten).toBe(2);
    const deltas = readDeltas();
    expect(deltas.map((d) => d.recordId).sort()).toEqual(['call_fail_end', 'call_fail_exit']);
    for (const d of deltas) {
      expect(d.toolStatus).toEqual({ apply_patch: { success: 0, failure: 1 } });
      expect(d.tools).toEqual({ apply_patch: 1 });
      expect(d.fileOperations).toBeUndefined();
    }
  });

  it('counts the same call_id once across passes', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const messages = [patchCall('add', body('*** Add File: a.ts\n+1')), endEvent('add', true)];
    await new CodexMetricsProcessor().process(session(messages), {} as never);
    const second = await new CodexMetricsProcessor().process(session(messages), {} as never);
    expect(second.metadata?.deltasWritten).toBe(0);
    expect(readDeltas()).toHaveLength(1);
  });

  it('skips an apply_patch call before the run start while a shell call in the same records is written', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    writeSessionRecord(Date.parse('2026-11-10T11:00:00.000Z'));
    const messages = [
      patchCall('old', body('*** Add File: a.ts\n+1')), endEvent('old', true),
      patchCall('new', body('*** Add File: b.ts\n+1'), 'custom_tool_call', '2026-11-10T11:30:00.000Z'), endEvent('new', true),
      { timestamp: TS, type: 'response_item', payload: { type: 'function_call', call_id: 'sh', name: 'exec_command' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'function_call_output', call_id: 'sh' } },
    ];
    await new CodexMetricsProcessor().process(session(messages), {} as never);
    expect(readDeltas().map((d) => d.recordId).sort()).toEqual(['new', 'sh']);
  });

  it('yields exactly one delta for a function_call apply_patch', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const messages = [
      patchCall('fc', body('*** Add File: a.ts\n+1'), 'function_call'),
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'fc', output: 'Success' } },
    ];
    await new CodexMetricsProcessor().process(session(messages), {} as never);
    const deltas = readDeltas();
    expect(deltas).toHaveLength(1);
    expect(deltas[0].fileOperations[0]).toMatchObject({ type: 'write', path: 'a.ts' });
  });

  it('keeps loaded sub-agent apply_patch calls when the rollout family cannot be loaded', async () => {
    vi.doMock('../codex.session.js', () => ({
      loadRolloutFamilyRecords: vi.fn().mockRejectedValue(new Error('boom')),
    }));
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const parsed = session([]) as unknown as { metadata: Record<string, unknown>; subagents: unknown[] };
    parsed.metadata.rolloutPath = '/tmp/missing-rollout.jsonl';
    parsed.subagents = [
      { agentId: 'child', filePath: '/tmp/child.jsonl', messages: [patchCall('kid', body('*** Add File: k.ts\n+1')), endEvent('kid', true)] },
    ];
    await new CodexMetricsProcessor().process(parsed as never, {} as never);
    vi.doUnmock('../codex.session.js');
    expect(readDeltas().map((d) => d.recordId)).toEqual(['kid']);
  });

  it('writes the same file operations as extractCodexMetrics over the same records', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const { extractCodexMetrics } = await import('../session/codex-metrics-extractor.js');
    const messages = [
      patchCall('a', body('*** Add File: a.ts\n+1')), endEvent('a', true),
      patchCall('b', body('*** Update File: b.ts\n@@\n-x\n+y\n+z')), endEvent('b', true),
      patchCall('c', body('*** Delete File: c.ts')), endEvent('c', true),
    ];
    await new CodexMetricsProcessor().process(session(messages), {} as never);
    const fromDeltas = readDeltas().flatMap((d) => d.fileOperations ?? []);
    expect(fromDeltas).toEqual(extractCodexMetrics(messages as never).fileOperations);
  });
});

describe('CodexMetricsProcessor — parent and direct children', () => {
  let tempHome: string;
  let dayDir: string;
  let originalCodemieHome: string | undefined;

  const PARENT_ID = '01a1c558-d216-7c70-95b7-83cb9ab38a05';
  const CHILD_ID = '01a1c56c-4e89-7281-a20a-509bf93321b4';
  const body = (b: string): string => `*** Begin Patch\n${b}\n*** End Patch`;
  const line = (timestamp: string, type: string, payload: unknown): string => JSON.stringify({ timestamp, type, payload });
  const patch = (ts: string, callId: string, file: string): string[] => [
    line(ts, 'response_item', { type: 'custom_tool_call', call_id: callId, name: 'apply_patch', input: body(`*** Add File: ${file}\n+x`) }),
    line(ts, 'event_msg', { type: 'patch_apply_end', call_id: callId, success: true }),
  ];

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'codex-family-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeFileSync(join(tempHome, 'sessions', 'codemie-session-xyz.json'), JSON.stringify({ sessionId: 'codemie-session-xyz', startTime: 0 }));
    dayDir = join(tempHome, 'codex-sessions', '2026', '11', '10');
    mkdirSync(dayDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
    else delete process.env.CODEMIE_HOME;
  });

  function writeParent(): string {
    const path = join(dayDir, `rollout-2026-11-10T10-00-00-${PARENT_ID}.jsonl`);
    writeFileSync(path, [
      line('2026-11-10T10:00:00.000Z', 'session_meta', { id: PARENT_ID, timestamp: '2026-11-10T10:00:00.000Z', cwd: '/tmp/work', source: 'cli' }),
      line('2026-11-10T10:01:00.000Z', 'response_item', { type: 'function_call', call_id: 'spawn1', name: 'spawn_agent', arguments: '{"agent_type":"worker"}' }),
      line('2026-11-10T10:01:01.000Z', 'event_msg', { type: 'collab_agent_spawn_end', call_id: 'spawn1', new_thread_id: CHILD_ID }),
      line('2026-11-10T10:02:00.000Z', 'response_item', { type: 'function_call', call_id: 'wait1', name: 'wait_agent', arguments: JSON.stringify({ targets: [CHILD_ID] }) }),
      line('2026-11-10T10:03:00.000Z', 'response_item', { type: 'function_call_output', call_id: 'wait1', output: 'done' }),
      ...patch('2026-11-10T10:04:00.000Z', 'parent-patch', 'parent.ts'),
    ].join('\n') + '\n');
    return path;
  }

  function writeChild(parentId = PARENT_ID): string {
    const path = join(dayDir, `rollout-2026-11-10T10-01-30-${CHILD_ID}.jsonl`);
    writeFileSync(path, [
      line('2026-11-10T10:01:30.000Z', 'session_meta', {
        id: CHILD_ID, timestamp: '2026-11-10T10:01:30.000Z', cwd: '/tmp/work', parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      }),
      ...patch('2026-11-10T10:02:30.000Z', 'child-patch', 'child.ts'),
    ].join('\n') + '\n');
    return path;
  }

  const readIds = (): string[] => {
    const path = join(tempHome, 'sessions', 'codemie-session-xyz_metrics.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).recordId).filter((id: string) => id.endsWith('-patch')).sort() : [];
  };

  async function run(pickedPath: string): Promise<void> {
    const { CodexSessionAdapter } = await import('../codex.session.js');
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const parsed = await new CodexSessionAdapter({ name: 'codex', dataPaths: { home: '.codex', sessionsDir: 'sessions' } } as never).parseSessionFile(pickedPath, 'codemie-session-xyz');
    await new CodexMetricsProcessor().process(parsed, {} as never);
  }

  it('counts parent and child patches once across two passes', async () => {
    const parent = writeParent();
    writeChild();
    await run(parent);
    await run(parent);
    expect(readIds()).toEqual(['child-patch', 'parent-patch']);
  });

  it('still reports the parent patches when a fresh child rollout is picked over an older parent', async () => {
    writeParent();
    const child = writeChild();
    await run(child);
    expect(readIds()).toEqual(['child-patch', 'parent-patch']);
  });

  it('uses the picked rollout when no parent is found', async () => {
    const child = writeChild('01a1c558-0000-7c70-95b7-000000000000');
    await run(child);
    expect(readIds()).toEqual(['child-patch']);
  });
});
