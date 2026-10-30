import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { link, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as exec from '../exec.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile) };
});

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

function psResult(stdout: string): exec.ExecResult {
  return { code: stdout ? 0 : 1, stdout, stderr: '' };
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Spawn-and-wait a throwaway process so its pid is guaranteed dead. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid as number));
  });
}


describe('acquirePidLock', () => {
  let dir: string;
  let lockPath: string;
  const liveHolder = () => JSON.stringify({ pid: process.pid });

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'pid-lock-'));
    lockPath = join(dir, 'session.reconcile.lock');
  });

  afterEach(() => {
    vi.mocked(writeFile).mockReset();
    vi.mocked(link).mockReset();
    vi.mocked(rename).mockReset();
    vi.mocked(rm).mockReset();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires a free lock with this process identity and releases it', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');

    const lock = await acquirePidLock(lockPath, { mode: 'try' });

    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf-8'))).toEqual({ pid: process.pid, startedAt: expect.any(Number) });
    await lock!.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns null at once in try mode and at the budget in wait mode while a live holder keeps it', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, liveHolder());

    expect(await acquirePidLock(lockPath, { mode: 'try' })).toBeNull();

    const started = Date.now();
    expect(await acquirePidLock(lockPath, { mode: 'wait', budgetMs: 100 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(readFileSync(lockPath, 'utf-8')).toBe(liveHolder());
  });

  it('in wait mode stops at the earlier of the budget and the deadline', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, liveHolder());

    let started = Date.now();
    expect(await acquirePidLock(lockPath, { mode: 'wait', budgetMs: 5_000, deadlineMs: started + 100 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(Date.now() - started).toBeLessThan(600);

    started = Date.now();
    expect(await acquirePidLock(lockPath, { mode: 'wait', budgetMs: 100, deadlineMs: started + 5_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reclaims a lock whose holder pid is dead', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, JSON.stringify({ pid: await exitedPid(), startedAt: 1 }));

    const lock = await acquirePidLock(lockPath, { mode: 'try' });

    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  });

  it('reclaims a lock whose live pid has another start time', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const { acquirePidLock } = await import('../pid-lock.js');
      // The live pid started 5 s ago; the lock names a start an hour earlier: a reused pid.
      vi.spyOn(exec, 'exec').mockResolvedValue(psResult('00:05'));
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3_600_000 }));

      const lock = await acquirePidLock(lockPath, { mode: 'try' });

      expect(lock).not.toBeNull();
      expect(JSON.parse(readFileSync(lockPath, 'utf-8')).startedAt).toBeGreaterThan(Date.now() - 3_600_000);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('with pidOnlyLiveness keeps a live pid whose lock names another start time and never runs ps', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const { acquirePidLock } = await import('../pid-lock.js');
      const execSpy = vi.spyOn(exec, 'exec').mockResolvedValue(psResult('00:05'));
      const reused = JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3_600_000 });
      writeFileSync(lockPath, reused);

      expect(await acquirePidLock(lockPath, { mode: 'try', pidOnlyLiveness: true })).toBeNull();
      expect(await acquirePidLock(lockPath, { mode: 'wait', budgetMs: 100, pidOnlyLiveness: true })).toBeNull();

      expect(execSpy).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf-8')).toBe(reused);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('in wait mode stops at once on an aborted signal and on an abort while it polls', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, liveHolder());

    let started = Date.now();
    expect(await acquirePidLock(lockPath, { mode: 'wait', budgetMs: 5_000, signal: AbortSignal.abort() })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);

    const controller = new AbortController();
    // The abort lands while the wait polls the live holder's lock
    setTimeout(() => controller.abort(), 50);
    started = Date.now();
    expect(await acquirePidLock(lockPath, { mode: 'wait', budgetMs: 5_000, signal: controller.signal })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(readFileSync(lockPath, 'utf-8')).toBe(liveHolder());
  });

  it('in wait mode runs ps once per holder content and reclaims the lock when that pid dies', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)']);
    try {
      const { acquirePidLock } = await import('../pid-lock.js');
      // ps says the holder started 5 s ago, matching the start its lock names.
      const execSpy = vi.spyOn(exec, 'exec').mockResolvedValue(psResult('00:05'));
      writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, startedAt: Date.now() - 5_000 }));

      expect(await acquirePidLock(lockPath, { mode: 'wait', budgetMs: 300 })).toBeNull();
      expect(execSpy).toHaveBeenCalledTimes(1);

      const waiting = acquirePidLock(lockPath, { mode: 'wait', budgetMs: 5_000 });
      // The holder dies once this wait has judged it alive.
      await vi.waitFor(() => expect(execSpy).toHaveBeenCalledTimes(2));
      holder.kill();
      const lock = await waiting;

      expect(lock).not.toBeNull();
      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    } finally {
      holder.kill();
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('keeps a fresh lock another waiter created between this one judging the old lock dead and reclaiming it', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, JSON.stringify({ pid: await exitedPid(), startedAt: 1 }));
    const fresh = JSON.stringify({ pid: process.pid, startedAt: 2 });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // The other waiter judged the same dead lock, reclaimed it and created its own just before this one removes it.
    let taken = false;
    const takeOver = (path: unknown) => {
      if (path === lockPath && !taken) {
        taken = true;
        writeFileSync(lockPath, fresh);
      }
    };
    vi.mocked(rename).mockImplementation((async (from: string, to: string) => {
      takeOver(from);
      return actual.rename(from, to);
    }) as typeof rename);
    vi.mocked(rm).mockImplementation((async (path: string, options?: Parameters<typeof rm>[1]) => {
      takeOver(path);
      return actual.rm(path, options);
    }) as typeof rm);

    expect(await acquirePidLock(lockPath, { mode: 'try' })).toBeNull();

    expect(readFileSync(lockPath, 'utf-8')).toBe(fresh);
    expect(readdirSync(dir)).toEqual(['session.reconcile.lock']);
  });

  it('keeps a third lock created while the fresh one is set aside, byte-identical', async () => {
    const { reclaimStaleLock } = await import('../pid-lock.js');
    const stale = JSON.stringify({ pid: 999_999, startedAt: 1 });
    const fresh = JSON.stringify({ pid: process.pid, startedAt: 2 });
    const third = JSON.stringify({ pid: process.pid, startedAt: 3 });
    writeFileSync(lockPath, fresh);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // A third process finds the path free right after the fresh lock is moved aside and creates its own.
    vi.mocked(rename).mockImplementation((async (from: string, to: string) => {
      await actual.rename(from, to);
      if (from === lockPath) writeFileSync(lockPath, third);
    }) as typeof rename);

    expect(await reclaimStaleLock(lockPath, stale)).toBe(false);

    expect(readFileSync(lockPath, 'utf-8')).toBe(third);
    expect(readdirSync(dir)).toEqual(['session.reconcile.lock']);
  });

  it('returns false without throwing when the put-back fails', async () => {
    const { reclaimStaleLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 2 }));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const ioError = (code: string) => Object.assign(new Error(code), { code });
    vi.mocked(link).mockRejectedValue(ioError('ENOTSUP'));
    vi.mocked(rename).mockImplementation((async (from: string, to: string) => {
      if (from !== lockPath) throw ioError('EIO');
      return actual.rename(from, to);
    }) as typeof rename);

    await expect(reclaimStaleLock(lockPath, 'stale')).resolves.toBe(false);
  });

  it('reclaims an empty lock older than 5 s and keeps one written a second ago', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, '');
    const oneSecondAgo = new Date(Date.now() - 1_000);
    utimesSync(lockPath, oneSecondAgo, oneSecondAgo);

    expect(await acquirePidLock(lockPath, { mode: 'try' })).toBeNull();

    const sixSecondsAgo = new Date(Date.now() - 6_000);
    utimesSync(lockPath, sixSecondsAgo, sixSecondsAgo);
    expect(await acquirePidLock(lockPath, { mode: 'try' })).not.toBeNull();
  });

  it('release() keeps a lock that another process holds by then', async () => {
    const { acquirePidLock } = await import('../pid-lock.js');
    const lock = await acquirePidLock(lockPath, { mode: 'try' });
    const foreign = JSON.stringify({ pid: process.pid + 1, startedAt: 1 });
    writeFileSync(lockPath, foreign);

    await lock!.release();

    expect(readFileSync(lockPath, 'utf-8')).toBe(foreign);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('treats %s on the exclusive create as held', async (code) => {
    const { acquirePidLock } = await import('../pid-lock.js');
    writeFileSync(lockPath, liveHolder());
    vi.mocked(writeFile).mockRejectedValueOnce(errnoError(code));

    expect(await acquirePidLock(lockPath, { mode: 'try' })).toBeNull();
    expect(readFileSync(lockPath, 'utf-8')).toBe(liveHolder());
  });
});
