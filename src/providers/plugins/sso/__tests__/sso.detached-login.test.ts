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
import {
  startDetachedSsoLogin,
  releaseLoginLockOnSuccess,
  releaseLoginLockOnFailure,
  waitForDetachedSsoLogin,
  describeLogin,
  getLastSignInAt,
} from '../sso.detached-login.js';

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

  it('reports cooldown within 30s of a successful sign-in, even though its process has already exited (PR #655 review)', async () => {
    // The sign-in child's own process has exited after succeeding (isProcessAlive => false),
    // and its startedAt could be from well before the 30s window — succeededAt is the only
    // signal that a login just completed and repeated redirects should be damped.
    vi.mocked(isProcessAlive).mockReturnValue(false);
    await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt: Date.now() - 5_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('signed-in-recently');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('does not report a successful sign-in as incomplete or send the user to `codemie profile login` during the post-success cooldown (EPMCDME-16568)', async () => {
    // `codemie profile login` signs in in-process without the lock, so following that advice
    // right after a successful sign-in opens yet another browser window.
    vi.mocked(isProcessAlive).mockReturnValue(false);
    await writeLock({ pid: 1, startedAt: Date.now() - 3_000, succeededAt: Date.now() - 1_000 });

    const text = describeLogin(await startDetachedSsoLogin(URL_));

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(text).not.toContain('did not complete');
    expect(text).not.toContain('codemie profile login');
    expect(text).toContain('re-send your prompt');
  });

  it('starts a new sign-in once the post-success cooldown has elapsed', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(false);
    await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt: Date.now() - 31_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('started');
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('starts a new sign-in once the cooldown elapses even if the succeeded process is still lingering (caught by blind review)', async () => {
    // A succeeded lock's own age (startedAt) and live pid must NOT fall through to the
    // isProcessAlive/LOCK_MAX_AGE_MS "in-progress" branch — that branch is for an unresolved
    // attempt, not a succeeded-but-slow-to-exit one. Without that split, this would wrongly
    // report 'in-progress' for up to 150s instead of releasing after the 30s cooldown.
    vi.mocked(isProcessAlive).mockReturnValue(true); // the succeeded process hasn't exited yet
    await writeLock({ pid: 1, startedAt: Date.now() - 40_000, succeededAt: Date.now() - 31_000 });

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

  it('stamps an owned lock as succeeded rather than removing it (PR #655 review: damp repeated sign-ins)', async () => {
    const startedAt = Date.now();
    await writeLock({ pid: process.pid, startedAt });

    await releaseLoginLockOnSuccess();

    expect(await exists(lockPath())).toBe(true);
    const lock = JSON.parse(await readFile(lockPath(), 'utf-8'));
    expect(lock).toMatchObject({ pid: process.pid, startedAt });
    expect(lock.succeededAt).toBeTypeOf('number');
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

  it('describes a recent sign-in as finished, asks to re-send, and names the cooldown seconds', () => {
    const text = describeLogin('signed-in-recently');
    expect(text).toContain('re-send your prompt');
    expect(text).toContain('wait about 30 seconds');
    expect(text).not.toContain('expired');
    expect(text).not.toContain('did not complete');
    expect(text).not.toContain('codemie profile login');
  });

  it('returns the generic failure text for an unexpected outcome instead of throwing', () => {
    const unexpected = 'surprise' as unknown as Parameters<typeof describeLogin>[0];

    expect(() => describeLogin(unexpected)).not.toThrow();
    expect(describeLogin(unexpected)).toBe(describeLogin('failed'));
  });

  it('describes a failure', () => {
    expect(describeLogin('failed')).toContain('Could not open the browser sign-in');
  });

  it('says the sign-in finished but this profile is still unauthenticated after a succeeded wait', () => {
    const text = describeLogin('cooldown', { wait: { status: 'succeeded' } });
    expect(text).toContain('sign-in finished');
    expect(text).toContain('still not authenticated');
    expect(text).not.toContain('did not complete');
    expect(text).toContain('re-send your prompt');
  });

  it('gives neutral text without the expected-expiry lead when no sign-in was attempted', () => {
    const text = describeLogin(undefined);
    expect(text).not.toContain('expired');
    expect(text).not.toContain('codemie profile login');
    expect(text).toContain('re-send your prompt');
  });
});

describe('releaseLoginLockOnFailure', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sso-lock-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stamps an owned lock as failed with the error', async () => {
    await writeLock({ pid: process.pid, startedAt: 1000 });

    await releaseLoginLockOnFailure('Authentication cancelled by user');

    const lock = JSON.parse(await readFile(lockPath(), 'utf-8'));
    expect(lock).toMatchObject({ pid: process.pid, startedAt: 1000, error: 'Authentication cancelled by user' });
    expect(lock.failedAt).toBeTypeOf('number');
  });

  it('leaves a lock owned by another process untouched', async () => {
    const lock = { pid: process.pid + 1, startedAt: 1000 };
    await writeLock(lock);

    await releaseLoginLockOnFailure('x');

    expect(JSON.parse(await readFile(lockPath(), 'utf-8'))).toEqual(lock);
  });
});

describe('waitForDetachedSsoLogin', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sso-lock-'));
    vi.clearAllMocks();
    vi.mocked(isProcessAlive).mockReturnValue(true);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns succeeded when succeededAt is stamped mid-wait', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() });
    setTimeout(() => void writeLock({ pid: 1, startedAt: Date.now(), succeededAt: Date.now() }), 30);

    expect(await waitForDetachedSsoLogin({ timeoutMs: 2_000, pollMs: 10 })).toEqual({ status: 'succeeded' });
  });

  it('returns failed with the stamped error', async () => {
    await writeLock({ pid: 1, startedAt: Date.now(), failedAt: Date.now(), error: 'Authentication cancelled by user' });

    expect(await waitForDetachedSsoLogin({ timeoutMs: 2_000, pollMs: 10 })).toEqual({
      status: 'failed',
      error: 'Authentication cancelled by user',
    });
  });

  it('returns failed immediately when the lock pid died without stamping', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(false);
    await writeLock({ pid: 1, startedAt: Date.now() });

    const result = await waitForDetachedSsoLogin({ timeoutMs: 2_000, pollMs: 10 });

    expect(result.status).toBe('failed');
  });

  it('returns failed when there is no lock', async () => {
    expect((await waitForDetachedSsoLogin({ timeoutMs: 2_000, pollMs: 10 })).status).toBe('failed');
  });

  it('returns timeout when the deadline passes with a live pid', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() });

    expect(await waitForDetachedSsoLogin({ timeoutMs: 50, pollMs: 10 })).toEqual({ status: 'timeout' });
  });
});

