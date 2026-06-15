import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetricDelta } from '../../../core/metrics/types.js';
import type { KimiWireEvent, KimiWireEventDisplay, KimiLoopEvent } from '../session/types.js';
import { KimiMetricsProcessor } from '../session/processors/kimi.metrics-processor.js';

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const { mockAppendDelta, mockReadAll } = vi.hoisted(() => ({
  mockAppendDelta: vi.fn<(delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>) => Promise<string>>(),
  mockReadAll: vi.fn<() => Promise<MetricDelta[]>>(),
}));

vi.mock('../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js', () => ({
  MetricsWriter: vi.fn(function (this: { appendDelta: typeof mockAppendDelta; readAll: typeof mockReadAll; getFilePath: () => string; exists: () => boolean }) {
    this.appendDelta = mockAppendDelta;
    this.readAll = mockReadAll;
    this.getFilePath = vi.fn().mockReturnValue('/tmp/test-metrics.jsonl');
    this.exists = vi.fn().mockReturnValue(false);
  }),
}));

function createProcessor(): KimiMetricsProcessor {
  return new KimiMetricsProcessor();
}

function createBaseSession(messages: unknown[] = [], metadata: Record<string, unknown> = {}): {
  sessionId: string;
  agentName: string;
  metadata: Record<string, unknown>;
  messages: unknown[];
} {
  return {
    sessionId: 'test-session',
    agentName: 'Kimi Code',
    metadata,
    messages,
  };
}

const baseContext = {
  apiBaseUrl: '',
  cookies: '',
  clientType: 'test',
  version: '0.0.0',
  dryRun: true,
};

function stepBegin(uuid: string, turnId = '0', step = 1, time = 1): KimiWireEvent {
  return { type: 'context.append_loop_event', time, event: { type: 'step.begin', uuid, turnId, step } };
}

function stepEnd(uuid: string, turnId = '0', step = 1, time = 1): KimiWireEvent {
  return { type: 'context.append_loop_event', time, event: { type: 'step.end', uuid, turnId, step } };
}

function toolCall(stepUuid: string, name: string, toolCallId: string, extra: Partial<KimiLoopEvent> = {}): KimiWireEvent {
  return { type: 'context.append_loop_event', event: { type: 'tool.call', stepUuid, name, toolCallId, ...extra } };
}

function toolResult(
  stepUuid: string,
  result: { output?: string; isError?: boolean },
  options: { toolCallId?: string; parentUuid?: string } = {},
): KimiWireEvent {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.result',
      stepUuid,
      toolCallId: options.toolCallId,
      parentUuid: options.parentUuid,
      result,
    },
  };
}

function fileIoEvent(
  stepUuid: string,
  operation: string,
  path: string,
  before?: string,
  after?: string,
): KimiWireEvent {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      stepUuid,
      name: 'Read',
      toolCallId: `${operation}-${path}`,
      display: {
        kind: 'file_io',
        operation: operation as KimiWireEventDisplay['operation'],
        path,
        before,
        after,
      },
    },
  };
}

function topLevelDisplay(stepUuid: string, display: KimiWireEventDisplay): KimiWireEvent {
  return { type: 'context.append_loop_event', event: { type: 'display.render', stepUuid }, display };
}

