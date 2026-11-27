import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { acquireAuthLock } from '../auth/auth-lock.js';
import { useTempCodemieHome } from './helpers/temp-home.js';

const home = useTempCodemieHome();

function lockPath(): string {
  return join(home.dir(), 'mcp-auth.lock');
}

function readLockFile(): { pid: number; createdAt: number; staleAfterMs?: number } {
  return JSON.parse(readFileSync(lockPath(), 'utf-8'));
}

/** A PID that is guaranteed to be dead: a child process that already exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  return result.pid;
}

/** A foreign PID that is alive (our parent), so only age can make its lock stale. */
const ALIVE_FOREIGN_PID = process.ppid;

describe('acquireAuthLock', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the lock file and removes it on release', async () => {
    const release = await acquireAuthLock({ maxWaitMs: 1000, staleAfterMs: 60_000 });

    expect(existsSync(lockPath())).toBe(true);
    expect(readLockFile().pid).toBe(process.pid);

    release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('records the caller staleAfterMs in the lock file', async () => {
    const release = await acquireAuthLock({ maxWaitMs: 1000, staleAfterMs: 12_345 });

    expect(readLockFile().staleAfterMs).toBe(12_345);

    release();
  });

  it('makes a second caller wait until the first releases', async () => {
    const releaseFirst = await acquireAuthLock({ maxWaitMs: 1000, staleAfterMs: 60_000 });

    let secondResolved = false;
    const secondPromise = acquireAuthLock({ maxWaitMs: 5000, staleAfterMs: 60_000 }).then((release) => {
      secondResolved = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(secondResolved).toBe(false);

    releaseFirst();
    const releaseSecond = await secondPromise;

    expect(secondResolved).toBe(true);
    expect(existsSync(lockPath())).toBe(true);
    expect(readLockFile().pid).toBe(process.pid);

    releaseSecond();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('removes a lock whose owner process is dead', async () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: deadPid(), createdAt: Date.now(), staleAfterMs: 600_000 })
    );

    const release = await acquireAuthLock({ maxWaitMs: 2000, staleAfterMs: 60_000 });

    expect(readLockFile().pid).toBe(process.pid);
    release();
  });

  it('uses the stale age recorded in the file, not the caller one', async () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: ALIVE_FOREIGN_PID, createdAt: Date.now() - 5000, staleAfterMs: 1000 })
    );

    const release = await acquireAuthLock({ maxWaitMs: 2000, staleAfterMs: 600_000 });

    expect(readLockFile().pid).toBe(process.pid);
    expect(readLockFile().staleAfterMs).toBe(600_000);
    release();
  });

  it('respects a fresh old-format lock file without staleAfterMs', async () => {
    const holder = { pid: ALIVE_FOREIGN_PID, createdAt: Date.now() - 10_000 };
    writeFileSync(lockPath(), JSON.stringify(holder));

    const release = await acquireAuthLock({ maxWaitMs: 400, staleAfterMs: 1000 });
    release();

    expect(readLockFile()).toEqual(holder);
  });

  it('removes an old-format lock file older than 150 seconds', async () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: ALIVE_FOREIGN_PID, createdAt: Date.now() - 151_000 })
    );

    const release = await acquireAuthLock({ maxWaitMs: 2000, staleAfterMs: 600_000 });

    expect(readLockFile().pid).toBe(process.pid);
    release();
  });

  it('gives up after maxWaitMs with a no-op release and leaves the holder lock', async () => {
    const holder = { pid: ALIVE_FOREIGN_PID, createdAt: Date.now(), staleAfterMs: 600_000 };
    writeFileSync(lockPath(), JSON.stringify(holder));

    const startedAt = Date.now();
    const release = await acquireAuthLock({ maxWaitMs: 400, staleAfterMs: 600_000 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2000);

    release();
    expect(readLockFile()).toEqual(holder);
  });
});