describe('describeLogin variants', () => {
  it('auto-resume text says it will continue automatically', () => {
    const text = describeLogin('started', { resume: 'auto' });
    expect(text).toContain('expected');
    expect(text).toContain('continue automatically');
    expect(text).not.toContain('re-send');
  });

  it('manual text tells the user to re-send', () => {
    const text = describeLogin('started');
    expect(text).toContain('expected');
    expect(text).toContain('re-send your prompt');
  });

  it('failed wait names the error and recovery', () => {
    const text = describeLogin('started', { wait: { status: 'failed', error: 'X' } });
    expect(text).toContain('X');
    expect(text).toContain('codemie profile login');
  });

  it('timed-out wait tells the user to re-send', () => {
    expect(describeLogin('started', { wait: { status: 'timeout' } })).toContain('re-send your prompt');
  });
});

describe('getLastSignInAt', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sso-lock-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the succeededAt of the lock', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 5_000 });

    expect(await getLastSignInAt(URL_)).toBe(5_000);
  });

  it('returns null when there is no lock', async () => {
    expect(await getLastSignInAt(URL_)).toBeNull();
  });

  it('returns null while an attempt that never followed a sign-in holds the lock', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() });

    expect(await getLastSignInAt(URL_)).toBeNull();
  });

  it('returns null for a failed lock that never followed a sign-in', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, failedAt: 2_000, error: 'boom' });

    expect(await getLastSignInAt(URL_)).toBeNull();
  });

  it('returns the carried-forward sign-in of a lock written over an earlier success', async () => {
    await writeLock({ pid: 1, startedAt: Date.now(), lastSucceededAt: 5_000 });

    expect(await getLastSignInAt(URL_)).toBe(5_000);
  });

  it('prefers the lock\'s own succeededAt over a carried-forward one', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 9_000, lastSucceededAt: 5_000 });

    expect(await getLastSignInAt(URL_)).toBe(9_000);
  });

  it('returns null for a corrupt lock', async () => {
    await writeLock('{not json');

    expect(await getLastSignInAt(URL_)).toBeNull();
  });
});

