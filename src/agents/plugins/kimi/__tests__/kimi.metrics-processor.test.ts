import { describe, it, expect, vi } from 'vitest';
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

function createProcessor(): KimiMetricsProcessor {
  return new KimiMetricsProcessor();
}

function createBaseSession(messages: unknown[] = []): {
  sessionId: string;
  agentName: string;
  metadata: Record<string, unknown>;
  messages: unknown[];
} {
  return {
    sessionId: 'test-session',
    agentName: 'Kimi Code',
    metadata: {},
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

describe('KimiMetricsProcessor', () => {
  it('shouldProcess returns true only for Kimi Code sessions', () => {
    const processor = createProcessor();

    expect(processor.shouldProcess(createBaseSession())).toBe(true);
    expect(processor.shouldProcess({ ...createBaseSession(), agentName: 'Claude Code' })).toBe(false);
    expect(processor.shouldProcess({ ...createBaseSession(), agentName: 'kimi' })).toBe(false);
  });

  it('counts tool calls from context.append_loop_event tool.call entries', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'read_1', name: 'Read' },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'write_1', name: 'Write' },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'read_2', name: 'Read' },
      },
    ]);

    const result = await processor.process(session, baseContext);

    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(3);
    expect(session.metrics?.tools).toEqual({ Read: 2, Write: 1 });
  });

  it('tracks tool success and failure from tool.result entries', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'read_1', name: 'Read' },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'read_1',
          result: { output: 'ok', isError: false },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'write_1', name: 'Write' },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'write_1',
          result: { output: 'failed', isError: true },
        },
      },
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
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', uuid: 'call-1', toolCallId: 'tool_1', name: 'Read' },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call-1',
          result: { output: 'ok', isError: false },
        },
      },
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.toolStatus?.Read?.success).toBe(1);
    expect(session.metrics?.toolStatus?.Read?.failure).toBe(0);
  });

  it('captures file operations from display.kind file_io entries', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'context.append_loop_event',
        event: { type: 'display.render', uuid: 'display-1' },
        display: { kind: 'file_io', operation: 'read', path: '/Users/alice/project/src/index.ts' },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'display.render', uuid: 'display-2' },
        display: { kind: 'file_io', operation: 'write', path: '/Users/alice/project/src/index.ts' },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'display.render', uuid: 'display-3' },
        display: { kind: 'file_io', operation: 'edit', path: '/Users/alice/project/src/other.ts' },
      },
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.fileOperations).toEqual([
      { type: 'read', path: '/Users/alice/project/src/index.ts' },
      { type: 'write', path: '/Users/alice/project/src/index.ts' },
      { type: 'edit', path: '/Users/alice/project/src/other.ts' },
    ]);
  });

  it('ignores unsupported display operations', async () => {
    const processor = createProcessor();
    const session = createBaseSession([
      {
        type: 'context.append_loop_event',
        event: { type: 'display.render', uuid: 'display-1' },
        display: { kind: 'file_io', operation: 'delete', path: '/tmp/file.ts' },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'display.render', uuid: 'display-2' },
        display: { kind: 'brief', text: 'noop' },
      },
    ]);

    await processor.process(session, baseContext);

    expect(session.metrics?.fileOperations).toEqual([]);
  });
});
