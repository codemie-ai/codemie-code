import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const mockMetricsProcess = vi.fn().mockResolvedValue({ success: true, message: 'metrics ok' });

vi.mock('../processors/metrics/metrics-sync-processor.js', () => ({
  MetricsSyncProcessor: vi.fn(function (this: Record<string, unknown>) {
    this.name = 'metrics-sync';
    this.priority = 2;
    this.shouldProcess = vi.fn().mockReturnValue(true);
    this.process = mockMetricsProcess;
  })
}));

const mockConvProcess = vi.fn().mockResolvedValue({ success: true, message: 'conversations ok' });

vi.mock('../processors/conversations/syncProcessor.js', () => ({
  createSyncProcessor: vi.fn(() => ({
    name: 'conversation-sync',
    priority: 3,
    shouldProcess: vi.fn().mockReturnValue(true),
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

describe('SessionSyncer — cross-process sync lock', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;
  let lockPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = mkdtempSync(join(tmpdir(), 'session-syncer-lock-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    lockPath = join(tempHome, 'sessions', 'session-1.sync.lock');
    mockLoadSession.mockResolvedValue(makeSession());
  });

  afterEach(async () => {
    // Close logger's write stream so Windows releases the lock on the log file before rm
    const { logger } = await import('@/utils/logger.js');
    await logger.close();
    await rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (originalCodemieHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = originalCodemieHome;
    }
  });

  it('defers without sending anything when another process holds a fresh lock', async () => {
    writeFileSync(lockPath, '99999');

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result).toEqual({
      success: true,
      message: 'Sync in progress in another process, deferred',
      processorResults: {},
      failedProcessors: [],
    });
    expect(mockMetricsProcess).not.toHaveBeenCalled();
    expect(mockConvProcess).not.toHaveBeenCalled();
    // The foreign lock must not be removed
    expect(existsSync(lockPath)).toBe(true);
  });

  it('takes over a stale lock, syncs, and releases it', async () => {
    writeFileSync(lockPath, '99999');
    const staleTime = new Date(Date.now() - 130_000);
    utimesSync(lockPath, staleTime, staleTime);

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result.success).toBe(true);
    expect(mockMetricsProcess).toHaveBeenCalledTimes(1);
    expect(mockConvProcess).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('removes the lock file after a successful sync', async () => {
    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result.success).toBe(true);
    expect(mockMetricsProcess).toHaveBeenCalledTimes(1);
    expect(mockConvProcess).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});