describe('last sign-in surviving a newer attempt', () => {
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

  const readLockFile = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(lockPath(), 'utf-8'));

  it('still reports an earlier success while a newer in-progress attempt holds the lock', async () => {
    const succeededAt = Date.now() - 60_000;
    await writeLock({ pid: 1, startedAt: Date.now() - 90_000, succeededAt });

    expect(await startDetachedSsoLogin(URL_)).toBe('started');

    const lock = await readLockFile();
    expect(lock.succeededAt).toBeUndefined();
    expect(lock.pid).toBe(4242);
    expect(await getLastSignInAt(URL_)).toBe(succeededAt);
  });

  it('keeps it across two consecutive attempts that replace each other', async () => {
    const succeededAt = Date.now() - 60_000;
    await writeLock({ pid: 1, startedAt: Date.now() - 90_000, succeededAt });
    await startDetachedSsoLogin(URL_);
    await writeLock({ ...(await readLockFile()), startedAt: Date.now() - 40_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('started');

    expect(await getLastSignInAt(URL_)).toBe(succeededAt);
  });

  it('still reports an earlier success after the newer attempt failed', async () => {
    const succeededAt = Date.now() - 60_000;
    await writeLock({ pid: process.pid, startedAt: Date.now() - 90_000, succeededAt });
    vi.mocked(spawnDetached).mockReturnValue(process.pid);
    await startDetachedSsoLogin(URL_);

    await releaseLoginLockOnFailure('Authentication cancelled by user');

    expect(await readLockFile()).toMatchObject({ failedAt: expect.any(Number) });
    expect(await getLastSignInAt(URL_)).toBe(succeededAt);
  });

  it('still reports an earlier success when the newer attempt could not even be spawned', async () => {
    const succeededAt = Date.now() - 60_000;
    await writeLock({ pid: 1, startedAt: Date.now() - 90_000, succeededAt });
    vi.mocked(spawnDetached).mockReturnValue(-1);

    expect(await startDetachedSsoLogin(URL_)).toBe('failed');

    expect(await getLastSignInAt(URL_)).toBe(succeededAt);
  });

  it('a leftover lock from a failed spawn neither blocks nor delays the next attempt', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 90_000, succeededAt: Date.now() - 60_000 });
    vi.mocked(spawnDetached).mockReturnValueOnce(-1);
    await startDetachedSsoLogin(URL_);
    vi.mocked(isProcessAlive).mockReturnValue(true);

    expect(await startDetachedSsoLogin(URL_)).toBe('started');
  });

  it('a new success replaces the carried-forward stamp', async () => {
    const earlier = Date.now() - 60_000;
    await writeLock({ pid: 1, startedAt: Date.now() - 90_000, succeededAt: earlier });
    vi.mocked(spawnDetached).mockReturnValue(process.pid);
    await startDetachedSsoLogin(URL_);

    await releaseLoginLockOnSuccess();

    const lock = await readLockFile();
    expect(lock.succeededAt).toBeTypeOf('number');
    expect(lock.succeededAt).toBeGreaterThan(earlier);
    expect(lock.lastSucceededAt).toBeUndefined();
    expect(await getLastSignInAt(URL_)).toBe(lock.succeededAt);
  });

  it('parses a lock written by an older version (no carried field)', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt: Date.now() - 31_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('started');
    expect(await getLastSignInAt(URL_)).not.toBeNull();
  });

  it('a carried-forward stamp does not trigger the post-success cooldown', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 40_000, lastSucceededAt: Date.now() - 1_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('started');
  });

  it('a carried-forward stamp does not turn a post-failure cooldown or in-progress into anything else', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 5_000, lastSucceededAt: Date.now() - 1_000 });
    expect(await startDetachedSsoLogin(URL_)).toBe('cooldown');

    vi.mocked(isProcessAlive).mockReturnValue(true);
    await writeLock({ pid: 1, startedAt: Date.now() - 5_000, lastSucceededAt: Date.now() - 1_000 });
    expect(await startDetachedSsoLogin(URL_)).toBe('in-progress');
  });

  it('keeps the post-success cooldown measured from succeededAt only', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt: Date.now() - 5_000, lastSucceededAt: 1_000 });

    expect(await startDetachedSsoLogin(URL_)).toBe('signed-in-recently');
  });
});

