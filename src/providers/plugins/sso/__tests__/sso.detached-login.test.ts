import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('@/utils/paths.js', () => ({
  getCodemiePath: (...parts: string[]) => join(tempDir, ...parts),
  getDirname: () => '/fake/dist/providers/plugins/sso',
}));
vi.mock('@/utils/processes.js', () => ({
  spawnDetached: vi.fn(),
  isProcessAlive: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => true),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { existsSync } from 'node:fs';
import { spawnDetached, isProcessAlive } from '@/utils/processes.js';
import { startDetachedSsoLogin, releaseLoginLockOnSuccess, describeLogin } from '../sso.detached-login.js';

const URL_ = 'https://codemie.example.com';
const lockPath = (): string => join(tempDir, 'sso-login.lock');
const writeLock = (lock: unknown): Promise<void> => writeFile(lockPath(), typeof lock === 'string' ? lock : JSON.stringify(lock));
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('startDetachedSsoLogin', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sso-lock-'));
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(spawnDetached).mockReturnValue(4242);
    vi.mocked(isProcessAlive).mockReturnValue(false);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts a sign-in when there is no lock', async () => {
    expect(await startDetachedSsoLogin(URL_)).toBe('started');

    const [command, args, options] = vi.mocked(spawnDetached).mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[1]).toBe('--url');
    expect(args[2]).toBe(URL_);
    expect(args[0]).toMatch(/sso-login\.js$/);
    expect(options).toEqual({ windowsHide: true });

    const lock = JSON.parse(await readFile(lockPath(), 'utf-8'));
    expect(lock).toMatchObject({ pid: 4242 });
  });

  it('reports in-progress for a fresh lock with a live pid', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 5_000 });
    vi.mocked(isProcessAlive).mockReturnValue(true);

    expect(await startDetachedSsoLogin(URL_)).toBe('in-progress');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('reports cooldown for a dead pid within 30s', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 5_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('cooldown');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('replaces a stale lock with a dead pid older than 30s', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 31_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('started');
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('replaces a lock with a live pid older than 150s', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 151_000 });
    vi.mocked(isProcessAlive).mockReturnValue(true);

    expect(await startDetachedSsoLogin(URL_)).toBe('started');
  });

  it.each([['not json'], [{ pid: 'x' }], [{ startedAt: 1 }]])('treats an old corrupt lock (%j) as stale', async (lock) => {
    await writeLock(lock);
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath(), old, old);

    expect(await startDetachedSsoLogin(URL_)).toBe('started');
  });

  it.each([[''], ['not json']])('reports in-progress for a freshly written unreadable lock (%j)', async (lock) => {
    await writeLock(lock);

    expect(await startDetachedSsoLogin(URL_)).toBe('in-progress');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('fails and removes the lock when spawn returns -1', async () => {
    vi.mocked(spawnDetached).mockReturnValue(-1);

    expect(await startDetachedSsoLogin(URL_)).toBe('failed');
    expect(await exists(lockPath())).toBe(false);
  });

  it('fails and removes the lock when spawn throws', async () => {
    vi.mocked(spawnDetached).mockImplementation(() => {
      throw new Error('spawn failed');
    });

    expect(await startDetachedSsoLogin(URL_)).toBe('failed');
    expect(await exists(lockPath())).toBe(false);
  });

  it('fails and removes the lock when the child script is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(await startDetachedSsoLogin(URL_)).toBe('failed');
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(await exists(lockPath())).toBe(false);
  });

  it('lets exactly one of two concurrent calls start a sign-in', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(true);

    const results = await Promise.all([startDetachedSsoLogin(URL_), startDetachedSsoLogin(URL_)]);

    expect([...results].sort()).toEqual(['in-progress', 'started']);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });
});

describe('releaseLoginLockOnSuccess', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sso-lock-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('removes an owned lock', async () => {
    await writeLock({ pid: process.pid, startedAt: Date.now() });

    await releaseLoginLockOnSuccess();

    expect(await exists(lockPath())).toBe(false);
  });

  it('leaves a lock owned by another process untouched', async () => {
    const lock = { pid: process.pid + 1, startedAt: 1000 };
    await writeLock(lock);

    await releaseLoginLockOnSuccess();

    expect(JSON.parse(await readFile(lockPath(), 'utf-8'))).toEqual(lock);
  });

  it('does nothing when there is no lock', async () => {
    await expect(releaseLoginLockOnSuccess()).resolves.toBeUndefined();
  });
});

describe('describeLogin', () => {
  it('describes a started sign-in', () => {
    expect(describeLogin('started')).toContain('opened automatically');
  });

  it('describes an in-progress sign-in', () => {
    expect(describeLogin('in-progress')).toContain('already in progress');
  });

  it('describes a cooldown', () => {
    expect(describeLogin('cooldown')).toContain('codemie profile login');
  });

  it.each([['failed' as const], [undefined]])('describes a failure (%s)', (outcome) => {
    expect(describeLogin(outcome)).toContain('Could not open the browser sign-in');
  });
});
