import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../../../../agents/core/session/types.js';
import type { ProcessingContext } from '../../../../../agents/core/session/BaseProcessor.js';

const mockLoadSession = vi.fn();
const mockSaveSession = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../../agents/core/session/SessionStore.js', () => ({
  SessionStore: vi.fn(function (this: Record<string, unknown>) {
    this.loadSession = mockLoadSession;
    this.saveSession = mockSaveSession;
  })
}));

const mockMetricsShouldProcess = vi.fn().mockReturnValue(true);
const mockMetricsProcess = vi.fn().mockResolvedValue({ success: true, message: 'metrics ok' });

vi.mock('../processors/metrics/metrics-sync-processor.js', () => ({
  MetricsSyncProcessor: vi.fn(function (this: Record<string, unknown>) {
    this.name = 'metrics-sync';
    this.priority = 2;
    this.shouldProcess = mockMetricsShouldProcess;
    this.process = mockMetricsProcess;
  })
}));

const mockConvShouldProcess = vi.fn().mockReturnValue(true);
const mockConvProcess = vi.fn().mockResolvedValue({ success: true, message: 'conversations ok' });

vi.mock('../processors/conversations/syncProcessor.js', () => ({
  createSyncProcessor: vi.fn(() => ({
    name: 'conversation-sync',
    priority: 3,
    shouldProcess: mockConvShouldProcess,
    process: mockConvProcess,
  }))
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: Date.now(),
    workingDirectory: '/tmp/project',
    status: 'active',
    activeDurationMs: 0,
    correlation: {
      status: 'matched',
      agentSessionId: 'agent-session-1',
      agentSessionFile: '/tmp/transcript.jsonl',
      retryCount: 0,
    },
    ...overrides,
  };
}

const context: ProcessingContext = {
  apiBaseUrl: 'https://api.example.com',
  cookies: 'session=abc',
  clientType: 'codemie-cli',
  version: '1.0.0',
  dryRun: false,
};

describe('SessionSyncer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips all processors and reports success for an external-resume session', async () => {
    mockLoadSession.mockResolvedValue(makeSession({ origin: 'external-resume' }));

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const syncer = new SessionSyncer();
    const result = await syncer.sync('session-1', context);

    expect(result).toEqual({
      success: true,
      message: 'Sync skipped: external-resume session',
      processorResults: {},
      failedProcessors: [],
    });
    expect(mockMetricsProcess).not.toHaveBeenCalled();
    expect(mockConvProcess).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('runs processors normally for a codemie-owned session', async () => {
    mockLoadSession.mockResolvedValue(makeSession({ origin: 'codemie' }));

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const syncer = new SessionSyncer();
    const result = await syncer.sync('session-1', context);

    expect(result.success).toBe(true);
    expect(mockMetricsProcess).toHaveBeenCalledTimes(1);
    expect(mockConvProcess).toHaveBeenCalledTimes(1);
  });

  it('runs processors normally for a legacy session with no origin field (back-compat)', async () => {
    mockLoadSession.mockResolvedValue(makeSession());

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const syncer = new SessionSyncer();
    const result = await syncer.sync('session-1', context);

    expect(result.success).toBe(true);
    expect(mockMetricsProcess).toHaveBeenCalledTimes(1);
    expect(mockConvProcess).toHaveBeenCalledTimes(1);
  });
});