describe('last sign-in per CodeMie URL', () => {
  const URL_A = 'https://a.example.com';
  const URL_B = 'https://b.example.com';
  const sourceFor = (url: string): { provider: string; baseUrl: string } => ({ provider: 'ai-run-sso', baseUrl: url });
  const readLockFile = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(lockPath(), 'utf-8'));

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

  it('does not return the stamp of a sign-in on URL A for a source on URL B', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 5_000, url: URL_A });

    expect(await getLastSignInAt(sourceFor(URL_B))).toBeNull();
  });

  it('returns the stamp for a source that resolves to the same URL', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 5_000, url: URL_A });

    expect(await getLastSignInAt(sourceFor(URL_A))).toBe(5_000);
  });

  it('compares URLs normalised: case, trailing slash and path do not matter', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 5_000, url: 'https://A.Example.com/' });

    expect(await getLastSignInAt(sourceFor('https://a.example.com/code-assistant-api'))).toBe(5_000);
    expect(await getLastSignInAt({ codeMieUrl: URL_A })).toBe(5_000);
  });

  it('resolves the source URL the way the stored credentials do: workspace URL for a non-CodeMie provider', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 5_000, url: URL_A });

    expect(await getLastSignInAt({ provider: 'litellm', baseUrl: URL_B, codeMieUrl: URL_A })).toBe(5_000);
    expect(await getLastSignInAt({ provider: 'litellm', baseUrl: URL_A, codeMieUrl: URL_B })).toBeNull();
  });

  it('keeps matching a lock without a URL (written by an older version)', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 5_000 });
    expect(await getLastSignInAt(sourceFor(URL_B))).toBe(5_000);

    await writeLock({ pid: 1, startedAt: Date.now(), lastSucceededAt: 6_000 });
    expect(await getLastSignInAt(sourceFor(URL_B))).toBe(6_000);
  });

  it('keeps matching when the source resolves to no URL', async () => {
    await writeLock({ pid: 1, startedAt: 1_000, succeededAt: 5_000, url: URL_A });

    expect(await getLastSignInAt({})).toBe(5_000);
  });

  it('checks a carried-forward stamp against the URL it was made for, not the newer attempt\'s', async () => {
    await writeLock({ pid: 1, startedAt: Date.now(), url: URL_B, lastSucceededAt: 5_000, lastSucceededUrl: URL_A });

    expect(await getLastSignInAt(sourceFor(URL_A))).toBe(5_000);
    expect(await getLastSignInAt(sourceFor(URL_B))).toBeNull();
  });

  it('records the URL of the sign-in it starts, and keeps it when that sign-in succeeds', async () => {
    vi.mocked(spawnDetached).mockReturnValue(process.pid);

    expect(await startDetachedSsoLogin(URL_A)).toBe('started');
    expect(await readLockFile()).toMatchObject({ url: URL_A });

    await releaseLoginLockOnSuccess();

    expect(await readLockFile()).toMatchObject({ url: URL_A, succeededAt: expect.any(Number) });
    expect(await getLastSignInAt(sourceFor(URL_A))).not.toBeNull();
    expect(await getLastSignInAt(sourceFor(URL_B))).toBeNull();
  });

  it('carries an earlier sign-in together with its URL across a newer attempt on another URL', async () => {
    const succeededAt = Date.now() - 60_000;
    await writeLock({ pid: 1, startedAt: Date.now() - 90_000, succeededAt, url: URL_A });

    expect(await startDetachedSsoLogin(URL_B)).toBe('started');

    expect(await readLockFile()).toMatchObject({ url: URL_B, lastSucceededAt: succeededAt, lastSucceededUrl: URL_A });
    expect(await getLastSignInAt(sourceFor(URL_A))).toBe(succeededAt);
    expect(await getLastSignInAt(sourceFor(URL_B))).toBeNull();
  });

  it('keeps the carried URL across two consecutive attempts, a failed attempt and a spawn failure', async () => {
    const succeededAt = Date.now() - 60_000;
    await writeLock({ pid: 1, startedAt: Date.now() - 90_000, succeededAt, url: URL_A });
    await startDetachedSsoLogin(URL_B);
    await writeLock({ ...(await readLockFile()), startedAt: Date.now() - 40_000 });
    expect(await startDetachedSsoLogin(URL_B)).toBe('started');
    expect(await getLastSignInAt(sourceFor(URL_A))).toBe(succeededAt);
    expect(await getLastSignInAt(sourceFor(URL_B))).toBeNull();

    vi.mocked(spawnDetached).mockReturnValue(process.pid);
    await writeLock({ ...(await readLockFile()), startedAt: Date.now() - 40_000 });
    await startDetachedSsoLogin(URL_B);
    await releaseLoginLockOnFailure('cancelled');
    expect(await getLastSignInAt(sourceFor(URL_A))).toBe(succeededAt);
    expect(await getLastSignInAt(sourceFor(URL_B))).toBeNull();

    vi.mocked(spawnDetached).mockReturnValue(-1);
    await writeLock({ ...(await readLockFile()), startedAt: Date.now() - 40_000 });
    expect(await startDetachedSsoLogin(URL_B)).toBe('failed');
    expect(await getLastSignInAt(sourceFor(URL_A))).toBe(succeededAt);
    expect(await getLastSignInAt(sourceFor(URL_B))).toBeNull();
  });

  describe('post-success cooldown per URL', () => {
    it('starts a sign-in for URL B within the cooldown of a success on URL A, carrying A\'s stamp', async () => {
      const succeededAt = Date.now() - 5_000;
      await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt, url: URL_A });

      expect(await startDetachedSsoLogin(URL_B)).toBe('started');

      expect(spawnDetached).toHaveBeenCalledTimes(1);
      expect(await readLockFile()).toMatchObject({ url: URL_B, lastSucceededAt: succeededAt, lastSucceededUrl: URL_A });
    });

    it('still reports signed-in-recently for URL A within the cooldown of a success on URL A', async () => {
      await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt: Date.now() - 5_000, url: URL_A });

      expect(await startDetachedSsoLogin(URL_A)).toBe('signed-in-recently');
      expect(spawnDetached).not.toHaveBeenCalled();
    });

    it('compares the URLs normalised: case, trailing slash and path do not make them differ', async () => {
      await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt: Date.now() - 5_000, url: 'https://A.Example.com/' });

      expect(await startDetachedSsoLogin('https://a.example.com/code-assistant-api')).toBe('signed-in-recently');
      expect(spawnDetached).not.toHaveBeenCalled();
    });

    it('keeps blocking on a success recorded without a URL (written by an older version)', async () => {
      await writeLock({ pid: 1, startedAt: Date.now() - 60_000, succeededAt: Date.now() - 5_000 });

      expect(await startDetachedSsoLogin(URL_B)).toBe('signed-in-recently');
      expect(spawnDetached).not.toHaveBeenCalled();
    });
  });

  it('does not change the in-progress or post-failure decisions across URLs', async () => {
    await writeLock({ pid: 1, startedAt: Date.now() - 5_000, url: URL_A });
    expect(await startDetachedSsoLogin(URL_B)).toBe('cooldown');

    vi.mocked(isProcessAlive).mockReturnValue(true);
    expect(await startDetachedSsoLogin(URL_B)).toBe('in-progress');
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});