describe('KimiMetricsProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadAll.mockResolvedValue([]);
    mockAppendDelta.mockImplementation(async (delta) => delta.recordId);
  });

  it('shouldProcess returns true only for Kimi Code sessions', () => {
    const processor = createProcessor();

    expect(processor.shouldProcess(createBaseSession())).toBe(true);
    expect(processor.shouldProcess({ ...createBaseSession(), agentName: 'Claude Code' })).toBe(false);
    expect(processor.shouldProcess({ ...createBaseSession(), agentName: 'kimi' })).toBe(false);
  });

  it('counts tool calls from context.append_loop_event tool.call entries', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1', '0', 1, 100),
      toolCall('step-1', 'Read', 'read_1'),
      toolCall('step-1', 'Write', 'write_1'),
      toolCall('step-1', 'Read', 'read_2'),
      stepEnd('step-1', '0', 1, 101),
    ]);

    const result = await processor.process(session, baseContext);

    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(5);
    expect(session.metrics?.tools).toEqual({ Read: 2, Write: 1 });
  });

  it('tracks tool success and failure from tool.result entries', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      toolCall('step-1', 'Read', 'read_1'),
      toolResult('step-1', { output: 'ok', isError: false }, { toolCallId: 'read_1' }),
      toolCall('step-1', 'Write', 'write_1'),
      toolResult('step-1', { output: 'failed', isError: true }, { toolCallId: 'write_1' }),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.toolStatus).toEqual({
      Read: { success: 1, failure: 0 },
      Write: { success: 0, failure: 1 },
    });
  });

  it('matches tool results to tool calls via parentUuid fallback', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      toolCall('step-1', 'Read', 'tool_1', { uuid: 'call-1' }),
      toolResult('step-1', { output: 'ok', isError: false }, { parentUuid: 'call-1' }),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.toolStatus?.Read?.success).toBe(1);
    expect(session.metrics?.toolStatus?.Read?.failure).toBe(0);
  });

  it('captures file operations from nested event.display.kind file_io entries', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      fileIoEvent('step-1', 'read', '/Users/alice/project/src/index.ts'),
      fileIoEvent('step-1', 'write', '/Users/alice/project/src/index.ts'),
      fileIoEvent('step-1', 'edit', '/Users/alice/project/src/other.ts'),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.fileOperations).toEqual([
      { type: 'read', path: '/Users/alice/project/src/index.ts', language: 'typescript', format: 'ts' },
      { type: 'write', path: '/Users/alice/project/src/index.ts', language: 'typescript', format: 'ts' },
      { type: 'edit', path: '/Users/alice/project/src/other.ts', language: 'typescript', format: 'ts' },
    ]);
  });

  it('still supports legacy top-level display for backward compatibility', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      topLevelDisplay('step-1', { kind: 'file_io', operation: 'read', path: '/Users/alice/project/src/index.ts' }),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.fileOperations).toEqual([
      { type: 'read', path: '/Users/alice/project/src/index.ts', language: 'typescript', format: 'ts' },
    ]);
  });

  it('ignores unsupported display operations', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      fileIoEvent('step-1', 'copy', '/tmp/file.ts'),
      topLevelDisplay('step-1', { kind: 'brief', text: 'noop' }),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.fileOperations).toEqual([]);
  });

  it('derives language and format from file paths', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      fileIoEvent('step-1', 'read', '/Users/alice/project/main.py'),
      fileIoEvent('step-1', 'read', '/Users/alice/project/README.md'),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.fileOperations).toEqual([
      { type: 'read', path: '/Users/alice/project/main.py', language: 'python', format: 'py' },
      { type: 'read', path: '/Users/alice/project/README.md', language: 'markdown', format: 'md' },
    ]);
  });

  it('computes line changes when before/after are provided', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      fileIoEvent(
        'step-1',
        'write',
        '/Users/alice/project/src/index.ts',
        "export const version = '1.0.0';\n",
        "export const version = '1.1.0';\nexport const name = 'app';\n",
      ),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.fileOperations).toEqual([
      {
        type: 'write',
        path: '/Users/alice/project/src/index.ts',
        language: 'typescript',
        format: 'ts',
        linesAdded: 1,
        linesRemoved: 0,
        linesModified: 1,
      },
    ]);
  });

  it('extracts user prompts from turn.prompt events', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Please read src/index.ts' }],
        origin: { kind: 'user' },
        time: 1781368649424,
      },
      stepBegin('step-1'),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.userPrompts).toEqual([{ count: 1, text: 'Please read src/index.ts' }]);
  });

  it('extracts user prompts from context.append_message role=user events', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Update the file' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: 1781368649424,
      },
      stepBegin('step-1'),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.userPrompts).toEqual([{ count: 1, text: 'Update the file' }]);
  });

  it('extracts skill invocations from Skill tool calls', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      toolCall('step-1', 'Skill', 'skill_1', { args: { skill: 'systematic-debugging' } }),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.skillInvocations).toEqual({ 'systematic-debugging': 1 });
  });

  it('extracts agent invocations from Agent tool calls', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-1'),
      toolCall('step-1', 'Agent', 'agent_1', { args: { subagent_type: 'explore', prompt: 'Explore the codebase' } }),
      toolCall('step-1', 'AgentSwarm', 'agent_2', { args: { subagent_type: 'coder' } }),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.agentInvocations).toEqual({ explore: 1, coder: 1 });
  });

  it('extracts slash commands from user prompts', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: '/pm create a new feature' }],
        origin: { kind: 'user' },
        time: 1781368649424,
      },
      stepBegin('step-1'),
      stepEnd('step-1'),
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.commandInvocations).toEqual({ pm: 1 });
  });

  it('attaches slash commands only to the first step of a turn', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: '/pm create a new feature' }],
        origin: { kind: 'user' },
        time: 1,
        event: { turnId: 'turn-1' },
      },
      stepBegin('s1', 'turn-1', 1, 100),
      stepEnd('s1', 'turn-1', 1, 101),
      stepBegin('s2', 'turn-1', 2, 200),
      stepEnd('s2', 'turn-1', 2, 201),
    ]);

    await processor.process(session, baseContext);

    expect(mockAppendDelta).toHaveBeenCalledTimes(2);
    const [first, second] = mockAppendDelta.mock.calls.map((call) => call[0] as MetricDelta);
    expect(first.commandInvocations).toEqual({ pm: 1 });
    expect(second.commandInvocations).toBeUndefined();
  });

  it('includes gitBranch from session metadata', async () => {
    const processor = createProcessor();
    const session = createBaseSession(
      [
        stepBegin('step-1'),
        toolCall('step-1', 'Read', 'read_1'),
        stepEnd('step-1'),
      ],
      { gitBranch: 'feature/kimi-metrics' },
    );

    const result = await processor.process(session, baseContext);

    expect(result.success).toBe(true);
    expect(mockAppendDelta).toHaveBeenCalledTimes(1);
    expect(mockAppendDelta.mock.calls[0][0]).toMatchObject({ gitBranch: 'feature/kimi-metrics' });
  });

  it('emits one delta per completed step', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-a', '0', 1, 100),
      toolCall('step-a', 'Read', 'r1'),
      stepEnd('step-a', '0', 1, 101),
      stepBegin('step-b', '0', 1, 200),
      toolCall('step-b', 'Write', 'w1'),
      stepEnd('step-b', '0', 1, 201),
    ]);

    const result = await processor.process(session, baseContext);

    expect(result.success).toBe(true);
    expect(result.metadata?.deltasWritten).toBe(2);
    expect(mockAppendDelta).toHaveBeenCalledTimes(2);
    expect(session.metrics?.tools).toEqual({ Write: 1 });
  });

  it('skips already-processed step uuids', async () => {
    mockReadAll.mockResolvedValue([
      {
        recordId: 'step-a',
        sessionId: 'test-session',
        agentSessionId: 'test-session',
        timestamp: 1,
        tools: { Read: 1 },
        syncStatus: 'pending',
        syncAttempts: 0,
      } as MetricDelta,
    ]);

    const processor = createProcessor();
    const session = createBaseSession([
      stepBegin('step-a', '0', 1, 100),
      toolCall('step-a', 'Read', 'r1'),
      stepEnd('step-a', '0', 1, 101),
      stepBegin('step-b', '0', 1, 200),
      toolCall('step-b', 'Write', 'w1'),
      stepEnd('step-b', '0', 1, 201),
    ]);

    const result = await processor.process(session, baseContext);

    expect(result.success).toBe(true);
    expect(result.metadata?.deltasWritten).toBe(1);
    expect(mockAppendDelta).toHaveBeenCalledTimes(1);
    expect(mockAppendDelta.mock.calls[0][0].recordId).toBe('step-b');
  });

  it('attaches user prompt only to first step of a turn', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'hello world' }],
        origin: { kind: 'user' },
        time: 1,
        event: { turnId: 'turn-1' },
      },
      stepBegin('s1', 'turn-1', 1, 100),
      stepEnd('s1', 'turn-1', 1, 101),
      stepBegin('s2', 'turn-1', 2, 200),
      stepEnd('s2', 'turn-1', 2, 201),
    ]);

    await processor.process(session, baseContext);

    expect(mockAppendDelta).toHaveBeenCalledTimes(2);
    const [first, second] = mockAppendDelta.mock.calls.map((call) => call[0] as MetricDelta);
    expect(first.userPrompts).toEqual([{ count: 1, text: 'hello world' }]);
    expect(second.userPrompts).toBeUndefined();
  });
});
