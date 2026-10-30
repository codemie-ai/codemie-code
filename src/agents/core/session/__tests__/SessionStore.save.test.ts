/**
 * SessionStore.saveSession: atomic write and the save-name guard
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../types.js';
import { PathSecurityError } from '../../../../utils/errors.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});

const SESSION_ID = 'b2c3d4e5-0000-4000-8000-000000000002';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: SESSION_ID,
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: 1_790_000_000_000,
    workingDirectory: '/tmp/project',
    status: 'active',
    activeDurationMs: 0,
    correlation: { status: 'matched', agentSessionId: 'native-1', retryCount: 0 },
    ...overrides,
  };
}

describe('SessionStore.saveSession', () => {
  let home: string;
  let sessionsDir: string;
  let originalHome: string | undefined;

  const livePath = () => join(sessionsDir, `${SESSION_ID}.json`);
  const completedPath = () => join(sessionsDir, `completed_${SESSION_ID}.json`);

  beforeEach(() => {
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'session-store-save-'));
    process.env.CODEMIE_HOME = home;
    sessionsDir = join(home, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    vi.mocked(rename).mockReset();
    vi.mocked(writeFile).mockReset();
    const { logger } = await import('../../../../utils/logger.js');
    await logger.close();
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('rewrites completed_{id}.json for a completed record loaded through the fallback, never creating {id}.json', async () => {
    writeFileSync(completedPath(), JSON.stringify(makeSession({ status: 'completed', endTime: 1_790_000_100_000 })));
    const { SessionStore } = await import('../SessionStore.js');
    const store = new SessionStore();

    const loaded = await store.loadSession(SESSION_ID);
    await store.saveSession({ ...loaded!, deliveryAttempts: 1 });

    expect(existsSync(livePath())).toBe(false);
    expect(JSON.parse(readFileSync(completedPath(), 'utf-8')).deliveryAttempts).toBe(1);
  });

  it('writes {id}.json for an active record of a new generation while a completed_ file exists', async () => {
    writeFileSync(completedPath(), JSON.stringify(makeSession({ status: 'completed' })));
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession({
      startTime: 1_790_000_500_000,
      correlation: { status: 'matched', agentSessionId: 'native-2', retryCount: 0 },
    }));

    expect(JSON.parse(readFileSync(livePath(), 'utf-8')).correlation.agentSessionId).toBe('native-2');
    expect(JSON.parse(readFileSync(completedPath(), 'utf-8')).status).toBe('completed');
  });

  it('never recreates {id}.json from an active copy of the generation already in completed_', async () => {
    const completed = JSON.stringify(makeSession({ status: 'completed', endTime: 1_790_000_100_000 }));
    writeFileSync(completedPath(), completed);
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession());

    expect(existsSync(livePath())).toBe(false);
    expect(readFileSync(completedPath(), 'utf-8')).toBe(completed);
  });

  it('removes the {id}.json it just wrote when the generation is renamed to completed_ during the write', async () => {
    writeFileSync(livePath(), JSON.stringify(makeSession()));
    const completed = JSON.stringify(makeSession({ status: 'completed', endTime: 1_790_000_100_000 }));
    const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    // SessionEnd renames the live record to completed_ after the save chose {id}.json, before its rename lands.
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      renameSync(livePath(), completedPath());
      writeFileSync(completedPath(), completed);
      return actualRename(from, to);
    });
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession({ activeDurationMs: 5_000 }));

    expect(existsSync(livePath())).toBe(false);
    expect(readFileSync(completedPath(), 'utf-8')).toBe(completed);
  });

  it('moves a completed {id}.json over completed_ when the generation is renamed during the write', async () => {
    writeFileSync(livePath(), JSON.stringify(makeSession()));
    const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    // Another process renames the live record to completed_ after the save chose {id}.json, before its rename lands.
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      renameSync(livePath(), completedPath());
      writeFileSync(completedPath(), JSON.stringify(makeSession({ status: 'completed', reason: 'stop' })));
      return actualRename(from, to);
    });
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession({ status: 'completed', reason: 'exit', endMetricSentAt: 1_790_000_200_000 }));

    expect(existsSync(livePath())).toBe(false);
    const completed = JSON.parse(readFileSync(completedPath(), 'utf-8'));
    expect(completed.reason).toBe('exit');
    expect(completed.endMetricSentAt).toBe(1_790_000_200_000);
  });

  async function renameToCompletedDuringWrite(other: Session): Promise<void> {
    const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    // Another process renames the live record to completed_ and saves its delivery state there before this rename lands.
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      renameSync(livePath(), completedPath());
      writeFileSync(completedPath(), JSON.stringify(other));
      return actualRename(from, to);
    });
  }

  it('merges a completed save into completed_ written meanwhile, keeping the other process\'s delivery mark', async () => {
    writeFileSync(livePath(), JSON.stringify(makeSession()));
    await renameToCompletedDuringWrite(
      makeSession({ status: 'completed', reason: 'stop', endMetricSentAt: 1_790_000_300_000, deliveryAttempts: 2 })
    );
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(
      makeSession({ status: 'completed', reason: 'exit', activeDurationMs: 7_000, deliveryAttempts: 1 })
    );

    expect(existsSync(livePath())).toBe(false);
    const completed = JSON.parse(readFileSync(completedPath(), 'utf-8'));
    expect(completed.reason).toBe('exit');
    expect(completed.activeDurationMs).toBe(7_000);
    expect(completed.endMetricSentAt).toBe(1_790_000_300_000);
    expect(completed.deliveryAttempts).toBe(2);
  });

  it('keeps the saving copy\'s larger attempt counter when merging into completed_', async () => {
    writeFileSync(livePath(), JSON.stringify(makeSession()));
    await renameToCompletedDuringWrite(makeSession({ status: 'completed', deliveryAttempts: 1 }));
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession({ status: 'completed', deliveryAttempts: 3 }));

    expect(existsSync(livePath())).toBe(false);
    expect(JSON.parse(readFileSync(completedPath(), 'utf-8')).deliveryAttempts).toBe(3);
  });

  it('leaves a newer generation\'s {id}.json written after the completed_ merge in place', async () => {
    writeFileSync(livePath(), JSON.stringify(makeSession()));
    await renameToCompletedDuringWrite(
      makeSession({ status: 'completed', reason: 'stop', endMetricSentAt: 1_790_000_300_000 })
    );
    const newer = JSON.stringify(makeSession({
      startTime: 1_790_000_900_000,
      correlation: { status: 'matched', agentSessionId: 'native-2', retryCount: 0 },
    }));
    const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    // A /clear SessionStart writes the fresh generation's {id}.json right after the merge lands in completed_.
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await actualRename(from, to);
      writeFileSync(livePath(), newer);
    });
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession({ status: 'completed', reason: 'exit' }));

    expect(readFileSync(livePath(), 'utf-8')).toBe(newer);
    const completed = JSON.parse(readFileSync(completedPath(), 'utf-8'));
    expect(completed.reason).toBe('exit');
    expect(completed.endMetricSentAt).toBe(1_790_000_300_000);
  });

  it('writes {id}.json for a completed record while {id}.json exists', async () => {
    writeFileSync(livePath(), JSON.stringify(makeSession()));
    writeFileSync(completedPath(), JSON.stringify(makeSession({ status: 'completed', reason: 'older' })));
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession({ status: 'completed', reason: 'exit' }));

    expect(JSON.parse(readFileSync(livePath(), 'utf-8')).reason).toBe('exit');
    expect(JSON.parse(readFileSync(completedPath(), 'utf-8')).reason).toBe('older');
  });

  it('leaves no temp file behind after a save', async () => {
    const { SessionStore } = await import('../SessionStore.js');

    await new SessionStore().saveSession(makeSession());

    expect(readdirSync(sessionsDir)).toEqual([`${SESSION_ID}.json`]);
  });

  it('leaves the target untouched and no temp file when the rename fails', async () => {
    const before = JSON.stringify(makeSession({ reason: 'before' }));
    writeFileSync(livePath(), before);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    const { SessionStore } = await import('../SessionStore.js');

    await expect(new SessionStore().saveSession(makeSession({ reason: 'after' }))).rejects.toThrow('EIO');

    expect(readFileSync(livePath(), 'utf-8')).toBe(before);
    expect(readdirSync(sessionsDir)).toEqual([`${SESSION_ID}.json`]);
  });

  it('removes the temp file and rethrows when the write fails after creating it', async () => {
    const actualWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
    vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      await actualWriteFile(path, '{"partial"');
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    });
    const { SessionStore } = await import('../SessionStore.js');

    await expect(new SessionStore().saveSession(makeSession())).rejects.toThrow('ENOSPC');

    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  it('rejects a session id containing a path separator', async () => {
    const { SessionStore } = await import('../SessionStore.js');

    const saving = new SessionStore().saveSession(makeSession({ sessionId: '../escape' }));
    await expect(saving).rejects.toBeInstanceOf(PathSecurityError);
    await expect(saving).rejects.toThrow(/path separator/);
  });
});
