import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const io = vi.hoisted(() => ({ root: '', fail: false }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (io.fail) {
        await actual.writeFile(args[0], '{"partial":');
        throw Object.assign(new Error('disk full during write'), { code: 'ENOSPC' });
      }
      return actual.writeFile(...args);
    },
  };
});
vi.mock('../spool-paths.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spoolRoot: () => io.root,
  statusFile: (sessionId: string) => join(io.root, `${sessionId}.status`),
}));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

beforeEach(async () => {
  io.root = await mkdtemp(join(tmpdir(), 'status-atomic-'));
  io.fail = false;
});
afterEach(async () => { io.fail = false; await rm(io.root, { recursive: true, force: true }); });

it('a partial failed status update retains the durable pre-send checkpoint and original cursor', async () => {
  const { createStatus, readStatus, writeStatus } = await import('../session-status.js');
  const original = { ...createStatus(), sendMode: 'evidence' as const, sendCheckpoint: true as const };
  await writeStatus('session', original);
  const before = await readFile(join(io.root, 'session.status'), 'utf8');
  io.fail = true;
  await expect(writeStatus('session', { ...original, stopIntent: 'response_unverified' })).rejects.toThrow('disk full');
  expect(await readFile(join(io.root, 'session.status'), 'utf8')).toBe(before);
  expect(await readStatus('session')).toMatchObject({ sendCheckpoint: true, sendMode: 'evidence', cursors: original.cursors });
  expect((await readdir(io.root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});
