/**
 * requeueSetUnderNewId: a failed move never leaves two live records
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

vi.mock('@/utils/pid-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/pid-lock.js')>();
  return { ...actual, acquirePidLock: vi.fn(actual.acquirePidLock) };
});

const ID = 'd4e5f6a7-0000-4000-8000-000000000004';

describe('requeueSetUnderNewId', () => {
  let home: string;
  let sessionsDir: string;
  let originalHome: string | undefined;

  const names = (): string[] => readdirSync(sessionsDir).filter((n) => !n.endsWith('.lock')).sort();

  beforeEach(() => {
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'session-requeue-'));
    process.env.CODEMIE_HOME = home;
    sessionsDir = join(home, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${ID}.json`), JSON.stringify({ sessionId: ID, status: 'completed', startTime: 1 }));
    writeFileSync(join(sessionsDir, `${ID}_metrics.jsonl`), '{"a":1}\n');
    writeFileSync(join(sessionsDir, `${ID}_conversation.jsonl`), '{"b":2}\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { logger } = await import('../../../../utils/logger.js');
    await logger.close();
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('re-keys the set under a fresh id and keeps the origin', async () => {
    const { requeueSetUnderNewId } = await import('../session-generation.js');

    const newId = await requeueSetUnderNewId(ID);

    expect(newId).toBeDefined();
    expect(names()).toEqual([`${newId}.json`, `${newId}_conversation.jsonl`, `${newId}_metrics.jsonl`].sort());
  });

  it('a failed removal of the old record rolls the whole move back: one live record, sidecars in place', async () => {
    const { requeueSetUnderNewId } = await import('../session-generation.js');
    const livePath = join(sessionsDir, `${ID}.json`);
    vi.mocked(unlink).mockImplementation(async (path) => {
      if (String(path) === livePath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return actual.unlink(path);
    });

    await expect(requeueSetUnderNewId(ID)).rejects.toThrow('busy');

    expect(names()).toEqual([`${ID}.json`, `${ID}_conversation.jsonl`, `${ID}_metrics.jsonl`].sort());
  });

  it('a reconcile lock that cannot be taken moves nothing', async () => {
    const { requeueSetUnderNewId } = await import('../session-generation.js');
    const pidLock = await import('@/utils/pid-lock.js');
    const actual = await vi.importActual<typeof import('@/utils/pid-lock.js')>('@/utils/pid-lock.js');
    vi.mocked(pidLock.acquirePidLock).mockImplementation((path, options) =>
      String(path).endsWith('.reconcile.lock') ? Promise.resolve(null) : actual.acquirePidLock(path, options));

    await expect(requeueSetUnderNewId(ID)).rejects.toThrow(/Reconcile lock/);

    expect(existsSync(join(sessionsDir, `${ID}.json`))).toBe(true);
    expect(names()).toEqual([`${ID}.json`, `${ID}_conversation.jsonl`, `${ID}_metrics.jsonl`].sort());
  });
});
