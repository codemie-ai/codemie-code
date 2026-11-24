import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Session } from '../../../../../agents/core/session/types.js';
import type { ProcessingContext } from '../../../../../agents/core/session/BaseProcessor.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

// Process spawns are a boundary: a hook process's lock check must never spawn `ps`
vi.mock('@/utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/exec.js')>();
  return { ...actual, exec: vi.fn(actual.exec) };
});

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

/** Spawn-and-wait a throwaway process so its pid is guaranteed dead. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid as number));
  });
}

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
    vi.mocked(rename).mockReset();
    vi.mocked(unlink).mockReset();
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

  it('defers without sending anything when a live process holds the lock', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));

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

  it('in a hook process defers on a live pid whose lock names another start time, without spawning ps', async () => {
    const holder = JSON.stringify({ pid: process.pid, startedAt: 1 });
    writeFileSync(lockPath, holder);
    const { exec } = await import('@/utils/exec.js');

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', { ...context, hookProcess: true });

    expect(result.message).toBe('Sync in progress in another process, deferred');
    expect(mockMetricsProcess).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf-8')).toBe(holder);
    expect(vi.mocked(exec).mock.calls.filter(([command]) => command === 'ps')).toEqual([]);
  });

  it('takes over a lock whose holder pid is dead at once, syncs, and releases it', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: await exitedPid(), startedAt: Date.now() }));

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result.success).toBe(true);
    expect(mockMetricsProcess).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('defers on a lock holding only the bare pid of a live process, even one older than the age limit', async () => {
    writeFileSync(lockPath, String(process.pid));
    const staleTime = new Date(Date.now() - 130_000);
    utimesSync(lockPath, staleTime, staleTime);

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result.message).toBe('Sync in progress in another process, deferred');
    expect(mockMetricsProcess).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
  });

  it('takes over a fresh lock holding only the bare pid of a dead process, syncs, and releases it', async () => {
    writeFileSync(lockPath, String(await exitedPid()));

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result.success).toBe(true);
    expect(mockMetricsProcess).toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keeps a lock another waiter took between the stale decision and the reclaim', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: await exitedPid(), startedAt: Date.now() }));
    const newHolder = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // The other waiter judged the same dead lock, reclaimed it and created its own just before this one removes it.
    let taken = false;
    const takeOver = (path: unknown) => {
      if (path === lockPath && !taken) {
        taken = true;
        writeFileSync(lockPath, newHolder);
      }
    };
    vi.mocked(rename).mockImplementation((async (from: string, to: string) => {
      takeOver(from);
      return actual.rename(from, to);
    }) as typeof rename);
    vi.mocked(unlink).mockImplementation((async (path: string) => {
      takeOver(path);
      return actual.unlink(path);
    }) as typeof unlink);

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result.message).toBe('Sync in progress in another process, deferred');
    expect(mockMetricsProcess).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf-8')).toBe(newHolder);
  });

  it('keeps a fresh lock that names no pid', async () => {
    writeFileSync(lockPath, '');

    const { SessionSyncer } = await import('../SessionSyncer.js');
    const result = await new SessionSyncer().sync('session-1', context);

    expect(result.message).toBe('Sync in progress in another process, deferred');
    expect(mockMetricsProcess).not.toHaveBeenCalled();
  });

  it('takes over a lock that names no pid once it is stale by age, syncs, and releases it', async () => {
    writeFileSync(lockPath, '');
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
