/**
 * Claude Desktop telemetry adapter + parser + metrics tests
 * @group unit
 *
 * Covers:
 *  - claude-desktop.metrics.ts  (extractClaudeDesktopMetrics)
 *  - claude-desktop.parser.ts   (parseClaudeDesktopSession, both branches)
 *  - ClaudeDesktopTelemetryAdapter.ts (processor wiring, delegation, sync updates)
 *
 * The metrics extractor and parser run against the REAL implementations
 * (FS isolated to a unique temp dir). The adapter's Claude processors and
 * SessionStore are mocked so processParsedSession wiring can be asserted
 * deterministically without touching real analytics/session storage. The
 * logger is stubbed so no logs are written to disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Mocks (file-global). None of these are imported by the real metrics/parser
// code paths under test, so the real implementations still run for those.
// ---------------------------------------------------------------------------

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mutable shared state used to drive the mocked processors + session store.
const h = vi.hoisted(() => ({
  order: [] as string[],
  metricsShouldProcess: true,
  convShouldProcess: true,
  metricsResult: undefined as unknown,
  convResult: undefined as unknown,
  metricsThrows: undefined as Error | undefined,
  loadedSession: null as unknown,
  savedSessions: [] as unknown[],
}));

vi.mock('@/agents/plugins/claude/session/processors/claude.metrics-processor.js', () => ({
  MetricsProcessor: class {
    readonly name = 'metrics';
    readonly priority = 1;
    shouldProcess(): boolean {
      return h.metricsShouldProcess;
    }
    async process(session: unknown, context: unknown): Promise<unknown> {
      h.order.push('metrics');
      if (h.metricsThrows) throw h.metricsThrows;
      void session;
      void context;
      return h.metricsResult;
    }
  },
}));

vi.mock('@/agents/plugins/claude/session/processors/claude.conversations-processor.js', () => ({
  ConversationsProcessor: class {
    readonly name = 'conversations';
    readonly priority = 2;
    shouldProcess(): boolean {
      return h.convShouldProcess;
    }
    async process(session: unknown, context: unknown): Promise<unknown> {
      h.order.push('conversations');
      void session;
      void context;
      return h.convResult;
    }
  },
}));

vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: class {
    async loadSession(): Promise<unknown> {
      return h.loadedSession;
    }
    async saveSession(session: unknown): Promise<void> {
      h.savedSessions.push(session);
    }
  },
}));

// Discovery touches the real Claude Desktop paths on disk — stub it so the
// adapter's discoverSessions delegation can be asserted without real FS.
const discoverMock = vi.hoisted(() => vi.fn());
vi.mock('../claude-desktop.discovery.js', () => ({
  discoverClaudeDesktopSessions: discoverMock,
}));

// Real implementations under test.
import { extractClaudeDesktopMetrics } from '../claude-desktop.metrics.js';
import { parseClaudeDesktopSession } from '../claude-desktop.parser.js';
import { ClaudeDesktopTelemetryAdapter } from '../ClaudeDesktopTelemetryAdapter.js';
import type { ClaudeMessage } from '@/agents/plugins/claude/claude-message-types.js';
import type { LocalTelemetryDiscoveredSession } from '@/telemetry/runtime/types.js';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(content: unknown, extra: Partial<ClaudeMessage> = {}): ClaudeMessage {
  return {
    type: 'user',
    uuid: 'u',
    sessionId: 's',
    timestamp: '2024-01-01T00:00:00Z',
    message: { role: 'user', content: content as never },
    ...extra,
  } as ClaudeMessage;
}

const CONTEXT: ProcessingContext = {
  apiBaseUrl: 'https://example.invalid',
  cookies: '',
  clientType: 'claude-desktop',
  version: 'test',
  dryRun: true,
} as ProcessingContext;

// =============================================================================
// extractClaudeDesktopMetrics (pure)
// =============================================================================
describe('extractClaudeDesktopMetrics', () => {
  it('returns empty structures for no messages', () => {
    expect(extractClaudeDesktopMetrics([])).toEqual({
      tools: {},
      toolStatus: {},
      fileOperations: [],
    });
  });

  it('counts tool_use invocations and records success/failure from tool_result', () => {
    const messages: ClaudeMessage[] = [
      msg([
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
      ]),
      // tool_result carries status by tool_use_id (isError and is_error variants)
      msg([
        { type: 'tool_result', tool_use_id: 't1', isError: false },
        { type: 'tool_result', tool_use_id: 't2', is_error: true },
      ]),
    ];

    const metrics = extractClaudeDesktopMetrics(messages);

    expect(metrics?.tools).toEqual({ Read: 1, Bash: 1 });
    expect(metrics?.toolStatus).toEqual({
      Read: { success: 1, failure: 0 },
      Bash: { success: 0, failure: 1 },
    });
    expect(metrics?.fileOperations).toEqual([]);
  });

  it('records a 0/0 status for a tool_use with no matching result', () => {
    const metrics = extractClaudeDesktopMetrics([
      msg([{ type: 'tool_use', id: 'x', name: 'Grep', input: {} }]),
    ]);
    expect(metrics?.tools).toEqual({ Grep: 1 });
    expect(metrics?.toolStatus).toEqual({ Grep: { success: 0, failure: 0 } });
  });

  it('ignores string content and tool_use items missing name or id', () => {
    const metrics = extractClaudeDesktopMetrics([
      msg('a plain string, not an array'),
      msg([{ type: 'tool_use', name: 'NoId' }]),
      msg([{ type: 'tool_use', id: 'only-id' }]),
    ]);
    expect(metrics?.tools).toEqual({});
    expect(metrics?.toolStatus).toEqual({});
  });

  it('classifies file operations from toolUseResult.type (write/edit/delete/remove)', () => {
    const messages: ClaudeMessage[] = [
      msg([], { toolUseResult: { type: 'Write', file: { filePath: '/f/w.ts', content: '' } } }),
      msg([], { toolUseResult: { type: 'Edit', file: { filePath: '/f/e.ts', content: '' } } }),
      msg([], { toolUseResult: { type: 'delete', file: { filePath: '/f/d.ts', content: '' } } }),
      msg([], { toolUseResult: { type: 'MultiRemove', file: { filePath: '/f/r.ts', content: '' } } }),
      // read is not a mutation -> no file operation
      msg([], { toolUseResult: { type: 'read', file: { filePath: '/f/read.ts', content: '' } } }),
    ];

    const metrics = extractClaudeDesktopMetrics(messages);

    expect(metrics?.fileOperations).toEqual([
      { type: 'write', path: '/f/w.ts' },
      { type: 'edit', path: '/f/e.ts' },
      { type: 'delete', path: '/f/d.ts' },
      { type: 'delete', path: '/f/r.ts' },
    ]);
  });
});

// =============================================================================
// parseClaudeDesktopSession
// =============================================================================
describe('parseClaudeDesktopSession', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cd-parser-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function discovered(overrides: Partial<LocalTelemetryDiscoveredSession> & { transcriptPath: string }): LocalTelemetryDiscoveredSession {
    return {
      externalSessionId: 'ext',
      agentSessionId: 'cli-x',
      metadataPath: '',
      workingDirectory: '/repo',
      createdAt: 1000,
      updatedAt: 2000,
      ...overrides,
    };
  }

  describe('desktop (non-.jsonl) branch', () => {
    it('parses metadata + audit transcript into a ParsedSession', async () => {
      const metadataPath = join(dir, 'metadata.json');
      const transcriptPath = join(dir, 'transcript.log');
      writeFileSync(
        metadataPath,
        JSON.stringify({
          sessionId: 'local_x',
          cliSessionId: 'cli-x',
          createdAt: 1000,
          lastActivityAt: 2000,
          model: 'claude-sonnet',
        }),
      );
      const events = [
        { type: 'user', uuid: 'u1', session_id: 'cli-x', timestamp: '2024-01-01T00:00:00Z', cwd: '/repo', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', isError: false }] }, toolUseResult: { type: 'write', file: { filePath: '/repo/a.txt', content: 'x' } } },
        { type: 'progress', uuid: 'p1' }, // filtered out (not user/assistant/system)
      ];
      writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n'));

      const parsed = await parseClaudeDesktopSession(
        discovered({ transcriptPath, metadataPath, model: 'claude-sonnet' }),
        'codemie-sess-1',
      );

      expect(parsed.sessionId).toBe('codemie-sess-1');
      expect(parsed.agentName).toBe('claude-desktop');
      expect(parsed.agentVersion).toBeUndefined();
      // progress event dropped; only user/assistant/user remain
      expect(parsed.messages).toHaveLength(3);
      // metadata timestamps come from the discovered record, not the metadata file
      expect(parsed.metadata.projectPath).toBe(transcriptPath);
      expect(parsed.metadata.createdAt).toBe(new Date(1000).toISOString());
      expect(parsed.metadata.updatedAt).toBe(new Date(2000).toISOString());
      // metrics extracted from the normalized messages
      expect(parsed.metrics?.tools).toEqual({ Read: 1 });
      expect(parsed.metrics?.toolStatus).toEqual({ Read: { success: 1, failure: 0 } });
      expect(parsed.metrics?.fileOperations).toEqual([{ type: 'write', path: '/repo/a.txt' }]);
    });

    it('backfills the assistant message model from metadata.model', async () => {
      const metadataPath = join(dir, 'metadata.json');
      const transcriptPath = join(dir, 'transcript.log');
      writeFileSync(metadataPath, JSON.stringify({ sessionId: 'local_x', createdAt: 1, lastActivityAt: 2, model: 'claude-opus' }));
      writeFileSync(
        transcriptPath,
        JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
      );

      const parsed = await parseClaudeDesktopSession(discovered({ transcriptPath, metadataPath }), 'sess');
      const first = parsed.messages[0] as ClaudeMessage;
      expect(first.message?.model).toBe('claude-opus');
    });

    it('synthesizes a uuid and session id when the event omits them', async () => {
      const metadataPath = join(dir, 'metadata.json');
      const transcriptPath = join(dir, 'transcript.log');
      writeFileSync(metadataPath, JSON.stringify({ sessionId: 'local_x', cliSessionId: 'cli-fallback', createdAt: 1, lastActivityAt: 2 }));
      writeFileSync(
        transcriptPath,
        JSON.stringify({ type: 'system', timestamp: '2024-01-01T00:00:03Z', message: { role: 'user', content: [] } }),
      );

      const parsed = await parseClaudeDesktopSession(discovered({ transcriptPath, metadataPath }), 'sess');
      const first = parsed.messages[0] as ClaudeMessage;
      expect(first.type).toBe('system');
      expect(first.uuid).toBe('system-2024-01-01T00:00:03Z');
      expect(first.sessionId).toBe('cli-fallback');
    });

    it('returns an empty message list for a transcript with no relevant events', async () => {
      const metadataPath = join(dir, 'metadata.json');
      const transcriptPath = join(dir, 'transcript.log');
      writeFileSync(metadataPath, JSON.stringify({ sessionId: 'local_x', createdAt: 1, lastActivityAt: 2 }));
      writeFileSync(transcriptPath, JSON.stringify({ type: 'progress', uuid: 'p1' }));

      const parsed = await parseClaudeDesktopSession(discovered({ transcriptPath, metadataPath }), 'sess');
      expect(parsed.messages).toEqual([]);
      expect(parsed.metrics).toEqual({ tools: {}, toolStatus: {}, fileOperations: [] });
    });
  });

  describe('.jsonl (Claude Code) branch', () => {
    it('delegates to the Claude adapter and overrides agentName to claude-desktop', async () => {
      const transcriptPath = join(dir, 'session.jsonl');
      const rows = [
        { type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2024-02-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
        { type: 'assistant', uuid: 'a1', sessionId: 's1', timestamp: '2024-02-01T00:00:05Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      ];
      writeFileSync(transcriptPath, rows.map((r) => JSON.stringify(r)).join('\n'));

      const parsed = await parseClaudeDesktopSession(discovered({ transcriptPath }), 'codemie-2');

      expect(parsed.agentName).toBe('claude-desktop');
      expect(parsed.sessionId).toBe('codemie-2');
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.metadata.createdAt).toBe('2024-02-01T00:00:00Z');
      expect(parsed.metadata.updatedAt).toBe('2024-02-01T00:00:05Z');
      expect(parsed.metrics?.tools).toEqual({ Read: 1 });
    });

    it('backfills empty timestamps from _audit_timestamp (Cowork audit log)', async () => {
      const transcriptPath = join(dir, 'audit.jsonl');
      const rows = [
        { type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2024-02-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'assistant', uuid: 'a2', sessionId: 's1', timestamp: '', _audit_timestamp: '2024-02-01T00:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ];
      writeFileSync(transcriptPath, rows.map((r) => JSON.stringify(r)).join('\n'));

      const parsed = await parseClaudeDesktopSession(discovered({ transcriptPath }), 'codemie-3');
      const backfilled = (parsed.messages as ClaudeMessage[]).find((m) => m.uuid === 'a2');
      expect(backfilled?.timestamp).toBe('2024-02-01T00:00:09Z');
    });
  });
});

// =============================================================================
// ClaudeDesktopTelemetryAdapter
// =============================================================================
describe('ClaudeDesktopTelemetryAdapter', () => {
  let adapter: ClaudeDesktopTelemetryAdapter;

  function parsedSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
    return {
      sessionId: 'sess-1',
      agentName: 'claude-desktop',
      metadata: {},
      messages: [msg([{ type: 'text', text: 'hi' }])],
      ...overrides,
    };
  }

  beforeEach(() => {
    h.order = [];
    h.metricsShouldProcess = true;
    h.convShouldProcess = true;
    h.metricsResult = { success: true, message: 'ok', metadata: { recordsProcessed: 3 } };
    h.convResult = { success: true, message: 'ok', metadata: { recordsProcessed: 2 } };
    h.metricsThrows = undefined;
    h.loadedSession = null;
    h.savedSessions = [];
    discoverMock.mockReset();
    adapter = new ClaudeDesktopTelemetryAdapter();
  });

  it('exposes the claude-desktop client type', () => {
    expect(adapter.clientType).toBe('claude-desktop');
  });

  it('delegates discoverSessions to discoverClaudeDesktopSessions with the sinceMs cutoff', async () => {
    const rows: LocalTelemetryDiscoveredSession[] = [
      { externalSessionId: 'e', agentSessionId: 'a', transcriptPath: '/t', metadataPath: '/m', workingDirectory: '/w', createdAt: 1, updatedAt: 2 },
    ];
    discoverMock.mockResolvedValue(rows);

    const result = await adapter.discoverSessions(4242);

    expect(discoverMock).toHaveBeenCalledWith(4242);
    expect(result).toBe(rows);
  });

  it('runs both processors in priority order (metrics before conversations) and aggregates records', async () => {
    const result = await adapter.processParsedSession(parsedSession(), CONTEXT);

    expect(h.order).toEqual(['metrics', 'conversations']);
    expect(result.success).toBe(true);
    expect(result.failedProcessors).toEqual([]);
    expect(result.totalRecords).toBe(5);
    expect(result.processors.metrics).toEqual({ success: true, message: 'ok', recordsProcessed: 3 });
    expect(result.processors.conversations).toEqual({ success: true, message: 'ok', recordsProcessed: 2 });
  });

  it('marks a processor that returns success:false as failed', async () => {
    h.convResult = { success: false, message: 'boom', metadata: {} };

    const result = await adapter.processParsedSession(parsedSession(), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.failedProcessors).toEqual(['conversations']);
    expect(result.processors.conversations.success).toBe(false);
  });

  it('catches a throwing processor, records the error, and still runs the next processor', async () => {
    h.metricsThrows = new Error('kaboom');

    const result = await adapter.processParsedSession(parsedSession(), CONTEXT);

    expect(h.order).toEqual(['metrics', 'conversations']);
    expect(result.success).toBe(false);
    expect(result.failedProcessors).toContain('metrics');
    expect(result.processors.metrics).toEqual({ success: false, message: 'kaboom' });
    // conversations still ran and succeeded
    expect(result.processors.conversations.success).toBe(true);
  });

  it('skips processors whose shouldProcess returns false', async () => {
    h.metricsShouldProcess = false;

    const result = await adapter.processParsedSession(parsedSession(), CONTEXT);

    expect(h.order).toEqual(['conversations']);
    expect(result.processors.metrics).toBeUndefined();
    expect(result.totalRecords).toBe(2);
  });

  it('does not save when the session cannot be loaded for sync updates', async () => {
    h.loadedSession = null;

    await adapter.processParsedSession(parsedSession(), CONTEXT);

    expect(h.savedSessions).toHaveLength(0);
  });

  it('applies metrics + conversations syncUpdates onto the loaded session and persists it', async () => {
    h.loadedSession = { sessionId: 'sess-1' };
    h.metricsResult = {
      success: true,
      message: 'ok',
      metadata: {
        recordsProcessed: 1,
        syncUpdates: { metrics: { processedRecordIds: ['r1', 'r2'], totalDeltas: 4, lastProcessedTimestamp: 111 } },
      },
    };
    h.convResult = {
      success: true,
      message: 'ok',
      metadata: {
        recordsProcessed: 1,
        syncUpdates: { conversations: { lastSyncedMessageUuid: 'uuid-9', lastSyncedHistoryIndex: 7 } },
      },
    };

    await adapter.processParsedSession(parsedSession(), CONTEXT);

    expect(h.savedSessions).toHaveLength(1);
    const saved = h.savedSessions[0] as {
      sync: {
        metrics: { processedRecordIds: string[]; totalDeltas: number; lastProcessedTimestamp: number };
        conversations: { lastSyncedMessageUuid: string; lastSyncedHistoryIndex: number };
      };
    };
    expect(saved.sync.metrics.processedRecordIds).toEqual(['r1', 'r2']);
    expect(saved.sync.metrics.totalDeltas).toBe(4);
    expect(saved.sync.metrics.lastProcessedTimestamp).toBe(111);
    expect(saved.sync.conversations.lastSyncedMessageUuid).toBe('uuid-9');
    expect(saved.sync.conversations.lastSyncedHistoryIndex).toBe(7);
  });

  it('merges new processed record ids with existing ones without duplicates', async () => {
    h.loadedSession = {
      sessionId: 'sess-1',
      sync: { metrics: { processedRecordIds: ['r1'], totalDeltas: 2, lastProcessedTimestamp: 10, totalSynced: 0, totalFailed: 0 } },
    };
    h.metricsResult = {
      success: true,
      message: 'ok',
      metadata: { recordsProcessed: 1, syncUpdates: { metrics: { processedRecordIds: ['r1', 'r3'], totalDeltas: 3 } } },
    };
    h.convResult = { success: true, message: 'ok', metadata: {} };

    await adapter.processParsedSession(parsedSession(), CONTEXT);

    const saved = h.savedSessions[0] as { sync: { metrics: { processedRecordIds: string[]; totalDeltas: number } } };
    expect(saved.sync.metrics.processedRecordIds.sort()).toEqual(['r1', 'r3']);
    // totalDeltas accumulates on top of the existing value
    expect(saved.sync.metrics.totalDeltas).toBe(5);
  });
});
